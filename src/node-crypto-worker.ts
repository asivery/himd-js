import { decryptBlock, encryptBlock, initCrypto } from './encryption';
import { isMainThread, parentPort, Worker } from 'worker_threads';
import { CryptoProvider } from './workers';

export async function makeAsyncDecryptor(w: Worker): Promise<CryptoProvider> {
    await new Promise((res) => {
        w.postMessage({
            action: 'init',
        });
        w.on('message', res);
    });

    let currentWaiting: ((data: Uint8Array) => void) | null = null;
    const resolver = (data: Uint8Array) => {
        currentWaiting?.(data);
        currentWaiting = null;
    };

    w.on('message', resolver);

    return {
        close: () => w.postMessage({ action: 'die' }),
        decryptor: async function decryptor(
            trackKey: Uint8Array,
            fragmentKey: Uint8Array,
            blockKey: Uint8Array,
            blockIv: Uint8Array,
            audioData: Uint8Array
        ): Promise<Uint8Array> {
            if (currentWaiting !== null) throw new Error('Cannot use the same decryptor in 2 contexts at the same time!');
            return new Promise((res) => {
                currentWaiting = res;
                w.postMessage({ action: 'decrypt', trackKey, fragmentKey, blockKey, blockIv, audioData });
            });
        },
        encryptor: async function encryptor(
            trackKey: Uint8Array,
            fragmentKey: Uint8Array,
            blockKey: Uint8Array,
            blockIv: Uint8Array,
            plaintext: Uint8Array
        ): Promise<Uint8Array> {
            if (currentWaiting !== null) throw new Error('Cannot use the same decryptor in 2 contexts at the same time!');
            return new Promise((res) => {
                currentWaiting = res;
                w.postMessage({ action: 'encrypt', trackKey, fragmentKey, blockKey, blockIv, plaintext });
            });
        },
    };
}

if (isMainThread) {
    // do nothing
} else {
    parentPort!.on('message', async (msg) => {
        const { action, ...params } = msg;
        if (action === 'init') {
            await initCrypto();
            parentPort!.postMessage({ init: true });
        } else if (action === 'decrypt') {
            const { trackKey, fragmentKey, blockKey, blockIv, audioData } = params;
            parentPort!.postMessage(decryptBlock(trackKey, fragmentKey, blockKey, blockIv, audioData));
        } else if (action === 'encrypt') {
            const { trackKey, fragmentKey, blockKey, blockIv, plaintext } = params;
            parentPort!.postMessage(encryptBlock(trackKey, fragmentKey, blockKey, blockIv, plaintext));
        } else if (action === 'die') {
            process.exit(0);
        }
    });
}
