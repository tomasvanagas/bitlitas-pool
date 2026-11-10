// -----------------------------------------------------------
//  [*] Tests — pinned defects of the payment run
//
//  Each test states what the payment run should do;
//  pinDefect keeps the run green while the defect lives and
//  fails once it is gone (tests/README.md, "Pinned defects").
//  The standalone payment id the wallet refuses is pinned at
//  the login that lets it in, in tests/stratum/defects.test.js.
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
// Payments
// -----------------------------------------------------------
//
// At the shipped interval of half an hour, so a second
// transfer within the test can only come from a run that
// started over.
// -----------------------------------------------------------

describe('the payment run', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('payment-defects');
		pool = await world.startPool({}, { module: 'payments' });
	});

	after(() => world.close());


	pinDefect('payment-records-configured-fee', 'record the fee the wallet paid, not the one the configuration names', async () => {
		const miner = addresses.address('fee-record');
		await world.redis.call('hset', 'bitlitas:workers:' + miner, 'balance', 2 * LTL);
		await world.stopPools();
		pool = await world.startPool({}, { module: 'payments' });
		const transfer = await waitFor(() => world.wallet.transfers.find((one) => one.destinations[0].address === miner), { what: 'the transfer' });
		const [record] = await waitFor(() => world.redis.call('zrange', 'bitlitas:payments:' + miner, 0, -1).then((list) => list.length && list), { what: 'the record' });
		assert.equal(Number(record.split(':')[2]), transfer.fee, 'the wallet charged ' + transfer.fee + ', the record says ' + record.split(':')[2]);
	});


	pinDefect('unreadable-transfer-reply-pays-twice', 'send a transfer once when the wallet\'s reply could not be read', async () => {
		const miner = addresses.address('pay-twice');
		world.wallet.mode = 'empty';
		await world.redis.call('hset', 'bitlitas:workers:' + miner, 'balance', 2 * LTL);
		await world.stopPools();
		pool = await world.startPool({}, { module: 'payments' });
		await waitFor(() => world.wallet.callsOf('transfer').some((call) => call.params.destinations[0].address === miner), { what: 'the transfer' });
		await sleep(4000);
		world.wallet.mode = 'ok';
		const sent = world.wallet.callsOf('transfer').filter((call) => call.params.destinations[0].address === miner).length;
		assert.equal(sent, 1, 'the run crashed on the reply, started over and sent the same payment again');
	});
});
