// -----------------------------------------------------------
//  [*] Tests — the public API
//
//  lib/api.js, run on its own (-module=api), collecting its
//  statistics every second instead of the shipped five. What
//  the website reads: /stats (the pool as configured, the
//  network, the last block, miners and hashrate over the last
//  ten minutes, blocks and payments, the charts), a miner's
//  own page (/stats_address), the payment and block lists,
//  the top miners, the explorer links and the market. The
//  long-polling endpoints answer at the next collection.
//  Every JSON reply allows any origin.
//
//  The data is written into Redis in the shapes the pool,
//  the unlocker and the payment run write it.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { seedCandidate, seedMatured } = require('../support/rounds.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// The miners this file's records belong to
const [ALICE, BOB] = [addresses.address('api-alice'), addresses.address('api-bob')];

// The world, its API, and the time the records were made
let world;
let pool;
let now;

before(async () => {
	world = await World.create('api-public');
	await seedRecords();
	pool = await world.startPool({ api: { updateInterval: 1 } }, { module: 'api' });
});

after(() => world.close());







// -----------------------------------------------------------
// short
// -----------------------------------------------------------
//
// An address the way the API shortens a block finder's: the
// first and last seven characters around three dots.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function short (address) {

	return address.substring(0, 7) + '...' + address.substring(address.length - 7);
}







// -----------------------------------------------------------
// stats
// -----------------------------------------------------------
//
// /stats, once the API's collection has put something in it.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function stats (query = '') {

	return waitFor(async () => {
		const reply = await apiGet(world.apiPort, '/stats' + query);
		return reply.json && reply.json.pool && reply;
	}, { what: '/stats to fill', explain: () => pool.tail() });
}







// -----------------------------------------------------------
// seedRecords
// -----------------------------------------------------------
//
// The records of a pool that has been mining a while: shares
// of two miners in the hashrate window and one share too old
// for it, a current round, a block candidate and two matured
// blocks, and two payments.
//
// Used by:
//   - before (below)
// -----------------------------------------------------------

async function seedRecords () {

	now = Math.floor(Date.now() / 1000);
	const ms = Date.now();
	await world.redis.multi([
		['zadd', 'bitlitas:hashrate', now - 10, '6000:' + ALICE + ':' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 10, '6000:' + ALICE + '~rig1:' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '6000:' + ALICE + ':' + (ms + 1) + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '6000:' + ALICE + '~rig1:' + (ms + 1) + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '3000:' + BOB + ':' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '3000:' + BOB + '~rigB:' + ms + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 900, '99000:' + BOB + '~rigB:' + (ms - 900000) + ':prop'],
		['hset', 'bitlitas:scores:prop:roundCurrent', ALICE, 12000, BOB, 3000],
		['hset', 'bitlitas:shares_actual:prop:roundCurrent', ALICE, 12000, BOB, 3000],
		['hset', 'bitlitas:workers:' + ALICE, 'hashes', 12000, 'lastShare', now - 5, 'balance', 250000000000, 'paid', 1186000000000],
		['hset', 'bitlitas:unique_workers:' + ALICE + '~rig1', 'hashes', 12000, 'lastShare', now - 5],
		['hset', 'bitlitas:stats', 'lastBlockFoundprop', ms - 60000],
		['zadd', 'bitlitas:payments:all', now - 300, 'aa'.repeat(32) + ':1186000000000:14000000000:7:1'],
		['zadd', 'bitlitas:payments:all', now - 200, 'bb'.repeat(32) + ':2972000000000:28000000000:7:2'],
		['zadd', 'bitlitas:payments:' + ALICE, now - 300, 'aa'.repeat(32) + ':1186000000000:14000000000:7'],
		['zadd', 'bitlitas:payments:' + BOB, now - 200, 'bb'.repeat(32) + ':1986000000000:28000000000:7']
	]);
	const tip = world.daemon.chain.tipHeight;
	await seedCandidate(world, { height: tip - 3, finder: ALICE, scores: {} });
	await seedMatured(world, { height: tip - 100, finder: BOB, time: now - 86400 });
	await seedMatured(world, { height: tip - 200, finder: ALICE, orphan: true, time: now - 2 * 86400 });
}







// -----------------------------------------------------------
// Pool statistics
// -----------------------------------------------------------
//
// /stats, the call every page of the website starts with.
// -----------------------------------------------------------

describe('/stats', () => {

	it('describes the pool as configured, its hidden port left out', async () => {
		const { json } = await stats();
		const shipped = world.shipped;
		assert.deepEqual(json.config.ports, shipped.poolServer.ports.filter((port) => !port.hidden).map((port) => ({ ...port, port: world.port(port.port) })));
		assert.deepEqual({
			poolHost: json.config.poolHost, coin: json.config.coin, symbol: json.config.symbol, coinUnits: json.config.coinUnits,
			coinDecimalPlaces: json.config.coinDecimalPlaces, coinDifficultyTarget: json.config.coinDifficultyTarget,
			cnAlgorithm: json.config.cnAlgorithm, cnVariant: json.config.cnVariant, hashrateWindow: json.config.hashrateWindow,
			fee: json.config.fee, soloFee: json.config.soloFee, networkFee: json.config.networkFee, finderReward: json.config.finderReward,
			donation: json.config.donation, depth: json.config.depth, version: json.config.version
		}, {
			poolHost: 'pool.bitlitas.lt', coin: 'bitlitas', symbol: 'LTL', coinUnits: 1e12,
			coinDecimalPlaces: 4, coinDifficultyTarget: 120,
			cnAlgorithm: 'randomx', cnVariant: 0, hashrateWindow: 600,
			fee: 1, soloFee: 1, networkFee: 0, finderReward: 0,
			donation: {}, depth: 60, version: 'v2.0.0'
		});
	});


	it('tells how payments work and where prices would come from', async () => {
		const { json } = await stats();
		assert.deepEqual({
			paymentsInterval: json.config.paymentsInterval, minPaymentThreshold: json.config.minPaymentThreshold,
			maxPaymentThreshold: json.config.maxPaymentThreshold, transferFee: json.config.transferFee,
			denominationUnit: json.config.denominationUnit, paymentIdSeparator: json.config.paymentIdSeparator,
			fixedDiffEnabled: json.config.fixedDiffEnabled, fixedDiffSeparator: json.config.fixedDiffSeparator,
			priceSource: json.config.priceSource, priceCurrency: json.config.priceCurrency,
			sendEmails: json.config.sendEmails, slushMiningEnabled: json.config.slushMiningEnabled,
			blocksChartEnabled: json.config.blocksChartEnabled, blocksChartDays: json.config.blocksChartDays
		}, {
			paymentsInterval: 1800, minPaymentThreshold: 1e12,
			maxPaymentThreshold: null, transferFee: 14000000000,
			denominationUnit: 1e11, paymentIdSeparator: '.',
			fixedDiffEnabled: true, fixedDiffSeparator: '.',
			priceSource: 'cryptonator', priceCurrency: 'USD',
			sendEmails: false, slushMiningEnabled: false,
			blocksChartEnabled: true, blocksChartDays: 30
		});
	});


	it('gives the network\'s difficulty and next height, and the last block\'s header', async () => {
		const { json } = await stats();
		const chain = world.daemon.chain;
		const tip = chain.header(chain.tipHeight);
		assert.deepEqual(json.network, { difficulty: chain.difficulty, height: chain.tipHeight + 1 });
		assert.deepEqual(json.lastblock, { difficulty: tip.difficulty, height: tip.height, timestamp: tip.timestamp, reward: tip.reward, hash: tip.hash });
	});


	it('counts miners, workers and the hashrate of the last ten minutes, older shares dropped', async () => {
		const { json } = await stats();
		assert.equal(json.pool.miners, 2);
		assert.equal(json.pool.workers, 2);
		assert.equal(json.pool.hashrate, Math.round((6000 + 6000 + 3000) / 600));
		const kept = await world.redis.call('zrange', 'bitlitas:hashrate', 0, -1);
		assert.equal(kept.some((entry) => entry.startsWith('99000:')), false);
	});


	it('adds up the current round', async () => {
		const { json } = await stats();
		assert.equal(json.pool.roundScore, 15000);
		assert.equal(json.pool.roundHashes, 15000);
		assert.equal(Number(json.pool.lastBlockFound) > 0, true);
	});


	it('gives one miner\'s hashrate and round when asked for an address', async () => {
		const { json } = await stats('?address=' + ALICE);
		assert.deepEqual(json.miner, { hashrate: Math.round(12000 / 600), roundScore: 12000, roundHashes: 12000 });
	});


	it('lists the candidate and the matured blocks, their finders shortened', async () => {
		const { json } = await stats();
		const members = json.pool.blocks.filter((entry, i) => i % 2 === 0);
		assert.equal(members.length, 3);
		for (const member of members) assert.match(member.split(':')[1], /^\w{7}\.\.\.\w{7}$/);
		assert.ok(members.some((member) => member.split(':')[1] === short(ALICE) && member.split(':').length === 7));
		assert.equal(json.pool.totalBlocks, 3);
	});


	it('lists the latest payments, counting the payments and the miners paid', async () => {
		const { json } = await stats();
		assert.equal(json.pool.payments[0], 'bb'.repeat(32) + ':2972000000000:28000000000:7:2');
		assert.equal(json.pool.totalPayments, 2);
		assert.equal(json.pool.totalMinersPaid, 2);
	});


	it('counts the matured blocks of the last thirty days by day', async () => {
		const { json } = await stats();
		const days = Object.keys(json.charts.blocks);
		assert.ok(days.length === 31 || days.length === 32, String(days.length));
		const counted = Object.values(json.charts.blocks).reduce((sum, count) => sum + count, 0);
		assert.equal(counted, 2);
		assert.ok(json.charts.blocksSolo);
	});
});







// -----------------------------------------------------------
// A miner's page
// -----------------------------------------------------------
//
// /stats_address, what a miner sees after typing their
// address on the website, plain and as a long poll.
// -----------------------------------------------------------

describe('/stats_address', () => {

	it('gives a miner\'s record, payments, charts and workers', async () => {
		const { json } = await apiGet(world.apiPort, '/stats_address?address=' + ALICE);
		assert.equal(json.stats.hashes, '12000');
		assert.equal(json.stats.balance, '250000000000');
		assert.equal(json.stats.paid, '1186000000000');
		assert.equal(json.stats.roundScore, 12000);
		assert.deepEqual(json.payments, ['aa'.repeat(32) + ':1186000000000:14000000000:7', String(now - 300)]);
		assert.deepEqual(json.charts.hashrate, []);
		assert.deepEqual(json.charts.payments, [[now - 300, '1186000000000']]);
		assert.equal(json.workers.length, 1);
		assert.equal(json.workers[0].name, 'rig1');
		assert.equal(json.workers[0].hashes, 12000);
		assert.equal(json.workers[0].lastShare, now - 5);
	});


	it('answers "Not found" for an address it has no record of', async () => {
		const { json } = await apiGet(world.apiPort, '/stats_address?address=' + addresses.address('stranger'));
		assert.deepEqual(json, { error: 'Not found' });
	});


	it('holds a long poll until the next collection, then answers with the miner\'s data', async () => {
		const started = Date.now();
		const reply = await apiGet(world.apiPort, '/stats_address?longpoll=true&address=' + ALICE);
		assert.ok(Date.now() - started < 3000);
		assert.equal(reply.json.stats.hashes, '12000');
	});


	it('answers a long poll for an unknown address at once with "Not found"', async () => {
		const reply = await apiGet(world.apiPort, '/stats_address?longpoll=true&address=' + addresses.address('stranger'));
		assert.deepEqual(reply.json, { error: 'Not found' });
	});
});







// -----------------------------------------------------------
// Lists
// -----------------------------------------------------------
//
// The paged lists of payments and blocks, and the top
// miners.
// -----------------------------------------------------------

describe('the lists', () => {

	it('of payments go back from a time, for the pool or for one miner', async () => {
		const all = await apiGet(world.apiPort, '/get_payments?time=' + (now + 60));
		assert.deepEqual(all.json, ['bb'.repeat(32) + ':2972000000000:28000000000:7:2', String(now - 200), 'aa'.repeat(32) + ':1186000000000:14000000000:7:1', String(now - 300)]);
		const before = await apiGet(world.apiPort, '/get_payments?time=' + (now - 250));
		assert.equal(before.json.length, 2);
		const own = await apiGet(world.apiPort, '/get_payments?address=' + BOB + '&time=' + (now + 60));
		assert.equal(own.json[0], 'bb'.repeat(32) + ':1986000000000:28000000000:7');
	});


	it('of payments fail without a time', async () => {
		const reply = await apiGet(world.apiPort, '/get_payments');
		assert.deepEqual(reply.json, { error: 'Query failed' });
	});


	it('of blocks go back from a height, finders shortened', async () => {
		const tip = world.daemon.chain.tipHeight;
		const reply = await apiGet(world.apiPort, '/get_blocks?height=' + (tip - 150));
		assert.equal(reply.json.length, 2);
		assert.equal(reply.json[0].split(':')[1], short(ALICE));
		assert.equal(reply.json[1], String(tip - 200));
	});


	it('of top miners order by hashrate, addresses shortened', async () => {
		const reply = await apiGet(world.apiPort, '/get_top10miners');
		assert.equal(reply.json[0].miner, short(ALICE));
		assert.equal(reply.json[0].hashrate, 20);
		assert.equal(reply.json[0].hashes, '12000');
		assert.ok(reply.json.length <= 10);
	});
});







// -----------------------------------------------------------
// The rest
// -----------------------------------------------------------
//
// Explorer links, child pools, the market, unknown paths,
// CORS and the live statistics.
// -----------------------------------------------------------

describe('the other endpoints', () => {

	it('give the Bitlitas explorer links', async () => {
		const reply = await apiGet(world.apiPort, '/block_explorers');
		assert.deepEqual(reply.json, { bitlitas: { blockchainExplorer: 'https://explorer.bitlitas.lt/block/{id}', transactionExplorer: 'https://explorer.bitlitas.lt/tx/{id}' } });
	});


	it('list no merged-mining child pools', async () => {
		assert.deepEqual((await apiGet(world.apiPort, '/get_apis')).json, {});
	});


	it('find no market price for LTL, without leaving the pool', async () => {
		const reply = await apiGet(world.apiPort, '/get_market?tickers[]=LTL-USD');
		assert.equal(reply.status, 200);
		assert.deepEqual(reply.json, {});
	});


	it('ask for tickers before looking up a market', async () => {
		assert.deepEqual((await apiGet(world.apiPort, '/get_market')).json, { error: 'No tickers specified.' });
	});


	it('answer an unknown path with a 404', async () => {
		const reply = await apiGet(world.apiPort, '/no_such_call');
		assert.equal(reply.status, 404);
		assert.equal(reply.body, 'Invalid API call');
	});


	it('answer a CORS preflight with 204 and the allowed methods', async () => {
		const reply = await apiGet(world.apiPort, '/stats', { method: 'OPTIONS' });
		assert.equal(reply.status, 204);
		assert.equal(reply.headers['access-control-allow-origin'], '*');
		assert.equal(reply.headers['access-control-allow-methods'], 'GET, POST, PUT, DELETE, OPTIONS');
	});


	it('let any origin read their JSON', async () => {
		for (const path of ['/stats', '/get_payments?time=1', '/get_blocks?height=1', '/block_explorers', '/get_top10miners']) {
			assert.equal((await apiGet(world.apiPort, path)).headers['access-control-allow-origin'], '*', path);
		}
	});


	it('hold /live_stats until the next collection, then send the stats', async () => {
		const started = Date.now();
		const reply = await apiGet(world.apiPort, '/live_stats?address=' + ALICE);
		assert.ok(Date.now() - started < 3000);
		assert.equal(reply.json.miner.hashrate, 20);
		assert.equal(reply.json.pool.miners, 2);
	});
});







// -----------------------------------------------------------
// The daemon
// -----------------------------------------------------------
//
// Where /stats gets the network's figures, and what it
// shows while it cannot get them.
// -----------------------------------------------------------

describe('the network figures', () => {

	it('come from the last block header when get_info fails, the height one past the tip', async () => {
		world.daemon.override('get_info', { error: { code: -32601, message: 'Method not found' } });
		try {
			const height = world.daemon.chain.tipHeight + 1;
			world.daemon.chain.mineElsewhere();
			const reply = await waitFor(async () => {
				const answer = await stats();
				return answer.json.network.height === height + 1 && answer;
			}, { what: 'the network height to move' });
			assert.equal(reply.json.network.difficulty, world.daemon.chain.difficulty);
		} finally {
			delete world.daemon.overrides.get_info;
		}
	});


	it('are missing, with the rest of /stats, while the daemon has been away from the start', async () => {
		const away = await World.create('api-no-daemon');
		try {
			await away.daemon.stop();
			await away.startPool({ api: { updateInterval: 1 } }, { module: 'api' });
			await waitFor(() => away.pools[0].count('Error collecting all stats') >= 1, { what: 'a failed collection' });
			const reply = await apiGet(away.apiPort, '/stats');
			assert.deepEqual(reply.json, { miner: {} });
		} finally {
			await away.close();
		}
	});
});
