import { HiMDError } from '../himd';
import { join } from 'path';
import { HiMDFile, HiMDFilesystem, HiMDFilesystemEntry } from './himd-filesystem';

//HACK: This seems to be a very recent addition:
type FileSystemWritableFileStream = any;

export class FSAHiMDFilesystem extends HiMDFilesystem {
    protected constructor(protected rootDirectoryHandle: FileSystemDirectoryHandle) {
        super();
    }

    static async init() {
        const handle = await (globalThis as any).showDirectoryPicker();
        return new FSAHiMDFilesystem(handle);
    }

    async open(filePath: string, mode: 'ro' | 'rw' = 'ro') {
        const entry = await this.resolve(this.rootDirectoryHandle, await this.transformToValidCase(filePath));
        if (entry.kind === 'directory') throw new HiMDError('Cannot open directory as file');
        const fileEntry = entry as FileSystemFileHandle;
        const file = await fileEntry.getFile();

        const writable = mode === 'ro' ? null : await (fileEntry as any).createWritable({ keepExistingData: true });

        return new FSAHiMDFile(file, writable);
    }

    private async getFileListing(dir: FileSystemDirectoryHandle) {
        let files: { [key: string]: FileSystemHandle } = {};
        for await (let [n, e] of dir as any) {
            files[n] = e;
        }
        return files;
    }

    private async resolve(root: FileSystemDirectoryHandle, path: string) {
        let entry: FileSystemHandle = root;
        for (let pathElement of path.split('/')) {
            if (pathElement.length === 0) continue;
            entry = (await this.getFileListing(entry as FileSystemDirectoryHandle))[pathElement]!;
        }
        return entry;
    }

    async _list(path: string): Promise<HiMDFilesystemEntry[]> {
        const entry = await this.resolve(this.rootDirectoryHandle, path);
        return Object.entries(await this.getFileListing(entry as FileSystemDirectoryHandle)).map(([name, content]) => ({
            name: join(path, name),
            type: (content as any).kind,
        }));
    }

    async rename(path: string, newPath: string) {
        throw new Error('no');
    }

    async getSize(path: string): Promise<number> {
        return (await ((await this.resolve(this.rootDirectoryHandle, path)) as FileSystemFileHandle).getFile()).size;
    }

    async getTotalSpace(): Promise<number> {
        return Math.pow(10, 9);
    }
}

class FSAHiMDFile implements HiMDFile {
    offset = 0;
    length = 0;

    constructor(public file: File, private writable: FileSystemWritableFileStream | null) {
        this.length = file.size;
    }

    async seek(offset: number) {
        this.offset = offset;
    }

    async read(length: number = this.length - this.offset) {
        const sub = new Uint8Array(await this.file!.slice(this.offset, this.offset + length).arrayBuffer());
        this.offset += sub.length;
        return sub;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.writable === null) throw new HiMDError('Cannot use a read-only file for writing');
        await this.writable.seek(this.offset);
        await this.writable.write(data);
        this.offset += data.length;
        this.length = Math.max(this.offset, this.length);
    }

    async close(): Promise<void> {
        if (this.writable === null) return;
        await this.writable.close();
    }
}
