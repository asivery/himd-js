import { HiMDFile, HiMDFilesystem, HiMDFilesystemEntry } from "./himd-filesystem";
import fs from 'fs';
import { join } from "path";
import { HiMDError } from "../himd";

export class NativeHiMDFilesystem implements HiMDFilesystem {
    constructor(protected rootPath: string) {}

    async transformToValidCase(path: string): Promise<string>{
        if(!path.startsWith("/")) path = "/" + path;
        if(path === '/' || path === '') return path;
        const parent = path.substring(0, path.lastIndexOf("/"));
        const validParent = await this.transformToValidCase(parent);

        return (await this._list(validParent))
            .find(e => e.name.toLowerCase() === path.toLowerCase())?.name ?? path;
    }

    async open(filePath: string, mode: "ro" | "rw" = 'ro'): Promise<HiMDFile> {
        // Ignore uppercase / lowercase distinction
        filePath = await this.transformToValidCase(filePath);

        return new Promise((res, rej) => {
            const path = join(this.rootPath, filePath);
            const stat = fs.statSync(path);
            const fd = fs.openSync(path, mode == 'ro' ? 'r' : 'r+');
            res(new NativeHiMDFile(
                mode === 'rw',
                fd,
                stat.size
            ));
        });
    }

    async list(path: string): Promise<HiMDFilesystemEntry[]> {
        path = await this.transformToValidCase(path);
        return this._list(path);
    }

    async _list(path: string): Promise<HiMDFilesystemEntry[]> {
        return new Promise((res, rej) => fs.readdir(join(this.rootPath, path), null, (err, files) => {
            if(err){
                rej(err);
                return;
            }
            const ret: HiMDFilesystemEntry[] = [];
            for(let f of files){
                const stats = fs.statSync(join(this.rootPath, path, f));
                if(stats.isFile() || stats.isDirectory()){
                    ret.push({
                        name: join(path, f),
                        type: stats.isFile() ? 'file' : 'directory',
                    });
                }
            }
            res(ret);
        }));
    }
}

class NativeHiMDFile implements HiMDFile{
    offset = 0;

    constructor(private writable: boolean, private fd: number, public length: number) {}
    seek(offset: number): Promise<void> {
        this.offset = offset;
        return Promise.resolve();
    }
    read(length: number = this.length - this.offset): Promise<Uint8Array> {
        return new Promise((res, rej) => {
            const buffer = new Uint8Array(length);
            fs.read(this.fd, buffer, 0, length, this.offset, (err, read, bfr) => {
                this.offset += read;
                if(err) rej(err);
                else res(bfr);
            });
        })
    }
    write(data: Uint8Array): Promise<void> {
        if(!this.writable)
            throw new HiMDError("Cannot write to a read-only opened file");
        throw new Error("Method not implemented.");
    }
    async close(): Promise<void> {
        
    }

    async truncate(size: number): Promise<void> {
        
    }
}
