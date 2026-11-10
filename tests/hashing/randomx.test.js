// -----------------------------------------------------------
//  [*] Tests — RandomX and block ids against real blocks
//
//  The pool trusts two native modules for everything a share
//  and a block are: cryptoforknote-util turns a block into
//  its hashing blob and its id, cryptonight-hashing computes
//  RandomX. Bitlitas v0.18 mines Monero's RandomX unchanged
//  (the same Argon2 salt, memory and program size in
//  external/randomx), so three real Monero mainnet blocks —
//  heights 2,000,000 (fork 12), 2,500,000 (fork 14) and
//  3,000,000 (fork 16, view-tagged outputs), the shapes
//  Bitlitas blocks take on either side of its own forks —
//  are the ground truth: their ids must come out as the
//  network's hashes, and their RandomX hashes under the
//  configured algorithm and variant must meet the difficulty
//  the network accepted them at. A wrong hash meets such a
//  difficulty about once in a hundred billion tries.
//
//  tests/fixtures/monero-mainnet-blocks.json holds the blocks
//  as two public nodes served them, which agreed byte for
//  byte, and the RandomX hash this build computed for each.
// -----------------------------------------------------------

const { describe, it } = require('node:test');
const assert = require('node:assert');
const cnHashing = require('cryptonight-hashing');
const cnUtil = require('cryptoforknote-util');
const blocks = require('../fixtures/monero-mainnet-blocks.json');
const regtest = require('../fixtures/bitlitasd-regtest.json');
const { seedHeight } = require('../support/chain.js');
const { meetsDifficulty } = require('../support/daemon.js');
const { SHIPPED_CONFIG } = require('../support/world.js');


// The shipped configuration
const CONFIG = require(SHIPPED_CONFIG);

// The hashing function its algorithm names, picked the way
// lib/pool.js picks it
const RANDOMX = cnHashing[CONFIG.cnAlgorithm];







// -----------------------------------------------------------
// Real blocks
// -----------------------------------------------------------
//
// Each fixture block's id and RandomX hash, then the same
// block hashed wrong in two ways.
// -----------------------------------------------------------

describe('a real mainnet block', () => {

	for (const block of blocks) {

		it('at height ' + block.height + ' (fork ' + block.major_version + ') has the id the network gave it', () => {
			assert.equal(cnUtil.get_block_id(Buffer.from(block.blob, 'hex'), CONFIG.cnBlobType).toString('hex'), block.hash);
		});


		it('at height ' + block.height + ' hashes under its seed to a RandomX hash that meets its difficulty', { timeout: 60000 }, () => {
			const hashingBlob = cnUtil.convert_blob(Buffer.from(block.blob, 'hex'), CONFIG.cnBlobType);
			const hash = RANDOMX(hashingBlob, Buffer.from(block.seed_hash, 'hex'), CONFIG.cnVariant);
			assert.equal(hash.toString('hex'), block.pow_hash);
			assert.ok(meetsDifficulty(hash, block.difficulty));
		});
	}


	it('hashed under another epoch\'s seed misses its difficulty', { timeout: 60000 }, () => {
		const block = blocks[0];
		const hashingBlob = cnUtil.convert_blob(Buffer.from(block.blob, 'hex'), CONFIG.cnBlobType);
		const hash = RANDOMX(hashingBlob, Buffer.from(blocks[1].seed_hash, 'hex'), CONFIG.cnVariant);
		assert.equal(meetsDifficulty(hash, block.difficulty), false);
	});


	it('with one nonce byte changed misses its difficulty', { timeout: 60000 }, () => {
		const block = blocks[2];
		const hashingBlob = cnUtil.convert_blob(Buffer.from(block.blob, 'hex'), CONFIG.cnBlobType);
		hashingBlob[39] ^= 0x01;
		const hash = RANDOMX(hashingBlob, Buffer.from(block.seed_hash, 'hex'), CONFIG.cnVariant);
		assert.equal(meetsDifficulty(hash, block.difficulty), false);
	});
});







// -----------------------------------------------------------
// The configured variant
// -----------------------------------------------------------
//
// cnVariant picks among the RandomX flavours the module
// carries; 0 is the one Monero and Bitlitas use. Any other
// gives a different hash for the same block.
// -----------------------------------------------------------

describe('the configured RandomX variant', () => {

	it('is the only one that reproduces the network\'s hash', { timeout: 60000 }, () => {
		const block = blocks[0];
		const hashingBlob = cnUtil.convert_blob(Buffer.from(block.blob, 'hex'), CONFIG.cnBlobType);
		const other = RANDOMX(hashingBlob, Buffer.from(block.seed_hash, 'hex'), 1).toString('hex');
		assert.notEqual(other, block.pow_hash);
	});
});







// -----------------------------------------------------------
// Seed heights
// -----------------------------------------------------------
//
// The seed of a height is the hash of an older block; the
// daemon announces the next seed 64 blocks before it takes
// over. The rule here is the one the fake daemon serves, held
// to the real blocks' seeds and to bitlitasd's own templates.
// -----------------------------------------------------------

describe('the RandomX seed height', () => {

	it('is the one the real blocks were hashed under', () => {
		for (const block of blocks) assert.equal(seedHeight(block.height), block.seed_height);
	});


	it('stays at genesis through the first epoch and its lag, as bitlitasd keyed its templates', () => {
		assert.equal(seedHeight(241), regtest.daemon.getblocktemplate.result.seed_height);
		assert.equal(seedHeight(2060), regtest.daemon.getblocktemplate_next_seed.result.seed_height);
		assert.equal(regtest.daemon.getblocktemplate.result.seed_hash, '418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3');
	});


	it('moves to block 2048 once the lag has passed, after being announced as the next seed', () => {
		assert.equal(seedHeight(2120), 2048);
		assert.equal(regtest.daemon.getblocktemplate_rotated.result.seed_height, 2048);
		assert.equal(regtest.daemon.getblocktemplate_next_seed.result.next_seed_hash, regtest.daemon.block_2048_hash);
		assert.equal(regtest.daemon.getblocktemplate_rotated.result.seed_hash, regtest.daemon.block_2048_hash);
		assert.equal(regtest.daemon.getblocktemplate_rotated.result.next_seed_hash, '');
	});
});
