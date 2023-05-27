import { decryptBlock, encryptBlock } from "./encryption";
import { getUint16, setUint16, setUint32 } from "./utils";
import { HiMDFile } from "./filesystem";
import { HiMDBlockInfo, HiMD, HiMDError, HiMDFragment } from "./himd";
import { CryptoProvider } from "./workers";

export const BLOCK_SIZE = 0x4000;
export const HIMD_AUDIO_SIZE = 0x3FC0;

export class HiMDBlockStream{
    protected currentBlock = 0;
    protected currentFragment = 0;
	constructor(
		protected himd: HiMD,
		protected atdata: HiMDFile,
		public fragments: HiMDFragment[],
		public framesPerBlock: number,
	){
        this.currentBlock = this.fragments[0].firstBlock;
    }

	async close(){
		await this.atdata.close();
	}

	isMpeg(){
		return this.framesPerBlock === 0; // TRACK_IS_MPEG = 0
	}
	
	async read(){
		// [Fragment [Block [Frame][Frame][Frame]][Block][Block]]
		if(this.currentFragment === this.fragments.length){
			//EOF
			return null;
		}

		let currentFragment = this.fragments[this.currentFragment];

		let firstFrame = 0; // An offset to actual data within the block
		let lastFrame; // Last offset of valid data

		if(this.currentBlock === currentFragment.firstBlock){
			firstFrame = currentFragment.firstFrame;
			await this.atdata.seek(this.currentBlock * BLOCK_SIZE);
		}
		const block = await this.atdata.read(BLOCK_SIZE);
		const key = currentFragment.key;
		if(this.currentBlock === currentFragment.lastBlock){
			lastFrame = this.isMpeg() ? (currentFragment.lastFrame - 1) : currentFragment.lastFrame;
			this.currentFragment++;
			currentFragment = this.fragments[this.currentFragment];
			if(this.currentFragment < this.fragments.length){
				this.currentBlock = currentFragment.firstBlock;
			}
		}else{
			lastFrame = this.isMpeg() ? (getUint16(block, 4) - 1) : this.framesPerBlock - 1;
			this.currentBlock++;
		}

		return { block, key, firstFrame, lastFrame };
	}
}

const defaultCryptoProvider: CryptoProvider = {
    close: () => {},
    decryptor: (trackKey: Uint8Array, fragmentKey: Uint8Array, blockKey: Uint8Array, blockIv: Uint8Array, audioData: Uint8Array) =>
        Promise.resolve(decryptBlock(trackKey, fragmentKey, blockKey, blockIv, audioData)),
    encryptor: (trackKey: Uint8Array, fragmentKey: Uint8Array, blockKey: Uint8Array, blockIv: Uint8Array, plainText: Uint8Array) =>
        Promise.resolve(encryptBlock(trackKey, fragmentKey, blockKey, blockIv, plainText)),
};

export class HiMDNonMP3Stream{
    protected blockBuffer?: Uint8Array;

    constructor(
        public blockStream: HiMDBlockStream,
        public frameSize: number,
        protected masterKey: Uint8Array,
    ){}

    public async readFrame(){
        if(!this.blockBuffer || this.blockBuffer.length === 0){
            const res = await this.readBlock();
            if(!res) return null;
            this.blockBuffer = res.block;
        }
        const frame = this.blockBuffer!.subarray(0, this.frameSize);
        this.blockBuffer = this.blockBuffer!.subarray(this.frameSize);
        return frame;
    }

    public async readBlock(cryptoProvider: CryptoProvider = defaultCryptoProvider){
        if(this.blockBuffer && this.blockBuffer?.length !== 0){
            // Consume the last buffered part of the block
            const ret = {
                framesCount: this.blockBuffer!.length / this.frameSize,
                block: this.blockBuffer!
            };
            this.blockBuffer = undefined;
            return ret;
        }
        const result = await this.blockStream.read();
        if(!result){
            return null;
        }
        const { block, key, firstFrame, lastFrame } = result;
        debugger;
        const decryptedBlock = await cryptoProvider.decryptor(
            this.masterKey,
            key,
            block.subarray(16, 16 + 8),
            block.subarray(24, 24 + 8),
            block.subarray(32, HIMD_AUDIO_SIZE + 32),
        );
        const framesCount = lastFrame - firstFrame + 1;
        return {
            block: decryptedBlock.subarray(firstFrame * this.frameSize, (lastFrame + 1) * this.frameSize),
            framesCount,
        };
    }
}

export class HiMDMP3Stream{
    constructor(
        public blockStream: HiMDBlockStream,
        public frameSize: number,
        private key: Uint8Array,
    ){}

    public async readBlock(){
        // Omitted code for reading part of the last cached block - reading by frames is not used

        const result = await this.blockStream.read();
        if(!result){
            return null;
        }
        const { block, firstFrame, lastFrame } = result;

        if(firstFrame > lastFrame){
            throw new HiMDError("LastFrame > FirstFrame");
        }

        const dataFrames = getUint16(block, 4);
        const dataBytes = getUint16(block, 8);

        if(dataBytes > HIMD_AUDIO_SIZE){
            throw new HiMDError(`Block contains ${dataBytes} bytes of MPEG data - too much`);
        }
        if(lastFrame >= dataFrames){
            throw new HiMDError(`Last requrested frame ${lastFrame} past number of frames ${dataFrames}`);
        }

        for(let i = 0; i< (dataBytes & ~7); i++){
            block[i+0x20] ^= this.key[i & 3];
        }

        const framesCount = lastFrame - firstFrame + 1;

        return {
            block: block.subarray(0x20, dataBytes + 0x20),
            framesCount,
        };
    }
}

function serializeBlock(blockInfo: HiMDBlockInfo){
    const data = new Uint8Array(BLOCK_SIZE);
    data.fill(0);
    data.set(blockInfo.type);
    setUint16(data, blockInfo.nFrames, 4);
    setUint16(data, blockInfo.mCode, 6);
    setUint16(data, blockInfo.lendata, 8);
    setUint32(data, blockInfo.serialNumber, 12);
    data.set(blockInfo.key, 16);
    data.set(blockInfo.iv, 24);
    data.set(blockInfo.audioData, 32);
    data.set(blockInfo.backupType, 16368);
    setUint16(data, blockInfo.backupMCode, 16374);
    setUint32(data, blockInfo.lo32ContentId, 16376);
    setUint32(data, blockInfo.backupSerialNumber, 16380);
    return data;
}

export class HiMDWriteStream{
    protected firstBlock: number;
    protected blockCount: number = 0;
    constructor(
        protected himd: HiMD,
        protected atdata: HiMDFile,
        protected doNotCloseATData?: boolean,

        protected trackKey?: Uint8Array,
        protected fragmentKey?: Uint8Array,
    ){
        this.firstBlock = this.atdata.length / BLOCK_SIZE;
    }

    public setKeys(trackKey: Uint8Array, fragmentKey: Uint8Array){
        this.trackKey = trackKey;
        this.fragmentKey = fragmentKey;
    }

    public async writeAndEncryptAudioBlock(block: HiMDBlockInfo, cryptoProvider: CryptoProvider = defaultCryptoProvider){
        if(!this.trackKey || !this.fragmentKey)
            throw new HiMDError("Tring to use himd write stream's encryption features without setting appropriate keys");
        block.audioData = await cryptoProvider.encryptor(this.trackKey!, this.fragmentKey!, block.key, block.iv, block.audioData);
        await this.writeAudioBlock(block);
    }

    public async writeAudioBlock(block: HiMDBlockInfo){
        this.blockCount++;
        await this.atdata.write(serializeBlock(block));
    }

    public async close(){
        if(!this.doNotCloseATData)
            await this.atdata.close();
        const lastBlock = this.firstBlock + this.blockCount - 1;
        return {
            firstBlock: this.firstBlock,
            lastBlock: lastBlock,
        };
    }
}
