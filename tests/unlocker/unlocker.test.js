// -----------------------------------------------------------
//  [*] Tests — the block unlocker
//
//  lib/blockUnlocker.js, run on its own (-module=unlocker)
//  every second instead of the shipped thirty. Each pass it
//  reads the block candidates the pool recorded, asks the
//  daemon for the header at each candidate's height, and
//  once a candidate is at least 60 blocks deep (the coinbase
//  unlock window) settles it: the chain's block there has the
//  candidate's hash, so it matured and its reward is split —
//  the 1 % pool fee off, the rest by round score among the
//  shared (prop) miners, or all of it to a solo finder — or
//  it has another hash, so the candidate is an orphan and
//  nobody is paid. Either way it moves to blocks:matured and
//  its round's keys go.
//
//  The candidates are written into Redis the way the pool
//  writes them when a block is found (tests/support/rounds.js);
//  the fake daemon's chain carries the block, or another one,
//  at the candidate's height.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { seedCandidate, settled, balance } = require('../support/rounds.js');
const { sleep } = require('../support/wait.js');


// The pool fee of the shipped file
const POOL_FEE = 0.01;







// -----------------------------------------------------------
// The shipped split
// -----------------------------------------------------------
//
// One unlocker under the shipped fees, every second; each
// test settles a block of its own.
// -----------------------------------------------------------

describe('a block candidate', () => {

	let world;
	let pool;
	let reward;

	before(async () => {
		world = await World.create('unlocker');
		pool = await world.startPool({ blockUnlocker: { interval: 1 } }, { module: 'unlocker' });
		reward = world.daemon.chain.reward;
	});

	after(() => world.close());


	it('stays a candidate until it is 60 blocks deep, then matures', async () => {
		const chain = world.daemon.chain;
		const height = chain.tipHeight - 59;
		const member = await seedCandidate(world, { height, finder: addresses.address('shallow'), scores: { [addresses.address('shallow')]: 10 } });
		await pool.waitForOutput('No pending blocks are unlocked yet (1 pending)');
		await sleep(1500);
		assert.deepEqual(await world.redis.call('zrange', 'bitlitas:blocks:candidates', 0, -1), [member]);
		chain.mineElsewhere();
		await settled(world, height, () => pool.tail());
		assert.deepEqual(await world.redis.call('zrange', 'bitlitas:blocks:candidates', 0, -1), []);
	});


	it('matures with each shared miner credited their score\'s part of the reward after the 1 % pool fee', async () => {
		const height = world.daemon.chain.tipHeight - 100;
		const [alice, bob] = [addresses.address('split-alice'), addresses.address('split-bob')];
		await seedCandidate(world, { height, finder: alice, scores: { [alice]: 3000, [bob]: 1000 } });
		await settled(world, height);
		const miners = Math.round(reward - reward * POOL_FEE);
		assert.equal(await balance(world, alice), Math.round(miners * 0.75));
		assert.equal(await balance(world, bob), Math.round(miners * 0.25));
	});


	it('leaves the pool fee in the pool\'s wallet: the credits add up to 99 % of the reward', async () => {
		const height = world.daemon.chain.tipHeight - 101;
		const miners = ['fee-a', 'fee-b', 'fee-c'].map((label) => addresses.address(label));
		await seedCandidate(world, { height, finder: miners[0], scores: { [miners[0]]: 1, [miners[1]]: 1, [miners[2]]: 1 } });
		await settled(world, height);
		let credited = 0;
		for (const miner of miners) credited += await balance(world, miner);
		assert.ok(Math.abs(credited - reward * (1 - POOL_FEE)) <= miners.length, String(credited));
	});


	it('is recorded as matured with its finder, hash, time, difficulty, shares, no orphan flag and the reward', async () => {
		const height = world.daemon.chain.tipHeight - 102;
		const finder = addresses.address('recorded');
		const member = await seedCandidate(world, { height, finder, scores: { [finder]: 77 } });
		const fields = await settled(world, height);
		assert.deepEqual(fields, member.split(':').slice(0, 6).concat(['0', String(reward)]));
	});


	it('takes its round\'s scores and shares away once settled', async () => {
		const height = world.daemon.chain.tipHeight - 103;
		const finder = addresses.address('cleanup');
		await seedCandidate(world, { height, finder, scores: { [finder]: 5 } });
		await settled(world, height);
		for (const kind of ['scores:prop', 'scores:solo', 'shares_actual:prop', 'shares_actual:solo']) {
			assert.equal(await world.redis.call('exists', 'bitlitas:' + kind + ':round' + height), 0, kind);
		}
	});


	it('of a solo miner pays the finder the reward less the pool fee, the soloFee being unset', async () => {
		const height = world.daemon.chain.tipHeight - 104;
		const finder = addresses.address('soloist');
		await seedCandidate(world, { height, finder, rewardType: 'solo', scores: { [finder]: 12 } });
		const fields = await settled(world, height);
		assert.equal(fields[0], 'solo');
		assert.equal(await balance(world, finder), Math.round(reward - reward * POOL_FEE));
	});


	it('is an orphan, crediting nobody, when the chain holds another block at its height', async () => {
		const height = world.daemon.chain.tipHeight - 105;
		const finder = addresses.address('orphaned');
		const member = await seedCandidate(world, { height, finder, scores: { [finder]: 40 }, orphan: true });
		const fields = await settled(world, height);
		assert.deepEqual(fields, member.split(':').slice(0, 6).concat(['1']));
		assert.equal(await balance(world, finder), 0);
		assert.equal(await world.redis.call('exists', 'bitlitas:scores:prop:round' + height), 0);
	});


	it('is looked up at its own height', async () => {
		const height = world.daemon.chain.tipHeight - 106;
		const finder = addresses.address('looked-up');
		await seedCandidate(world, { height, finder, scores: { [finder]: 1 } });
		await settled(world, height);
		assert.ok(world.daemon.callsOf('getblockheaderbyheight').some((call) => call.params.height === height));
	});


	it('waits while the daemon is away and settles when it is back', async () => {
		const height = world.daemon.chain.tipHeight - 107;
		const finder = addresses.address('patient');
		await world.daemon.stop();
		const mark = pool.mark();
		await seedCandidate(world, { height, finder, scores: { [finder]: 9 } });
		await pool.waitForOutput('Error with getblockheaderbyheight RPC request for block', { from: mark });
		assert.equal((await world.redis.call('zrangebyscore', 'bitlitas:blocks:matured', height, height)).length, 0);
		await world.daemon.start();
		await settled(world, height);
		assert.ok(await balance(world, finder) > 0);
	});


	it('matures with nobody credited when its round\'s scores are gone', async () => {
		const height = world.daemon.chain.tipHeight - 108;
		const finder = addresses.address('scoreless');
		await seedCandidate(world, { height, finder });
		const fields = await settled(world, height);
		assert.equal(fields[7], String(reward));
		assert.equal(await balance(world, finder), 0);
	});


	it('keeps a block pending when the daemon answers without a header', async () => {
		const height = world.daemon.chain.tipHeight - 109;
		const finder = addresses.address('headerless');
		world.daemon.override('getblockheaderbyheight', { result: { status: 'OK', untrusted: false } });
		const mark = pool.mark();
		try {
			await seedCandidate(world, { height, finder, scores: { [finder]: 3 } });
			await pool.waitForOutput('Error with getblockheaderbyheight RPC request for block', { from: mark });
			assert.equal((await world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height)).length, 1);
		} finally {
			delete world.daemon.overrides.getblockheaderbyheight;
		}
		await settled(world, height);
	});


	it('credits nobody a part too small to come to one atomic unit', async () => {
		const height = world.daemon.chain.tipHeight - 110;
		const [big, tiny] = [addresses.address('big-share'), addresses.address('tiny-share')];
		await seedCandidate(world, { height, finder: big, scores: { [big]: 1e15, [tiny]: 1 } });
		await settled(world, height);
		assert.ok(await balance(world, big) > 0);
		assert.equal(await world.redis.call('exists', 'bitlitas:workers:' + tiny), 0);
	});


	it('is an orphan when a longer chain replaced its block before it was 60 deep', async () => {
		const chain = world.daemon.chain;
		const height = chain.tipHeight - 30;
		const finder = addresses.address('reorged-early');
		const member = await seedCandidate(world, { height, finder, scores: { [finder]: 8 } });
		chain.reorg(height - 2, 40);
		const fields = await settled(world, height);
		assert.deepEqual(fields, member.split(':').slice(0, 6).concat(['1']));
		assert.equal(await balance(world, finder), 0);
	});


	it('stays credited when a reorganisation deeper than 60 blocks takes its block away later', async () => {
		const chain = world.daemon.chain;
		const height = chain.tipHeight - 100;
		const finder = addresses.address('reorged-late');
		await seedCandidate(world, { height, finder, scores: { [finder]: 8 } });
		const before = await settled(world, height);
		const credited = await balance(world, finder);
		chain.reorg(height - 5, 3);
		await sleep(2500);
		assert.notEqual(chain.hashAt(height), before[2]);
		assert.deepEqual(await settled(world, height), before);
		assert.equal(await balance(world, finder), credited);
	});


	it('settles two blocks in one pass, a miner in both credited for both', async () => {
		await world.stopPools();
		const tip = world.daemon.chain.tipHeight;
		const miner = addresses.address('twice');
		await seedCandidate(world, { height: tip - 200, finder: miner, scores: { [miner]: 1 } });
		await seedCandidate(world, { height: tip - 201, finder: miner, scores: { [miner]: 1 } });
		pool = await world.startPool({ blockUnlocker: { interval: 1 } }, { module: 'unlocker' });
		await pool.waitForOutput('Unlocked 2 blocks and update balances for 1 workers');
		assert.equal(await balance(world, miner), 2 * Math.round(reward - reward * POOL_FEE));
	});
});







// -----------------------------------------------------------
// Other fees
// -----------------------------------------------------------
//
// The fee settings the shipped file leaves at zero or unset,
// all at once: a finder's reward of 2 %, a solo fee of 0 %
// and a 10 % network fee taken before anything else.
// -----------------------------------------------------------

describe('a block candidate under other fee settings', () => {

	let world;
	let reward;

	before(async () => {
		world = await World.create('unlocker-fees');
		await world.startPool({ blockUnlocker: { interval: 1, finderReward: 2, soloFee: 0, networkFee: 10 } }, { module: 'unlocker' });
		reward = world.daemon.chain.reward - world.daemon.chain.reward * 0.1;
	});

	after(() => world.close());


	it('is recorded with the reward less the network fee', async () => {
		const height = world.daemon.chain.tipHeight - 100;
		const finder = addresses.address('net-fee');
		await seedCandidate(world, { height, finder, scores: { [finder]: 1 } });
		const fields = await settled(world, height);
		assert.equal(Number(fields[7]), reward);
	});


	it('gives the finder of a shared block 2 % on top of their score\'s part', async () => {
		const height = world.daemon.chain.tipHeight - 101;
		const [finder, other] = [addresses.address('finder'), addresses.address('other')];
		await seedCandidate(world, { height, finder, scores: { [finder]: 1, [other]: 1 } });
		await settled(world, height);
		const miners = Math.round(reward - reward * (POOL_FEE + 0.02));
		assert.equal(await balance(world, other), Math.round(miners * 0.5));
		assert.equal(await balance(world, finder), Math.round(miners * 0.5) + Math.round(reward * 0.02));
	});


	it('pays a solo finder the whole reward when the solo fee is 0', async () => {
		const height = world.daemon.chain.tipHeight - 102;
		const finder = addresses.address('free-solo');
		await seedCandidate(world, { height, finder, rewardType: 'solo', scores: { [finder]: 1 } });
		await settled(world, height);
		assert.equal(await balance(world, finder), Math.round(reward));
	});
});

