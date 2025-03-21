import { createEA3Header, createLPCMHeader, createRandomBytes, getUint32 } from './utils';
import { CodecInfo, getBytesPerFrame, getCodecName, getKBPS, getSeconds, HiMDCodec, HiMDCodecName } from './codecs';
import { HiMDBlockInfo, DOSTIME_NULL, HiMD, HiMDError, HiMDFragment, HiMDRawGroup, HiMDRawTrack, HiMDStringType } from './himd';
import { CryptoBlockProvider, CryptoProvider } from './workers';
import { BLOCK_SIZE, HiMDBlockStream, HiMDWriteStream, HIMD_AUDIO_SIZE } from './streams';
import { create as createID3 } from 'node-id3';
import { getMP3EncryptionKey } from './encryption';
import { readTags, readFrame, FrameHeader, Header } from 'mp3-parser';
import { HiMDSecureSession } from './secure-session';

export interface HiMDTrack {
    index: number;
    title: string | null;
    album: string | null;
    artist: string | null;
    duration: number;
    encoding: HiMDCodecName;
    bitrate: number;
}

export interface HiMDGroup {
    groupIndex: number;
    title: string | null;
    startIndex: number;
    tracks: HiMDTrack[];
}

export interface HiMDSimplerGroup {
    title: string | null;
    indices: number[];
}

const HIMD_MP3_VAR_VERSION = 0x40;
const HIMD_MP3_VAR_LAYER = 0x20;
const HIMD_MP3_VAR_BITRATE = 0x10;
const HIMD_MP3_VAR_SRATE = 0x08;
const HIMD_MP3_VAR_CHMODE = 0x04;
const HIMD_MP3_VAR_PREEMPH = 0x02;

export function getTrackInfo(himd: HiMD, index: number): HiMDTrack {
    const track = himd.getTrack(himd.trackIndexToTrackSlot(index));
    const getStringOrNull = (idx: number) => (idx === 0 ? null : himd.getString(idx));
    if (track.firstFragment === 0) throw new HiMDError(`No such track: ${index}`);
    return {
        index,
        title: getStringOrNull(track.titleIndex),
        album: getStringOrNull(track.albumIndex),
        artist: getStringOrNull(track.artistIndex),
        encoding: getCodecName(track),
        bitrate: getKBPS(track),
        duration: track.seconds,
    };
}

export function getAllTracks(himd: HiMD): HiMDTrack[] {
    return Array(himd.getTrackCount())
        .fill(0)
        .map((_, i) => getTrackInfo(himd, i));
}

// Within himd-functions groups are 0-indexed.
// That is not the case in himd.ts, because group 0 is the disc title.

export function getGroups(himd: HiMD): HiMDGroup[] {
    const groups: HiMDGroup[] = [];
    const ungrouped: HiMDTrack[] = getAllTracks(himd);

    const rawGroups = Array(himd.getGroupCount())
        .fill(0)
        .map((_, i) => himd.getGroup(i + 1))
        .sort((a, b) => b.startTrackIndex - a.startTrackIndex);
    // Sort the array in reverse
    for (let group of rawGroups) {
        groups.push({
            groupIndex: group.groupIndex - 1, // himd-functions counts groups from 0, physical group 0 is reserved - convert.
            startIndex: group.startTrackIndex,
            title: group.titleIndex === 0 ? '' : himd.getString(group.titleIndex),
            tracks: ungrouped.splice(group.startTrackIndex, group.endTrackIndex - group.startTrackIndex),
        });
    }

    groups.push({
        title: null,
        startIndex: 0,
        tracks: ungrouped,
        groupIndex: -1,
    });

    return groups.reverse();
}

export function renameDisc(himd: HiMD, title: string | null) {
    renameGroup(himd, -1, title);
}

export function renameGroup(himd: HiMD, groupIndex: number, title: string | null) {
    const discTitleGroup = himd.getGroup(groupIndex + 1);
    if (discTitleGroup.titleIndex !== 0) {
        himd.removeString(discTitleGroup.titleIndex);
        discTitleGroup.titleIndex = 0;
    }
    if (title !== null) {
        discTitleGroup.titleIndex = himd.addString(title, HiMDStringType.GROUP);
    }
    himd.writeGroup(groupIndex + 1, discTitleGroup);
}

export function addGroup(himd: HiMD, title: string | null, start: number, length: number) {
    // Groups are indexed from 1.
    const stringIndex = title === null ? 0 : himd.addString(title, HiMDStringType.GROUP);
    let groupIndex;
    for(groupIndex = 1; groupIndex < himd.getGroupCount() + 1; groupIndex++) {
        if(himd.getGroup(groupIndex).startTrackIndex > start) {
            // Break. This is the created group's index.
            break;
        }
    }
    // Shift the groups up.
    for(let i = himd.getGroupCount() + 1; i > groupIndex; i--) {
        himd.writeGroup(i, himd.getGroup(i - 1));
    }
    const group: HiMDRawGroup = {
        startTrackIndex: start,
        endTrackIndex: start + length,
        titleIndex: stringIndex,
        groupIndex: groupIndex,
    };
    himd.writeGroup(groupIndex, group);
}

export function deleteGroup(himd: HiMD, index: number) {
    const groupCount = himd.getGroupCount();
    index += 1; // himd-js based group counting starts at 0, physical group 0 is reserved.
    himd.removeString(himd.getGroup(index).titleIndex);
    for (let i = index; i < groupCount; i++) {
        himd.writeGroup(i, himd.getGroup(i + 1));
    }
    himd.eraseGroup(groupCount);
}

export function moveTrack(himd: HiMD, from: number, to: number) {
    const tracks = Array(himd.getTrackCount())
        .fill(0)
        .map((_, i) => himd.trackIndexToTrackSlot(i));
    let [i] = tracks.splice(from, 1);
    tracks.splice(to, 0, i);
    tracks.forEach((v, i) => himd.writeTrackIndexToTrackSlot(i, v));
}

export function renameTrack(himd: HiMD, index: number, { title, album, artist }: { title?: string; album?: string; artist?: string }) {
    const track = himd.getTrack(himd.trackIndexToTrackSlot(index));
    const freeIfDefined = (e: number) => e !== 0 && himd.removeString(e);

    if (title !== undefined) {
        freeIfDefined(track.titleIndex);
        track.titleIndex = title.length > 0 ? himd.addString(title, HiMDStringType.TITLE) : 0;
    }
    if (album !== undefined) {
        freeIfDefined(track.albumIndex);
        track.albumIndex = album.length > 0 ? himd.addString(album, HiMDStringType.ALBUM) : 0;
    }
    if (artist !== undefined) {
        freeIfDefined(track.artistIndex);
        track.artistIndex = artist.length > 0 ? himd.addString(artist, HiMDStringType.ARTIST) : 0;
    }

    himd.writeTrack(himd.trackIndexToTrackSlot(index), track);
}

export type DumpingGenerator = AsyncGenerator<{ data: Uint8Array; total: number }>;

function getTotal({ blockStream }: { blockStream: HiMDBlockStream }) {
    return blockStream.fragments.reduce((a, b) => a + (b.lastBlock - b.firstBlock + 1), 0);
}

async function* dumpOMATrack(himd: HiMD, trackSlotNumber: number, externalDecryptor?: CryptoProvider): DumpingGenerator {
    const nonMP3Stream = await himd.openNonMP3Stream(trackSlotNumber);
    let block;

    let total = getTotal(nonMP3Stream);

    yield { data: createEA3Header(himd.getTrack(trackSlotNumber)), total };
    while ((block = await nonMP3Stream.readBlock(externalDecryptor)) !== null) {
        yield { data: block.block, total };
    }
}

async function* dumpMP3Track(himd: HiMD, trackSlotNumber: number): DumpingGenerator {
    const mp3Stream = await himd.openMP3Stream(trackSlotNumber);
    const rawTrack = himd.getTrack(trackSlotNumber);
    const getOrNone = (e: number) => (e === 0 ? undefined : himd.getString(e));
    let block;

    let total = getTotal(mp3Stream);

    // Write the ID3 tags
    const id3Tags = createID3({
        title: getOrNone(rawTrack.titleIndex),
        album: getOrNone(rawTrack.albumIndex),
        artist: getOrNone(rawTrack.artistIndex),
    });

    yield { data: new Uint8Array(id3Tags), total };

    while ((block = await mp3Stream.readBlock()) !== null) {
        yield { data: block.block, total };
    }
}

async function* dumpWAVTrack(himd: HiMD, trackSlotNumber: number, externalDecryptor?: CryptoProvider): DumpingGenerator {
    const nonMP3Stream = await himd.openNonMP3Stream(trackSlotNumber);
    let block;

    let total = getTotal(nonMP3Stream);

    yield { data: createLPCMHeader(total * BLOCK_SIZE), total };
    while ((block = await nonMP3Stream.readBlock(externalDecryptor)) !== null) {
        let blockContent = block.block;
        // Flip endianness of samples
        for (let i = 0; i < blockContent.length; i += 2) {
            let temp = blockContent[i];
            blockContent[i] = blockContent[i + 1];
            blockContent[i + 1] = temp;
        }
        yield { data: blockContent.subarray(0, blockContent.length), total };
    }
}

export function dumpTrack(
    himd: HiMD,
    trackSlotNumber: number,
    externalDecryptor?: CryptoProvider
): { data: DumpingGenerator; format: 'MP3' | 'WAV' | 'OMA' } {
    const track = himd.getTrack(trackSlotNumber);
    switch (getCodecName(track)) {
        case 'A3+':
        case 'AT3':
            return { format: 'OMA', data: dumpOMATrack(himd, trackSlotNumber, externalDecryptor) };
        case 'MP3':
            return { format: 'MP3', data: dumpMP3Track(himd, trackSlotNumber) };
        case 'PCM':
            return { format: 'WAV', data: dumpWAVTrack(himd, trackSlotNumber, externalDecryptor) };
    }
}

export function rewriteGroups(himd: HiMD, groups: HiMDSimplerGroup[]) {
    let groupCount = himd.getGroupCount();

    for (let i = 0; i < groupCount; i++) {
        deleteGroup(himd, i);
    }

    let alreadyGrouped: Set<number> = new Set();

    groups.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices));

    for (let group of groups) {
        const indices = [...group.indices].sort((a, b) => a - b);
        const start = indices[0];
        const end = indices[indices.length - 1];
        if (indices[indices.length - 1] - indices[0] !== indices.length - 1) {
            throw new HiMDError(`Cannot rewrite group ${start} - group is not sequential`);
        }
        if (indices.some(alreadyGrouped.has, alreadyGrouped)) {
            throw new HiMDError(`Cannot add a track to group - track already grouped!`);
        }
        const groupLength = end - start + 1;
        addGroup(himd, group.title, start, groupLength);
        indices.forEach(alreadyGrouped.add, alreadyGrouped);
    }
}

export async function uploadMP3Track(
    himd: HiMD,
    writeStream: HiMDWriteStream,
    mp3Data: ArrayBuffer,
    { title, album, artist }: { title?: string; album?: string; artist?: string },
    callback?: (object: { blockCount: number; frameNumber: number; byte: number; totalBytes: number }) => void
) {
    let frameCount = 0;
    let duration = 0;
    let mp3CodecInfo: Uint8Array = new Uint8Array(3);
    let contentId = new Uint8Array(20);
    contentId[0] = 2;
    contentId[1] = 3;
    contentId[2] = 0;
    contentId[3] = 0;
    // Create random content id
    contentId.set(createRandomBytes(20 - 4), 4);
    const freelistTrack = himd.getTrack(0);
    const newTrackIndex = freelistTrack.trackNumber;
    const key = getMP3EncryptionKey(himd, newTrackIndex);

    // Write the data here...
    let mpegVers = 3,
        mpegLayer = 1,
        mpegBitrate = 9,
        mpegSampleRate = 0,
        mpegChMode = 0,
        mpegPreemph = 0,
        flags = 0x80,
        firstTime = true;
    const view = new DataView(mp3Data);
    const findRootSection = (type: string) => readTags(view).filter((e: any) => e._section.type === type)[0];

    let frame = findRootSection('frame') as Header<FrameHeader>;
    let totalSamples = 0; // Used for duration calculation

    let bucket: {
        totalSize: number;
        nFrames: number;
        currentOffset: number;
        block: HiMDBlockInfo;
    } = null as any; // newBucket() is called immediately

    function newBucket() {
        bucket = {
            totalSize: 0,
            nFrames: 0,
            currentOffset: 0,
            block: {
                audioData: new Uint8Array(HIMD_AUDIO_SIZE).fill(0),
                backupKey: new Uint8Array(8).fill(0),
                backupMCode: 0,
                backupReserved: 0,
                backupSerialNumber: 0,
                backupType: new Uint8Array(4).fill(0),
                iv: new Uint8Array(8).fill(0),
                key: new Uint8Array(8).fill(0),
                lendata: 0,
                lo32ContentId: 0,
                mCode: 0,
                nFrames: 0,
                reserved1: 0,
                reserved2: new Uint8Array(4).fill(0),
                serialNumber: 0,
                type: new Uint8Array(4).fill(0),
            },
        };
    }

    let _blockNumber = 0;
    async function finalizeBlockInBucket() {
        const typeData = new Uint8Array([83, 77, 80, 65]); // "SMPA"
        bucket.block.type = typeData;
        bucket.block.nFrames = bucket.nFrames;
        bucket.block.mCode = 3;
        bucket.block.lendata = bucket.totalSize;
        bucket.block.reserved1 = 0;
        bucket.block.serialNumber = _blockNumber;
        bucket.block.backupSerialNumber = _blockNumber;
        bucket.block.backupType = typeData;
        bucket.block.backupReserved = 0;
        bucket.block.backupMCode = bucket.block.mCode;
        bucket.block.lo32ContentId = contentId[16] * 16777216 + contentId[17] * 65536 + contentId[18] * 256 + contentId[19];

        // Encrypt the block
        for (let i = 0; i < (bucket.totalSize & ~7); i++) {
            bucket.block.audioData[i] ^= key[i & 3];
        }
        await writeStream.writeAudioBlock(bucket.block);
        frameCount = bucket.nFrames;
    }

    function appendToBucket(data: Uint8Array) {
        if (bucket.totalSize + data.length >= HIMD_AUDIO_SIZE - 1) {
            if (bucket.totalSize === 0) {
                return 0;
            }
            return -1;
        }

        bucket.block.audioData.set(data, bucket.currentOffset);
        bucket.currentOffset += data.length;
        bucket.totalSize += data.length;
        bucket.nFrames += 1;

        return data.length;
    }

    newBucket();

    let totalFrames = 0;

    for (;;) {
        callback?.({
            blockCount: _blockNumber,
            byte: frame._section.offset,
            frameNumber: totalFrames,
            totalBytes: mp3Data.byteLength,
        });
        let blockMpegVersion = (view.getUint8(frame.header._section.offset + 1) >> 3) & 0x03, //binary(frame.header.mpegAudioVersionBits),
            blockMpegLayer = (view.getUint8(frame.header._section.offset + 1) >> 1) & 0x03, //binary(frame.header.layerDescriptionBits),
            blockMpegBitrate = (view.getUint8(frame.header._section.offset + 2) >> 4) & 0x0f, //binary(frame.header.bitrateBits),
            blockMpegSampleRate = (view.getUint8(frame.header._section.offset + 2) >> 2) & 0x03, //binary(frame.header.samplingRateBits),
            blockMpegChannelMode = (view.getUint8(frame.header._section.offset + 3) >> 6) & 0x03, //binary(frame.header.channelModeBits),
            blockMpegPreemph = view.getUint8(frame.header._section.offset + 3) & 0x03;
        totalSamples += frame._section.sampleLength!;
        if (firstTime) {
            mpegVers = blockMpegVersion;
            mpegLayer = blockMpegLayer;
            mpegBitrate = blockMpegBitrate;
            mpegSampleRate = blockMpegSampleRate;
            mpegChMode = blockMpegChannelMode;
            mpegPreemph = blockMpegPreemph;
            firstTime = false;
        } else {
            if (blockMpegVersion !== mpegVers) {
                flags |= HIMD_MP3_VAR_VERSION;
                mpegVers = Math.min(mpegVers, blockMpegVersion); /* smaller num -> higher version */
            }
            if (blockMpegLayer !== mpegLayer) {
                flags |= HIMD_MP3_VAR_LAYER;
                mpegLayer = Math.min(mpegLayer, blockMpegLayer); /* smaller num -> higher layer */
            }
            if (blockMpegBitrate !== mpegBitrate) {
                /* TODO: check whether "free-form" streams need special handling */
                flags |= HIMD_MP3_VAR_BITRATE;
                mpegBitrate = Math.max(mpegBitrate, blockMpegBitrate);
            }
            if (blockMpegSampleRate !== mpegSampleRate) {
                flags |= HIMD_MP3_VAR_SRATE;
                /* "1" is highest (48), "0" is medium (44), "2" is lowest (32) */
                if (mpegSampleRate !== 1) {
                    if (blockMpegSampleRate === 1) mpegSampleRate = blockMpegSampleRate;
                    else mpegSampleRate = Math.min(mpegSampleRate, blockMpegSampleRate);
                }
            }
            if (blockMpegChannelMode !== mpegChMode) {
                /* TODO: find out how to choose "maximal" mode */
                flags |= HIMD_MP3_VAR_CHMODE;
            }
            if (blockMpegPreemph !== mpegPreemph) {
                /* TODO: find out how to choose "maximal" preemphasis */
                flags |= HIMD_MP3_VAR_PREEMPH;
            }
        }

        // Append frames to block
        let frameRaw = new Uint8Array(mp3Data.slice(frame._section.offset, frame._section.offset + frame._section.byteLength));
        let bytesAdded = appendToBucket(frameRaw);
        if (bytesAdded < 0) {
            await finalizeBlockInBucket();
            newBucket();
            bytesAdded = appendToBucket(frameRaw);
            if (bytesAdded < 0) {
                throw new HiMDError("This shouldn't happen!");
            }
            ++_blockNumber;
        } else if (bytesAdded === 0) {
            newBucket();
        }
        ++totalFrames;
        let nextFrameIndex = frame._section.nextFrameIndex!;
        if (!nextFrameIndex) break;
        frame = readFrame(view, nextFrameIndex)!;
        if (frame === null) break;
    }

    if (bucket.nFrames !== 0) {
        // The last bucket
        await finalizeBlockInBucket();
        ++_blockNumber;
    }

    callback?.({
        blockCount: _blockNumber,
        byte: mp3Data.byteLength,
        frameNumber: totalFrames,
        totalBytes: mp3Data.byteLength,
    });

    mp3CodecInfo[0] = flags;
    mp3CodecInfo[1] = (mpegVers << 6) | (mpegLayer << 4) | mpegBitrate;
    mp3CodecInfo[2] = (mpegSampleRate << 6) | (mpegChMode << 4) | (mpegPreemph << 2);

    duration = totalSamples / [44100, 48000, 32000][mpegSampleRate];

    const { firstBlock, lastBlock } = await writeStream.close();
    const fragment: HiMDFragment = {
        firstBlock,
        lastBlock,
        firstFrame: 0,
        lastFrame: frameCount,
        fragmentType: 0,
        nextFragment: 0,
        key: new Uint8Array(8).fill(0),
    };
    const fragmentIndex = himd.addFragment(fragment);

    let idxTitle = 0,
        idxAlbum = 0,
        idxArtist = 0;
    if (title) idxTitle = himd.addString(title, HiMDStringType.TITLE);
    if (album) idxAlbum = himd.addString(album, HiMDStringType.ALBUM);
    if (artist) idxArtist = himd.addString(artist, HiMDStringType.ARTIST);

    const track: HiMDRawTrack = {
        albumIndex: idxAlbum,
        artistIndex: idxArtist,
        titleIndex: idxTitle,
        trackNumber: 1,
        firstFragment: fragmentIndex,
        ekbNumber: 0,
        trackInAlbum: 1,
        seconds: duration,

        codecInfo: new Uint8Array([3, 0, ...mp3CodecInfo]),
        codecId: HiMDCodec.ATRAC3PLUS_OR_MPEG,

        mac: new Uint8Array(8).fill(0),
        contentId,

        recordingTime: DOSTIME_NULL,
        licenseEndTime: DOSTIME_NULL,
        licenseStartTime: DOSTIME_NULL,

        lt: 0x10,
        dest: 1,
        xcc: 1,
        ct: 0,
        cc: 0x40,
        cn: 0,
        key: new Uint8Array(8).fill(0),
    };

    const slot = himd.addTrack(track);
    track.trackNumber = slot;
    himd.writeTrackIndexToTrackSlot(himd.getTrackCount(), slot);
    himd.writeTrackCount(himd.getTrackCount() + 1);

    await himd.flush();
}

export async function uploadMacDependent(
    himd: HiMD,
    session: HiMDSecureSession,
    writeStream: HiMDWriteStream,
    rawData: ArrayBuffer,
    codecInfo: CodecInfo,
    { title, album, artist }: { title?: string; album?: string; artist?: string },
    callback?: (object: { byte: number; totalBytes: number }) => void,
    cryptoProvider?: CryptoProvider
) {
    // Register one fragment, create a key for it
    const bytesPerFrame = getBytesPerFrame(codecInfo);
    let currentInputByte = 0;
    let i = 0;

    const typeString = {
        MP3: null,
        AT3: 'A3D ',
        'A3+': 'ATX ',
        PCM: 'LPCM',
    }[getCodecName(codecInfo)];
    if (!typeString) throw new Error('MP3 audio cannot be uploaded as a Mac-Dependent audio file');
    const type = new TextEncoder().encode(typeString);
    const mCode = typeString === 'LPCM' ? 0x0124 : 3;

    const slot = himd.getNextFreeTrackSlot();

    const trackData: HiMDRawTrack = {
        albumIndex: 0,
        artistIndex: 0,
        titleIndex: 0,
        trackNumber: slot,
        firstFragment: 0,
        ekbNumber: 0x00010012,
        cc: 68,
        cn: 0,
        ct: 0,
        dest: 0,
        lt: 1,
        xcc: 1,
        key: new Uint8Array(),
        mac: new Uint8Array(),
        contentId: new Uint8Array(),
        licenseEndTime: DOSTIME_NULL,
        licenseStartTime: DOSTIME_NULL,
        seconds: getSeconds(codecInfo, Math.ceil(rawData.byteLength / bytesPerFrame)),
        recordingTime: DOSTIME_NULL,
        trackInAlbum: 0,
        ...codecInfo,
    };

    const cryptoSignedData = await session.createAndSignNewTrack(trackData);


    const keyForFragment = createRandomBytes();
    writeStream.setKeys(cryptoSignedData.trackKey, keyForFragment);

    let lastFrameInFragment = 0;

    callback?.({ byte: 0, totalBytes: rawData.byteLength });

    while (currentInputByte < rawData.byteLength) {
        let bytesInThisBlock = Math.min(HIMD_AUDIO_SIZE - (typeString === 'LPCM' ? 0 : 1), rawData.byteLength - currentInputByte);
        const framesInThisBlock = Math.floor(bytesInThisBlock / bytesPerFrame);
        if (framesInThisBlock === 0) break;
        bytesInThisBlock = framesInThisBlock * bytesPerFrame;

        const keyForBlock = createRandomBytes();
        const audioData = new Uint8Array(rawData.slice(currentInputByte, currentInputByte + bytesInThisBlock));

        lastFrameInFragment = framesInThisBlock - 1;

        let audioBlock: HiMDBlockInfo = {
            audioData: audioData,
            backupKey: keyForBlock,
            backupMCode: mCode,
            backupReserved: 0,
            backupSerialNumber: i,
            backupType: type,
            iv: new Uint8Array(8).fill(0),
            key: keyForBlock,
            lendata: 0,
            lo32ContentId: getUint32(cryptoSignedData.contentId, 16),
            mCode,
            nFrames: 0,
            reserved1: 0,
            reserved2: new Uint8Array(4).fill(0),
            serialNumber: i,
            type,
        };
        await writeStream.writeAndEncryptAudioBlock(audioBlock, cryptoProvider);
        i++;
        currentInputByte += bytesInThisBlock;
        callback?.({ byte: currentInputByte, totalBytes: rawData.byteLength });
    }

    const { firstBlock, lastBlock } = await writeStream.close();

    // Create a new fragment
    const fragment: HiMDFragment = {
        firstBlock,
        lastBlock,
        key: keyForFragment,
        nextFragment: 0,
        fragmentType: 0,
        firstFrame: 0,
        lastFrame: Math.max(0, lastFrameInFragment),
    };

    const fragmentIndex = himd.addFragment(fragment);

    // Create a new track
    trackData.firstFragment = himd.addFragment(fragment);

    // Create a new track
    if (title) trackData.titleIndex = himd.addString(title, HiMDStringType.TITLE);
    if (album) trackData.albumIndex = himd.addString(album, HiMDStringType.ALBUM);
    if (artist) trackData.artistIndex = himd.addString(artist, HiMDStringType.ARTIST);

    const newTrackSlot = himd.addTrack(trackData);
    himd.writeTrackIndexToTrackSlot(himd.getTrackCount(), newTrackSlot);
    himd.writeTrackCount(himd.getTrackCount() + 1);

    await himd.flush();
}

export async function uploadStreamingMacDependent(
    himd: HiMD,
    session: HiMDSecureSession,
    writeStream: HiMDWriteStream,
    rawData: ArrayBuffer,
    codecInfo: CodecInfo,
    { title, album, artist }: { title?: string; album?: string; artist?: string },
    streamingCryptoProvider: CryptoBlockProvider,
    encCallback?: (object: { totalBytes: number; encryptedBytes: number; }) => void,
    writeCallback?: (object: { writtenBytes: number; totalBytes: number }) => void,
) {
    // Register one fragment, create a key for it
    const bytesPerFrame = getBytesPerFrame(codecInfo);

    const typeString = {
        MP3: null,
        AT3: 'A3D ',
        'A3+': 'ATX ',
        PCM: 'LPCM',
    }[getCodecName(codecInfo)];
    if (!typeString) throw new Error('MP3 audio cannot be uploaded as a Mac-Dependent audio file');
    const type = new TextEncoder().encode(typeString);
    const mCode = typeString === 'LPCM' ? 0x0124 : 3;

    const slot = himd.getNextFreeTrackSlot();

    const trackData: HiMDRawTrack = {
        albumIndex: 0,
        artistIndex: 0,
        titleIndex: 0,
        trackNumber: slot,
        firstFragment: 0,
        ekbNumber: 0x00010012,
        cc: 68,
        cn: 0,
        ct: 0,
        dest: 0,
        lt: 1,
        xcc: 1,
        key: new Uint8Array(),
        mac: new Uint8Array(),
        contentId: new Uint8Array(),
        licenseEndTime: DOSTIME_NULL,
        licenseStartTime: DOSTIME_NULL,
        seconds: getSeconds(codecInfo, Math.ceil(rawData.byteLength / bytesPerFrame)),
        recordingTime: DOSTIME_NULL,
        trackInAlbum: 0,
        ...codecInfo,
    };

    const cryptoSignedData = await session.createAndSignNewTrack(trackData);

    const keyForFragment = createRandomBytes();
    writeStream.setKeys(cryptoSignedData.trackKey, keyForFragment);

    let lastFrameInFragment = 0;

    writeCallback?.({ writtenBytes: 0, totalBytes: rawData.byteLength });

    const generator = streamingCryptoProvider.process({
        rawData,
        bytesPerFrame,
        fragmentKey: keyForFragment,
        lo32ContentId: getUint32(cryptoSignedData.contentId, 16),
        maxBytesInBlock: HIMD_AUDIO_SIZE - (typeString === 'LPCM' ? 0 : 1),
        mCode,
        trackKey: cryptoSignedData.trackKey,
        type
    }, encCallback);

    let bytes = 0;
    for await(let { block, lastFrameInFragment: _lastFrameInFragment } of generator) {
        lastFrameInFragment = _lastFrameInFragment;
        await writeStream.writeAudioBlock(block);
        bytes += block.audioData.length;
        writeCallback?.({ writtenBytes: bytes, totalBytes: rawData.byteLength });
    }

    const { firstBlock, lastBlock } = await writeStream.close();

    // Create a new fragment
    const fragment: HiMDFragment = {
        firstBlock,
        lastBlock,
        key: keyForFragment,
        nextFragment: 0,
        fragmentType: 0,
        firstFrame: 0,
        lastFrame: Math.max(0, lastFrameInFragment),
    };

    trackData.firstFragment = himd.addFragment(fragment);

    // Create a new track
    if (title) trackData.titleIndex = himd.addString(title, HiMDStringType.TITLE);
    if (album) trackData.albumIndex = himd.addString(album, HiMDStringType.ALBUM);
    if (artist) trackData.artistIndex = himd.addString(artist, HiMDStringType.ARTIST);

    const newTrackSlot = himd.addTrack(trackData);
    himd.writeTrackIndexToTrackSlot(himd.getTrackCount(), newTrackSlot);
    himd.writeTrackCount(himd.getTrackCount() + 1);

    await himd.flush();
}

export async function deleteTracks(himd: HiMD, tracksToDelete: number[]) {
    // AFTER INVOKING THIS THE MACLIST NEEDS TO BE UPDATED AND RESIGNED!
    /*
        const session = new UMSCHiMDSession(this.fsDriver!.driver, this.himd!);
        await session.performAuthentication();
        for(let trackSlot of allTrackSlots) {
            session.allMacs!.set(new Uint8Array(8).fill(0), (trackSlot - 1) * 8);
        }
        await session.finalizeSession();
    */

    if(!himd.filesystem.freeFileRegions) {
        throw new HiMDError("Track deletion is not supported by this driver.");
    }

    const blocksToFree: { firstBlock: number, length: number }[] = [];
    tracksToDelete.sort((a, b) => b - a);
    for(let trackListIndex of tracksToDelete){
        const trackIndex = himd.trackIndexToTrackSlot(trackListIndex);
        const track = himd.getTrack(trackIndex);
        let fragment = track.firstFragment;
        const fragmentChain: HiMDFragment[] = [];
        // Traverse the fragment chain, and delete each one
        while(fragment !== 0) {
            const fragmentObject = himd.getFragment(fragment);
            fragmentChain.push(fragmentObject);
            const block = {
                firstBlock: fragmentObject.firstBlock,
                length: fragmentObject.lastBlock - fragmentObject.firstBlock + 1,
            };

            // Block is 16kBytes
            // Cluster is 32kBytes.
            // One or two blocks can't be freed... max 32k lost lost per track

            if((block.firstBlock % 2) === 1) {
                block.firstBlock++;
                block.length--;
            }
            if((block.length % 2) === 1) {
                block.length--;
            }
            blocksToFree.push(block);
            const nextFragment = fragmentObject.nextFragment;
            himd.removeFragment(fragment);
            fragment = nextFragment;
        }
        // Delete the track
        if(track.albumIndex) himd.removeString(track.albumIndex);
        if(track.artistIndex) himd.removeString(track.artistIndex);
        if(track.titleIndex) himd.removeString(track.titleIndex);
        himd.removeTrack(trackIndex);
        // Update the track index => track slot table
        for(let i = trackListIndex; i < himd.getTrackCount()-1; i++){
            himd.writeTrackIndexToTrackSlot(i, himd.trackIndexToTrackSlot(i + 1));
        }
        himd.writeTrackIndexToTrackSlot(himd.getTrackCount() - 1, 0);
        himd.writeTrackCount(himd.getTrackCount() - 1);
    }

    // Traverse all other tracks, to update the block positions.
    for(let i = 0; i<himd.getTrackCount(); i++) {
        let frag = himd.getTrack(himd.trackIndexToTrackSlot(i)).firstFragment;
        while(frag !== 0) {
            let fragObject = himd.getFragment(frag);
            let anyHit = false;
            for(let { firstBlock: firstBlockToFree, length: lengthToFree } of blocksToFree){
                if(fragObject.firstBlock > firstBlockToFree){
                    fragObject.firstBlock -= lengthToFree;
                    fragObject.lastBlock -= lengthToFree;
                    anyHit = true;
                }
            }
            if(anyHit){
                himd.writeFragment(frag, fragObject);
            }
            frag = fragObject.nextFragment;
        }
    }

    await himd.filesystem.freeFileRegions(himd.getDatanumDependentName("ATDATA"), blocksToFree.map(e => ({startByte: e.firstBlock * BLOCK_SIZE, length: e.length * BLOCK_SIZE})));
    await himd.flush();
}
