// -----------------------------------------------------------
//  [*] Tests — the payment run
//
//  lib/paymentProcessor.js, run on its own (-module=payments).
//  It starts with a run and repeats every interval (1800
//  seconds as shipped; one second here, so retries show).
//  Each run reads every miner's balance, picks the balances
//  at or over the miner's payout level (1 LTL unless the miner
//  set a higher one), rounds each down to a tenth of an LTL,
//  takes the 0.014 LTL transfer fee off it, and pays through
//  the wallet RPC's transfer — up to 50 miners in one
//  transaction, and an integrated address or a payment id in
//  a transaction of its own. A paid balance keeps only its
//  remainder, and the payment is recorded for the pool and
//  for the miner. A transfer the wallet refuses changes
//  nothing, so the next run tries again.
//
//  The balances are written into Redis as the unlocker
//  credits them; the wallet is the fake one, which refuses
//  what bitlitas-wallet-rpc v0.18 refused.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { balance } = require('../support/rounds.js');
const { waitFor, sleep } = require('../support/wait.js');


// One LTL in atomic units
const LTL = 1e12;

// The shipped transfer fee, charged per destination
const FEE = 14000000000;







// -----------------------------------------------------------
// ltl
// -----------------------------------------------------------
//
// An amount of LTL in whole atomic units — a balance the
// pool stores is never a fraction of one.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function ltl (amount) {

	return Math.round(amount * LTL);
}







// -----------------------------------------------------------
// credit
// -----------------------------------------------------------
//
// Sets a miner's balance (and, when given, the payout level
// the miner chose) the way the unlocker and the API write
// them.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function credit (world, miner, amount, payoutLevel) {

	await world.redis.call('hset', 'bitlitas:workers:' + miner, 'balance', amount);
	if (payoutLevel !== undefined) await world.redis.call('hset', 'bitlitas:workers:' + miner, 'minPayoutLevel', payoutLevel);
}







// -----------------------------------------------------------
// transfersTo
// -----------------------------------------------------------
//
// The transfer calls the wallet got that pay a given address.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function transfersTo (world, address) {

	return world.wallet.callsOf('transfer').filter((call) => call.params.destinations.some((destination) => destination.address === address));
}







// -----------------------------------------------------------
// The shipped rules
// -----------------------------------------------------------
//
// One payment run under the shipped settings, every
// second; each test pays a miner of its own.
// -----------------------------------------------------------

describe('a payment run', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('payments');
		pool = await world.startPool({ payments: { interval: 1 } }, { module: 'payments' });
	});

	after(() => world.close());


	it('pays nobody below the 1 LTL minimum', async () => {
		const miner = addresses.address('pay-below');
		await credit(world, miner, ltl(0.99));
		await sleep(2500);
		assert.equal(transfersTo(world, miner).length, 0);
		assert.equal(await balance(world, miner), ltl(0.99));
	});


	it('pays a balance from 1 LTL, rounded down to a tenth, less the 0.014 LTL fee', async () => {
		const miner = addresses.address('pay-once');
		await credit(world, miner, ltl(1.2345));
		const [call] = await waitFor(() => transfersTo(world, miner).length && transfersTo(world, miner), { what: 'the transfer' });
		assert.deepEqual(call.params, {
			destinations: [{ amount: ltl(1.2) - FEE, address: miner }],
			fee: FEE,
			priority: 0,
			unlock_time: 0,
			mixin: 7
		});
	});


	it('leaves the remainder as the balance and adds the payout to what was paid', async () => {
		const miner = addresses.address('pay-once');
		await waitFor(async () => await balance(world, miner) < LTL, { what: 'the balance to drop' });
		assert.equal(await balance(world, miner), ltl(1.2345) - ltl(1.2));
		assert.equal(Number(await world.redis.call('hget', 'bitlitas:workers:' + miner, 'paid')), ltl(1.2) - FEE);
	});


	it('records the payment for the pool and for the miner, with the hash the wallet gave', async () => {
		const miner = addresses.address('pay-once');
		const transfer = world.wallet.transfers.find((one) => one.destinations.some((destination) => destination.address === miner));
		const all = await world.redis.call('zrange', 'bitlitas:payments:all', 0, -1);
		assert.ok(all.includes([transfer.txHash, ltl(1.2) - FEE, FEE, 7, 1].join(':')), all.join('\n'));
		const own = await world.redis.call('zrange', 'bitlitas:payments:' + miner, 0, -1, 'WITHSCORES');
		assert.equal(own[0], [transfer.txHash, ltl(1.2) - FEE, FEE, 7].join(':'));
		assert.ok(Math.abs(Number(own[1]) - Date.now() / 1000) < 60);
	});


	it('pays a balance only once', async () => {
		await sleep(2500);
		assert.equal(transfersTo(world, addresses.address('pay-once')).length, 1);
	});


	it('pays 50 miners in one transaction and the next in another, the fee 0.014 LTL per destination', async () => {
		const miners = Array.from({ length: 51 }, (unused, i) => addresses.address('batch-' + i));
		await world.redis.multi(miners.map((miner) => ['hset', 'bitlitas:workers:' + miner, 'balance', ltl(1.1)]));
		await waitFor(() => miners.every((miner) => transfersTo(world, miner).length === 1), { what: '51 miners paid' });
		const calls = [...new Set(miners.map((miner) => transfersTo(world, miner)[0]))];
		assert.deepEqual(calls.map((call) => call.params.destinations.length).sort((a, b) => a - b), [1, 50]);
		for (const call of calls) assert.equal(call.params.fee, FEE * call.params.destinations.length);
	});


	it('pays an integrated address in a transaction of its own, without a payment id beside it', async () => {
		const integrated = addresses.integratedAddress('pay-integrated', '0102030405060708');
		const plain = addresses.address('pay-plain');
		await credit(world, integrated, LTL);
		await credit(world, plain, LTL);
		const [call] = await waitFor(() => transfersTo(world, integrated).length && transfersTo(world, integrated), { what: 'the transfer' });
		assert.equal(call.params.destinations.length, 1);
		assert.equal(call.params.payment_id, undefined);
		await waitFor(() => transfersTo(world, plain).length, { what: 'the plain address paid too' });
	});


	it('keeps the balance of a miner the wallet will not pay, a standalone payment id, and goes on', async () => {
		const miner = addresses.address('pay-payment-id');
		const login = miner + '.' + 'ef'.repeat(32);
		const other = addresses.address('pay-after-refusal');
		const mark = pool.mark();
		await credit(world, login, ltl(2));
		await credit(world, other, ltl(2));
		await pool.waitForOutput('Standalone payment IDs are obsolete', { from: mark });
		const [call] = transfersTo(world, miner);
		assert.equal(call.params.payment_id, 'ef'.repeat(32));
		assert.equal(await balance(world, login), ltl(2));
		await waitFor(() => transfersTo(world, other).length, { what: 'the other miner paid' });
	});


	it('pays a payment id of a length the wallet does not take to the plain address, without it', async () => {
		const miner = addresses.address('pay-odd-id');
		const login = miner + '.' + 'c'.repeat(40);
		await credit(world, login, ltl(2));
		const [call] = await waitFor(() => transfersTo(world, miner).length && transfersTo(world, miner), { what: 'the transfer' });
		assert.equal(call.params.payment_id, undefined);
		await waitFor(async () => await balance(world, login) < LTL, { what: 'the balance paid' });
		assert.equal((await world.redis.call('zrange', 'bitlitas:payments:' + miner, 0, -1)).length, 1);
		assert.equal((await world.redis.call('zrange', 'bitlitas:payments:' + login, 0, -1)).length, 0);
	});


	it('waits for a payout level the miner set above the minimum', async () => {
		const miner = addresses.address('pay-level');
		await credit(world, miner, ltl(3), ltl(5));
		await sleep(2500);
		assert.equal(transfersTo(world, miner).length, 0);
		await credit(world, miner, ltl(5.5));
		await waitFor(() => transfersTo(world, miner).length, { what: 'the transfer' });
	});


	it('reads a payout level below the minimum as the minimum', async () => {
		const miner = addresses.address('pay-low-level');
		await credit(world, miner, ltl(0.5), ltl(0.1));
		await sleep(2500);
		assert.equal(transfersTo(world, miner).length, 0);
	});


	it('keeps the balances when the wallet is away, and pays once it is back', async () => {
		const miner = addresses.address('pay-wallet-away');
		await world.wallet.stop();
		const mark = pool.mark();
		await credit(world, miner, ltl(2));
		await pool.waitForOutput('Error with transfer RPC request to wallet daemon', { from: mark });
		assert.equal(await balance(world, miner), ltl(2));
		await world.wallet.start();
		await waitFor(async () => await balance(world, miner) < LTL, { what: 'the payment after the wallet came back' });
	});


	it('keeps the balances when the wallet has too little to send', async () => {
		const miner = addresses.address('pay-poor-wallet');
		world.wallet.balance = LTL;
		const mark = pool.mark();
		await credit(world, miner, ltl(3));
		await pool.waitForOutput('not enough money', { from: mark });
		assert.equal(await balance(world, miner), ltl(3));
		world.wallet.balance = ltl(1000);
		await waitFor(async () => await balance(world, miner) < LTL, { what: 'the payment once the wallet had funds' });
	});
});







// -----------------------------------------------------------
// Other limits
// -----------------------------------------------------------
//
// The limits the shipped file leaves open: a payout level
// capped at 2 LTL, transactions of at most 3 LTL, a minimum of
// 0.01 LTL, below the transfer fee, and a ring size of 16 —
// the field the v0.18 wallet reads, where the shipped mixin
// is one it ignores.
// -----------------------------------------------------------

describe('a payment run under other limits', () => {

	let world;

	before(async () => {
		world = await World.create('payments-limits');
		await world.startPool({ payments: { interval: 1, maxPayment: ltl(2), maxTransactionAmount: ltl(3), minPayment: ltl(0.01), ringSize: 16 } }, { module: 'payments' });
	});

	after(() => world.close());


	it('caps a miner\'s payout level at the maximum', async () => {
		const miner = addresses.address('cap-level');
		await credit(world, miner, ltl(2.5), ltl(9));
		await waitFor(() => transfersTo(world, miner).length, { what: 'the capped payout' });
	});


	it('splits payments so no transaction carries more than the maximum, the rest paid later', async () => {
		const miners = [addresses.address('split-1'), addresses.address('split-2')];
		await world.redis.multi(miners.map((miner) => ['hset', 'bitlitas:workers:' + miner, 'balance', ltl(2.5)]));
		await waitFor(async () => await balance(world, miners[0]) < ltl(0.1) && await balance(world, miners[1]) < ltl(0.1), { what: 'both paid out' });
		assert.deepEqual(miners.map((miner) => transfersTo(world, miner).length).sort(), [1, 2]);
		for (const call of world.wallet.callsOf('transfer')) {
			const total = call.params.destinations.reduce((sum, destination) => sum + destination.amount, 0);
			assert.ok(total <= ltl(3), String(total));
		}
	});


	it('asks the wallet for the ring size when ringSize is set, and records it in place of the mixin', async () => {
		const miner = addresses.address('ring-size');
		await credit(world, miner, ltl(1.5));
		const [call] = await waitFor(() => transfersTo(world, miner).length && transfersTo(world, miner), { what: 'the transfer' });
		assert.equal(call.params.ring_size, 16);
		assert.equal(call.params.mixin, undefined);
		const [record] = await waitFor(() => world.redis.call('zrange', 'bitlitas:payments:' + miner, 0, -1).then((list) => list.length && list), { what: 'the record' });
		assert.equal(record.split(':')[3], '16');
	});


	it('never pays a balance smaller than its transfer fee', async () => {
		const miner = addresses.address('fee-bigger');
		await credit(world, miner, ltl(0.012));
		await sleep(2500);
		assert.equal(transfersTo(world, miner).length, 0);
		assert.equal(await balance(world, miner), ltl(0.012));
	});
});
