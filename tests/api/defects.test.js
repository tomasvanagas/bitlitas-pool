// -----------------------------------------------------------
//  [*] Tests — pinned defects of the API
//
//  Each test states what the API should do; pinDefect keeps
//  the run green while the defect lives and fails once it is
//  gone (tests/README.md, "Pinned defects"). The first is the
//  gravest: the shipped file trusts X-Forwarded-For, so a
//  request that names 127.0.0.1 in that header is "local" and
//  needs no password for any administration call — and the
//  API port is one the image exposes. A crash here is the API
//  worker dying: the master forks a new one two seconds
//  later, which means the API is gone meanwhile and every
//  visitor can take it down again.
// -----------------------------------------------------------

const { describe, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');
const { waitFor, sleep } = require('../support/wait.js');
const { seedMatured } = require('../support/rounds.js');
const { pinDefect } = require('../support/defects.js');


// Where a request from another machine comes from
const ELSEWHERE = '127.0.0.2';

// The line the master logs when the API worker dies
const API_DIED = 'API died, spawning replacement...';







// -----------------------------------------------------------
// survives
// -----------------------------------------------------------
//
// Whether the API worker is still the same one a moment after
// a request: no death logged since the mark, and the API
// answering /stats.
//
// Used by:
//   - the crash tests (below)
// -----------------------------------------------------------

async function survives (pool, port, mark) {

	await sleep(1500);
	return pool.count(API_DIED, mark) === 0 && (await apiGet(port, '/stats')).status === 200;
}







// -----------------------------------------------------------
// The API
// -----------------------------------------------------------
//
// One API with records that bring each defect out: a
// worker named in Lithuanian, a miner without a password,
// a miner whose IP is known.
// -----------------------------------------------------------

describe('the API', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('api-defects');
		const now = Math.floor(Date.now() / 1000);
		await world.redis.multi([
			['zadd', 'bitlitas:hashrate', now - 5, '6000:' + addresses.address('lt-worker') + '~ąžuolas:' + Date.now() + ':prop'],
			['zadd', 'bitlitas:hashrate', now - 5, '6000:' + addresses.address('lt-worker') + ':' + Date.now() + ':prop'],
			['zadd', 'bitlitas:hashrate', now - 5, '3000:' + addresses.address('no-password') + ':' + (Date.now() + 1) + ':prop'],
			['sadd', 'bitlitas:workers_ip:' + addresses.address('victim'), '::ffff:10.20.30.40']
		]);
		pool = await world.startPool({ api: { updateInterval: 1 } }, { module: 'api' });
		await waitFor(async () => (await apiGet(world.apiPort, '/stats')).json?.pool, { what: 'the first collection' });
	});

	after(() => world.close());


	pinDefect('forwarded-for-skips-password', 'ask a request from another machine for the password, whatever X-Forwarded-For says', async () => {
		const reply = await apiGet(world.apiPort, '/admin_users', { localAddress: ELSEWHERE, headers: { 'X-Forwarded-For': '127.0.0.1' } });
		assert.equal(reply.status, 401, 'the header made the request local: ' + reply.status + ' ' + reply.body.slice(0, 80));
	});


	pinDefect('payout-level-trusts-typed-ip', 'let only the miner\'s own IP change its payout level, not an IP the request merely names', async () => {
		const reply = await apiGet(world.apiPort, '/set_miner_payout_level?address=' + addresses.address('victim') + '&ip=10.20.30.40&level=1000', { localAddress: ELSEWHERE });
		assert.notDeepEqual(reply.json, { status: 'done' }, 'a request from ' + ELSEWHERE + ' set the payout level of a miner mining from 10.20.30.40');
	});


	pinDefect('workers-hashrate-counts-characters', 'send the workers\' hashrates whole when a worker name has Lithuanian letters', async () => {
		const reply = await apiGet(world.apiPort, '/workers_hashrate');
		assert.ok(reply.json, 'Content-Length counted characters, not bytes: the reply came ' + (reply.error ? 'with ' + reply.error : 'cut short') + ' and does not parse');
	});


	pinDefect('empty-password-adds-no-hashrate', 'count a miner who logged in without a password in the pool\'s hashrate', async () => {
		const { json } = await apiGet(world.apiPort, '/stats');
		assert.equal(json.pool.miners, 2);
		assert.ok(json.pool.hashrate >= Math.round((6000 + 3000) / 600), 'the pool hashrate ' + json.pool.hashrate + ' adds up worker records only');
	});


	pinDefect('market-lookup-never-answers', 'answer a market lookup on an exchange it cannot reach', async () => {
		const reply = await apiGet(world.apiPort, '/get_market?tickers[]=LTL-BTC&exchange=coingecko', { timeout: 8000 });
		assert.notEqual(reply.error, 'TIMEOUT', 'no answer came, and the connection stays open');
	});


	pinDefect('admin-log-refused-name-crashes', 'refuse a log file name it does not take, and stay up', async () => {
		const mark = pool.mark();
		const reply = await apiGet(world.apiPort, '/admin_log?file=../config-1.json');
		assert.equal(reply.body, 'wrong log file');
		assert.ok(await survives(pool, world.apiPort, mark), 'the API worker died after refusing the name');
	});


	pinDefect('admin-log-missing-file-crashes', 'answer a request for a log file that does not exist, and stay up', async () => {
		await waitFor(async () => (await apiGet(world.apiPort, '/stats')).status === 200, { what: 'the API back up' });
		const mark = pool.mark();
		await apiGet(world.apiPort, '/admin_log?file=nothing.log');
		assert.ok(await survives(pool, world.apiPort, mark), 'the API worker died on the missing file');
	});
});







// -----------------------------------------------------------
// A one-day blocks chart
// -----------------------------------------------------------
//
// charts.blocks.days set to 1, which buckets the chart by the
// hour.
// -----------------------------------------------------------

describe('the blocks chart over one day', () => {

	let world;

	before(async () => {
		world = await World.create('api-defects-chart');
		await seedMatured(world, { height: 353100, finder: addresses.address('chart-day'), time: Math.floor(Date.now() / 1000) - 2 * 3600 });
		await world.startPool({ api: { updateInterval: 1 }, charts: { blocks: { days: 1 } } }, { module: 'api' });
	});

	after(() => world.close());


	pinDefect('blocks-chart-one-day-keys', 'count a block in the hour it was found when the chart covers one day', async () => {
		const dateFormat = require('dateformat');
		const { json } = await waitFor(async () => {
			const reply = await apiGet(world.apiPort, '/stats');
			return reply.json && reply.json.charts && reply.json.charts.blocks && reply;
		}, { what: 'the blocks chart' });
		const hour = dateFormat(new Date((Math.floor(Date.now() / 1000) - 2 * 3600) * 1000), 'yyyy-mm-dd HH:00');
		const extra = Object.keys(json.charts.blocks).filter((key) => !key.endsWith(':00'));
		assert.equal(json.charts.blocks[hour], 1, 'the block went to a day key the hourly chart does not have: ' + extra.join(', '));
	});
});
