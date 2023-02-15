import { decryptBlock, initCrypto } from "./encryption";
import { isMainThread, parentPort, Worker } from "worker_threads";
import { ExternalDecryptor } from "./workers";

export async function makeAsyncDecryptor(w: Worker): Promise<ExternalDecryptor> {
    await new Promise(res => {
        w.postMessage({
            action: 'init'
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
        decryptor: async function decryptor(masterKey: Uint8Array, key: Uint8Array, data: Uint8Array): Promise<Uint8Array>{
            if(currentWaiting !== null) throw new Error("Cannot use the same decryptor in 2 contexts at the same time!");
            return new Promise(res => {
                currentWaiting = res;
                w.postMessage({ action: 'next', masterKey, data, key });
            });
        }
    };
}

if(isMainThread){
    // do nothing
} else {
    parentPort!.on('message', async msg => {
        const { action, ...params } = msg;
        if(action === 'init'){
            await initCrypto();
            parentPort!.postMessage({ init: true });
        }else if(action === 'next'){
            const { masterKey, key, data } = params;
            parentPort!.postMessage(decryptBlock(masterKey, key, data));
        }else if(action === 'die'){
            process.exit(0);
        }
    });
}