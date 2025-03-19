import { MAIN_KEY, createIcvMac, createTrackKey, createTrackMac, decryptMaclistKey, encryptTrackKey, retailMac } from "./encryption";
import { HiMDFile } from "./filesystem";
import { HiMD, HiMDRawTrack } from "./himd";
import { assert, concatUint8Arrays, createRandomBytes, getUint32, setUint32, arrayEq } from "./utils";

export interface SCSISessionDriver {
    writeHostLeafID(leafID: Uint8Array, hostNonce: Uint8Array): Promise<void>;
    writeAuthenticationStage3Info(hostMac: Uint8Array): Promise<void>;
    readICV(): Promise<{ header: Uint8Array, icv: Uint8Array, mac: Uint8Array }>;
    writeICV(icvHeader: Uint8Array, icv: Uint8Array, mac: Uint8Array): Promise<void>;
    getAuthenticationStage2Info(): Promise<{ discId: Uint8Array, mac: Uint8Array, deviceLeafId: Uint8Array, deviceNonce: Uint8Array }>;
}

export class HiMDSecureSession {
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

    constructor(protected himd: HiMD, protected driver?: SCSISessionDriver) {}

    public async performAuthentication() {
        if(this.driver) {
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
        }

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

    public async createAndSignNewTrack(track: HiMDRawTrack) {
        const trackKey = createRandomBytes();
        const kek = encryptTrackKey(trackKey);

        track.contentId = new Uint8Array([1, 15, 80, 0, 0, 4, 0, 0, 0, 21, 109, 95, 56, 45, 48, 211, 105, 13, 174, 166]);

        // We have all the parameters required to create a new track on the maclist
        // Rewrite the parameters within the macfile
        const mac = this.createTrackMac(track, trackKey);

        track.key = kek;
        track.mac = mac;
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

        if(this.driver) {
            const newMac = createIcvMac(concatUint8Arrays([this.currentIcvHeader!, this.currentIcv!]), this.sessionKey!);
            await this.driver.writeICV(this.currentIcvHeader!, this.currentIcv!, newMac);
        }
        await mclistHandle.close();
        this.mclistHandle = undefined;
    }
}
