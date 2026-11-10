// -----------------------------------------------------------
//  [*] Tests — share trust and IP bans
//
//  Two defences of the shipped configuration. Banning counts
//  each IP's valid and invalid shares; once checkThreshold
//  shares are in, an IP whose invalid shares reach
//  invalidPercent of its VALID shares is banned for
//  banning.time seconds — every miner behind it, in every
//  pool worker — and otherwise the count starts over. Share
//  trust saves the second and a half a RandomX check costs:
//  after `threshold` good shares a miner's share is taken
//  unchecked with a probability that grows by stepDown per
//  good share, up to 1 - min; one bad share caught resets
//  that and adds `penalty` shares of full checking.
//
//  The shipped numbers (bans after 30 shares, trust after 10)
//  would take minutes of hashing, so each world here states
//  smaller ones; the arithmetic is the shipped code's. Bans
//  are tested from loopback addresses of their own.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { sleep, waitFor } = require('../support/wait.js');


// A result that is no RandomX hash of anything
const WRONG_RESULT = 'ab'.repeat(32);







// -----------------------------------------------------------
// Bans
// -----------------------------------------------------------
//
// Trust is off, so every share is checked; four shares make a
// check window and 30 % is the line. One bad share among four
// is a third of the three good ones but only a quarter of all
// four, which tells the two readings of the percentage apart.
// -----------------------------------------------------------

describe('a ban', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('bans');
		pool = await world.startPool({
			poolServer: {
				shareTrust: { enabled: false },
				banning: { enabled: true, time: 2, invalidPercent: 30, checkThreshold: 4 }
			}
		}, { cheapPort: true });
	});

	after(() => world.close());


	it('falls on an IP whose invalid shares reach the percentage of its valid ones', async () => {
		const miner = await world.stratum('cheap', { localAddress: '127.0.0.7' });
		const neighbour = await world.stratum('cheap', { localAddress: '127.0.0.7' });
		await miner.login(addresses.address('ban-a'));
		await neighbour.login(addresses.address('ban-b'));
		assert.equal((await miner.submit({ job_id: miner.job.job_id, nonce: '00000001', result: WRONG_RESULT })).error.message, 'Rejected share: invalid result');
		for (let nonce = 2; nonce <= 4; nonce++) {
			assert.equal((await miner.submit(miner.mine({ nonce }))).result.status, 'OK');
		}
		await pool.waitForOutput('Banned ' + addresses.address('ban-a') + '@::ffff:127.0.0.7');
		assert.equal((await miner.getjob()).error.message, 'Your IP is banned');
	});


	it('covers every miner behind the IP', async () => {
		const other = await world.stratum('cheap', { localAddress: '127.0.0.7' });
		assert.equal((await other.login(addresses.address('ban-c'))).error.message, 'Your IP is banned');
	});


	it('leaves other IPs mining', async () => {
		const elsewhere = await world.stratum('cheap', { localAddress: '127.0.0.8' });
		assert.equal((await elsewhere.login(addresses.address('ban-d'))).result.status, 'OK');
	});


	it('ends after the ban time', async () => {
		await sleep(2500);
		const back = await world.stratum('cheap', { localAddress: '127.0.0.7' });
		assert.equal((await back.login(addresses.address('ban-a'))).result.status, 'OK');
	});
});







// -----------------------------------------------------------
// Bans across pool workers
// -----------------------------------------------------------
//
// Two pool workers: the cluster hands connections out in
// turn, and a ban in one worker reaches the other through
// the master.
// -----------------------------------------------------------

describe('a ban in one pool worker', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('bans-cluster');
		pool = await world.startPool({ poolServer: { clusterForks: 2 } });
	});

	after(() => world.close());


	it('reaches the miners of the other worker', async () => {
		await pool.waitForOutput('Pool spawned on 2 thread(s)');
		// A worker still loading when the first template came has
		// none; the next block reaches both
		const mark = pool.mark();
		world.daemon.chain.mineElsewhere();
		await pool.waitForOutput(/New bitlitas block to mine/, { from: mark, times: 2 });
		const byThread = {};
		for (let i = 0; i < 10 && Object.keys(byThread).length < 2; i++) {
			const before = pool.mark();
			const miner = await world.stratum(3333, { localAddress: '127.0.0.9' });
			assert.equal((await miner.login(addresses.address('cluster-' + i))).result.status, 'OK');
			await pool.waitForOutput(/\(Thread \d\) Miner connected/, { from: before });
			const thread = pool.output.slice(before).match(/\(Thread (\d)\) Miner connected/)[1];
			byThread[thread] = byThread[thread] || miner;
		}
		assert.deepEqual(Object.keys(byThread).sort(), ['1', '2']);
		assert.equal((await byThread['1'].submit({ job_id: byThread['1'].job.job_id, nonce: 'bad', result: WRONG_RESULT })).error.message, 'Duplicate share1');
		await waitFor(async () => (await byThread['2'].getjob()).error?.message === 'Your IP is banned', { what: 'the ban to reach the other worker', timeout: 5000 });
	});
});







// -----------------------------------------------------------
// Share trust
// -----------------------------------------------------------
//
// Trust from the first good share on, at full probability:
// with no threshold, a step of 100 % and no floor, a miner's
// second share is taken unchecked unless Math.random()
// returns exactly 0.
// -----------------------------------------------------------

describe('share trust', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('trust');
		pool = await world.startPool({
			poolServer: { shareTrust: { enabled: true, min: 0, stepDown: 100, threshold: 0, penalty: 30 } }
		}, { cheapPort: true });
	});

	after(() => world.close());


	it('checks a miner\'s first share', async () => {
		const miner = await world.stratum('cheap');
		await miner.login(addresses.address('trust-a'));
		assert.equal((await miner.submit({ job_id: miner.job.job_id, nonce: '00000001', result: WRONG_RESULT })).error.message, 'Rejected share: invalid result');
	});


	it('takes a share on trust after a good one, its result never hashed', async () => {
		const login = addresses.address('trust-b');
		const miner = await world.stratum('cheap');
		await miner.login(login);
		assert.equal((await miner.submit(miner.mine())).result.status, 'OK');
		const mark = pool.mark();
		const reply = await miner.submit({ job_id: miner.job.job_id, nonce: '00000099', result: 'ff'.repeat(32) });
		assert.equal(reply.result.status, 'OK');
		await pool.waitForOutput('Accepted trusted share at difficulty 1/1 from ' + login, { from: mark });
		await waitFor(async () => await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login) === '2', { what: 'the trusted share credited' });
	});


	it('sends a trusted share that claims a block to the daemon, which refuses it, and records no block', async () => {
		const login = addresses.address('trust-c');
		const miner = await world.stratum('cheap');
		await miner.login(login);
		await miner.submit(miner.mine());
		const mark = pool.mark();
		const claimed = '01' + '00'.repeat(31);
		const reply = await miner.submit({ job_id: miner.job.job_id, nonce: crypto.randomBytes(4).toString('hex'), result: claimed });
		assert.equal(reply.result.status, 'OK');
		await pool.waitForOutput('Error submitting block at height', { from: mark });
		assert.deepEqual(await world.redis.call('zrange', 'bitlitas:blocks:candidates', 0, -1), []);
	});
});
