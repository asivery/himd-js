import type { HiMDCodec } from './codecs';

export function getUint16(data: Uint8Array, offset: number = 0) {
    return (data[offset + 0] << 8) | data[offset + 1];
}

export function getUint32(data: Uint8Array, offset: number = 0) {
    return (data[offset + 0] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

export function setUint16(data: Uint8Array, value: number, offset: number = 0) {
    data[offset + 0] = (value >> 8) & 0xff;
    data[offset + 1] = (value >> 0) & 0xff;
}

export function setUint32(data: Uint8Array, value: number, offset: number = 0) {
    data[offset + 0] = (value >> 24) & 0xff;
    data[offset + 1] = (value >> 16) & 0xff;
    data[offset + 2] = (value >> 8) & 0xff;
    data[offset + 3] = (value >> 0) & 0xff;
}

export function assert(condition: boolean, message?: string) {
    if (condition) {
        return;
    }
    message = message || 'no message provided';
    throw new Error(`Assertion failed: ${message}`);
}

export function arrayEq<T>(a: ArrayLike<T>, b: ArrayLike<T>) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function join(...paths: string[]){
    return paths.filter(e => e).join("/").replace(/\/*/, '/');
}

export function concatUint8Arrays(args: Uint8Array[]) {
    let totalLength = 0;
    for (let a of args) {
        totalLength += a.length;
    }

    let res = new Uint8Array(totalLength);

    let offset = 0;
    for (let a of args) {
        res.set(a, offset);
        offset += a.length;
    }
    return res;
}

export function padStartUint8Array(data: Uint8Array, length: number, byte: number = 0) {
    return concatUint8Arrays([data, data.length < length ? new Uint8Array(length - data.length).fill(byte) : new Uint8Array()]);
}

export function createEA3Header({ codecId, codecInfo }: { codecId: HiMDCodec; codecInfo: Uint8Array }) {
    const headerSize = 96;
    const header = new Uint8Array(headerSize);
    header.set(new Uint8Array([0x45, 0x41, 0x33, 0x01, 0x00, 0x60, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]));
    header[32] = codecId;
    header[33] = codecInfo[0];
    header[34] = codecInfo[1];
    header[35] = codecInfo[2];
    return header;
}

function wordToByteArray(word: number, length: number, littleEndian = false) {
    let ba = [],
        xFF = 0xff;
    let actualLength = length;
    if (littleEndian) {
        length = 4;
    }
    if (length > 0) ba.push(word >>> 24);
    if (length > 1) ba.push((word >>> 16) & xFF);
    if (length > 2) ba.push((word >>> 8) & xFF);
    if (length > 3) ba.push(word & xFF);
    if (littleEndian) {
        ba = ba.splice(4 - actualLength).reverse();
    }
    return ba;
}

export function wordArrayToByteArray(wordArray: any, length: number = wordArray.sigBytes) {
    let res = new Uint8Array(length);
    let bytes;
    let i = 0;
    let offset = 0;
    while (length > 0) {
        bytes = wordToByteArray(wordArray.words[i], Math.min(4, length));
        res.set(bytes, offset);
        length -= bytes.length;
        offset += bytes.length;
        i++;
    }
    return res;
}

export function createLPCMHeader(bytes: number) {
    return concatUint8Arrays([
        new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0x64, 0xee, 0xd6, 0x01, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01,
            0x00, 0x02, 0x00, 0x44, 0xac, 0x00, 0x00, 0x10, 0xb1, 0x02, 0x00, 0x04, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
        ]),
        new Uint8Array(wordToByteArray(bytes, 4, true)),
    ]);
}

export function createRandomBytes(length = 8) {
    return new Uint8Array(
        Array(length)
            .fill(0)
            .map(() => Math.floor(Math.random() * 256))
    );
}
