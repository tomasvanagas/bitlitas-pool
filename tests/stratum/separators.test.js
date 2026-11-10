// -----------------------------------------------------------
//  [*] Tests — logins under the upstream payment-id separator
//
//  The shipped file separates both a payment id and a fixed
//  difficulty from the address with ".", so a login can carry
//  one or the other. Upstream's default for the payment id is
//  "+", which lets a login carry both; an operator who wants
//  that changes one setting, and these are the logins the pool
//  then takes and refuses. With paymentId.validation on, a
//  login with two payment ids bans its IP. The refusal of a
//  short payment id is pinned in defects.test.js for what it
//  says.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { targetHex } = require('../support/stratum.js');
const { waitFor } = require('../support/wait.js');


// A payment id of 64 characters
const PAYMENT_ID = 'ef'.repeat(32);







// -----------------------------------------------------------
// "+" for the payment id
// -----------------------------------------------------------
//
// The payment id behind "+", the difficulty behind "." as
// shipped.
// -----------------------------------------------------------

describe('a login under the "+" separator', () => {

	let world;

	before(async () => {
		world = await World.create('separators');
		await world.startPool({ poolServer: { paymentId: { addressSeparator: '+' } }, api: { enabled: false } });
	});

	after(() => world.close());


	it('may carry a payment id and a fixed difficulty together', async () => {
		const address = addresses.address('plus-both');
		const miner = await world.stratum(3333);
		const reply = await miner.login(address + '+' + PAYMENT_ID + '.20000');
		assert.equal(reply.result.status, 'OK');
		assert.equal(reply.result.job.target, targetHex(20000));
		await waitFor(async () => await world.redis.call('hget', 'bitlitas:active_connections', address + '+' + PAYMENT_ID + '~x') === '1', { what: 'the login recorded with its payment id' });
	});


	it('leaves a "." payment id to be read as a difficulty', async () => {
		const address = addresses.address('plus-dot');
		const miner = await world.stratum(3333);
		const reply = await miner.login(address + '.00112233aabbccdd');
		assert.equal(reply.result.status, 'OK');
		assert.equal(reply.result.job.target, targetHex(5000));
	});


	it('refuses two payment ids without banning while validation is off', async () => {
		const miner = await world.stratum(3333, { localAddress: '127.0.0.16' });
		const reply = await miner.login(addresses.address('plus-two') + '+a+b');
		assert.equal(reply.error.message, 'Invalid paymentId specified for parent login, ::ffff:127.0.0.16');
		assert.equal((await miner.login(addresses.address('plus-two'))).result.status, 'OK');
	});
});







// -----------------------------------------------------------
// Validation on
// -----------------------------------------------------------
//
// The same separator with paymentId.validation on, which turns
// a refusal into a ban.
// -----------------------------------------------------------

describe('a login under the "+" separator with payment-id validation on', () => {

	let world;

	before(async () => {
		world = await World.create('separators-validating');
		await world.startPool({ poolServer: { paymentId: { addressSeparator: '+', validation: true } }, api: { enabled: false } });
	});

	after(() => world.close());


	it('with two payment ids bans its IP', async () => {
		const miner = await world.stratum(3333, { localAddress: '127.0.0.17' });
		const reply = await miner.login(addresses.address('plus-banned') + '+a+b');
		assert.equal(reply.error.message, 'Invalid paymentId specified for parent login, ::ffff:127.0.0.17 banned for 10 minutes');
		await waitFor(async () => (await miner.login(addresses.address('plus-banned'))).error?.message === 'Your IP is banned', { what: 'the ban', timeout: 5000 });
	});
});
