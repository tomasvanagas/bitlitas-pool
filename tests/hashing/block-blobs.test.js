// -----------------------------------------------------------
//  [*] Tests — block templates and the blocks the pool builds
//
//  What a real bitlitasd v0.18.3.1 handed out and accepted,
//  on a regtest chain at fork 16, when the fixtures were
//  captured: three templates (one keyed by the genesis seed,
//  one announcing the next seed, one under the rotated seed)
//  and a block built from the first the way lib/pool.js
//  builds one — the extra nonce written big-endian at the
//  reserved offset, a four-byte instance id behind it, the
//  miner's nonce at byte 39 — which the daemon took as its
//  new tip. The suite's template builder must reproduce the
//  daemon's templates byte for byte, so the fake daemon
//  serves what the real one would; and the pool's way of
//  finding the reserved bytes and building a block must give
//  what the daemon accepted.
// -----------------------------------------------------------

const { describe, it } = require('node:test');
const assert = require('node:assert');
const cnUtil = require('cryptoforknote-util');
const regtest = require('../fixtures/bitlitasd-regtest.json');
const { buildTemplateBlob, parseTemplateBlob, FakeChain } = require('../support/chain.js');


// The three real templates
const TEMPLATES = [
	regtest.daemon.getblocktemplate.result,
	regtest.daemon.getblocktemplate_next_seed.result,
	regtest.daemon.getblocktemplate_rotated.result
];

// What lib/pool.js searches a template for: the extra-nonce
// tag, its length 17 and 17 zero bytes
const RESERVE_PATTERN = '02' + (17).toString(16) + '00'.repeat(17);







// -----------------------------------------------------------
// rebuild
// -----------------------------------------------------------
//
// A template blob rebuilt by the suite's builder from the
// fields of a real one.
//
// Used by:
//   - the template tests (below)
// -----------------------------------------------------------

function rebuild (blob) {

	const fields = parseTemplateBlob(blob);
	return buildTemplateBlob({
		major: fields.major,
		timestamp: fields.timestamp,
		prevHash: fields.prevHash,
		height: fields.height,
		reward: fields.reward,
		outputKey: fields.outputKey,
		viewTag: fields.viewTag,
		txPubKey: fields.txPubKey,
		reserveSize: fields.reserved.length
	});
}







// -----------------------------------------------------------
// Templates
// -----------------------------------------------------------
//
// The real templates, the suite's builder held to them,
// and the reserved bytes the pool writes into.
// -----------------------------------------------------------

describe('a block template', () => {

	for (const template of TEMPLATES) {

		it('at height ' + template.height + ' is rebuilt by the suite byte for byte', () => {
			const { blob, reservedOffset } = rebuild(Buffer.from(template.blocktemplate_blob, 'hex'));
			assert.equal(blob.toString('hex'), template.blocktemplate_blob);
			assert.equal(reservedOffset, template.reserved_offset);
		});
	}


	it('carries the hashing blob the daemon itself derives from it', () => {
		for (const template of TEMPLATES) {
			assert.equal(cnUtil.convert_blob(Buffer.from(template.blocktemplate_blob, 'hex'), 0).toString('hex'), template.blockhashing_blob);
		}
	});


	it('has its reserved bytes where the pool\'s search finds them', () => {
		for (const template of TEMPLATES) {
			const found = template.blocktemplate_blob.indexOf(RESERVE_PATTERN);
			assert.equal(2 + (found >> 1), template.reserved_offset);
		}
	});


	it('asks for no transactions and pays one view-tagged output at fork 16', () => {
		const fields = parseTemplateBlob(Buffer.from(TEMPLATES[0].blocktemplate_blob, 'hex'));
		assert.equal(fields.major, 16);
		assert.equal(fields.minor, 16);
		assert.equal(fields.outputTag, 0x03);
		assert.equal(fields.reward, TEMPLATES[0].expected_reward);
		assert.equal(fields.unlockTime, TEMPLATES[0].height + 60);
		assert.equal(fields.prevHash.toString('hex'), TEMPLATES[0].prev_hash);
	});


	it('of fork 12 pays a plain output key, which the hashing module parses as well', () => {
		const chain = new FakeChain({ major: 12 });
		const template = chain.template();
		const blob = Buffer.from(template.blocktemplate_blob, 'hex');
		assert.equal(parseTemplateBlob(blob).outputTag, 0x02);
		assert.equal(cnUtil.convert_blob(blob, 0).length, 76);
		assert.equal(cnUtil.get_block_id(blob, 0).length, 32);
	});
});







// -----------------------------------------------------------
// The block the pool builds
// -----------------------------------------------------------
//
// The block lib/pool.js builds from a template and a share,
// held to the one bitlitasd accepted.
// -----------------------------------------------------------

describe('a block built the way the pool builds one', () => {

	it('is the block bitlitasd accepted as its new tip', () => {
		const template = TEMPLATES[0];
		const built = regtest.built_block;
		const buffer = Buffer.from(template.blocktemplate_blob, 'hex');
		buffer.writeUInt32BE(built.extra_nonce, template.reserved_offset);
		Buffer.from(built.instance_id, 'hex').copy(buffer, template.reserved_offset + 4);
		const block = cnUtil.construct_block_blob(buffer, Buffer.from(built.nonce, 'hex'), 0);
		assert.equal(block.toString('hex'), built.blob);
		assert.equal(cnUtil.get_block_id(block, 0).toString('hex'), regtest.daemon.submitblock.result.block_id);
		assert.equal(regtest.daemon.submitblock.result.status, 'OK');
		assert.equal(regtest.daemon.getblockheaderbyheight.result.block_header.hash, built.block_id);
	});


	it('carries the miner\'s nonce at byte 39, which the daemon reads back little-endian', () => {
		const block = Buffer.from(regtest.built_block.blob, 'hex');
		assert.equal(block.subarray(39, 43).toString('hex'), regtest.built_block.nonce);
		assert.equal(block.readUInt32LE(39), regtest.daemon.getblockheaderbyheight.result.block_header.nonce);
	});


	it('hashes to the hashing blob a miner works on, the extra nonce changing its merkle root', () => {
		const template = Buffer.from(TEMPLATES[0].blocktemplate_blob, 'hex');
		const block = Buffer.from(regtest.built_block.blob, 'hex');
		const fromBlock = cnUtil.convert_blob(block, 0);
		const fromTemplate = cnUtil.convert_blob(template, 0);
		assert.equal(fromBlock.subarray(0, 39).toString('hex'), fromTemplate.subarray(0, 39).toString('hex'));
		assert.notEqual(fromBlock.subarray(43).toString('hex'), fromTemplate.subarray(43).toString('hex'));
		assert.equal(fromBlock.toString('hex'), regtest.built_block.hashing_blob);
	});


	it('is refused by the daemon as a wrong blob when it does not parse', () => {
		assert.deepEqual(regtest.daemon.submitblock_garbage.error, { code: -6, message: 'Wrong block blob' });
		assert.throws(() => cnUtil.convert_blob(Buffer.from('00ff', 'hex'), 0));
	});
});
