import { getBytesPerFrame, HiMDCodec } from "./codecs";
import { HiMDRawTrack } from "./himd";
import { HIMD_AUDIO_SIZE } from "./streams";


export function getFramesPerBlock(track: HiMDRawTrack){
    const frameSize = getBytesPerFrame(track);
    if(frameSize === 0){ // 0 = TRACK_IS_MPEG
        return 0;
    }

    console.log("A", frameSize, "B", Math.floor(0x3FBF / frameSize))

    if(track.codecId === HiMDCodec.LPCM){
        return HIMD_AUDIO_SIZE / 64; // 64 = SONY_VIRTUAL_LPCM_FRAMESIZE
    }else{
        return Math.floor(0x3FBF / frameSize);
    }
}

