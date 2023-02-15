import { dumpTrack, getTrackInfo } from "./himd-functions";
import { NativeHiMDFilesystem } from "./filesystem";
import { HiMD } from "./himd";
import { getAllTracks, getGroups } from '.';
import F from 'fs';
import { makeAsyncDecryptor } from "./node-decrypt-worker";
import { Worker } from "worker_threads";
import path from "path";

(async () => {
    const fs = new NativeHiMDFilesystem("HiMD/20230208_folder_added_nothing_found");
    const himd = await HiMD.init(fs);
    console.log(getGroups(himd));
    for(let i = 0; i<200; i++){
        console.log(getTrackInfo(himd, i));
    }

    // const data = dumpTrack(himd, himd.trackIndexToTrackSlot(0), await makeAsyncDecryptor(new Worker(path.join(__dirname, '../dist/node-decrypt-worker.js'))));
    // const file = F.openSync("/ram/test.mp3", F.constants.O_WRONLY | F.constants.O_CREAT);
    // for await(let { data: e } of data.data){
    //     F.writeFileSync(file, e);
    //     console.log(`Read ${e.length} bytes!`);
    // }
    // F.closeSync(file);
})().then(process.exit as any);
