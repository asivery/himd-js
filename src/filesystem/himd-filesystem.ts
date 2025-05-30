export abstract class HiMDFilesystem {
    async transformToValidCase(path: string): Promise<string> {
        if (!path.startsWith('/')) path = '/' + path;
        if (path === '/' || path === '') return path;
        const parent = path.substring(0, path.lastIndexOf('/'));
        const validParent = await this.transformToValidCase(parent);

        return (await this._list(validParent)).find((e) => e.name.toLowerCase() === path.toLowerCase())?.name ?? path;
    }

    async list(path: string): Promise<HiMDFilesystemEntry[]> {
        path = await this.transformToValidCase(path);
        return this._list(path);
    }

    async getSizeOfDirectory(path: string) {
        let bytes = 0;
        for (let { type, name } of await this.list(path)) {
            if (type === 'directory') {
                bytes += await this.getSizeOfDirectory(name);
            } else {
                try {
                    bytes += (await this.getSize(name))!;
                } catch (ex) {}
            }
        }
        return bytes;
    }

    async statFilesystem(): Promise<{used: number, total: number, left: number}> {
        // Default implementation.
        const totalSpaceTaken = (await this.getSizeOfDirectory('/'));
        const totalVolumeSize = (await this.getTotalSpace());
        return { total: totalVolumeSize, used: totalSpaceTaken, left: totalVolumeSize - totalSpaceTaken };
    }

    abstract getName(): string;
    abstract open(filePath: string, mode?: 'ro' | 'rw'): Promise<HiMDFile>;
    abstract _list(path: string): Promise<HiMDFilesystemEntry[]>;
    abstract rename(path: string, newPath: string): Promise<void>;
    abstract getSize(path: string): Promise<number | null>;
    abstract getTotalSpace(): Promise<number>;
    abstract wipeDisc(reinitializeHiMDFilesystem: boolean): Promise<void>;
    abstract freeFileRegions?(filePath: string, regions: { startByte: number, length: number }[]): Promise<void>;
    abstract delete(filePath: string): Promise<void>;
    abstract mkdir(filePath: string): Promise<void>;
}

export interface HiMDFilesystemEntry {
    type: 'directory' | 'file';
    name: string;
}

export interface HiMDFile {
    seek(offset: number): Promise<void>;
    read(length?: number): Promise<Uint8Array>;
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;

    length: number;
}
