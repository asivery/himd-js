import { assert, concatUint8Arrays, getUint16, getUint32, padStartUint8Array, setUint16, setUint32 } from './utils';
import { HiMDFilesystem } from './filesystem/himd-filesystem';
import { getBytesPerFrame, HiMDCodec } from './codecs';
import iconv from 'iconv-lite';
import { getFramesPerBlock } from './trackinfo';
import { HiMDBlockStream, HiMDMP3Stream, HiMDNonMP3Stream, HiMDWriteStream } from './streams';
import { createTrackKey, getMP3EncryptionKey, initCrypto } from './encryption';
import jconv from 'jconv';

function encode(encoding: HiMDStringEncoding, content: string): Uint8Array | null {
    // iconv writes incorrect sjis
    if (encoding === HiMDStringEncoding.SHIFT_JIS) {
        return jconv.encode(content, 'sjis');
    }
    const map = {
        [HiMDStringEncoding.LATIN1]: 'latin1',
        [HiMDStringEncoding.UTF16BE]: 'utf16be',
    };
    const encodingName = map[encoding];
    const encoder = iconv.getEncoder(encodingName);
    try {
        return new Uint8Array(encoder.write(content));
    } catch (ex) {
        return null;
    }
}

function decode(encoding: HiMDStringEncoding, bfr: Buffer): string {
    let str;
    switch (encoding) {
        case HiMDStringEncoding.LATIN1:
            str = iconv.decode(bfr, 'latin1');
            break;
        case HiMDStringEncoding.SHIFT_JIS:
            str = iconv.decode(bfr, 'sjis');
            break;
        case HiMDStringEncoding.UTF16BE:
            str = iconv.decode(bfr, 'utf16-be');
            break;
        default:
            throw new HiMDError(`Invalid encoding ${encoding}`);
    }
    if (str.includes('\x00')) str = str.substring(0, str.indexOf('\x00'));
    return str;
}

export const HIMD_NO_GROUP: HiMDRawGroup = Object.freeze({
    startTrackIndex: -1,
    endTrackIndex: 0,
    titleIndex: 0,
    groupIndex: -2,
});

export class HiMDError extends Error {
    constructor(m: string) {
        super(m);
        Object.setPrototypeOf(this, HiMDError.prototype);
    }
}
export interface HiMDString {
    content: Uint8Array;
    type: HiMDStringType;
    link: number;
}

export enum HiMDStringType {
    UNUSED = 0x0,
    CONTINUATION = 0x1,
    TITLE = 0x8,
    ARTIST = 0x9,
    ALBUM = 0xa,
    GROUP = 0xc,
}

export enum HiMDStringEncoding {
    LATIN1 = 0x05,
    UTF16BE = 0x84,
    SHIFT_JIS = 0x90,
}

export interface DOSTime {
    second: number;
    minute: number;
    hour: number;
    day: number;
    month: number;
    year: number;
}

export interface HiMDStringChunk {
    content: Uint8Array;
    link: number;
    type: HiMDStringType;
}

export const DevicesIds: { vendorId: number, deviceId: number, name: string }[] = [
    { vendorId: 0x5341, deviceId: 0x5256, name: 'Exploit-Unrestricted'},

    { vendorId: 0x054c, deviceId: 0x017f, name: 'Sony MZ-NH1' },
    { vendorId: 0x054c, deviceId: 0x0181, name: 'Sony MZ-NH3D' },
    { vendorId: 0x054c, deviceId: 0x0183, name: 'Sony MZ-NH900' },
    { vendorId: 0x054c, deviceId: 0x0185, name: 'Sony MZ-NH700' },
    { vendorId: 0x054c, deviceId: 0x0187, name: 'Sony MZ-NH600' },
    { vendorId: 0x054c, deviceId: 0x018b, name: 'Sony LAM' },
    { vendorId: 0x054c, deviceId: 0x01ea, name: 'Sony MZ-DH10P' },
    { vendorId: 0x054c, deviceId: 0x021a, name: 'Sony MZ-RH10' },
    { vendorId: 0x054c, deviceId: 0x021c, name: 'Sony MZ-RH910' },
    { vendorId: 0x054c, deviceId: 0x022d, name: 'Sony CMT-AH10' },
    { vendorId: 0x054c, deviceId: 0x023d, name: 'Sony DS-HMD1' },
    { vendorId: 0x054c, deviceId: 0x0287, name: 'Sony MZ-RH1' },
];

export const DOSTIME_NULL = parseDOSTime(new Uint8Array(4).fill(0));

export function parseDOSTime(raw: Uint8Array, offset: number = 0): DOSTime {
    const time = getUint16(raw, 2 + offset);
    const date = getUint16(raw, 0 + offset);

    return {
        second: (time & 0x1f) * 2,
        minute: (time & 0x7e0) >> 5,
        hour: (time & 0xf100) >> 11,
        day: date & 0x1f,
        month: ((date & 0x1e0) >> 5) - 1,
        year: ((date & 0xfe00) >> 9) + 80,
    };
}

export function serializeDosTime(parsed: DOSTime) {
    const date = parsed.day | ((parsed.month + 1) << 5) | ((parsed.year - 80) << 9);
    const time = (parsed.second / 2) | (parsed.minute << 5) | (parsed.hour << 11);

    const buffer = new Uint8Array(4);
    setUint16(buffer, date, 0);
    setUint16(buffer, time, 2);
    return buffer;
}

export interface HiMDRawTrack {
    recordingTime: DOSTime;

    ekbNumber: number;
    titleIndex: number;
    artistIndex: number;
    albumIndex: number;
    trackInAlbum: number;

    key: Uint8Array;
    mac: Uint8Array;

    codecId: HiMDCodec;
    codecInfo: Uint8Array;
    firstFragment: number;
    trackNumber: number;
    seconds: number;

    lt: number;
    dest: number;

    contentId: Uint8Array;
    licenseStartTime: DOSTime;
    licenseEndTime: DOSTime;

    xcc: number;
    ct: number;
    cc: number;
    cn: number;
}

export interface HiMDFragment {
    key: Uint8Array;
    firstBlock: number;
    lastBlock: number;
    firstFrame: number;
    lastFrame: number;
    fragmentType: number;
    nextFragment: number;
}

export interface HiMDRawGroup {
    groupIndex: number;
    startTrackIndex: number;
    endTrackIndex: number;
    titleIndex: number;
}

export interface HiMDBlockInfo {
    type: Uint8Array; // "LPCM" or "A3D " or "ATX" or "SMPA"
    nFrames: number;
    mCode: number;
    lendata: number;
    reserved1: number;
    serialNumber: number;
    key: Uint8Array;
    iv: Uint8Array;
    audioData: Uint8Array;
    backupKey: Uint8Array;
    reserved2: Uint8Array;
    backupType: Uint8Array;
    backupReserved: number;
    backupMCode: number;
    lo32ContentId: number;
    backupSerialNumber: number;
}

function dirty(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const old = descriptor.value as (...args: any) => any;
    descriptor.value = function (...args: any) {
        (this as any).dirty = true;
        return old.apply(this, args);
    };
    return descriptor;
}

export class HiMD {
    protected datanum?: number;
    protected tifData?: Uint8Array;
    protected discId?: Uint8Array;
    protected dirty: boolean = false;

    protected constructor(public filesystem: HiMDFilesystem) {}
    static async init(filesystem: HiMDFilesystem) {
        await initCrypto();

        const himd = new HiMD(filesystem);

        await himd.reload();

        return himd;
    }

    public async reload(){
        await this.findDatanum();
        await this.loadTifdata();
        await this.readDiscId();
    }

    public getDeviceName(){
        return this.filesystem.getName();
    }

    public async wipe(reinitializeFS: boolean = false){
        await this.filesystem.wipeDisc(reinitializeFS);
        await this.reload();
        this.dirty = false;
    }

    protected async findDatanum() {
        let maxDatanum = -1;
        for (let { name, type } of await this.filesystem.list('/HMDHIFI')) {
            const match = name.match(/(.*)atdata([0-9a-f]{2})\.hma$/i);
            if (match === null || type === 'directory') continue;
            const datanum = parseInt(match[2], 16);
            if (maxDatanum !== -1) console.log('[HiMD]: Found more than one data root file. This should not happen.');
            maxDatanum = datanum;
        }
        if (maxDatanum == -1) throw new HiMDError('Cannot find the track index file');

        this.datanum = maxDatanum;
    }

    public getDatanumDependentName(name: string, datanum = this.datanum!) {
        return `/HMDHIFI/${name}${datanum.toString(16).padStart(2, '0').toUpperCase()}.HMA`;
    }

    protected async openDatanumDependent(name: string, mode?: 'rw' | 'ro') {
        return this.filesystem.open(this.getDatanumDependentName(name), mode);
    }

    protected async openTifFile(mode?: 'rw' | 'ro') {
        return this.openDatanumDependent('trkidx', mode);
    }

    protected async loadTifdata() {
        const entry = await this.openTifFile();
        this.tifData = await entry.read();
        await entry.close();

        const magic = this.tifData!.subarray(0, 4);
        const validMagic = new TextEncoder().encode('TIF ');

        if (!magic.every((a, i) => a === validMagic[i]) || this.tifData.length !== 0x50000)
            throw new HiMDError('Invalid TRKIDX...HMA file');
    }

    protected getSubarray(start: number, length: number) {
        return this.tifData!.subarray(start, start + length);
    }

    async flush() {
        if (!this.dirty) {
            return;
        }
        const tif = await this.openTifFile('rw');
        await tif.seek(0);
        await tif.write(this.tifData!);
        await tif.close();
        this.dirty = false;
    }

    @dirty addFragment(fragment: HiMDFragment) {
        const freelistFragment = this.getFragment(0);
        let newFragmentIndex = freelistFragment.nextFragment;
        let newFragment = this.getFragment(newFragmentIndex);
        freelistFragment.nextFragment = newFragment.nextFragment;
        this.writeFragment(0, freelistFragment);
        this.writeFragment(newFragmentIndex, fragment);
        return newFragmentIndex;
    }

    @dirty removeFragment(fragmentIndex: number) {
        const freelistFragment = this.getFragment(0);
        const fragmentToFree = this.getFragment(fragmentIndex);
        fragmentToFree.nextFragment = freelistFragment.nextFragment;
        freelistFragment.nextFragment = fragmentIndex;
        this.writeFragment(0, freelistFragment);
        // The fragment needs to be completely zeroed out, otherwise HiMD device crashes with 'CAN'T PLAY'
        const raw = this.getSubarray(0x30000 + 0x10 * fragmentIndex, 0x10);
        raw.fill(0);
        setUint16(raw, fragmentToFree.nextFragment & 0xfff, 14);
    }

    @dirty writeFragment(index: number, fragment: HiMDFragment) {
        const raw = this.getSubarray(0x30000 + 0x10 * index, 0x10);
        raw.set(fragment.key, 0);
        setUint16(raw, fragment.firstBlock, 8);
        setUint16(raw, fragment.lastBlock, 10);
        raw[12] = fragment.firstFrame;
        raw[13] = fragment.lastFrame;
        let temp = fragment.fragmentType << 12;
        temp |= fragment.nextFragment & 0xfff;
        setUint16(raw, temp, 14);
    }

    getFragment(index: number): HiMDFragment {
        const raw = this.getSubarray(0x30000 + 0x10 * index, 0x10);
        return {
            key: raw.slice(0, 8),
            firstBlock: getUint16(raw, 8),
            lastBlock: getUint16(raw, 10),
            firstFrame: raw[12],
            lastFrame: raw[13],
            fragmentType: raw[14] >> 4,
            nextFragment: getUint16(raw, 14) & 0xfff,
        };
    }

    getStringChunk(index: number): HiMDStringChunk {
        const rawBuffer = this.getSubarray(0x40000 + 0x10 * index, 0x10);
        const flags = getUint16(rawBuffer, 14);

        const link = flags & 0xfff;
        const type = (flags >> 12) as HiMDStringType;
        return {
            content: rawBuffer.slice(0, 14),
            link,
            type,
        };
    }

    @dirty writeStringChunk(index: number, chunk: HiMDStringChunk) {
        assert(chunk.content.length === 14, 'String chunk content must be equal to 14');

        const rawBuffer = this.getSubarray(0x40000 + 0x10 * index, 0x10);
        const flags = (chunk.link & 0xfff) | (chunk.type << 12);
        setUint16(rawBuffer, flags, 14);
        chunk.content.forEach((e, i) => (rawBuffer[i] = e));
    }

    trackIndexToTrackSlot(index: number) {
        return getUint16(this.tifData!, 0x102 + 2 * index);
    }

    @dirty writeTrackIndexToTrackSlot(index: number, slot: number) {
        setUint16(this.tifData!, slot, 0x102 + 2 * index);
    }

    getRawString(rootIndex: number) {
        const rootString = this.getStringChunk(rootIndex);
        if (rootString.type < 0x8) throw new HiMDError('Root fragment is not a valid root');
        const stringPieces: Uint8Array[] = [];
        let piece = rootString;
        for (;;) {
            stringPieces.push(piece.content);
            if (piece.link === 0) break;
            piece = this.getStringChunk(piece.link);
        }
        return concatUint8Arrays(stringPieces);
    }

    getString(index: number) {
        let raw = this.getRawString(index);
        const encoding = raw[0] as HiMDStringEncoding;
        const bfr = Buffer.from(raw.slice(1));

        return decode(encoding, bfr);
    }

    // IMPORTANT: Groups start with 1 - group 0 = disc title
    getGroup(groupIndex: number): HiMDRawGroup {
        const rawBuffer = this.getSubarray(0x2100 + 0x8 * groupIndex, 0x8);
        return {
            groupIndex,
            startTrackIndex: getUint16(rawBuffer, 0) - 1,
            endTrackIndex: getUint16(rawBuffer, 2),
            titleIndex: getUint16(rawBuffer, 4),
        };
    }

    @dirty writeGroup(groupIndex: number, group: HiMDRawGroup) {
        const rawBuffer = this.getSubarray(0x2100 + 0x8 * groupIndex, 0x8);
        setUint16(rawBuffer, group.startTrackIndex + 1, 0);
        setUint16(rawBuffer, group.endTrackIndex, 2);
        setUint16(rawBuffer, group.titleIndex, 4);
        rawBuffer[6] = group.groupIndex === -1 ? 0 : 0x10;
    }

    getDiscTitle(): string | null {
        const rootGroup = this.getGroup(0);
        return rootGroup.titleIndex === 0 ? null : this.getString(rootGroup.titleIndex);
    }

    getTrack(trackSlotIndex: number): HiMDRawTrack {
        assert(trackSlotIndex >= 0 && trackSlotIndex <= 2047);

        const rawBuffer = this.getSubarray(0x8000 + 0x50 * trackSlotIndex, 0x50);
        return {
            recordingTime: parseDOSTime(rawBuffer, 0),
            ekbNumber: getUint32(rawBuffer, 4),
            titleIndex: getUint16(rawBuffer, 8),
            artistIndex: getUint16(rawBuffer, 10),
            albumIndex: getUint16(rawBuffer, 12),
            trackInAlbum: rawBuffer[14],
            key: rawBuffer.slice(16, 16 + 8),
            mac: rawBuffer.slice(24, 24 + 8),
            codecId: rawBuffer[32] as HiMDCodec,
            codecInfo: new Uint8Array([...rawBuffer.slice(33, 33 + 3), ...rawBuffer.slice(44, 44 + 2)]),
            firstFragment: getUint16(rawBuffer, 36),
            trackNumber: getUint16(rawBuffer, 38),
            seconds: getUint16(rawBuffer, 40),
            lt: rawBuffer[42],
            dest: rawBuffer[43],
            contentId: rawBuffer.slice(48, 48 + 20),
            licenseStartTime: parseDOSTime(rawBuffer, 68),
            licenseEndTime: parseDOSTime(rawBuffer, 72),
            xcc: rawBuffer[76],
            ct: rawBuffer[77],
            cc: rawBuffer[78],
            cn: rawBuffer[79],
        };
    }

    getNextFreeTrackSlot() {
        const freelistTrack = this.getTrack(0);
        const newTrackIndex = freelistTrack.trackNumber;
        return newTrackIndex;
    }

    @dirty addTrack(track: HiMDRawTrack) {
        const freelistTrack = this.getTrack(0);
        const newTrackIndex = freelistTrack.trackNumber;
        const freeTrackObject = this.getTrack(newTrackIndex);
        freelistTrack.trackNumber = freeTrackObject.trackNumber;
        track.trackNumber = newTrackIndex;

        this.writeTrack(0, freelistTrack);
        this.writeTrack(newTrackIndex, track);

        return newTrackIndex;
    }

    @dirty removeTrack(trackIndex: number) {
        const freelistTrack = this.getTrack(0);
        const trackToFree = this.getTrack(trackIndex);
        trackToFree.trackNumber = freelistTrack.trackNumber;
        freelistTrack.trackNumber = trackIndex;
        this.writeTrack(0, freelistTrack);
        // The track needs to be completely zeroed out, otherwise HiMD device crashes with 'CAN'T PLAY'
        const rawBuffer = this.getSubarray(0x8000 + 0x50 * trackIndex, 0x50);
        rawBuffer.fill(0);
        setUint16(rawBuffer, trackToFree.firstFragment, 38);
    }

    @dirty writeTrack(trackSlotIndex: number, track: HiMDRawTrack, writeTo?: Uint8Array) {
        assert(trackSlotIndex >= 0 && trackSlotIndex <= 2047);

        const rawBuffer = writeTo ?? this.getSubarray(0x8000 + 0x50 * trackSlotIndex, 0x50);
        rawBuffer.set(serializeDosTime(track.recordingTime), 0);
        setUint32(rawBuffer, track.ekbNumber, 4);
        setUint16(rawBuffer, track.titleIndex, 8);
        setUint16(rawBuffer, track.artistIndex, 10);
        setUint16(rawBuffer, track.albumIndex, 12);
        rawBuffer[14] = track.trackInAlbum;

        rawBuffer.set(track.key, 16);
        rawBuffer.set(track.mac, 24);
        rawBuffer[32] = track.codecId;

        rawBuffer.set(track.codecInfo.subarray(0, 3), 33);
        rawBuffer.set(track.codecInfo.subarray(3, 5), 44);

        setUint16(rawBuffer, track.firstFragment, 36);
        setUint16(rawBuffer, track.trackNumber, 38);
        setUint16(rawBuffer, track.seconds, 40);

        rawBuffer.set(track.contentId, 48);

        // DRM stuff
        rawBuffer.set(serializeDosTime(track.licenseStartTime), 68);
        rawBuffer.set(serializeDosTime(track.licenseEndTime), 72);
        rawBuffer[42] = track.lt;
        rawBuffer[43] = track.dest;
        rawBuffer[76] = track.xcc;
        rawBuffer[77] = track.ct;
        rawBuffer[78] = track.cc;
        rawBuffer[79] = track.cn;
    }

    getTrackCount() {
        return getUint16(this.tifData!, 0x100);
    }

    @dirty writeTrackCount(number: number) {
        setUint16(this.tifData!, number, 0x100);
    }

    getGroupCount() {
        for (let i = 1; i < 256; i++) {
            let group = this.getGroup(i);
            if (group.endTrackIndex === 0 && group.startTrackIndex === -1 && group.titleIndex === 0) {
                // Group doesn't exist
                return i - 1;
            }
        }
        return 256;
    }

    @dirty eraseGroup(index: number) {
        this.writeGroup(index, HIMD_NO_GROUP);
    }

    @dirty removeString(index: number) {
        if (index === 0) return;
        const freelist = this.getStringChunk(0);

        // Freelist points to the next free chunk
        const nextFreeChunk = freelist.link;

        // Insert the current string into the beginning of the freelist
        freelist.link = index;

        this.writeStringChunk(0, freelist);

        while (index !== 0) {
            const chunk = this.getStringChunk(index);
            chunk.content.fill(0);
            chunk.type = HiMDStringType.UNUSED;
            if (chunk.link === 0) {
                // This is the final chunk.
                chunk.link = nextFreeChunk;
                this.writeStringChunk(index, chunk);
                return;
            }
            this.writeStringChunk(index, chunk);
            index = chunk.link;
        }
    }

    @dirty addString(string: string, type: HiMDStringType): number {
        let encodedText: number[] | null = null;

        const order = [HiMDStringEncoding.LATIN1, HiMDStringEncoding.SHIFT_JIS, HiMDStringEncoding.UTF16BE];
        for(let entry of order){
            const encoded = encode(entry, string);
            if(!encoded) continue;
            const decodedString = decode(entry, Buffer.from(encoded.buffer));
            if(decodedString === string){
                encodedText = [entry, ...encoded];
                break;
            }
        }

        if (encodedText === null) throw new HiMDError('Cannot encode the string');

        // +13 for rounding up
        const slots = Math.floor((encodedText.length + 13) / 14);

        // Make sure there's at least $slots free strings
        let index = 0;
        for (let i = 0; i < slots; i++) {
            const chunk = this.getStringChunk(index);
            if (chunk.type !== HiMDStringType.UNUSED) throw new HiMDError('Freelist string chain broken');
            if (chunk.link === 0) throw new HiMDError('Not enough free string slots');

            index = chunk.link;
        }

        // Follow through - write the strings
        let startIndex = /* freelist */ this.getStringChunk(0).link;
        index = startIndex;
        for (let i = 0; i < slots; i++) {
            const chunk = this.getStringChunk(index);
            chunk.content = padStartUint8Array(Uint8Array.from(encodedText.splice(0, 14)), 14);
            chunk.type = i == 0 ? type : HiMDStringType.CONTINUATION;
            let nextLink = chunk.link;
            if (i === slots - 1) chunk.link = 0;
            this.writeStringChunk(index, chunk);
            index = nextLink;
        }

        // Update the freelist:
        this.writeStringChunk(0, {
            ...this.getStringChunk(0),
            link: index,
        });

        return startIndex;
    }

    isDirty() {
        return this.dirty;
    }

    async openBlockStream(firstFragment: number, framesPerBlock: number) {
        const fragments = [];

        let fragmentNumber = firstFragment;
        while (fragmentNumber !== 0) {
            const fragment = this.getFragment(fragmentNumber);
            fragments.push(fragment);
            fragmentNumber = fragment.nextFragment;
        }

        const atdata = await this.openDatanumDependent('atdata', 'ro');
        return new HiMDBlockStream(this, atdata, fragments, framesPerBlock);
    }

    async openNonMP3Stream(trackNumber: number) {
        const track = this.getTrack(trackNumber);
        const blockStream = await this.openBlockStream(track.firstFragment, getFramesPerBlock(track));
        const masterKey = createTrackKey(track.ekbNumber, track.key);
        return new HiMDNonMP3Stream(blockStream, getBytesPerFrame(track), masterKey);
    }

    async openMP3Stream(trackNumber: number) {
        const track = this.getTrack(trackNumber);
        const blockStream = await this.openBlockStream(track.firstFragment, 0);
        const key = getMP3EncryptionKey(this, trackNumber);
        return new HiMDMP3Stream(blockStream, getBytesPerFrame(track), key);
    }

    async openAtdataForWriting() {
        const atdata = await this.openDatanumDependent('atdata', 'rw');
        atdata.seek(atdata.length);
        return atdata;
    }

    async openMaclistForWriting() {
        const maclist = await this.openDatanumDependent('mclist', 'rw');
        return maclist;
    }

    async openMaclistForReading() {
        const maclist = await this.openDatanumDependent('mclist', 'ro');
        return maclist;
    }

    async advanceGeneration(newGeneration: number) {
        let newDataNum = newGeneration % 16;
        const existsFile = async (f: string) => (await this.filesystem.list("/HMDHIFI")).find(e => e.type === 'file' && e.name.toLowerCase() === f.toLowerCase());
        for (let e of ['ATDATA', 'MCLIST', 'TRKIDX']) {
            let newName = this.getDatanumDependentName(e, newDataNum);
            if(await existsFile(newName)){
                let n = 0;
                let newNameForOldFile;
                do{
                    newNameForOldFile = '/HMDHIFI/' + n.toString().padStart(8, '0') + '.HJS';
                    n++;
                }while(await existsFile(newNameForOldFile));
                await this.filesystem.rename(newName, newNameForOldFile);
            }
            await this.filesystem.rename(this.getDatanumDependentName(e, this.datanum!), newName);
        }
        this.datanum = newDataNum;
    }

    async openWriteStream() {
        const atdata = await this.openAtdataForWriting();
        return new HiMDWriteStream(this, atdata);
    }

    protected async readDiscId() {
        const file = await this.openDatanumDependent('MCLIST');
        await file.seek(0x40);
        this.discId = await file.read(0x10);
        await file.close();
    }

    getDiscId() {
        return this.discId;
    }
}
