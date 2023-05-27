import { decryptBlock, encryptBlock, initCrypto } from "./encryption";
import { CryptoProvider } from "./workers";

export async function makeAsyncDecryptor(w: Worker): Promise<CryptoProvider> {
    await new Promise(res => {
        w.postMessage({
            action: 'init'
        });
        w.onmessage = res;
    });

    let currentWaiting: ((data: Uint8Array) => void) | null = null;
    const resolver = (data: Uint8Array) => {
        currentWaiting?.(data);
        currentWaiting = null;
    };

    w.onmessage = ev => resolver(ev.data);

    return {
        close: () => w.postMessage({ action: 'die' }),
        decryptor: async function decryptor(trackKey: Uint8Array, fragmentKey: Uint8Array, blockKey: Uint8Array, blockIv: Uint8Array, audioData: Uint8Array): Promise<Uint8Array>{
            if(currentWaiting !== null) throw new Error("Cannot use the same decryptor in 2 contexts at the same time!");
            return new Promise(res => {
                currentWaiting = res;
                w.postMessage({ action: 'decrypt', trackKey, fragmentKey, blockKey, blockIv, audioData });
            });
        },
        encryptor: async function encryptor(trackKey: Uint8Array, fragmentKey: Uint8Array, blockKey: Uint8Array, blockIv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>{
            if(currentWaiting !== null) throw new Error("Cannot use the same decryptor in 2 contexts at the same time!");
            return new Promise(res => {
                currentWaiting = res;
                w.postMessage({ action: 'encrypt', trackKey, fragmentKey, blockKey, blockIv, plaintext });
            });
        },
    };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    // Worker
    onmessage = async msg => {
        const { action, ...params } = msg.data;
        if(action === 'init'){
            await initCrypto();
            postMessage({ init: true });
        }else if(action === 'decrypt'){
            const { trackKey, fragmentKey, blockKey, blockIv, audioData } = params;
            postMessage(decryptBlock(trackKey, fragmentKey, blockKey, blockIv, audioData));
        }else if(action === 'encrypt'){
            const { trackKey, fragmentKey, blockKey, blockIv, plaintext } = params;
            postMessage(encryptBlock(trackKey, fragmentKey, blockKey, blockIv, plaintext));
        }else if(action === 'die'){
            process.exit(0);
        }
    };
}
