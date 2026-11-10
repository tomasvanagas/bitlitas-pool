// -----------------------------------------------------------
//  [*] Tests — variable difficulty
//
//  Every retargetTime seconds each miner's difficulty is
//  moved toward one share per targetTime: the average gap of
//  its recent shares (or, once it has gone quiet for longer
//  than the target allows, the time since its last share)
//  scales the difficulty, no further than maxJump percent up
//  in one step, and never outside minDiff and maxDiff. The new
//  difficulty arrives as a new job. A miner who fixed its
//  difficulty in the login is never retargeted.
//
//  The shipped file retargets each minute toward a share
//  every two; here both are one second, the variance and the
//  limits stay as shipped, and share trust takes every share
//  after the first unchecked, so a burst of shares costs no
//  hashing.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { targetDifficulty } = require('../support/stratum.js');


// The world and its pool
let world;

before(async () => {
	world = await World.create('vardiff');
	await world.startPool({
		poolServer: {
			varDiff: { targetTime: 1, retargetTime: 1 },
			shareTrust: { enabled: true, min: 0, stepDown: 100, threshold: 0, penalty: 30 }
		}
	}, { cheapPort: true });
});

after(() => world.close());







// -----------------------------------------------------------
// Retargeting
// -----------------------------------------------------------
//
// How a difficulty moves for a fast miner, a quiet one, and
// one that fixed its own.
// -----------------------------------------------------------

describe('a miner\'s difficulty', () => {

	it('doubles at most in one step when shares come far faster than the target', async () => {
		const miner = await world.stratum('cheap');
		await miner.login(addresses.address('fast'));
		assert.equal((await miner.submit(miner.mine())).result.status, 'OK');
		const pushed = miner.nextJob();
		// More shares than the 16 gaps vardiff keeps, so the long
		// wait for the first, mined share falls out of the average
		for (let nonce = 100; nonce < 124; nonce++) {
			const share = { job_id: miner.job.job_id, nonce: nonce.toString(16).padStart(8, '0'), result: 'ff'.repeat(32) };
			assert.equal((await miner.submit(share)).result.status, 'OK');
		}
		const job = await pushed;
		assert.ok(job, 'no new job');
		assert.equal(targetDifficulty(job.target), 2);
	});


	it('falls for a miner who has gone quiet, step by step, down to the minimum of 100', async () => {
		const miner = await world.stratum(3333);
		await miner.login(addresses.address('quiet'));
		const seen = [];
		while (true) {
			const job = await miner.nextJob({ timeout: 10000 });
			assert.ok(job, 'no new job after ' + seen.join(', '));
			seen.push(targetDifficulty(job.target));
			if (seen[seen.length - 1] === 100) break;
		}
		for (let i = 1; i < seen.length; i++) assert.ok(seen[i] < seen[i - 1], seen.join(', '));
		assert.ok(seen[0] < 5000 && seen[0] >= 2500, seen.join(', '));
		assert.equal(await miner.nextJob({ timeout: 3500 }), null);
	});


	it('stays where a login fixed it', async () => {
		const miner = await world.stratum(3333);
		await miner.login(addresses.address('fixed') + '.5000');
		assert.equal(await miner.nextJob({ timeout: 3500 }), null);
		assert.equal(targetDifficulty(miner.job.target), 5000);
	});
});
