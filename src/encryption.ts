import { HiMD, HiMDError } from "./himd";
import { getUint32, setUint32, wordArrayToByteArray } from "./utils";
import Crypto from '@originjs/crypto-js-wasm';

export async function initCrypto(){
    await Crypto.TripleDES.loadWasm();
    await Crypto.DES.loadWasm();
}

function xorKeys(a: Uint8Array, b: Uint8Array){
    if(a.length !== b.length) throw new Error("Keys have to be the same length");
    return a.map((e, i) => e ^ b[i]);
}

const EKBROOTS: {[key: number]: Uint8Array} = {
    0x00010012: new Uint8Array([
        0xf5,0x1e,0xcb,0x2a,0x80,0x8f,0x15,0xfd,
        0x54,0x2e,0xf5,0x12,0x3b,0xcd,0xbc,0xa4,
        0xf5,0x1e,0xcb,0x2a,0x80,0x8f,0x15,0xfd,
    ]),
};

export function getMP3EncryptionKey(himd: HiMD, trackNumber: number){
    const discId = himd.getDiscId()!;
    const key = ((trackNumber * 0x6953B2ED) + 0x6BAAB1) ^ getUint32(discId, 12);
    const keyAsBytes = new Uint8Array(4);
    setUint32(keyAsBytes, key);
    return keyAsBytes;
}

export function createMasterKey(ekbNum: number, trackKey: Uint8Array){
    if(!(ekbNum in EKBROOTS)){
        throw new HiMDError('Requested decription with an unknown EKB');
    }
    const rootKeyC = Crypto.lib.WordArray.create(EKBROOTS[ekbNum]);
    const trackKeyC = Crypto.lib.CipherParams.create({
        ciphertext: Crypto.lib.WordArray.create(trackKey),
    });

    const decryptedTrackKey = Crypto.TripleDES.decrypt(trackKeyC, rootKeyC, {
        mode: Crypto.mode.ECB,
    });

    return wordArrayToByteArray(decryptedTrackKey, 8);
}

export function decryptBlock(masterKey: Uint8Array, fragmentKey: Uint8Array, fragment: Uint8Array){
    const finalFragmentKey = Crypto.lib.WordArray.create(xorKeys(masterKey, fragmentKey));
    const decryptedMainKeyA = Crypto.lib.WordArray.create(fragment.subarray(16, 16 + 8));
    const mainKey = Crypto.DES.encrypt(decryptedMainKeyA, finalFragmentKey, { mode: Crypto.mode.ECB }).ciphertext;
    const iv = Crypto.lib.WordArray.create(fragment.subarray(24, 24 + 8));
    const blockWA = Crypto.lib.CipherParams.create({
        ciphertext: Crypto.lib.WordArray.create(fragment.subarray(32)),
    });
    return wordArrayToByteArray(Crypto.DES.decrypt(blockWA, mainKey, { mode: Crypto.mode.CBC, iv }), fragment.length - 32);
}
