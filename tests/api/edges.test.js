// -----------------------------------------------------------
//  [*] Tests — the API at its edges
//
//  The answers the other API files do not reach: the top
//  miners in order, a miner in the round but not in the
//  hashrate window, the thirty-day edge of the blocks chart,
//  the one-hour, six-hour and one-day averages of the charts,
//  the refusals of the settings calls, a payout ceiling, and
//  the test notifications with email and Telegram switched on
//  but Telegram left without a token. The API runs on its own,
//  collecting every second, with a payout ceiling of 5 LTL.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { seedMatured } = require('../support/rounds.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// Three miners of different hashrates, and one that has a
// round score but no share in the hashrate window
const [SLOW, FAST, MIDDLE, ROUND_ONLY] = ['edge-slow', 'edge-fast', 'edge-middle', 'edge-round'].map((label) => addresses.address(label));

// The world, its API, and when the records were written
let world;
let now;

before(async () => {
	world = await World.create('api-edges');
	now = Math.floor(Date.now() / 1000);
	const ms = Date.now();
	await world.redis.multi([
		['zadd', 'bitlitas:hashrate', now - 5, '600:' + SLOW + ':' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '6000:' + FAST + ':' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '6000:' + FAST + '~rig:' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '3000:' + MIDDLE + ':' + ms + ':prop'],
		['hset', 'bitlitas:workers:' + SLOW, 'hashes', 600],
		['hset', 'bitlitas:workers:' + FAST, 'hashes', 6000],
		['hset', 'bitlitas:workers:' + MIDDLE, 'hashes', 3000],
		['hset', 'bitlitas:unique_workers:' + FAST + '~rig', 'hashes', 6000, 'lastShare', now - 5],
		['hset', 'bitlitas:scores:prop:roundCurrent', ROUND_ONLY, 500],
		['set', 'bitlitas:charts:hashrate:' + FAST, JSON.stringify([[now - 60, 9, 2], [now - 3 * 3600, 3, 2], [now - 12 * 3600, 6, 2]])],
		['set', 'bitlitas:charts:worker_hashrate:' + FAST + '~rig', JSON.stringify([[now - 60, 8, 3]])],
		['sadd', 'bitlitas:workers_ip:' + FAST, '::ffff:10.5.5.5']
	]);
	await seedMatured(world, { height: 353000, finder: FAST, time: now - 3600 });
	await seedMatured(world, { height: 340000, finder: FAST, time: now - 40 * 86400 });
	await world.startPool({
		api: { updateInterval: 1 },
		payments: { maxPayment: 5e12 },
		email: { enabled: true },
		telegram: { enabled: true, token: '' }
	}, { module: 'api' });
	await waitFor(async () => (await apiGet(world.apiPort, '/stats')).json?.pool, { what: 'the first collection' });
});

after(() => world.close());







// -----------------------------------------------------------
// call
// -----------------------------------------------------------
//
// One API call's JSON reply, its query built from an object.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function call (path, query = {}) {

	return (await apiGet(world.apiPort, path + '?' + new URLSearchParams(query).toString())).json;
}







// -----------------------------------------------------------
// Statistics
// -----------------------------------------------------------
//
// The figures of /stats, the top miners and a miner's page
// that only these records bring out.
// -----------------------------------------------------------

describe('the statistics at their edges', () => {

	it('order the top miners by hashrate, highest first', async () => {
		const top = await call('/get_top10miners');
		assert.deepEqual(top.map((entry) => entry.hashrate), [10, 5, 1]);
		assert.equal(top[0].miner, FAST.substring(0, 7) + '...' + FAST.substring(FAST.length - 7));
	});


	it('give a miner in the round but not in the hashrate window its round score alone', async () => {
		const { miner } = await call('/stats', { address: ROUND_ONLY });
		assert.deepEqual(miner, { roundScore: 500 });
	});


	it('leave a block matured more than thirty days ago out of the blocks chart', async () => {
		const { charts } = await call('/stats');
		assert.equal(Object.values(charts.blocks).reduce((sum, count) => sum + count, 0), 1);
	});


	it('average a miner\'s chart over the last hour, six hours and day', async () => {
		const { stats } = await call('/stats_address', { address: FAST });
		assert.equal(stats.hashrate_1h, 9);
		assert.equal(stats.hashrate_6h, 6);
		assert.equal(stats.hashrate_24h, 6);
	});


	it('average a worker\'s chart the same way on the miner\'s page and in its long poll', async () => {
		const page = await call('/stats_address', { address: FAST });
		assert.equal(page.workers[0].hashrate_1h, 8);
		const poll = await call('/stats_address', { address: FAST, longpoll: 'true' });
		assert.equal(poll.workers[0].hashrate_1h, 8);
		assert.equal(poll.stats.hashrate_1h, 9);
	});


	it('answer a block list asked for without a height with "Query failed"', async () => {
		assert.deepEqual(await call('/get_blocks'), { error: 'Query failed' });
	});
});







// -----------------------------------------------------------
// Settings
// -----------------------------------------------------------
//
// The refusals of the settings calls, and the payout ceiling.
// -----------------------------------------------------------

describe('the settings calls at their edges', () => {

	it('refuse a payout level above the ceiling, and cap a stored one at it', async () => {
		assert.deepEqual(await call('/set_miner_payout_level', { address: FAST, ip: '10.5.5.5', level: '6' }), { status: 'The maximum payout level is 5' });
		await world.redis.call('hset', 'bitlitas:workers:' + FAST, 'minPayoutLevel', 9e12);
		assert.deepEqual(await call('/get_miner_payout_level', { address: FAST }), { status: 'done', level: 5 });
	});


	it('want an address, an IP and an action before changing email notifications, and no wildcard', async () => {
		assert.deepEqual(await call('/get_email_notifications'), { status: 'Parameters are incomplete' });
		assert.deepEqual(await call('/set_email_notifications', { address: FAST, action: 'enable' }), { status: 'Parameters are incomplete' });
		assert.deepEqual(await call('/set_email_notifications', { address: FAST + '*', ip: '10.5.5.5', action: 'enable' }), { status: 'Remove the wildcard from your input' });
	});


	it('want a chat id and an address before reading or changing Telegram notifications', async () => {
		assert.deepEqual(await call('/get_telegram_notifications'), { status: 'No chat id specified' });
		assert.deepEqual(await call('/get_telegram_notifications', { chatId: '1' }), { status: 'No miner address specified' });
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '1', action: 'enable' }), { status: 'No miner address specified' });
		assert.deepEqual(await call('/set_telegram_notifications', { chatId: '1', type: 'default' }), { status: 'No miner address specified' });
	});
});







// -----------------------------------------------------------
// Test notifications
// -----------------------------------------------------------
//
// Email on, Telegram on without a token.
// -----------------------------------------------------------

describe('the test notifications', () => {

	it('want an address to send the test mail to', async () => {
		assert.deepEqual(await call('/test_email_notification'), { status: 'No email specified' });
	});


	it('say Telegram has no token', async () => {
		assert.deepEqual(await call('/test_telegram_notification'), { status: 'No telegram bot token specified in configuration' });
	});
});
