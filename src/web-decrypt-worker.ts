import { decryptBlock, initCrypto } from "./encryption";
import { ExternalDecryptor } from "./workers";

export async function makeAsyncDecryptor(w: Worker): Promise<ExternalDecryptor> {
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
        decryptor: async function decryptor(masterKey: Uint8Array, key: Uint8Array, data: Uint8Array): Promise<Uint8Array>{
            if(currentWaiting !== null) throw new Error("Cannot use the same decryptor in 2 contexts at the same time!");
            return new Promise(res => {
                currentWaiting = res;
                w.postMessage({ action: 'next', masterKey, data, key });
            });
        }
    };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    // Worker
    onmessage = async msg => {
        const { action, ...params } = msg.data;
        if(action === 'init'){
            await initCrypto();
            postMessage({ init: true });
        }else if(action === 'next'){
            const { masterKey, key, data } = params;
            postMessage(decryptBlock(masterKey, key, data));
        }else if(action === 'die'){
            process.exit(0);
        }
    };
}
