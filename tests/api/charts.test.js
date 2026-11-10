// -----------------------------------------------------------
//  [*] Tests — the charts
//
//  lib/chartsDataCollector.js (with lib/charts.js) asks the
//  pool's own API for its figures on each chart's interval
//  and keeps one series per chart in Redis: sets of a time,
//  the averaged (or, for workers, the highest) value and the
//  number of updates folded in, a new set every stepInterval,
//  sets older than maximumPeriod dropped. The pool charts are
//  hashrate, miners, workers and the network difficulty, each
//  with a solo twin; every miner and every worker gets a
//  hashrate chart of its own. The price and profit charts are
//  off in the shipped file. The API hands the series out in
//  /stats and on a miner's page.
//
//  Here the API and the collector run as their own modules,
//  both updating every second instead of every minute or
//  three; the steps stay as shipped.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// The miner whose shares the charts show
const ALICE = addresses.address('chart-alice');

// Every chart updating each second
const FAST_CHARTS = {
	api: { updateInterval: 1 },
	charts: {
		pool: { hashrate: { updateInterval: 1 }, miners: { updateInterval: 1 }, workers: { updateInterval: 1 }, difficulty: { updateInterval: 1 } },
		user: { hashrate: { updateInterval: 1 }, worker_hashrate: { updateInterval: 1 } }
	}
};

// The world
let world;

before(async () => {
	world = await World.create('charts');
	const now = Math.floor(Date.now() / 1000);
	await world.redis.multi([
		['zadd', 'bitlitas:hashrate', now, '6000:' + ALICE + ':' + Date.now() + ':prop'],
		['zadd', 'bitlitas:hashrate', now, '6000:' + ALICE + '~rig1:' + Date.now() + ':prop'],
		['hset', 'bitlitas:workers:' + ALICE, 'hashes', 6000],
		// A set older than the miners chart's day, and a worker
		// count higher than the one the collector will see
		['set', 'bitlitas:charts:minersSolo', JSON.stringify([[now - 200000, 9, 1]])],
		['set', 'bitlitas:charts:workersSolo', JSON.stringify([[now - 10, 7, 1]])]
	]);
	await world.startPool(FAST_CHARTS, { module: 'api' });
	await world.startPool(FAST_CHARTS, { module: 'chartsDataCollector' });
});

after(() => world.close());







// -----------------------------------------------------------
// series
// -----------------------------------------------------------
//
// A chart's series once its last set is the collector's own
// — begun within the last minute — and holds at least the
// given number of updates.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function series (name, updates = 1) {

	return waitFor(async () => {
		const text = await world.redis.call('get', 'bitlitas:charts:' + name);
		const sets = text && JSON.parse(text);
		const last = sets && sets[sets.length - 1];
		return last && Date.now() / 1000 - last[0] < 60 && last[2] >= updates && sets;
	}, { what: 'the ' + name + ' chart', timeout: 20000 });
}







// -----------------------------------------------------------
// Pool charts
// -----------------------------------------------------------
//
// The series of the pool as a whole, and how /stats hands
// them out.
// -----------------------------------------------------------

describe('the pool charts', () => {

	it('record the hashrate of the last ten minutes, kept for 15 days', async () => {
		const sets = await series('hashrate');
		assert.equal(sets[0][1], Math.round(6000 / 600));
		assert.ok(Math.abs(sets[0][0] - Date.now() / 1000) < 60);
		const ttl = await world.redis.call('ttl', 'bitlitas:charts:hashrate');
		assert.ok(ttl > 15 * 86400 - 60, String(ttl));
	});


	it('fold the updates within one step into one set, counting them', async () => {
		const sets = await series('hashrate', 3);
		assert.equal(sets.length, 1);
		assert.equal(sets[0][1], 10);
	});


	it('record miners, workers and the network difficulty, each with its solo twin', async () => {
		assert.equal((await series('miners'))[0][1], 1);
		assert.equal((await series('workers'))[0][1], 1);
		assert.equal((await series('difficulty'))[0][1], world.daemon.chain.difficulty);
		assert.equal((await series('minersSolo'))[0][1], 0);
		assert.equal((await series('hashrateSolo'))[0][1], 0);
	});


	it('drop the sets older than a chart\'s period once a new set begins', async () => {
		const sets = await series('minersSolo');
		assert.equal(sets.length, 1);
		assert.equal(sets[0][1], 0);
	});


	it('keep the highest worker count of a step, not the average', async () => {
		const sets = await series('workersSolo', 2);
		assert.equal(sets[0][1], 7);
	});


	it('keep no price and no profit chart', async () => {
		await series('hashrate', 2);
		assert.equal(await world.redis.call('exists', 'bitlitas:charts:price'), 0);
		assert.equal(await world.redis.call('exists', 'bitlitas:charts:profit'), 0);
	});


	it('reach the website through /stats', async () => {
		await series('hashrate');
		const { json } = await waitFor(async () => {
			const reply = await apiGet(world.apiPort, '/stats');
			return reply.json && reply.json.charts && reply.json.charts.hashrate && reply;
		}, { what: 'the charts in /stats' });
		assert.equal(json.charts.hashrate[0][1], 10);
		assert.ok(json.charts.difficulty);
	});
});







// -----------------------------------------------------------
// Miner charts
// -----------------------------------------------------------
//
// The series of one miner and of one worker, and the
// miner's page that shows them.
// -----------------------------------------------------------

describe('the miner charts', () => {

	it('record each miner\'s hashrate and each worker\'s', async () => {
		assert.equal((await series('hashrate:' + ALICE))[0][1], 10);
		assert.equal((await series('worker_hashrate:' + ALICE + '~rig1'))[0][1], 10);
	});


	it('reach the miner\'s page', async () => {
		await series('hashrate:' + ALICE);
		const { json } = await apiGet(world.apiPort, '/stats_address?address=' + ALICE);
		assert.equal(json.charts.hashrate[0][1], 10);
		assert.equal(json.stats.hashrate_1h, 10);
	});
});







// -----------------------------------------------------------
// The API away
// -----------------------------------------------------------
//
// The collector carries on when the API it reads is gone.
// -----------------------------------------------------------

describe('the charts collector without its API', () => {

	it('logs that it cannot read the API, and keeps running', async () => {
		const [api, collector] = world.pools;
		await api.kill();
		const mark = collector.mark();
		await collector.waitForOutput('Unable to get API data for stats', { from: mark });
		assert.equal(collector.running, true);
	});
});
