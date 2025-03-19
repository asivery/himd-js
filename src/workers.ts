import type{ HiMDBlockInfo } from "./himd";
import { encryptBlock } from "./encryption";
import { createRandomBytes } from "./utils";

export type CryptoProvider = {
    decryptor: (
        trackKey: Uint8Array,
        fragmentKey: Uint8Array,
        blockKey: Uint8Array,
        blockIv: Uint8Array,
        audioData: Uint8Array
    ) => Promise<Uint8Array>;
    encryptor: (
        trackKey: Uint8Array,
        fragmentKey: Uint8Array,
        blockKey: Uint8Array,
        blockIv: Uint8Array,
        plaintext: Uint8Array
    ) => Promise<Uint8Array>;
    close: () => void;
};
export interface CryptoBlockProvider {
    process(
        params: {
            rawData: ArrayBuffer,
            trackKey: Uint8Array,
            fragmentKey: Uint8Array,
            bytesPerFrame: number,
            maxBytesInBlock: number,
            mCode: number,
            type: Uint8Array,
            lo32ContentId: number
        },
        progressCallback?: (progress: { totalBytes: number; encryptedBytes: number }) => void
    ): AsyncIterableIterator<{ block: HiMDBlockInfo, lastFrameInFragment: number }>;
    close(): void;
}

export async function* createHiMDBlockGenerator(
    {
        rawData,
        trackKey,
        fragmentKey,
        bytesPerFrame,
        maxBytesInBlock,
        mCode,
        type,
        lo32ContentId
    }: {
        rawData: ArrayBuffer,
        trackKey: Uint8Array,
        fragmentKey: Uint8Array,
        bytesPerFrame: number,
        maxBytesInBlock: number,
        mCode: number,
        type: Uint8Array,
        lo32ContentId: number
    }
): AsyncIterableIterator<{ block: HiMDBlockInfo, lastFrameInFragment: number }>{
    let currentInputByte = 0;
    let i = 0;

    while (currentInputByte < rawData.byteLength) {
        let bytesInThisBlock = Math.min(maxBytesInBlock, rawData.byteLength - currentInputByte);
        const framesInThisBlock = Math.floor(bytesInThisBlock / bytesPerFrame);
        if (framesInThisBlock === 0) break;
        bytesInThisBlock = framesInThisBlock * bytesPerFrame;

        const keyForBlock = createRandomBytes();
        const audioData = new Uint8Array(rawData.slice(currentInputByte, currentInputByte + bytesInThisBlock));

        const lastFrameInFragment = framesInThisBlock - 1;

        let block: HiMDBlockInfo = {
            audioData: null as any,
            backupKey: keyForBlock,
            backupMCode: mCode,
            backupReserved: 0,
            backupSerialNumber: i,
            backupType: type,
            iv: new Uint8Array(8).fill(0),
            key: keyForBlock,
            lendata: 0,
            lo32ContentId,
            mCode,
            nFrames: 0,
            reserved1: 0,
            reserved2: new Uint8Array(4).fill(0),
            serialNumber: i,
            type,
        };

        block.audioData = encryptBlock(trackKey, fragmentKey, block.key, block.iv, audioData);

        i++;
        currentInputByte += bytesInThisBlock;
        yield { lastFrameInFragment, block }
    }
}
