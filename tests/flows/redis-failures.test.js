// -----------------------------------------------------------
//  [*] Tests — a Redis that fails under the running pool
//
//  Redis holds everything the pool knows: the rounds, the
//  balances, the blocks, the payments. Here it fails while the
//  whole pool runs, the way a database fails in production:
//  it refuses every write, as a Redis a failover left a
//  read-only replica does (reads still answer), and then
//  takes writes again. What the modules do about it is told
//  here; what they should do and do not is pinned in
//  defects.test.js — among it a Redis out of memory, which
//  takes the API down, and a Redis that stops altogether,
//  which takes every worker down.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { seedCandidate } = require('../support/rounds.js');
const { apiGet } = require('../support/http.js');
const { waitFor, sleep } = require('../support/wait.js');


// The pool fee of the shipped file
const POOL_FEE = 0.01;







// -----------------------------------------------------------
// Writes refused
// -----------------------------------------------------------
//
// One pool whose Redis turns read-only replica from the
// moment a test says so until it says otherwise.
// -----------------------------------------------------------

describe('a Redis that refuses every write', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('redis-refusing');
		pool = await world.startPool({ blockUnlocker: { interval: 1 }, api: { updateInterval: 1 } }, { cheapPort: true });
	});

	after(async () => {
		await world.redis.recover().catch(() => {});
		await world.close();
	});


	it('has a share answered as accepted and lost: Redis never records it', async () => {
		const login = addresses.address('oom-share');
		const miner = await world.stratum('cheap');
		await miner.login(login);
		await waitFor(() => world.redis.call('exists', 'bitlitas:workers_ip:' + login), { what: 'the login recorded' });
		const share = miner.mine();
		const mark = pool.mark();
		await world.redis.refuseWrites();
		try {
			assert.equal((await miner.submit(share)).result.status, 'OK');
			await pool.waitForOutput('Failed to insert share data into redis', { from: mark });
		} finally {
			await world.redis.recover();
		}
		await sleep(500);
		assert.equal(await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login), null);
	});


	it('leaves the API answering from what Redis still reads', async () => {
		await world.redis.refuseWrites();
		try {
			await sleep(1500);
			const reply = await apiGet(world.apiPort, '/stats');
			assert.equal(reply.status, 200);
			assert.ok(reply.json.pool);
		} finally {
			await world.redis.recover();
		}
	});


	it('leaves a block the unlocker could not settle a candidate, and settles it once when writes come back', async () => {
		const chain = world.daemon.chain;
		const height = chain.tipHeight - 50;
		const finder = addresses.address('oom-finder');
		await seedCandidate(world, { height, finder, scores: { [finder]: 10 } });
		await world.redis.refuseWrites();
		const mark = pool.mark();
		try {
			chain.mineElsewhere(10);
			await pool.waitForOutput('Error with unlocking blocks', { from: mark });
			assert.equal((await world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height)).length, 1);
		} finally {
			await world.redis.recover();
		}
		await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:matured', height, height).then((list) => list.length), { what: 'the block settled' });
		await sleep(2500);
		const reward = chain.reward;
		assert.equal(Number(await world.redis.call('hget', 'bitlitas:workers:' + finder, 'balance')), Math.round(reward - reward * POOL_FEE));
	});
});







// -----------------------------------------------------------
// Memory full
// -----------------------------------------------------------
//
// The unlocker and the payment run on their own, while their
// Redis is out of memory: a transaction fails even when it
// only reads.
// -----------------------------------------------------------

describe('a Redis out of memory', () => {

	let world;

	before(async () => {
		world = await World.create('redis-full-modules');
	});

	after(async () => {
		await world.redis.recover().catch(() => {});
		await world.close();
	});


	it('leaves the unlocker unable to read its rounds, the block a candidate until memory is back', async () => {
		const height = world.daemon.chain.tipHeight - 100;
		const finder = addresses.address('full-unlocker');
		await seedCandidate(world, { height, finder, scores: { [finder]: 4 } });
		await world.redis.runOutOfMemory();
		try {
			const pool = await world.startPool({ blockUnlocker: { interval: 1 } }, { module: 'unlocker' });
			await pool.waitForOutput('Error with getting round shares from redis');
			assert.equal((await world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height)).length, 1);
		} finally {
			await world.redis.recover();
		}
		await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:matured', height, height).then((list) => list.length), { what: 'the block settled' });
		await world.stopPools();
	});


	it('leaves the payment run unable to read the balances, paying nothing until memory is back', async () => {
		const miner = addresses.address('full-payments');
		await world.redis.call('hset', 'bitlitas:workers:' + miner, 'balance', 2e12);
		await world.redis.runOutOfMemory();
		try {
			const pool = await world.startPool({ payments: { interval: 1 } }, { module: 'payments' });
			await pool.waitForOutput('Error with getting balances from redis');
			assert.equal(world.wallet.callsOf('transfer').length, 0);
		} finally {
			await world.redis.recover();
		}
		await waitFor(() => world.wallet.transfers.some((transfer) => transfer.destinations.some((destination) => destination.address === miner)), { what: 'the payment once memory was back', explain: () => world.pools[world.pools.length - 1].tail(30) });
		await world.stopPools();
	});
});
