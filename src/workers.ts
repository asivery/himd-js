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
