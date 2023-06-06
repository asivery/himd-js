import { HiMD } from './himd';

export function* stringifyStringFreelist(himd: HiMD): Generator<string> {
    let link = 0;
    while ((link = himd.getStringChunk(link).link) !== 0) {
        yield `${link} >`;
    }
}

export function printStringFreelist(himd: HiMD, limit?: number) {
    console.log('>>>HIMD STRING FREELIST<<<');
    let counter = 0;
    for (let e of stringifyStringFreelist(himd)) {
        console.log(e);
        if (limit !== undefined && counter++ > limit) break;
    }
    console.log('///HIMD STRING FREELIST///');
}
