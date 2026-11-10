// -----------------------------------------------------------
//  [*] Tests — the pool's small helpers (lib/utils.js)
//
//  The helpers every module leans on, loaded with the shipped
//  configuration as the global `config`: how a login's
//  "solo:" or "prop:" prefix picks the reward type, how the
//  API and notifications write hashrates and LTL amounts, the
//  ring buffer vardiff averages share times in, the ids jobs
//  and miners get, and the character counting the login
//  checks rely on.
// -----------------------------------------------------------

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { sandboxConfig } = require('../support/world.js');
const { REAL } = require('../support/addresses.js');


// The module under test, loaded once the config is in place
let utils;

before(() => {
	global.config = sandboxConfig();
	utils = require('../../lib/utils.js');
});







// -----------------------------------------------------------
// determineRewardData
// -----------------------------------------------------------
//
// How a login picks shared or solo mining.
// -----------------------------------------------------------

describe('the reward type a login picks', () => {

	it('is shared (prop) for a bare address', () => {
		assert.deepEqual(utils.determineRewardData(REAL.miner), { address: REAL.miner, rewardType: 'prop' });
	});


	it('is solo behind "solo:", the prefix taken off the address, in any letter case', () => {
		assert.deepEqual(utils.determineRewardData('solo:' + REAL.miner), { address: REAL.miner, rewardType: 'solo' });
		assert.deepEqual(utils.determineRewardData('SOLO:' + REAL.miner), { address: REAL.miner, rewardType: 'solo' });
	});


	it('is shared behind "prop:", the prefix taken off', () => {
		assert.deepEqual(utils.determineRewardData('prop:' + REAL.miner), { address: REAL.miner, rewardType: 'prop' });
	});


	it('leaves an empty address behind a bare prefix', () => {
		assert.deepEqual(utils.determineRewardData('solo:'), { address: '', rewardType: 'solo' });
	});


	it('reads only a leading prefix', () => {
		assert.deepEqual(utils.determineRewardData(REAL.miner + 'solo:'), { address: REAL.miner + 'solo:', rewardType: 'prop' });
	});
});







// -----------------------------------------------------------
// getReadableHashRate and getReadableCoins
// -----------------------------------------------------------
//
// The hashrates and LTL amounts the API, the notifications
// and the logs show.
// -----------------------------------------------------------

describe('readable hashrates and amounts', () => {

	it('write a hashrate in H, KH, MH … per second with two decimals', () => {
		assert.equal(utils.getReadableHashRate(0), '0.00 H/sec');
		assert.equal(utils.getReadableHashRate(999), '999.00 H/sec');
		assert.equal(utils.getReadableHashRate(1001), '1.00 KH/sec');
		assert.equal(utils.getReadableHashRate(2500000), '2.50 MH/sec');
	});


	it('keep exactly 1000 in the unit below', () => {
		assert.equal(utils.getReadableHashRate(1000), '1000.00 H/sec');
	});


	it('write atomic units as LTL with the configured four decimals', () => {
		assert.equal(utils.getReadableCoins(1e12), '1.0000 LTL');
		assert.equal(utils.getReadableCoins(35168236092881), '35.1682 LTL');
		assert.equal(utils.getReadableCoins(123456789), '0.0001 LTL');
	});


	it('take another number of digits, leave the symbol out on request, and read nothing as zero', () => {
		assert.equal(utils.getReadableCoins(1500000000000, 2), '1.50 LTL');
		assert.equal(utils.getReadableCoins(1e12, null, true), '1.0000');
		assert.equal(utils.getReadableCoins(undefined), '0.0000 LTL');
		assert.equal(utils.getReadableCoins('2000000000000'), '2.0000 LTL');
	});
});







// -----------------------------------------------------------
// ringBuffer
// -----------------------------------------------------------
//
// Vardiff keeps the seconds between a miner's last 16 shares
// here and asks for their average, with the time since the
// last share counted in when the miner has gone quiet.
// -----------------------------------------------------------

describe('the ring buffer of share times', () => {

	it('averages what it holds before it is full', () => {
		const ring = utils.ringBuffer(4);
		ring.append(2);
		ring.append(4);
		assert.equal(ring.size(), 2);
		assert.equal(ring.avg(), 3);
	});


	it('counts one more value in when asked to', () => {
		const ring = utils.ringBuffer(4);
		ring.append(2);
		ring.append(4);
		assert.equal(ring.avg(9), 5);
	});


	it('drops the oldest value once full', () => {
		const ring = utils.ringBuffer(3);
		for (const value of [100, 1, 2, 3]) ring.append(value);
		assert.equal(ring.size(), 3);
		assert.equal(ring.avg(), 2);
	});


	it('starts over when cleared, an empty buffer averaging to nothing', () => {
		const ring = utils.ringBuffer(3);
		ring.append(5);
		ring.clear();
		assert.equal(ring.size(), 0);
		assert.ok(Number.isNaN(ring.avg()));
		assert.equal(ring.avg(7), 7);
	});
});







// -----------------------------------------------------------
// Ids and counting
// -----------------------------------------------------------
//
// The ids of miners, jobs and processes, and the
// separator counts a login is checked with.
// -----------------------------------------------------------

describe('ids and character counts', () => {

	it('give miners and jobs fifteen-digit ids', () => {
		const ids = new Set();
		for (let i = 0; i < 1000; i++) ids.add(utils.uid());
		assert.equal(ids.size, 1000);
		for (const id of ids) assert.match(id, /^[1-9]\d{14}$/);
	});


	it('give each process a four-byte instance id', () => {
		assert.equal(utils.instanceId().length, 4);
	});


	it('count the separators the login checks look for', () => {
		assert.equal(utils.characterCount('a.b.c', '\\.'), 2);
		assert.equal(utils.characterCount('a+b', '\\+'), 1);
		assert.equal(utils.characterCount(REAL.miner, '\\.'), 0);
	});
});







// -----------------------------------------------------------
// cleanupSpecialChars
// -----------------------------------------------------------
//
// Merged mining cleans a child-chain login with it; the
// shipped configuration mines no child chain.
// -----------------------------------------------------------

describe('cleaning special characters', () => {

	it('turns the accented Latin letters it knows into plain ones', () => {
		assert.equal(utils.cleanupSpecialChars('Àéîõü'), 'Aeiu');
	});


	it('drops the Lithuanian letters, which it does not know', () => {
		assert.equal(utils.cleanupSpecialChars('ąžuolas'), 'uolas');
	});


	it('keeps letters, digits, dashes, underscores and plus signs only', () => {
		assert.equal(utils.cleanupSpecialChars('rig-1_a+b.c d@e'), 'rig-1_a+bcde');
	});
});
