import { decryptBlock, encryptBlock, initCrypto } from './encryption';
import { isMainThread, parentPort, Worker } from 'worker_threads';
import { CryptoBlockProvider, CryptoProvider, createHiMDBlockGenerator } from './workers';
import type { HiMDBlockInfo } from './himd';

export async function makeAsyncWorker(w: Worker): Promise<CryptoProvider> {
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

// Based on netmd-js' implementation
type InitArgument = (CryptoBlockProvider['process'] extends ((a: infer X) => any) ? X : never);
export function makeAsyncCryptoBlockProvider(
    w: Worker,
): CryptoBlockProvider {
    async function* provider(
        params: InitArgument,
        progressCallback?: (progress: { totalBytes: number; encryptedBytes: number }) => void
    ): ReturnType<CryptoBlockProvider['process']> {
        const initWorker = () =>
            new Promise(res => {
                const message: { action: 'queuedInit' } & InitArgument = {
                    action: 'queuedInit',
                    ...params,
                };
                w.postMessage(
                    message,
                    [params.rawData]
                );
                w.once('message', res);
            });

        let resolver: (data: any) => void;

        let encryptedBytes = 0;
        let totalBytes = params.rawData.byteLength;
        let chunks: Promise<{ block: HiMDBlockInfo, lastFrameInFragment: number } | null>[] = [];
        const queueNextChunk = () => {
            let chunkPromise = new Promise<{ block: HiMDBlockInfo, lastFrameInFragment: number } | null>(resolve => {
                resolver = data => {
                    if (data !== null) {
                        encryptedBytes += data.block.audioData.byteLength;
                        progressCallback && progressCallback({ totalBytes, encryptedBytes });
                        queueNextChunk();
                    }
                    resolve(data);
                };
            });
            chunks.push(chunkPromise);
            w.postMessage({ action: 'next' });
        };

        await initWorker();
        function handler(msg: any){
            resolver(msg);
        }

        w.on('message', handler);
        queueNextChunk();

        let i = 0;
        while (1) {
            let r = await chunks[i];
            delete chunks[i];
            if (r === null) {
                break;
            }
            yield r;
            i++;
        }

        w.off('message', handler);
    }

    return {
        close: () => w.postMessage({ action: 'die' }),
        process: provider,
    };
}

if (isMainThread) {
    // do nothing
} else {
    let generator: AsyncIterableIterator<{ block: HiMDBlockInfo, lastFrameInFragment: number }> | null = null;
    let cryptoInited = false;

    parentPort!.on('message', async (msg) => {
        const { action, ...params } = msg;
        // Queued API:

        if (action === 'queuedInit') {
            generator = createHiMDBlockGenerator(params as any);
            if(!cryptoInited) {
                await initCrypto();
                cryptoInited = true;
            }
            parentPort!.postMessage({ queuedInit: true });
        } else if(action === 'next') {
            const { value, done } = await generator!.next();
            if(done) {
                parentPort!.postMessage(null);
            } else {
                parentPort!.postMessage(value, [value.block.audioData.buffer]);
            }
        }

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
