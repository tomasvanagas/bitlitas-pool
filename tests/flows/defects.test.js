// -----------------------------------------------------------
//  [*] Tests — pinned defects of the whole pool and its Redis
//
//  Each test states what the pool should do when its Redis
//  fails; pinDefect keeps the run green while the defect
//  lives and fails once it is gone (tests/README.md, "Pinned
//  defects"). The first is the gravest of the suite: no
//  worker listens for its Redis client's errors, so a Redis
//  restart kills every worker, and the pool workers forked
//  again come back without a template — they answer no miner
//  until the network finds a block, which, while the pool is
//  Bitlitas's only miner, it never does.
// -----------------------------------------------------------

const { describe, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { waitFor, sleep } = require('../support/wait.js');
const { pinDefect } = require('../support/defects.js');


// One LTL in atomic units
const LTL = 1e12;







// -----------------------------------------------------------
// Redis stopping
// -----------------------------------------------------------
//
// A pool whose Redis stops for a few seconds and comes back
// empty, as a restart without persistence does.
// -----------------------------------------------------------

describe('a Redis that stops', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('redis-stopping');
		pool = await world.startPool({}, { cheapPort: true });
	});

	after(() => world.close());


	pinDefect('redis-stop-kills-every-worker', 'keep its miners connected while Redis is away', async () => {
		const miner = await world.stratum('cheap');
		await miner.login(addresses.address('through-the-outage'));
		let dropped = false;
		miner.closed.then(() => dropped = true);
		const mark = pool.mark();
		await world.redis.stop();
		try {
			await sleep(3000);
		} finally {
			await world.redis.start();
		}
		const deaths = pool.count('died, spawning replacement', mark);
		assert.equal(dropped, false, 'the connection was dropped: ' + deaths + ' worker deaths in three seconds');
	});
});







// -----------------------------------------------------------
// Writes refused
// -----------------------------------------------------------
//
// A Redis a failover left a read-only replica: reads answer,
// every write and every transaction holding one fails.
// -----------------------------------------------------------

describe('a Redis that refuses every write', () => {

	let world;

	before(async () => {
		world = await World.create('redis-refusing-defects');
	});

	after(async () => {
		await world.redis.recover().catch(() => {});
		await world.close();
	});


	pinDefect('redis-write-error-kills-worker', 'keep the pool worker running when Redis refuses what a login writes', async () => {
		const pool = await world.startPool({}, { cheapPort: true });
		const mark = pool.mark();
		await world.redis.refuseWrites();
		try {
			const miner = await world.stratum('cheap');
			assert.equal((await miner.login(addresses.address('read-only-login'))).result.status, 'OK');
			await sleep(1500);
		} finally {
			await world.redis.recover();
		}
		const deaths = pool.count('Pool fork 1 died, spawning replacement worker...', mark);
		await world.stopPools();
		assert.equal(deaths, 0, 'the login\'s Redis writes, sent without a callback, failed as error events nobody listens to');
	});


	pinDefect('redis-refusal-loses-block', 'record a block the daemon took, once Redis takes writes again', async () => {
		const pool = await world.startPool({}, { cheapPort: true });
		const chain = world.daemon.chain;
		const miner = await world.stratum('cheap');
		await miner.login(addresses.address('lost-block'));
		const height = chain.tipHeight + 2;
		chain.easyHeights.add(height);
		chain.mineElsewhere();
		const job = await miner.jobAtHeight(height);
		const share = miner.mine({ job });
		const mark = pool.mark();
		await world.redis.refuseWrites();
		try {
			assert.equal((await miner.submit(share)).result.status, 'OK');
			await waitFor(() => chain.tipHeight === height, { what: 'the daemon to take the block' });
			await pool.waitForOutput('Failed to insert share data into redis', { from: mark });
		} finally {
			await world.redis.recover();
		}
		await sleep(2000);
		await world.stopPools();
		const candidates = await world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height);
		assert.equal(candidates.length, 1, 'the block at ' + height + ' is on the chain, paid to the pool wallet, and recorded nowhere');
	});


	pinDefect('redis-refusal-pays-twice', 'send a payment once when Redis refuses to record it', async () => {
		const miner = addresses.address('paid-again');
		const pool = await world.startPool({ payments: { interval: 1 } }, { module: 'payments' });
		// Redis turns read-only as the wallet sends the transfer, so the
		// run's bookkeeping after it is what fails
		world.wallet.override('transfer', (params, wallet) => {
			world.redis.refuseWrites().catch(() => {});
			return wallet.transfer(params);
		});
		try {
			await world.redis.call('hset', 'bitlitas:workers:' + miner, 'balance', 2 * LTL);
			await pool.waitForOutput('Super critical error! Payments sent yet failing to update balance in redis');
			await sleep(2500);
		} finally {
			delete world.wallet.overrides.transfer;
			await world.redis.recover();
			await world.stopPools();
		}
		const sent = world.wallet.transfers.filter((transfer) => transfer.destinations.some((destination) => destination.address === miner)).length;
		assert.equal(sent, 1, 'the wallet sent the same payment ' + sent + ' times while Redis refused the bookkeeping');
	});
});







// -----------------------------------------------------------
// Memory full
// -----------------------------------------------------------
//
// A Redis out of memory: every write fails, and so does every
// transaction, reads included.
// -----------------------------------------------------------

describe('a Redis out of memory', () => {

	let world;

	before(async () => {
		world = await World.create('redis-full');
	});

	after(async () => {
		await world.redis.recover().catch(() => {});
		await world.close();
	});


	pinDefect('api-crashes-on-failed-redis-transaction', 'keep the API up when a statistics transaction fails', async () => {
		const pool = await world.startPool({ api: { updateInterval: 1 } }, { module: 'api' });
		const mark = pool.mark();
		await world.redis.runOutOfMemory();
		try {
			await sleep(2500);
		} finally {
			await world.redis.recover();
		}
		const deaths = pool.count('API died, spawning replacement...', mark);
		assert.equal(deaths, 0, 'the health check read the failed transaction\'s replies and crashed the API ' + deaths + ' times');
	});
});
