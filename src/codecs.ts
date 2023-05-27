import { HiMDError } from "./himd";

export type CodecInfo = { codecId: HiMDCodec; codecInfo: Uint8Array };

const MPEG_I_SAMPLES_PER_FRAME = 384;
const MPEG_II_III_SAMPLES_PER_FRAME = MPEG_I_SAMPLES_PER_FRAME * 3;
const SONY_VIRTUAL_LPCM_FRAMESIZE = 64;
const SONY_ATRAC3_SAMPLES_PER_FRAME = 1024;
const SONY_ATRAC3P_SAMPLES_PER_FRAME = 2048;

export enum HiMDCodec {
	ATRAC3 = 0x00,
	ATRAC3PLUS_OR_MPEG = 0x01,
	LPCM = 0x80,
}

export const HiMDKBPSToFrameSize: {
    atrac3: {[key: number]: number},
    atrac3plus: {[key: number]: number},
} = {
    atrac3: {
        66: 192,
        105: 304,
        132: 384,
    } as const,
    atrac3plus: {
        32: 192,
        48: 280,
        64: 376,
        192: 1120,
        256: 1488,
        352: 2048,
    } as const
} as const;

function isMpeg(codecInfo: Uint8Array){
    return (codecInfo[0] & 0b11) === 0b11;
}

export function getBytesPerFrame(ci: CodecInfo){
    const { codecId, codecInfo } = ci;
    switch(codecId){
        case HiMDCodec.LPCM:
            return SONY_VIRTUAL_LPCM_FRAMESIZE;
        case HiMDCodec.ATRAC3:
            return codecInfo[2] * 8;
        case HiMDCodec.ATRAC3PLUS_OR_MPEG:
            if(isMpeg(codecInfo)){
                let mask = ~0;
                if((codecInfo[3] & 0xC0) === 0xC0)
                    mask = ~3;
                
                return (getSamplesPerFrame(ci) * (125 * getKBPS(ci)) / getSampleRate(ci)) & mask;
            }else{
                // Atrac 3 Plus
                return ((((codecInfo[1] << 8) | (codecInfo[2])) & 0x3FF) + 1) * 8;
            }
    }
}

export function getSamplesPerFrame({ codecId, codecInfo }: CodecInfo){
    switch(codecId){
        case HiMDCodec.LPCM:
            return SONY_VIRTUAL_LPCM_FRAMESIZE / 4;
        case HiMDCodec.ATRAC3:
            return SONY_ATRAC3_SAMPLES_PER_FRAME;
        case HiMDCodec.ATRAC3PLUS_OR_MPEG:
            if(!isMpeg(codecInfo))
                return SONY_ATRAC3P_SAMPLES_PER_FRAME;
            if((codecInfo[3] & 0x30) == 0x30)
                return MPEG_I_SAMPLES_PER_FRAME;
            else
                return MPEG_II_III_SAMPLES_PER_FRAME;
        default:
            throw new HiMDError("Cannot get samples per frame - invalid codec");
    }
}

export function getSampleRate({ codecId, codecInfo }: CodecInfo){
    const atracRates = [32000, 44100, 48000, 88200, 96000];
    const mpegRates = [44100, 48000, 32000];
    if(codecId === HiMDCodec.ATRAC3PLUS_OR_MPEG && !isMpeg(codecInfo))
        codecId = HiMDCodec.ATRAC3;
    switch(codecId){
        case HiMDCodec.LPCM:
            return 44100;
        case HiMDCodec.ATRAC3 /* or ATRAC3PLUS */:
            return atracRates[codecInfo[1] >> 5];
        case HiMDCodec.ATRAC3PLUS_OR_MPEG /* Just MPEG */:
            return mpegRates[codecInfo[4] >> 6] / (4 - (codecInfo[3] >> 6));
        default:
            throw new HiMDError("Cannot get sample rate - invalid codec");    
    }
}

export function getKBPS(ci: CodecInfo): number{
    const { codecId, codecInfo } = ci;
    if(codecId === HiMDCodec.ATRAC3PLUS_OR_MPEG && isMpeg(codecInfo)){
        const map = [
            [
                [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448,0],
                [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384,0],
                [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0],
            ],
            [
                [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,0],
                [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0],
                [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0],
            ]
        ];

        if((codecInfo[3] & 0xC0) === 0x40 || (codecInfo[3] & 0x30) === 0)
            return 0;
        return map
            [1-((codecInfo[3] & 0x40) >> 6)]
            [3-((codecInfo[3] & 0x30) >> 4)]
            [codecInfo[3] & 0xF];
    }else{
        return Math.floor(getBytesPerFrame(ci) * getSampleRate(ci) / (125 * getSamplesPerFrame(ci)));
    }
}

export function getSeconds(ci: CodecInfo, frames: number){
    return (frames * getSamplesPerFrame(ci)) / getSampleRate(ci);
}

export type HiMDCodecName = "PCM" | "AT3" | "MP3" | "A3+";

export function getCodecName(ci: CodecInfo): HiMDCodecName {
    switch(ci.codecId){
        case HiMDCodec.LPCM:
            return "PCM";
        case HiMDCodec.ATRAC3:
            return "AT3";
        case HiMDCodec.ATRAC3PLUS_OR_MPEG:
            if(isMpeg(ci.codecInfo))
                return "MP3";
            else
                return "A3+";
        default:
            throw new HiMDError(`Invalid codec: ${ci.codecId}`)
    }
}

export function generateCodecInfo(codecName: HiMDCodecName, frameSize: number, channels: number = 2, sampleRate: number = 44100){
    // LP4 seems borked.
    const output: CodecInfo = { codecId: 0, codecInfo: new Uint8Array(5).fill(0) };
    let convertedSampleRate = ({
        32000: 0x0,
        44100: 0x20,
        48000: 0x40,
        88200: 0x60,
        96000: 0x80,
    })[sampleRate];
    if(convertedSampleRate === undefined) throw new HiMDError("Invalid sample rate provided");
    if(frameSize % 8 !== 0) throw new HiMDError("Invalid frame size provided");
    if(codecName === "AT3"){
        output.codecId = 0;
        output.codecInfo[0] = frameSize === 192 ? 2 : 0; // joint stereo
        output.codecInfo[1] = convertedSampleRate;
        output.codecInfo[2] = Math.floor(frameSize / 8);
    }else if(codecName === "A3+"){
        output.codecId = 1;
        output.codecInfo[1] = convertedSampleRate | (channels === 2 ? 8 : 4);
        output.codecInfo[2] = (Math.floor(frameSize / 8) - 1);
    }else if(codecName === "PCM"){
        output.codecId = 0x80;
        output.codecInfo[0] = 6; // UNKNOWN
        output.codecInfo[2] = 7; // UNKNOWN
        output.codecInfo[1] = 40; // UNKNOWN
    }else if(codecName === "MP3") throw new HiMDError("MP3 CodecInfo is generated by the MP3 upload function");
    return output;
}
