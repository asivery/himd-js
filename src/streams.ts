import { decryptBlock } from "./encryption";
import { getUint16 } from "./utils";
import { HiMDFile } from "./filesystem";
import { HiMD, HiMDError, HiMDFragment } from "./himd";

export const BLOCK_SIZE = 0x4000;

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
			lastFrame = this.isMpeg() ? currentFragment.lastFrame - 1 : currentFragment.lastFrame;
			this.currentFragment++;
			currentFragment = this.fragments[this.currentFragment];
			if(this.currentFragment < this.fragments.length){
				this.currentBlock = currentFragment.firstBlock;
			}
		}else{
			lastFrame = this.isMpeg() ? getUint16(block, 4) - 1 : this.framesPerBlock - 1;
			this.currentBlock++;
		}

		return { block, key, firstFrame, lastFrame };
	}
}

const defaultDecryptor = (masterKey: Uint8Array, key: Uint8Array, data: Uint8Array) =>
    new Promise<Uint8Array>(res => res(decryptBlock(masterKey, key, data)));

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

    public async readBlock(decryptor: (masterKey: Uint8Array, key: Uint8Array, data: Uint8Array) => Promise<Uint8Array> = defaultDecryptor){
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
        const decryptedBlock = await decryptor(
            this.masterKey,
            key,
            block,
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
        const { block, key, firstFrame, lastFrame } = result;

        if(firstFrame > lastFrame){
            throw new HiMDError("LastFrame > FirstFrame");
        }

        const dataFrames = getUint16(block, 4);
        const dataBytes = getUint16(block, 8);

        if(dataBytes > 0x3FC0){
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
