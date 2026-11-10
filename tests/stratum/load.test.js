// -----------------------------------------------------------
//  [*] Tests — many miners at once
//
//  A pool worker serves every miner on one event loop. Fifty
//  logins arriving together, and several miners sending
//  hundreds of shares together, must all be answered and all
//  be counted — the scores and hashes adding up exactly. And a
//  RandomX check holds the loop for its second and a half:
//  while the worker checks shares, every other miner on it
//  waits, which is the pool's ceiling, about one checked
//  share a second per worker. Share trust takes a miner's
//  shares unchecked after its first good one (no threshold, a
//  step of 100 %), so the bursts cost no hashing; the
//  checked shares are each a fresh miner's first.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { waitFor, sleep } = require('../support/wait.js');


// How many miners log in at once
const LOGINS = 50;

// How many miners mine at once
const MINERS = 8;

// How many unchecked shares each of those sends
const BURST = 40;







// -----------------------------------------------------------
// Load
// -----------------------------------------------------------
//
// One pool worker, every miner on it.
// -----------------------------------------------------------

describe('a pool worker under load', () => {

	let world;

	before(async () => {
		world = await World.create('load');
		await world.startPool({
			poolServer: { shareTrust: { enabled: true, min: 0, stepDown: 100, threshold: 0, penalty: 30 } },
			api: { enabled: false }
		}, { cheapPort: true });
	});

	after(() => world.close());


	it('answers fifty logins that arrive together, each with a job of its own', async () => {
		const miners = await Promise.all(Array.from({ length: LOGINS }, () => world.stratum('cheap')));
		const replies = await Promise.all(miners.map((miner, i) => miner.login(addresses.address('crowd-' + i), 'rig')));
		assert.equal(replies.filter((reply) => reply && reply.result && reply.result.status === 'OK').length, LOGINS);
		assert.equal(new Set(replies.map((reply) => reply.result.job.blob)).size, LOGINS);
	});


	it('counts every share of several miners sending hundreds together, none lost', async () => {
		const logins = Array.from({ length: MINERS }, (unused, i) => addresses.address('busy-' + i));
		const miners = [];
		for (const login of logins) {
			const miner = await world.stratum('cheap');
			await miner.login(login, 'rig');
			miners.push(miner);
		}
		const first = miners.map((miner) => miner.mine());
		const checked = await Promise.all(miners.map((miner, i) => miner.submit(first[i], { timeout: 60000 })));
		assert.ok(checked.every((reply) => reply.result.status === 'OK'));
		const bursts = miners.map((miner) => Array.from({ length: BURST }, (unused, n) => miner.submit({ job_id: miner.job.job_id, nonce: (0x1000 + n).toString(16).padStart(8, '0'), result: 'ff'.repeat(32) })));
		const replies = await Promise.all(bursts.flat());
		assert.equal(replies.filter((reply) => reply && reply.result && reply.result.status === 'OK').length, MINERS * BURST);
		await waitFor(async () => {
			const scores = await world.redis.call('hgetall', 'bitlitas:scores:prop:roundCurrent');
			return logins.every((login) => scores[login] === String(BURST + 1));
		}, { what: 'every share in the round' });
		for (const login of logins) {
			assert.equal(await world.redis.call('hget', 'bitlitas:workers:' + login, 'hashes'), String(BURST + 1));
			assert.equal(await world.redis.call('hget', 'bitlitas:shares_actual:prop:roundCurrent', login), String(BURST + 1));
		}
	});


	it('makes every other miner wait while it checks a share', async () => {
		const checker = await world.stratum('cheap');
		await checker.login(addresses.address('slow-check'), 'rig');
		const share = checker.mine();
		const bystander = await world.stratum('cheap');
		await bystander.login(addresses.address('bystander'), 'rig');
		const submitted = checker.submit(share);
		// By now the worker has read the share and is inside its check
		await sleep(300);
		const asked = Date.now();
		const reply = await bystander.keepalived();
		const waited = Date.now() - asked;
		assert.equal((await submitted).result.status, 'OK');
		assert.deepEqual(reply.result, { status: 'KEEPALIVED' });
		assert.ok(waited > 800, 'the keepalive was answered after ' + waited + ' ms, during a check that takes about 1400');
	});
});
