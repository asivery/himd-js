export type ExternalDecryptor = {
    decryptor: (masterKey: Uint8Array, key: Uint8Array, data: Uint8Array) => Promise<Uint8Array>,
    close: () => void,
};