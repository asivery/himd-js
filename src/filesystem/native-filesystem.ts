import { HiMDFile, HiMDFilesystem, HiMDFilesystemEntry } from './himd-filesystem';
import fs from 'fs';
import { join } from 'path';
import { HiMDError } from '../himd';

export class NativeHiMDFilesystem extends HiMDFilesystem {
    constructor(protected rootPath: string) {
        super();
    }

    async open(filePath: string, mode: 'ro' | 'rw' = 'ro'): Promise<HiMDFile> {
        // Ignore uppercase / lowercase distinction
        filePath = await this.transformToValidCase(filePath);

        return new Promise((res, rej) => {
            const path = join(this.rootPath, filePath);
            const stat = fs.statSync(path);
            const fd = fs.openSync(path, mode == 'ro' ? 'r' : 'r+');
            res(new NativeHiMDFile(mode === 'rw', fd, stat.size));
        });
    }

    async _list(path: string): Promise<HiMDFilesystemEntry[]> {
        return new Promise((res, rej) =>
            fs.readdir(join(this.rootPath, path), null, (err, files) => {
                if (err) {
                    rej(err);
                    return;
                }
                const ret: HiMDFilesystemEntry[] = [];
                for (let f of files) {
                    const stats = fs.statSync(join(this.rootPath, path, f));
                    if (stats.isFile() || stats.isDirectory()) {
                        ret.push({
                            name: join(path, f),
                            type: stats.isFile() ? 'file' : 'directory',
                        });
                    }
                }
                res(ret);
            })
        );
    }

    async rename(path: string, newPath: string) {
        fs.renameSync(path, newPath);
    }

    async getSize(path: string): Promise<number> {
        return new Promise((res) => fs.stat(join(this.rootPath, path), (err, stat) => res(stat.size)));
    }

    async getTotalSpace(): Promise<number> {
        return Math.pow(10, 9);
    }

    getName() {
        return "Local Directory";
    }
}

class NativeHiMDFile implements HiMDFile {
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
                if (err) rej(err);
                else res(bfr);
            });
        });
    }
    write(data: Uint8Array): Promise<void> {
        if (!this.writable) throw new HiMDError('Cannot write to a read-only opened file');
        return new Promise((res, rej) => {
            fs.write(this.fd, data, 0, data.length, this.offset, (err, wr, buf) => {
                this.offset += wr;
                this.length = Math.max(this.offset, this.length);
                if (err) return rej(err);
                res();
            });
        });
    }
    async close(): Promise<void> {
        return new Promise<void>((res, rej) => fs.close(this.fd, (err) => (err ? rej(err) : res())));
    }
}
