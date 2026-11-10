// -----------------------------------------------------------
//  [*] Tests — a block's life, the whole pool at work
//
//  Everything init.js starts, running together as in
//  production: the stratum ports, the template poller, the
//  unlocker, the payment run, the API and the charts. Two
//  miners mine on the test port; one share of one of them
//  becomes a block; the daemon takes it; sixty blocks later
//  the unlocker matures it and splits the reward by the
//  round's shares; the payment run pays both miners in one
//  transfer; and the API shows the block and the payment.
//  The tests run in order, each picking up where the last
//  left off. The unlocker runs every second and the payments
//  every two instead of every 30 and 1800, and the API
//  collects every second instead of five.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// The miner whose share becomes the block
const FINDER = addresses.address('life-finder');

// The miner whose share is in the same round
const HELPER = addresses.address('life-helper');

// The pool fee of the shipped file
const POOL_FEE = 0.01;

// The transfer fee each paid miner is charged
const TRANSFER_FEE = 14000000000;

// Payouts are rounded down to a tenth of an LTL
const DENOMINATION = 1e11;







// -----------------------------------------------------------
// A block from share to payment
// -----------------------------------------------------------
//
// One pool, two miners, one block, followed from the
// first share to the payment it ends in.
// -----------------------------------------------------------

describe('a block found by the pool', () => {

	let world;
	let pool;
	let finder;
	let helper;
	let height;
	let candidate;

	before(async () => {
		world = await World.create('block-lifecycle');
		pool = await world.startPool({
			blockUnlocker: { interval: 1 },
			payments: { interval: 2 },
			api: { updateInterval: 1 }
		}, { cheapPort: true });
		finder = await world.stratum('cheap');
		helper = await world.stratum('cheap');
		await finder.login(FINDER, 'finder-rig');
		await helper.login(HELPER, 'helper-rig');
	});

	after(() => world.close());


	it('starts with a share of the helper credited to the round', async () => {
		assert.equal((await helper.submit(helper.mine())).result.status, 'OK');
		await waitFor(async () => await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', HELPER) === '1', { what: 'the helper\'s score' });
	});


	it('turns the finder\'s share into a block, which the daemon takes', async () => {
		const chain = world.daemon.chain;
		height = chain.tipHeight + 2;
		chain.easyHeights.add(height);
		chain.mineElsewhere();
		const job = await finder.jobAtHeight(height);
		assert.equal((await finder.submit(finder.mine({ job }))).result.status, 'OK');
		await waitFor(() => chain.tipHeight === height, { what: 'the block taken', explain: () => pool.tail() });
		await pool.waitForOutput('found at height ' + height + ' by miner ' + FINDER);
	});


	it('waits as a candidate, the round of both miners closed under its height', async () => {
		candidate = await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height).then((list) => list[0]), { what: 'the candidate' });
		assert.deepEqual(await world.redis.call('hgetall', 'bitlitas:scores:prop:round' + height), { [HELPER]: '1', [FINDER]: '1' });
		await pool.waitForOutput('No pending blocks are unlocked yet');
	});


	it('matures sixty blocks later, the reward less the pool fee split by the shares', async () => {
		world.daemon.chain.mineElsewhere(60);
		const matured = await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:matured', height, height).then((list) => list[0]), { what: 'the block matured', explain: () => pool.tail() });
		const reward = world.daemon.chain.reward;
		assert.equal(matured, candidate.split(':').slice(0, 6).concat(['0', String(reward)]).join(':'));
		assert.equal(await world.redis.call('exists', 'bitlitas:scores:prop:round' + height), 0);
	});


	it('pays both miners in one transfer, each their share in tenths of an LTL less the fee', async () => {
		const reward = world.daemon.chain.reward;
		const share = Math.round(Math.round(reward - reward * POOL_FEE) * 0.5);
		const payout = share - share % DENOMINATION - TRANSFER_FEE;
		const call = await waitFor(() => world.wallet.callsOf('transfer')[0], { what: 'the transfer', explain: () => pool.tail() });
		assert.deepEqual(call.params.destinations.sort((a, b) => a.address.localeCompare(b.address)), [
			{ amount: payout, address: FINDER },
			{ amount: payout, address: HELPER }
		].sort((a, b) => a.address.localeCompare(b.address)));
		await waitFor(async () => Number(await world.redis.call('hget', 'bitlitas:workers:' + FINDER, 'paid')) === payout, { what: 'the payment recorded' });
		assert.equal(Number(await world.redis.call('hget', 'bitlitas:workers:' + FINDER, 'balance')), share % DENOMINATION);
	});


	it('shows the block and the payment through the API', async () => {
		const reply = await waitFor(async () => {
			const answer = await apiGet(world.apiPort, '/stats');
			return answer.json && answer.json.pool && answer.json.pool.totalPayments === 1 && answer;
		}, { what: 'the payment in /stats' });
		assert.equal(reply.json.pool.totalBlocks, 1);
		assert.equal(reply.json.pool.totalMinersPaid, 2);
		const transfer = world.wallet.transfers[0];
		assert.equal(reply.json.pool.payments[0].split(':')[0], transfer.txHash);
		const own = await apiGet(world.apiPort, '/stats_address?address=' + FINDER);
		assert.equal(own.json.payments[0].split(':')[0], transfer.txHash);
		assert.equal(own.json.workers[0].name, 'finder-rig');
	});


	it('leaves the miners mining the next height', async () => {
		const next = world.daemon.chain.tipHeight + 1;
		assert.ok(await finder.jobAtHeight(next));
		assert.ok(await helper.jobAtHeight(next));
	});
});
