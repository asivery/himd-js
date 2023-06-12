import { HiMDFile, HiMDFilesystem, HiMDFilesystemEntry } from './himd-filesystem';
import { USBMassStorageDriver } from 'node-mass-storage';
import fatfs from 'fatfs';
import { join } from 'path';
import { HiMD, HiMDError, HiMDRawTrack, DevicesIds } from '../himd';
import { concatUint8Arrays, createRandomBytes, getUint32, setUint16, setUint32 } from '../utils';
import { createIcvMac, createTrackKey, createTrackMac, decryptMaclistKey, encryptTrackKey, MAIN_KEY, retailMac } from '../encryption';
import { Mutex } from 'async-mutex';

function assert(expr: boolean, message: string) {
    if (!expr) throw new Error(message);
}

function arrayEq<T>(a: ArrayLike<T>, b: ArrayLike<T>) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class SonyVendorUSMCDriver extends USBMassStorageDriver {
    async preventAllowMediumRemoval(status: 'prevent' | 'allow') {
        const command = new Uint8Array([0x1e, 0x0, 0x0, 0x0, status === 'prevent' ? 0xff : 0x0]);
        const result = await this.sendMassStorageInCommand(command, 0, 0xc);
        await this._getStatus(result.expectedTag);
    }

    async testUnitReady() {
        await this._getStatus((await this.sendMassStorageInCommand(new Uint8Array(), 0x00, 0xc)).expectedTag);
    }

    async getTime() {
        return await this.sendCommandInGetResult(new Uint8Array([0xc2, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x00, 0x07]), 0x7, false, 0xc);
    }

    async setTime(/*time*/) {
        const command = new Uint8Array([0xc2, 0x00, 0x00, 0x90, 0x00, 0x02, 0x17, 0x13, 0x02, 0x06, 0x6d, 0x00, 0x00, 0x00, 0x00, 0x00]);
        const res = await this.sendMassStorageInCommand(command, 0, command.length);
        await this._getStatus(res.expectedTag);
    }

    private async drmRead(param: number, length: number) {
        const command = new Uint8Array([
            0xa4,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0xbd,
            (length >> 8) & 0xff,
            length & 0xff,
            param,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
        ]);
        const result = await this.sendCommandInGetResult(command, length, false, command.length);
        return result.result.subarray(2); // FUN_000b152e defines constant prefix - length. Discard.
    }

    private async drmWrite(param: number, data: Uint8Array) {
        const newData = new Uint8Array(data.length + 2);
        setUint16(newData, data.length, 0);
        newData.set(data, 2);
        const length = newData.length;

        const command = new Uint8Array([
            0xa3,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0xbd,
            (length >> 8) & 0xff,
            length & 0xff,
            param,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
        ]);
        await this.sendCommandOutGetResult(command, newData, command.length);
    }

    async getLeafID() {
        return this.drmRead(0x3b, 0x0a);
    }

    async getDiscID() {
        return this.drmRead(0x3d, 0x12);
    }

    async writeHostLeafID(leafID: Uint8Array, hostNonce: Uint8Array) {
        assert(leafID.length === 8, 'Wrong length of leaf id');
        const finalBuffer = new Uint8Array(2 + 8 + 8);
        finalBuffer.fill(0);
        finalBuffer.set(leafID, 2);
        finalBuffer.set(hostNonce, 10);
        await this.drmWrite(0x30, finalBuffer);
    }

    async getAuthenticationStage2Info() {
        const data = await this.drmRead(0x31, 0x43c);
        assert(data[0] == 0 && data[1] == 0, 'Invalid preffix of auth2 data');

        let _current = 2;
        const read = (len: number) => data.subarray(_current, (_current += len));
        const discId = read(16);
        const mac = read(8);
        const deviceLeafId = read(8);
        const deviceNonce = read(8);

        // EKB info begin
        const keyType = read(4);
        const keyLevel = read(4);
        const ekbid = read(4);
        const zero = read(4);
        const key = read(16);

        assert(arrayEq(ekbid, [0x00, 0x01, 0x00, 0x12]), 'EKBID is not 00010012');
        assert(arrayEq(keyType, [0x00, 0x00, 0x00, 0x01]), 'Key is not one-device');
        assert(arrayEq(keyLevel, [0x00, 0x00, 0x00, 0x09]), 'Not a level 9 key');
        assert(arrayEq(zero, [0x00, 0x00, 0x00, 0x00]), 'Unknown parameter is not equal to 0');
        assert(
            arrayEq(key, [0x6a, 0x7a, 0x4c, 0x7d, 0x5f, 0x3f, 0x86, 0x84, 0x28, 0x6d, 0x1a, 0x12, 0x32, 0x98, 0x22, 0x13]),
            'Key is not the default'
        );

        return { discId, mac, deviceLeafId, deviceNonce };
    }

    async writeAuthenticationStage3Info(hostMac: Uint8Array) {
        const finalBuffer = new Uint8Array(0x41a);
        finalBuffer.fill(0);
        finalBuffer.set(hostMac, 2);
        // Agree to the configuration sent by the device in stage 2
        finalBuffer.set(
            [
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x01, 0x00, 0x12, 0x00, 0x00, 0x00, 0x00, 0xec, 0xd2, 0x63, 0xdb,
                0xfe, 0xc8, 0x3d, 0xd3, 0x25, 0x28, 0x4b, 0x7b, 0x8c, 0xe4, 0xdf, 0xd1,
            ],
            10
        );
        await this.drmWrite(0x32, finalBuffer);
    }

    inSession = false;

    async readICV() {
        const data = await this.drmRead(0x33, 0x404);
        let _current = 2;
        const read = (len: number) => data.subarray(_current, (_current += len));
        const header = read(8);
        const icv = read(16);
        const mac = read(8);
        this.inSession = true;
        return { header, icv, mac };
    }

    async writeICV(icvHeader: Uint8Array, icv: Uint8Array, mac: Uint8Array) {
        const finalBuffer = new Uint8Array(0x402).fill(0);
        finalBuffer.set(icvHeader, 2);
        finalBuffer.set(icv, 8 + 2);
        finalBuffer.set(mac, 16 + 8 + 2);
        this.inSession = false;
        await this.drmWrite(0x34, finalBuffer);
    }
}

export class UMSCHiMDSession {
    hostNonce = createRandomBytes();
    hostLeafId = new Uint8Array([0x02, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    deviceNonce?: Uint8Array;
    discId?: Uint8Array;
    deviceLeafId?: Uint8Array;
    currentIcv?: Uint8Array;
    currentIcvHeader?: Uint8Array;
    sessionKey?: Uint8Array;

    mclistHandle?: HiMDFile;
    currentGeneration?: number;
    headKey?: Uint8Array;
    bodyKey?: Uint8Array;

    allMacs?: Uint8Array;

    constructor(protected driver: SonyVendorUSMCDriver, protected himd: HiMD) {}

    public async performAuthentication() {
        // Authentication 1 - inform the device of the host nonce and leaf id
        await this.driver.writeHostLeafID(this.hostLeafId, this.hostNonce);

        // Authentication 2 - get the device's leaf id, nonce and disc id
        const { deviceLeafId, deviceNonce, discId, mac } = await this.driver.getAuthenticationStage2Info();
        this.deviceLeafId = deviceLeafId;
        this.deviceNonce = deviceNonce;
        this.discId = discId;

        // Verify the MAC send by the device
        // Just to make sure everything is going according to plan
        const recalculatedMac = retailMac(concatUint8Arrays([discId, this.hostNonce, deviceNonce]), MAIN_KEY);
        assert(arrayEq(mac, recalculatedMac), "Device MAC doesn't match!");

        // Create the host MAC
        const hostMac = retailMac(concatUint8Arrays([discId, deviceNonce, this.hostNonce]), MAIN_KEY);

        // Authentication 3 - agree to the device's settings, send host MAC
        await this.driver.writeAuthenticationStage3Info(hostMac);

        // All done! Read the ICV (Main cryptographic parameter binding all tracks together)
        const { header, icv, mac: icvMac } = await this.driver.readICV();
        this.currentIcv = icv;
        this.currentIcvHeader = header;

        // Prepare the new header
        this.currentIcvHeader![1] = 0x20;
        // Increment the generation number.
        this.currentGeneration = getUint32(this.currentIcvHeader!, 4);
        this.currentGeneration++;
        setUint32(this.currentIcvHeader!, this.currentGeneration!, 4);

        // Create the session key
        const sessionKey = retailMac(concatUint8Arrays([discId, mac, hostMac]), MAIN_KEY);
        this.sessionKey = sessionKey;

        // Verify the ICV / ICV MAC
        let icvMacVerify = createIcvMac(concatUint8Arrays([header, icv]), sessionKey);
        //assert(arrayEq(icvMac, icvMacVerify), "ICV MACs do not match!");

        const mclistHandle = await this.himd.openMaclistForReading();
        // Read the current generation

        await mclistHandle.seek(0x38);
        const ekbid = await mclistHandle.read(4);
        assert(arrayEq(ekbid, [0x00, 0x01, 0x00, 0x12]), 'The MAC list has been verified using a different EKB!');

        await mclistHandle.seek(0x10);
        this.headKey = decryptMaclistKey(await mclistHandle.read(0x10));

        await mclistHandle.seek(0x60);
        this.bodyKey = decryptMaclistKey(await mclistHandle.read(0x10));

        await mclistHandle.seek(0x70);
        this.allMacs = await mclistHandle.read(32000);

        await mclistHandle.close();
    }

    public async createNewTrack(track: HiMDRawTrack) {
        const trackKey = createRandomBytes();
        const kek = encryptTrackKey(trackKey);

        track.contentId = new Uint8Array([1, 15, 80, 0, 0, 4, 0, 0, 0, 21, 109, 95, 56, 45, 48, 211, 105, 13, 174, 166]);

        // We have all the parameters required to create a new track on the maclist
        // Rewrite the parameters within the macfile
        const mac = this.createTrackMac(track, trackKey);

        return { contentId: track.contentId, trackKey, kek, mac };
    }

    public createTrackMac(track: HiMDRawTrack, providedKey?: Uint8Array) {
        const trackKey = providedKey ?? createTrackKey(track.ekbNumber, track.key);
        const fullSerializedTrackEntry = new Uint8Array(0x50);
        this.himd.writeTrack(0, track, fullSerializedTrackEntry);
        const mac = createTrackMac(trackKey, fullSerializedTrackEntry.subarray(0x28));
        this.allMacs!.set(mac, (track.trackNumber - 1) * 8);
        return mac;
    }

    protected async calculateNewICV() {
        const generationBytes = new Uint8Array(4);
        setUint32(generationBytes, this.currentGeneration!);

        // Recalculate the new ICV
        const head = concatUint8Arrays([
            generationBytes,
            new Uint8Array(20).fill(0),
            new Uint8Array([0x00, 0x01, 0x00, 0x12]),
            new Uint8Array(4).fill(0),
            this.discId!,
            new Uint8Array(16).fill(0),
        ]);
        const icvHalf = retailMac(head, this.headKey!);
        const icvHalf2 = retailMac(this.allMacs!, this.bodyKey!);
        return concatUint8Arrays([icvHalf, icvHalf2]);
    }

    public async finalizeSession() {
        // Recalculate the new ICV
        this.currentIcv = await this.calculateNewICV();

        await this.himd.advanceGeneration(this.currentGeneration!);
        const mclistHandle = await this.himd.openMaclistForWriting();
        const generationBytes = new Uint8Array(4);
        setUint32(generationBytes, this.currentGeneration!);
        await mclistHandle.seek(0x20);
        await mclistHandle.write(generationBytes);

        // Rewrite disc ID to the macfile
        await mclistHandle.seek(0x40);
        await mclistHandle.write(this.discId!);

        await mclistHandle.seek(0x70);
        await mclistHandle.write(this.allMacs!);

        const newMac = createIcvMac(concatUint8Arrays([this.currentIcvHeader!, this.currentIcv!]), this.sessionKey!);
        await this.driver.writeICV(this.currentIcvHeader!, this.currentIcv!, newMac);
        await mclistHandle.close();
        this.mclistHandle = undefined;
    }
}

const FIRST_N_SECTORS_CACHED = 1000;

export class UMSCHiMDFilesystem extends HiMDFilesystem {
    fatfs: any;
    driver: SonyVendorUSMCDriver;
    rootPath = '/';
    volumeSize: number = 0;
    fsDriver?: SonyVendorUSMCDriver['createArbitraryFatFSVolumeDriver'] extends (...args: any[]) => Promise<infer R> ? R : never;
    fsUncachedDriver?: SonyVendorUSMCDriver['createArbitraryFatFSVolumeDriver'] extends (...args: any[]) => Promise<infer R> ? R : never;

    cacheMutex = new Mutex();

    constructor(protected usbDevice: USBDevice) {
        super();
        this.driver = new SonyVendorUSMCDriver(this.usbDevice, 0x05);
    }
    lowSectorsCache: { dirty: boolean; data: Uint8Array | null }[] = Array(FIRST_N_SECTORS_CACHED)
        .fill(0)
        .map(() => ({ dirty: false, data: null }));

    async flushLowSectors() {
        const release = await this.cacheMutex.acquire();
        let i = 0;
        for (let entry of this.lowSectorsCache) {
            if (entry.dirty && entry.data) {
                await new Promise((res) => this.fsUncachedDriver!.writeSectors!(i, entry.data!, res));
            }
            ++i;
        }
        this.lowSectorsCache = Array(FIRST_N_SECTORS_CACHED)
            .fill(0)
            .map(() => ({ dirty: false, data: null }));
        release();
    }

    async init() {
        await this.driver.init();
        const partInfo = await this.driver.getCapacity();
        this.fsUncachedDriver = await this.driver.createArbitraryFatFSVolumeDriver(
            { firstLBA: 0x0, sectorCount: partInfo.maxLba + 1 },
            partInfo.blockSize,
            true
        );

        this.fsDriver = {
            ...this.fsUncachedDriver,
            readSectors: async (i, dest, cb) => {
                const release = await this.cacheMutex.acquire();
                if (i >= FIRST_N_SECTORS_CACHED) {
                    release();
                    this.fsUncachedDriver!.readSectors(i, dest, cb);
                } else if (this.lowSectorsCache[i].data !== null) {
                    this.lowSectorsCache[i].data!.forEach((v, i) => (dest[i] = v));
                    release();
                    cb(null);
                } else {
                    await new Promise((res) => this.fsUncachedDriver!.readSectors(i, dest, res));
                    this.lowSectorsCache[i].data = new Uint8Array([...dest]);
                    release();
                    cb(null);
                }
            },
            writeSectors: async (i, data, cb) => {
                if (i >= FIRST_N_SECTORS_CACHED) {
                    this.fsUncachedDriver!.writeSectors!(i, data, cb);
                } else {
                    const release = await this.cacheMutex.acquire();
                    this.lowSectorsCache[i].data = new Uint8Array([...data]);
                    this.lowSectorsCache[i].dirty = true;
                    release();
                    cb(null);
                }
            },
        };
        this.fatfs = fatfs.createFileSystem(this.fsDriver);
        this.volumeSize = partInfo.deviceSize;
    }

    async _list(path: string): Promise<HiMDFilesystemEntry[]> {
        const dirContents = await new Promise<string[]>((res, rej) =>
            this.fatfs.readdir(join(this.rootPath, path), (err: any, files: string[]) => (err ? rej(err) : res(files)))
        );
        const ret: HiMDFilesystemEntry[] = [];
        for (let f of dirContents) {
            let name: string = join(path, f),
                type: 'directory' | 'file';
            try {
                const stats = await new Promise<any>((res, rej) =>
                    this.fatfs.stat(join(this.rootPath, path, f), (err: any, stats: any) => (err ? rej(err) : res(stats)))
                );
                type = stats.isDirectory() ? 'directory' : 'file';
            } catch (ex: any) {
                if (ex.code === 'ISDIR') {
                    type = 'directory';
                } else throw ex;
            }

            ret.push({ name, type });
        }
        return ret;
    }

    async open(filePath: string, mode: 'rw' | 'ro' = 'ro'): Promise<HiMDFile> {
        // Ignore uppercase / lowercase distinction
        filePath = await this.transformToValidCase(filePath);

        const path = join(this.rootPath, filePath);
        const stat = await new Promise<any>((res, rej) => this.fatfs.stat(path, (err: any, stat: any) => (err ? rej(err) : res(stat))));
        if (stat.size === 0 && stat.firstCluster === 0 && mode === 'rw') {
            // This is an unallocated file.
            // Make fatfs reallocate it
            await new Promise<any>((res) => this.fatfs.reallocateAnew(path, res));

            this.fatfs = fatfs.createFileSystem(this.fsDriver);
        }
        const fd = await new Promise<number>((res, rej) =>
            this.fatfs.open(path, mode == 'ro' ? 'r' : 'r+', (err: any, fd: number) => (err ? rej(err) : res(fd)))
        );
        return new UMSCHiMDFile(this, mode === 'rw', fd, stat.size);
    }

    async rename(path: string, newPath: string) {
        const exists = await new Promise((res) => {
            this.fatfs.stat(newPath, (err: any, stat: any) => {
                if (err) return res(false);
                res(stat.isFile());
            });
        });
        if (exists) {
            const newName =
                Array(8)
                    .fill(0)
                    .map(() => String.fromCharCode(Math.floor(Math.random() * (90 - 65) + 65)))
                    .join('') + '.WMD';
            await new Promise((res) => this.fatfs.rename(newPath, newName, res));
        }
        await new Promise((res) => this.fatfs.rename(path, newPath.substring(newPath.lastIndexOf('/') + 1), res));
    }

    async getTotalSpace() {
        return this.volumeSize;
    }

    async getSize(path: string) {
        const stats = await new Promise<any>((res, rej) =>
            this.fatfs.stat(join(this.rootPath, path), (err: any, stats: any) => (err ? rej(err) : res(stats)))
        );
        return stats.size;
    }

    getName(){
        let { vendorId, productId } = this.usbDevice;
        let deviceId = DevicesIds.find(device => device.deviceId === productId && device.vendorId === vendorId);
        return deviceId?.name || 'Unknown Device';
    }
}

class UMSCHiMDFile implements HiMDFile {
    offset = 0;

    constructor(private parent: UMSCHiMDFilesystem, private writable: boolean, private fd: number, public length: number) {}
    seek(offset: number): Promise<void> {
        this.offset = offset;
        return Promise.resolve();
    }
    read(length: number = this.length - this.offset): Promise<Uint8Array> {
        return new Promise((res, rej) => {
            const buffer = Buffer.alloc(length);
            this.parent.fatfs.read(this.fd, buffer, 0, length, this.offset, (err: any, read: number, bfr: Uint8Array) => {
                this.offset += read;
                if (err) rej(err);
                else res(bfr);
            });
        });
    }
    write(data: Uint8Array): Promise<void> {
        if (!this.writable) throw new HiMDError('Cannot write to a read-only opened file');
        return new Promise((res, rej) =>
            this.parent.fatfs.write(this.fd, Buffer.from(data), 0, data.length, this.offset, (err: any, written: number, buffer: any) => {
                if (err) return rej(err);
                this.offset += written;
                this.length = Math.max(this.offset, this.length);
                res();
            })
        );
    }
    async close(): Promise<void> {
        await new Promise((res) => this.parent.fatfs.close(this.fd, res));
        await this.parent.flushLowSectors();
    }
}
