export interface HiMDFilesystem {
	open(filePath: string, mode?: 'ro' | 'rw'): Promise<HiMDFile>;
	list(path: string): Promise<HiMDFilesystemEntry[]>
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
	truncate(size: number): Promise<void>;
	
	length: number;
}
