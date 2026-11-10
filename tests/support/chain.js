// -----------------------------------------------------------
//  [*] Test support — a Bitlitas chain and its block templates
//
//  The chain the fake daemon serves. Block templates are
//  built byte for byte the way bitlitasd v0.18 builds them —
//  tests/hashing/block-blobs.test.js holds the builder to a
//  real template the daemon handed out — so the pool parses,
//  extends and submits exactly what it would in production:
//  the header (major and minor version, timestamp, previous
//  block, nonce), the miner transaction with its one output
//  and the 17 reserved extra-nonce bytes the pool asks for,
//  and an empty transaction list. From hard fork 15 the miner
//  output is a view-tagged key, as it is on Bitlitas mainnet
//  past height 506,000.
//
//  Heights start where Bitlitas mainnet runs the RandomX
//  rules (hard fork 12 at height 353,064, or 16 at 506,720),
//  so the pool sees the heights, seed epochs and versions it
//  would meet there. Blocks below the start, and blocks that
//  "someone else" mines, get stable made-up hashes; a block
//  the pool submits gets the id cryptoforknote-util computes
//  for it, which tests/hashing/randomx.test.js holds to real
//  Monero blocks.
//
//  Split into:
//
//    seedHeight         — the RandomX seed height of a height
//    buildTemplateBlob  — one block template, byte for byte
//    parseTemplateBlob  — its fields back, for assertions
//    madeUpHash         — a stable hash for a label
//    FakeChain          — heights, hashes, headers, templates
//
//  Used by:
//    - tests/support/daemon.js, tests/support/rounds.js, the
//      hashing suites, tests/stratum/jobs.test.js
// -----------------------------------------------------------

const crypto = require('crypto');
const cnUtil = require('cryptoforknote-util');
const { encodeVarint } = require('./addresses.js');


// A RandomX seed epoch is 2048 blocks long, and the seed
// changes 64 blocks into the next (src/crypto/rx-slow-hash.c)
const SEEDHASH_EPOCH_BLOCKS = 2048;

// The 64 blocks a new seed waits, announced as the next seed
const SEEDHASH_EPOCH_LAG = 64;

// A coinbase output unlocks 60 blocks later
// (CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW)
const UNLOCK_WINDOW = 60;

// Miner outputs carry a view tag from this hard fork on
// (HF_VERSION_VIEW_TAGS)
const VIEW_TAG_FORK = 15;

// Where Bitlitas mainnet switched to the rules a test picks
// (src/hardforks/hardforks.cpp of the v0.18 tree)
const FORK_HEIGHTS = { 12: 353064, 16: 506720 };

// The reserve the pool asks every template for (lib/daemon.js)
const POOL_RESERVE_SIZE = 17;

// What a block paid at height 241 of the fixture regtest chain
const DEFAULT_REWARD = 35168236092881;







// -----------------------------------------------------------
// seedHeight
// -----------------------------------------------------------
//
// The height whose block hash keys RandomX at a given height:
// the genesis block for the first epoch and its lag, then the
// last multiple of 2048 at least 65 blocks back — the rule
// rx_seedheight applies in the daemon.
//
// Used by:
//   - FakeChain (below), tests/support/daemon.js,
//     tests/hashing/randomx.test.js
// -----------------------------------------------------------

function seedHeight (height) {

	if (height <= SEEDHASH_EPOCH_BLOCKS + SEEDHASH_EPOCH_LAG) return 0;
	return (height - SEEDHASH_EPOCH_LAG - 1) & ~(SEEDHASH_EPOCH_BLOCKS - 1);
}







// -----------------------------------------------------------
// buildTemplateBlob
// -----------------------------------------------------------
//
// One block template as the daemon serialises it, with the
// offset of the reserved extra-nonce bytes. The minor
// version repeats the major one and the nonce is zero, as in
// every template bitlitasd hands out; the miner transaction
// is version 2 with RingCT type null and unlocks
// UNLOCK_WINDOW blocks on.
//
// Used by:
//   - FakeChain.template (below), tests/hashing/block-blobs.test.js
// -----------------------------------------------------------

function buildTemplateBlob ({ major, timestamp, prevHash, height, reward, outputKey, viewTag, txPubKey, reserveSize }) {

	const taggedOutput = major >= VIEW_TAG_FORK;
	const output = taggedOutput ?
		Buffer.concat([Buffer.from([0x03]), outputKey, Buffer.from([viewTag])]) :
		Buffer.concat([Buffer.from([0x02]), outputKey]);
	const extra = Buffer.concat([Buffer.from([0x01]), txPubKey, Buffer.from([0x02]), encodeVarint(reserveSize), Buffer.alloc(reserveSize)]);


	const head = Buffer.concat([
		encodeVarint(major), encodeVarint(major), encodeVarint(timestamp), prevHash, Buffer.alloc(4),
		encodeVarint(2), encodeVarint(height + UNLOCK_WINDOW),
		encodeVarint(1), Buffer.from([0xff]), encodeVarint(height),
		encodeVarint(1), encodeVarint(reward), output,
		encodeVarint(extra.length)
	]);
	const blob = Buffer.concat([head, extra, Buffer.from([0x00]), encodeVarint(0)]);
	return { blob, reservedOffset: head.length + extra.length - reserveSize };
}







// -----------------------------------------------------------
// parseTemplateBlob
// -----------------------------------------------------------
//
// The fields of a template or block blob of this one-output
// shape, read back: versions, timestamp, previous block,
// nonce, height, reward, output key and view tag, the
// transaction key and the reserved bytes. Tests read a
// submitted block with it, and the builder test reads the
// real template it rebuilds.
//
// Used by:
//   - tests/hashing/block-blobs.test.js
// -----------------------------------------------------------

function parseTemplateBlob (blob) {

	let offset = 0;
	const varint = () => {
		let value = 0n;
		let shift = 0n;
		while (true) {
			const byte = blob[offset++];
			value |= BigInt(byte & 0x7f) << shift;
			shift += 7n;
			if (!(byte & 0x80)) return value;
		}
	};
	const bytes = (count) => blob.subarray(offset, offset += count);


	const fields = { major: Number(varint()), minor: Number(varint()), timestamp: Number(varint()) };
	fields.prevHash = bytes(32);
	fields.nonceOffset = offset;
	fields.nonce = bytes(4);
	varint();
	fields.unlockTime = Number(varint());
	varint();
	offset++;
	fields.height = Number(varint());
	varint();
	fields.reward = Number(varint());
	fields.outputTag = blob[offset++];
	fields.outputKey = bytes(32);
	fields.viewTag = fields.outputTag === 0x03 ? blob[offset++] : null;


	const extraLength = Number(varint());
	const extraStart = offset;
	offset++;
	fields.txPubKey = bytes(32);
	offset++;
	const reserveSize = Number(varint());
	fields.reservedOffset = offset;
	fields.reserved = bytes(reserveSize);
	fields.extraLength = extraLength;
	fields.extraEnd = extraStart + extraLength;
	return fields;
}







// -----------------------------------------------------------
// madeUpHash
// -----------------------------------------------------------
//
// A stable 32-byte hash for a label: the same label always
// names the same block in every run.
//
// Used by:
//   - FakeChain (below), tests/support/rounds.js
// -----------------------------------------------------------

function madeUpHash (label) {

	return crypto.createHash('sha256').update('bitlitas-fake-chain:' + label).digest('hex');
}







// -----------------------------------------------------------
// FakeChain
// -----------------------------------------------------------
//
// The daemon's view of the chain: a tip, the blocks above the
// starting height, headers in the shape getblockheaderbyheight
// and getlastblockheader return, and templates for the next
// height. Tests move it the way the network would — a block
// found elsewhere, the pool's own block accepted, the tip
// replaced by another block at the same height, a longer
// branch replacing the blocks from some height on — and set the
// difficulty a template asks for: the default makes no share
// a block; a height in `easyHeights` asks for difficulty 1
// there alone, so the share that comes first at that height
// is a block and the templates after it are hard again, however
// late the pool fetches them.
//
// Used by:
//   - tests/support/daemon.js
// -----------------------------------------------------------

class FakeChain {

	constructor ({ major = 12, height = FORK_HEIGHTS[major] + 136, difficulty = 2 ** 52, reward = DEFAULT_REWARD } = {}) {
		this.major = major;
		this.difficulty = difficulty;
		this.easyHeights = new Set();
		this.reward = reward;
		this.blocks = new Map();
		this.tipHeight = height - 1;
		this.branch = 'main';
		this.clock = 1794173844;
	}


	hashAt (height) {
		const block = this.blocks.get(height);
		return block ? block.hash : madeUpHash(height);
	}


	get tipHash () {
		return this.hashAt(this.tipHeight);
	}


	difficultyAt (height) {
		return this.easyHeights.has(height) ? 1 : this.difficulty;
	}


	header (height) {
		const block = this.blocks.get(height) || { hash: this.hashAt(height), timestamp: this.clock - (this.tipHeight - height) * 120, reward: this.reward, difficulty: this.difficulty, nonce: 0 };
		const cumulative = 1000000 + height;
		return {
			block_size: 103,
			block_weight: 103,
			cumulative_difficulty: cumulative,
			cumulative_difficulty_top64: 0,
			depth: this.tipHeight - height,
			difficulty: block.difficulty,
			difficulty_top64: 0,
			hash: block.hash,
			height: height,
			long_term_weight: 176470,
			major_version: this.major,
			miner_tx_hash: madeUpHash('miner-tx:' + block.hash),
			minor_version: this.major,
			nonce: block.nonce,
			num_txes: 0,
			orphan_status: false,
			pow_hash: '',
			prev_hash: height > 0 ? this.hashAt(height - 1) : '0'.repeat(64),
			reward: block.reward,
			timestamp: block.timestamp,
			wide_cumulative_difficulty: '0x' + cumulative.toString(16),
			wide_difficulty: '0x' + block.difficulty.toString(16)
		};
	}


	template (reserveSize = POOL_RESERVE_SIZE) {
		const height = this.tipHeight + 1;
		const label = this.branch + ':' + height;
		const { blob, reservedOffset } = buildTemplateBlob({
			major: this.major,
			timestamp: this.clock + 1,
			prevHash: Buffer.from(this.tipHash, 'hex'),
			height,
			reward: this.reward,
			outputKey: Buffer.from(madeUpHash('output:' + label), 'hex'),
			viewTag: 0x49,
			txPubKey: Buffer.from(madeUpHash('tx-key:' + label), 'hex'),
			reserveSize
		});
		const seed = seedHeight(height);
		const nextSeed = seedHeight(height + SEEDHASH_EPOCH_LAG);
		const difficulty = this.difficultyAt(height);
		return {
			blockhashing_blob: cnUtil.convert_blob(blob, 0).toString('hex'),
			blocktemplate_blob: blob.toString('hex'),
			difficulty,
			difficulty_top64: 0,
			expected_reward: this.reward,
			height,
			next_seed_hash: nextSeed !== seed ? this.hashAt(nextSeed) : '',
			prev_hash: this.tipHash,
			reserved_offset: reservedOffset,
			seed_hash: this.hashAt(seed),
			seed_height: seed,
			status: 'OK',
			untrusted: false,
			wide_difficulty: '0x' + difficulty.toString(16)
		};
	}


	mineElsewhere (count = 1) {
		for (let i = 0; i < count; i++) {
			this.clock += 120;
			this.tipHeight++;
			this.blocks.set(this.tipHeight, {
				hash: madeUpHash(this.branch + ':found-elsewhere:' + this.tipHeight),
				timestamp: this.clock,
				reward: this.reward,
				difficulty: this.difficulty,
				nonce: 0
			});
		}
		return this.tipHash;
	}


	accept (blob, nonce) {
		this.clock += 120;
		this.tipHeight++;
		const hash = cnUtil.get_block_id(blob, 0).toString('hex');
		this.blocks.set(this.tipHeight, { hash, timestamp: this.clock, reward: this.reward, difficulty: this.difficultyAt(this.tipHeight), nonce });
		return hash;
	}


	replaceTip () {
		this.branch += "'";
		this.blocks.set(this.tipHeight, {
			hash: madeUpHash(this.branch + ':replaced:' + this.tipHeight),
			timestamp: this.clock + 5,
			reward: this.reward,
			difficulty: this.difficulty,
			nonce: 0
		});
		return this.tipHash;
	}


	// Another branch takes over from a height on: every block
	// from there to the tip is replaced, and the new branch
	// runs `longer` blocks past the old tip
	reorg (fromHeight, longer = 1) {
		this.branch += "'";
		const tip = this.tipHeight + longer;
		for (let height = fromHeight; height <= tip; height++) {
			this.blocks.set(height, {
				hash: madeUpHash(this.branch + ':reorg:' + height),
				timestamp: this.clock + (height - this.tipHeight) * 120,
				reward: this.reward,
				difficulty: this.difficulty,
				nonce: 0
			});
		}
		this.clock += longer * 120;
		this.tipHeight = tip;
		return this.tipHash;
	}
}







// What the suites take from here
module.exports = {
	SEEDHASH_EPOCH_BLOCKS,
	UNLOCK_WINDOW,
	FORK_HEIGHTS,
	POOL_RESERVE_SIZE,
	DEFAULT_REWARD,
	seedHeight,
	buildTemplateBlob,
	parseTemplateBlob,
	madeUpHash,
	FakeChain
};
