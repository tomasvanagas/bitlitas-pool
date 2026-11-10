// -----------------------------------------------------------
//  [*] Tests — a miner's own settings through the API
//
//  The settings page of the website: the payout level, the
//  address for email notifications, and the Telegram chats.
//  Levels are in LTL, at least the 1 LTL minimum, stored in
//  atomic units. A change is allowed when the IP the request
//  names has been seen mining for the address — the IPv4
//  form the website sends is matched against the IPv4-mapped
//  form the pool stores. Telegram chats are set without that
//  check (Telegram is off in the shipped file; the chats are
//  stored all the same).
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');


// The miner whose settings change
const MINER = addresses.address('settings-miner');

// The IP it mined from, as the pool stores it
const STORED_IP = '::ffff:10.1.2.3';

// The same IP as the miner types it
const TYPED_IP = '10.1.2.3';

// The world and its API
let world;

before(async () => {
	world = await World.create('api-settings');
	await world.redis.call('sadd', 'bitlitas:workers_ip:' + MINER, STORED_IP);
	await world.redis.call('hset', 'bitlitas:workers:' + MINER, 'hashes', 100);
	await world.startPool({}, { module: 'api' });
});

after(() => world.close());







// -----------------------------------------------------------
// call
// -----------------------------------------------------------
//
// One settings call's JSON reply, its query built from an
// object.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function call (path, query) {

	const reply = await apiGet(world.apiPort, path + '?' + new URLSearchParams(query).toString());
	return reply.json;
}







// -----------------------------------------------------------
// The payout level
// -----------------------------------------------------------
//
// The level above which the payment run pays a miner.
// -----------------------------------------------------------

describe('the payout level', () => {

	it('is the 1 LTL minimum until the miner sets one', async () => {
		assert.deepEqual(await call('/get_miner_payout_level', { address: MINER }), { status: 'done', level: 1 });
	});


	it('is set in LTL from the IP the miner mined from, and stored in atomic units', async () => {
		assert.deepEqual(await call('/set_miner_payout_level', { address: MINER, ip: TYPED_IP, level: '2.5' }), { status: 'done' });
		assert.equal(await world.redis.call('hget', 'bitlitas:workers:' + MINER, 'minPayoutLevel'), '2500000000000');
		assert.deepEqual(await call('/get_miner_payout_level', { address: MINER }), { status: 'done', level: 2.5 });
	});


	it('is not set from an IP never seen mining for the address', async () => {
		const reply = await call('/set_miner_payout_level', { address: MINER, ip: '10.9.9.9', level: '3' });
		assert.deepEqual(reply, { status: 'We haven\'t seen that IP for that wallet address in our record' });
	});


	it('is not set below the minimum, nor to something that is no number', async () => {
		assert.deepEqual(await call('/set_miner_payout_level', { address: MINER, ip: TYPED_IP, level: '0.5' }), { status: 'The minimum payout level is 1' });
		assert.deepEqual(await call('/set_miner_payout_level', { address: MINER, ip: TYPED_IP, level: 'lots' }), { status: 'Your minimum payout level doesn\'t look like a number' });
	});


	it('is not set without the address, the IP and the level, nor with a wildcard', async () => {
		assert.deepEqual(await call('/set_miner_payout_level', { address: MINER, level: '2' }), { status: 'Parameters are incomplete' });
		assert.deepEqual(await call('/set_miner_payout_level', { address: '*', ip: TYPED_IP, level: '2' }), { status: 'Remove the wildcard from your miner address' });
		assert.deepEqual(await call('/get_miner_payout_level', {}), { status: 'Parameters are incomplete' });
	});
});







// -----------------------------------------------------------
// Email notifications
// -----------------------------------------------------------
//
// The address the pool mails a miner's worker and payment
// news to.
// -----------------------------------------------------------

describe('email notifications', () => {

	it('are switched on with an address from the IP the miner mined from', async () => {
		assert.deepEqual(await call('/set_email_notifications', { address: MINER, ip: TYPED_IP, action: 'enable', email: 'miner@example.lt' }), { status: 'done' });
		assert.deepEqual(await call('/get_email_notifications', { address: MINER }), { status: 'done', email: 'miner@example.lt' });
	});


	it('are switched off again', async () => {
		assert.deepEqual(await call('/set_email_notifications', { address: MINER, ip: TYPED_IP, action: 'disable' }), { status: 'done' });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(await call('/get_email_notifications', { address: MINER }), { status: 'done', email: null });
	});


	it('are not switched on without an address, nor from an unseen IP, nor by an unknown action', async () => {
		assert.deepEqual(await call('/set_email_notifications', { address: MINER, ip: TYPED_IP, action: 'enable' }), { status: 'No email address specified' });
		assert.deepEqual(await call('/set_email_notifications', { address: MINER, ip: '10.9.9.9', action: 'enable', email: 'x@y.lt' }), { status: 'We haven\'t seen that IP for your address' });
		assert.deepEqual(await call('/set_email_notifications', { address: MINER, ip: TYPED_IP, action: 'spam' }), { status: 'Invalid action' });
	});
});







// -----------------------------------------------------------
// Telegram notifications
// -----------------------------------------------------------
//
// The chats the pool would message, for a miner, for
// blocks, and as a chat's default miner.
// -----------------------------------------------------------

describe('telegram notifications', () => {

	it('link a chat to a known miner and back, with no IP asked for', async () => {
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '4242', address: MINER, action: 'enable' }), { status: 'done' });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(await call('/get_telegram_notifications', { chatId: '4242', address: MINER }), { status: 'done', chatId: '4242' });
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '4242', address: MINER, action: 'disable' }), { status: 'done' });
	});


	it('are not linked to an address the pool has never seen', async () => {
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '4242', address: addresses.address('nobody'), action: 'enable' }), { status: 'Miner not found in database' });
	});


	it('of blocks are switched on and off for a chat', async () => {
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '777', type: 'blocks', action: 'enable' }), { status: 'done' });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(await call('/get_telegram_notifications', { chatId: '777', type: 'blocks' }), { status: 'done', enabled: 1 });
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '777', type: 'blocks', action: 'disable' }), { status: 'done' });
	});


	it('keep a chat\'s default miner address', async () => {
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '888', type: 'default', address: MINER }), { status: 'done' });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(await call('/get_telegram_notifications', { chatId: '888', type: 'default' }), { status: 'done', address: MINER });
	});


	it('need a chat id and a known action', async () => {
		assert.deepEqual(await call('/set_telegram_notifications', { address: MINER, action: 'enable' }), { status: 'No chat id specified' });
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '1', address: MINER, action: 'maybe' }), { status: 'Invalid action' });
	});
});
