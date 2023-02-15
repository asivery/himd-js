import { concatUint8Arrays, createEA3Header, createLPCMHeader } from "./utils";
import { getCodecName, HiMDCodecName } from "./codecs";
import { HiMD, HiMDError, HiMDRawGroup, HiMDStringType } from "./himd";
import { ExternalDecryptor } from "workers";
import { BLOCK_SIZE, HiMDBlockStream } from "./streams";
import { create as createID3 } from 'node-id3';

export interface HiMDTrack {
    index: number;
    title: string | null;
    album: string | null;
    artist: string | null;
    duration: number;
    encoding: HiMDCodecName;
}

export interface HiMDGroup{
    title: string | null;
    startIndex: number;
    tracks: HiMDTrack[];
}

export interface HiMDSimplerGroup{
    title: string | null;
    indices: number[]
}

export function getTrackInfo(himd: HiMD, index: number): HiMDTrack{
    const track = himd.getTrack(himd.trackIndexToTrackSlot(index));
    const getStringOrNull = (idx: number) => idx === 0 ? null : himd.getString(idx);
    if(track.firstFragment === 0)
        throw new HiMDError(`No such track: ${index}`);
    return {
        index,
        title: getStringOrNull(track.titleIndex),
        album: getStringOrNull(track.albumIndex),
        artist: getStringOrNull(track.artistIndex),
        encoding: getCodecName(track),
        duration: track.seconds,
    };
}

export function getAllTracks(himd: HiMD): HiMDTrack[]{
    return Array(himd.getTrackCount()).fill(0).map((_, i) => getTrackInfo(himd, i));
}

// Within himd-functions groups are 0-indexed.
// That is not the case in himd.ts, because group 0 is the disc title.

export function getGroups(himd: HiMD): HiMDGroup[]{
    const groups: HiMDGroup[] = [];
    const ungrouped: HiMDTrack[] = getAllTracks(himd);

    const rawGroups = Array(himd.getGroupCount())
        .fill(0)
        .map((_, i) => himd.getGroup(i + 1))
        .sort((a, b) => b.startTrackIndex - a.startTrackIndex);
    // Sort the array in reverse
    for(let group of rawGroups){
        groups.push({
            startIndex: group.startTrackIndex,
            title: group.titleIndex === 0 ? null : himd.getString(group.titleIndex),
            tracks: ungrouped.splice(group.startTrackIndex, group.endTrackIndex - group.startTrackIndex),
        });
    }

    groups.push({
        title: null,
        startIndex: 0,
        tracks: ungrouped,
    });
    
    return groups.reverse();
}

export function renameDisc(himd: HiMD, title: string | null){
    renameGroup(himd, 0, title);
}

export function renameGroup(himd: HiMD, groupIndex: number, title: string | null){
    const discTitleGroup = himd.getGroup(groupIndex + 1);
    if(discTitleGroup.titleIndex !== 0){
        himd.removeString(discTitleGroup.titleIndex);
        discTitleGroup.titleIndex = 0;
    }
    if(title !== null){
        discTitleGroup.titleIndex = himd.addString(title, HiMDStringType.GROUP);
    }
    himd.writeGroup(groupIndex + 1, discTitleGroup);
}

export function addGroup(himd: HiMD, title: string | null, start: number, length: number){
    const stringIndex = title === null ? 0 : himd.addString(title, HiMDStringType.GROUP);
    const group: HiMDRawGroup = {
        startTrackIndex: start,
        endTrackIndex: start + length,
        titleIndex: stringIndex,
    };
    const groupIndex = himd.getGroupCount();
    himd.writeGroup(groupIndex + 1, group);
}

export function deleteGroup(himd: HiMD, index: number){
    const groupCount = himd.getGroupCount();
    himd.removeString(himd.getGroup(index + 1).titleIndex);
    for(let i = index + 1; i < groupCount - 1; i++){
        himd.writeGroup(i, himd.getGroup(i + 1));
    }
    himd.eraseGroup(groupCount);
}

export function moveTrack(himd: HiMD, from: number, to: number) { 
    const tracks = Array(himd.getTrackCount()).fill(0).map((_, i) => himd.trackIndexToTrackSlot(i));
    let [ i ] = tracks.splice(from, 1);
    tracks.splice(to, 0, i);
    tracks.forEach((v, i) => himd.writeTrackIndexToTrackSlot(i, v));
}

export function renameTrack(himd: HiMD, index: number, { title, album, artist }: { title?: string, album?: string, artist?: string }){
    const track = himd.getTrack(himd.trackIndexToTrackSlot(index));
    const freeIfDefined = (e: number) => e !== 0 && himd.removeString(e);

    if(title !== undefined){
        freeIfDefined(track.titleIndex);
        track.titleIndex = title.length > 0 ? himd.addString(title, HiMDStringType.TITLE) : 0;
    }
    if(album !== undefined){
        freeIfDefined(track.albumIndex);
        track.albumIndex = album.length > 0 ? himd.addString(album, HiMDStringType.ALBUM) : 0;
    }
    if(artist !== undefined){
        freeIfDefined(track.artistIndex);
        track.artistIndex = artist.length > 0 ? himd.addString(artist, HiMDStringType.ARTIST) : 0;
    }

    himd.writeTrack(himd.trackIndexToTrackSlot(index), track);
}

export type DumpingGenerator = AsyncGenerator<{ data: Uint8Array, total: number }>;

function getTotal({ blockStream }: { blockStream: HiMDBlockStream }){
    return blockStream.fragments.reduce((a, b) => a + (b.lastBlock - b.firstBlock + 1), 0);
}

async function* dumpOMATrack(himd: HiMD, trackSlotNumber: number, externalDecryptor?: ExternalDecryptor): DumpingGenerator{
    const nonMP3Stream = await himd.openNonMP3Stream(trackSlotNumber);
    let block;

    let total = getTotal(nonMP3Stream);

    yield { data: createEA3Header(himd.getTrack(trackSlotNumber)), total };
    while((block = await nonMP3Stream.readBlock(externalDecryptor?.decryptor)) !== null){
        yield { data: block.block, total };
    }
    externalDecryptor?.close();
}

async function* dumpMP3Track(himd: HiMD, trackSlotNumber: number, externalDecryptor?: ExternalDecryptor): DumpingGenerator{
    const mp3Stream = await himd.openMP3Stream(trackSlotNumber);
    const rawTrack = himd.getTrack(trackSlotNumber);
    const getOrNone = (e: number) => e === 0 ? undefined : himd.getString(e);
    let block;
    
    let total = getTotal(mp3Stream);

    // Write the ID3 tags
    const id3Tags = createID3({
        title: getOrNone(rawTrack.titleIndex),
        album: getOrNone(rawTrack.albumIndex),
        artist: getOrNone(rawTrack.artistIndex),
    });

    yield { data: new Uint8Array(id3Tags), total };

    while((block = await mp3Stream.readBlock()) !== null){
        yield { data: block.block, total };
    }
    externalDecryptor?.close();
}

async function* dumpWAVTrack(himd: HiMD, trackSlotNumber: number, externalDecryptor?: ExternalDecryptor): DumpingGenerator{
    const nonMP3Stream = await himd.openNonMP3Stream(trackSlotNumber);
    let block;

    let total = getTotal(nonMP3Stream);

    yield { data: createLPCMHeader(total * BLOCK_SIZE), total };
    while((block = await nonMP3Stream.readBlock(externalDecryptor?.decryptor)) !== null){
        let blockContent = block.block;
        // Flip endianness of samples
        for(let i = 0; i<blockContent.length; i+=2){
            let temp = blockContent[i];
            blockContent[i] = blockContent[i+1];
            blockContent[i+1] = temp;
        }
        yield { data: blockContent.subarray(0, blockContent.length), total };
    }
    externalDecryptor?.close();
}

export function dumpTrack(himd: HiMD, trackSlotNumber: number, externalDecryptor?: ExternalDecryptor): { data: DumpingGenerator, format: "MP3" | "WAV" | "OMA" } {
    const track = himd.getTrack(trackSlotNumber);
    switch(getCodecName(track)){
        case "A3+":
        case "AT3":
            return { format: "OMA", data: dumpOMATrack(himd, trackSlotNumber, externalDecryptor) };
        case "MP3":
            return { format: "MP3", data: dumpMP3Track(himd, trackSlotNumber, externalDecryptor) };
        case "PCM":
            return { format: "WAV", data: dumpWAVTrack(himd, trackSlotNumber, externalDecryptor) };
    }
}

export function rewriteGroups(himd: HiMD, groups: HiMDSimplerGroup[]){
    let groupCount = himd.getGroupCount();

    for(let i = 0; i<groupCount; i++){
        deleteGroup(himd, i);
    }
    
    let alreadyGrouped: Set<number> = new Set();

    for(let group of groups){
        const indices = [...group.indices].sort((a, b) => a - b);
        const start = indices[0];
        const end = indices[indices.length - 1];
        if(indices[indices.length - 1] - indices[0] !== indices.length - 1){
            throw new HiMDError(`Cannot rewrite group ${start} - group is not sequential`);
        }
        if(indices.some(alreadyGrouped.has, alreadyGrouped)){
            throw new HiMDError(`Cannot add a track to group - track already grouped!`);
        }
        const groupLength = end - start + 1;
        addGroup(himd, group.title, start, groupLength);
        indices.forEach(alreadyGrouped.add, alreadyGrouped);
    }
}
