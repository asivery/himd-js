import { HiMDFile, HiMDFilesystem, HiMDFilesystemEntry } from './himd-filesystem';
import { getBEUint32AsBytes, USBMassStorageDriver } from 'node-mass-storage';
import { CachedDirectory, FatFilesystem, FatFSFileHandle } from 'nufatfs';
import { HiMDError, DevicesIds } from '../himd';
import { arrayEq, assert, setUint16, join } from '../utils';
import { Mutex } from 'async-mutex';
import { SCSISessionDriver } from '../secure-session';

export class SonyVendorUSMCDriver extends USBMassStorageDriver implements SCSISessionDriver {
    isDeviceConnected(device: USBDevice) {
        return this.usbDevice === device;
    }

    async preventAllowMediumRemoval(status: 'prevent' | 'allow') {
        const command = new Uint8Array([0x1e, 0x0, 0x0, 0x0, status === 'prevent' ? 0xff : 0x0]);
        const result = await this.sendMassStorageInCommand(command, 0, 0xc);
        await this._getStatus(result.expectedTag);
    }

    async testUnitReady() {
        return await this.sendCommandInGetResult(new Uint8Array(0xc).fill(0), 0x00, true);
    }

    async getTime() {
        return await this.sendCommandInGetResult(new Uint8Array([0xc2, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x00, 0x07]), 0x7, false, 0xc);
    }

    async setTime(/*time*/) {
        const command = new Uint8Array([0xc2, 0x00, 0x00, 0x90, 0x00, 0x02, 0x17, 0x13, 0x02, 0x06, 0x6d, 0x00, 0x00, 0x00, 0x00, 0x00]);
        const res = await this.sendMassStorageInCommand(command, 0, command.length);
        await this._getStatus(res.expectedTag);
    }

    protected async drmRead(param: number, length: number) {
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

    protected async drmWrite(param: number, data: Uint8Array) {
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

    protected async himdDeviceControl(applicationId: 0 | 1 | 2, subcommand: number, flags: number, dataLength: number){
        // TODO: Compare this command's sequence with the firmware.
        const command = new Uint8Array([
            0xc2, 0x00, applicationId, subcommand, flags, ...getBEUint32AsBytes(dataLength), 0, 0, 0
        ]);
        const res = await this.sendCommandInGetResult(command, dataLength, true, command.length);
        await this.awaitSystemReady();
        return res;
    }

    protected async awaitSystemReady(progressCallback?: (action: number, progress: number) => void){
        let senseResult;
        do{
            senseResult = await this.getSense();
            progressCallback?.(senseResult.result[15], (senseResult.result[16] << 8) | senseResult.result[17]);
            await new Promise(res => setTimeout(res, 200));
        }while(!senseResult.result.slice(15, 18).every(v => v === 0));
    }

    public async reformatHiMD(){
        return await this.himdDeviceControl(0, 1, 0b011, 0);
    }

    public async wipe(){
        return await this.himdDeviceControl(0, 0, 0b11, 0);
    }
}

const FIRST_N_SECTORS_CACHED = 1000;

const createLowSectorsCache = () => Array(FIRST_N_SECTORS_CACHED)
    .fill(0)
    .map(() => ({ dirty: false, data: null }));

export class UMSCHiMDFilesystem extends HiMDFilesystem {
    fatfs?: FatFilesystem;
    driver: SonyVendorUSMCDriver;
    rootPath = '/';
    volumeSize: number = 0;
    fsDriver?: SonyVendorUSMCDriver['createArbitraryNUFatFSVolumeDriver'] extends (...args: any[]) => Promise<infer R> ? R : never;
    fsUncachedDriver?: SonyVendorUSMCDriver['createArbitraryNUFatFSVolumeDriver'] extends (...args: any[]) => Promise<infer R> ? R : never;

    cacheMutex = new Mutex();

    constructor(protected usbDevice: USBDevice) {
        super();
        this.driver = new SonyVendorUSMCDriver(this.usbDevice, 0x05);
    }
    lowSectorsCache: { dirty: boolean; data: Uint8Array | null }[] = createLowSectorsCache();

    protected async initFS(bypassCoherencyChecks: boolean = false){
        const partInfo = await this.driver.getCapacity();
        this.fsUncachedDriver = await this.driver.createArbitraryNUFatFSVolumeDriver(
            { firstLBA: 0x0, sectorCount: partInfo.maxLba + 1 },
            partInfo.blockSize,
            true
        );

        this.fatfs = await FatFilesystem.create(this.fsUncachedDriver, bypassCoherencyChecks);
        this.volumeSize = partInfo.deviceSize;
        this.lowSectorsCache = createLowSectorsCache();
    }

    async init(bypassCoherencyChecks: boolean = false) {
        await this.driver.init();
        await this.initFS(bypassCoherencyChecks);
    }

    async list(path: string): Promise<HiMDFilesystemEntry[]> {
        return this._list(path);
    }

    async _list(path: string): Promise<HiMDFilesystemEntry[]> {
        const dirContents = await this.fatfs!.listDir(join(this.rootPath, path));
        if(!dirContents) return [];
        const ret: HiMDFilesystemEntry[] = [];
        for (let f of dirContents) {
            let name: string = join(path, f),
                type: 'directory' | 'file';
            if(f.endsWith("/")){
                name = name.substring(0, name.length - 1);
                type = 'directory';
            }else{
                type = 'file';
            }

            ret.push({ name, type });
        }
        return ret;
    }

    async open(filePath: string, mode: 'rw' | 'ro' = 'ro'): Promise<HiMDFile> {
        // Ignore uppercase / lowercase distinction
        filePath = await this.transformToValidCase(filePath);

        const path = join(this.rootPath, filePath);
        const handle = await this.fatfs!.open(path, mode === 'rw');
        if(!handle) throw new Error("Cannot open file " + path);
        
        return new UMSCHiMDFile(this, mode === 'rw', handle);
    }

    async rename(path: string, newPath: string) {
        await this.fatfs!.rename(path, newPath);
        await this.fatfs!.flushMetadataChanges();
    }

    async getTotalSpace() {
        return this.volumeSize;
    }

    async getSize(path: string) {
        return (await this.fatfs!.getSizeOf(path))!;
    }

    async wipeDisc(reinitializeHiMDFilesystem: boolean){
        if(reinitializeHiMDFilesystem){
            await this.driver.reformatHiMD();
        }else{
            await this.driver.wipe();
        }
        await this.initFS();
    }

    async freeFileRegions(filePath: string, regions: { startByte: number, length: number }[]){
        const tree = await this.fatfs!.getUnderlying().traverseEntries(filePath);
        if(!tree) throw new HiMDError("Illegal request to free regions of a non-existent file!");
        const [parent, entry] = tree.slice(-2);
        if(!entry || (entry instanceof CachedDirectory)) {
            throw new HiMDError("Illegal request to free regions of a non-file!");
        }
        const clusterChain = this.fatfs!.getUnderlying().getClusterChainFromFAT(entry.firstClusterAddressLow | (entry.firstClusterAddressHigh << 16));
        const clusterSize = this.fatfs!.getUnderlying().clusterSizeInBytes;
        // Sort from highest to lowest
        regions.sort((a, b) => b.startByte - a.startByte);
        const oldInitial = clusterChain[0];
        let totalBytesFreed = 0;
        for(const { startByte, length } of regions){
            if(
                ((startByte % clusterSize) !== 0) ||
                ((length % clusterSize) !== 0)
            ) {
                throw new HiMDError(`Illegal request to free non-aligned parts of file (@${startByte}->${startByte + length})`);
            }
            const startCluster = startByte / clusterSize;
            const clusterCount = length / clusterSize;
            totalBytesFreed += length;

            if(startCluster + clusterCount > clusterChain.length) {
                throw new HiMDError("Illegal request to free parts of file outside of the file's boundaries!");
            }

            clusterChain.splice(startCluster, clusterCount);
        }
        this.fatfs!.getUnderlying().redefineClusterChain(oldInitial, clusterChain);
        entry.fileSize -= totalBytesFreed;
        entry.firstClusterAddressHigh = (clusterChain[0] & 0xFFFF0000) >> 16;
        entry.firstClusterAddressLow = clusterChain[0] & 0xFFFF;
        this.fatfs!.getUnderlying().markAsAltered(parent as CachedDirectory);
        await this.fatfs!.flushMetadataChanges();
    }

    getName(){
        let { vendorId, productId } = this.usbDevice;
        let deviceId = DevicesIds.find(device => device.deviceId === productId && device.vendorId === vendorId);
        return deviceId?.name || 'Unknown Device';
    }
}

class UMSCHiMDFile implements HiMDFile {
    offset = 0;

    public get length(){
        return this.handle.length;
    }

    public set length(e: number){
        throw new HiMDError("Cannot set length of file!")
    }

    constructor(private parent: UMSCHiMDFilesystem, private writable: boolean, private handle: FatFSFileHandle) {}
    seek(offset: number): Promise<void> {
        this.offset = offset;
        this.handle.seek(offset);
        return Promise.resolve();
    }
    read(length: number = this.length - this.offset): Promise<Uint8Array> {
        return this.handle.read(length);
    }
    write(data: Uint8Array): Promise<void> {
        if (!this.writable) throw new HiMDError('Cannot write to a read-only opened file');
        return this.handle.write!(data);
    }
    async close(): Promise<void> {
        await this.handle.close();
        await this.parent.fatfs!.flushMetadataChanges();
    }
}
