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
} as const;

export const MAIN_KEY = EKBROOTS[0x00010012].subarray(0, 16);

export function getMP3EncryptionKey(himd: HiMD, trackNumber: number){
    const discId = himd.getDiscId()!;
    const key = ((trackNumber * 0x6953B2ED) + 0x6BAAB1) ^ getUint32(discId, 12);
    const keyAsBytes = new Uint8Array(4);
    setUint32(keyAsBytes, key);
    return keyAsBytes;
}

export function createTrackKey(ekbNum: number, trackKey: Uint8Array){
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

export function decryptBlock(trackKey: Uint8Array, fragmentKey: Uint8Array, blockKey: Uint8Array, blockIv: Uint8Array, audioData: Uint8Array){
    const finalFragmentKey = Crypto.lib.WordArray.create(xorKeys(trackKey, fragmentKey));
    const decryptedMainKeyA = Crypto.lib.WordArray.create(blockKey);
    const mainKey = Crypto.DES.encrypt(decryptedMainKeyA, finalFragmentKey, { mode: Crypto.mode.ECB }).ciphertext;
    const ivWa = Crypto.lib.WordArray.create(blockIv);
    const blockWA = Crypto.lib.CipherParams.create({
        ciphertext: Crypto.lib.WordArray.create(audioData),
    });
    return wordArrayToByteArray(Crypto.DES.decrypt(blockWA, mainKey, { mode: Crypto.mode.CBC, iv: ivWa }), audioData.length);
}

export function encryptBlock(trackKey: Uint8Array, fragmentKey: Uint8Array, blockKey: Uint8Array, blockIv: Uint8Array, audioData: Uint8Array){
    const finalFragmentKey = Crypto.lib.WordArray.create(xorKeys(trackKey, fragmentKey));
    const decryptedMainKeyA = Crypto.lib.WordArray.create(blockKey);
    const mainKey = Crypto.DES.encrypt(decryptedMainKeyA, finalFragmentKey, { mode: Crypto.mode.ECB }).ciphertext;
    const iv = Crypto.lib.WordArray.create(blockIv);
    const blockWA = Crypto.lib.WordArray.create(audioData);
    return wordArrayToByteArray(Crypto.DES.encrypt(blockWA, mainKey, { mode: Crypto.mode.CBC, iv }).ciphertext, audioData.length);
}

const NO_PADDING = { pad: (a: any) => a, unpad: (a: any) => a };

export function retailMac(message: Uint8Array, key: Uint8Array){
    const keyA = key.subarray(0, 8);
    const keyB = key.subarray(8, 16);
    const messageWa = Crypto.lib.WordArray.create(message);
    const keyAWa = Crypto.lib.WordArray.create(keyA);
    const keyBWa = Crypto.lib.WordArray.create(keyB);
    const zeroWa = Crypto.lib.WordArray.create(new Uint8Array(8).fill(0));
    const encA = Crypto.DES.encrypt(messageWa, keyAWa, { padding: NO_PADDING, mode: Crypto.mode.CBC, iv: zeroWa }).ciphertext;
    const messageBFull = wordArrayToByteArray(encA);
    const messageB = messageBFull.subarray(messageBFull.length - 8);
    const messageBWa = Crypto.lib.CipherParams.create({
        ciphertext: Crypto.lib.WordArray.create(messageB)
    });
    const encB = Crypto.DES.decrypt(messageBWa, keyBWa, { padding: NO_PADDING, mode: Crypto.mode.ECB });
    const final = Crypto.DES.encrypt(encB, keyAWa, { padding: NO_PADDING, mode: Crypto.mode.ECB }).ciphertext;
    return wordArrayToByteArray(final);
}

export function createIcvMac(icvAndHeader: Uint8Array, sessionKey: Uint8Array){
    const icvWa = Crypto.lib.WordArray.create(icvAndHeader);
    const sessionKeyWa = Crypto.lib.WordArray.create(sessionKey);
    const zeroWa = Crypto.lib.WordArray.create(new Uint8Array(8).fill(0));
    const result = Crypto.DES.encrypt(icvWa, sessionKeyWa, { mode: Crypto.mode.CBC, iv: zeroWa, padding: NO_PADDING });
    return wordArrayToByteArray(result.ciphertext).subarray(-8);
}

export function encryptTrackKey(trackKey: Uint8Array){
    const trackKeyWa = Crypto.lib.WordArray.create(trackKey);
    const keyWa = Crypto.lib.WordArray.create(EKBROOTS[0x00010012]);
    const encrypted = Crypto.TripleDES.encrypt(trackKeyWa, keyWa, { mode: Crypto.mode.ECB, padding: NO_PADDING });
    return wordArrayToByteArray(encrypted.ciphertext);
}

export function createTrackMac(trackKey: Uint8Array, trackEntry: Uint8Array){
    const trackKeyWa = Crypto.lib.WordArray.create(trackKey);
    const trackEntryWa = Crypto.lib.WordArray.create(trackEntry);

    const macKeySourceWa = Crypto.lib.WordArray.create(new Uint8Array(8).fill(0));
    const macKey = Crypto.DES.encrypt(macKeySourceWa, trackKeyWa, { mode: Crypto.mode.ECB, padding: NO_PADDING }).ciphertext;
    const zeroWa = Crypto.lib.WordArray.create(new Uint8Array(8).fill(0));
    const mac = Crypto.DES.encrypt(trackEntryWa, macKey, { mode: Crypto.mode.CBC, iv: zeroWa, padding: NO_PADDING });
    return wordArrayToByteArray(mac.ciphertext).subarray(-8);
}

export function decryptMaclistKey(key: Uint8Array){
    const rootKeyWa = Crypto.lib.WordArray.create(EKBROOTS[0x00010012]);
    const keyC = Crypto.lib.CipherParams.create({
        ciphertext: Crypto.lib.WordArray.create(key),
    });

    const decryptedTrackKey = Crypto.TripleDES.decrypt(keyC, rootKeyWa, {
        mode: Crypto.mode.ECB,
    });
    return wordArrayToByteArray(decryptedTrackKey, 16);
}
