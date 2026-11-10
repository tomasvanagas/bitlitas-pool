// -----------------------------------------------------------
//  [*] Tests — the website's calls into the API
//
//  website_example/ is the static site the pool ships for its
//  miners; this suite does not run its pages. What it holds
//  them to is the contract between the pages and the API:
//  every endpoint a page or script of the site calls must
//  exist and answer the call the way the site makes it. The
//  endpoints are read out of the site's own files, so a page
//  that starts calling a new one fails here until the API has
//  it and the table below says how the site calls it.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { World } = require('../support/world.js');
const { POOL_ROOT } = require('../support/pool-process.js');
const addresses = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// The miner the calls ask about
const MINER = addresses.address('website-miner');

// How the site calls each endpoint: the query it sends
const CALLS = {
	stats: '',
	live_stats: '?address=' + MINER,
	stats_address: '?address=' + MINER,
	get_payments: '?time=' + 4102444800,
	get_blocks: '?height=' + 999999999,
	get_market: '?tickers[]=LTL-USD&tickers[]=LTL-BTC',
	get_top10miners: '',
	get_miner_payout_level: '?address=' + MINER,
	set_miner_payout_level: '?address=' + MINER + '&ip=127.0.0.1&level=2',
	get_email_notifications: '?address=' + MINER,
	set_email_notifications: '?address=' + MINER + '&ip=127.0.0.1&action=disable',
	block_explorers: '',
	get_apis: '',
	admin_stats: '',
	admin_users: '',
	admin_ports: '',
	admin_monitoring: '',
	admin_log: '?file=api_info.log',
	test_email_notification: '?email=miner@example.lt',
	test_telegram_notification: ''
};

// What an API endpoint looks like in the site's code
const ENDPOINT = /['"`][^'"`\n]{0,60}?\/(stats|live_stats|stats_address|get_\w+|set_\w+|admin_\w+|miners_hashrate|workers_hashrate|block_explorers|test_\w+_notification)\b/g;

// The world and its API
let world;

before(async () => {
	world = await World.create('website');
	await world.redis.call('hset', 'bitlitas:workers:' + MINER, 'hashes', 10, 'balance', 0);
	await world.redis.call('sadd', 'bitlitas:workers_ip:' + MINER, '::ffff:127.0.0.1');
	await world.startPool({ api: { updateInterval: 1 }, logging: { files: { flushInterval: 1 } } }, { module: 'api' });
	await waitFor(() => fs.existsSync(path.join(world.logs, 'api_info.log')), { what: 'the API log file' });
});

after(() => world.close());







// -----------------------------------------------------------
// siteEndpoints
// -----------------------------------------------------------
//
// Every API endpoint named anywhere in the site's scripts and
// pages.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function siteEndpoints () {

	const found = new Set();
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (/\.(js|html)$/.test(entry.name)) {
				for (const match of fs.readFileSync(file, 'utf8').matchAll(ENDPOINT)) found.add(match[1]);
			}
		}
	};
	walk(path.join(POOL_ROOT, 'website_example'));
	return [...found].sort();
}







// -----------------------------------------------------------
// The contract
// -----------------------------------------------------------
//
// The endpoints the site calls, each called the way the
// site calls it.
// -----------------------------------------------------------

describe('the website', () => {

	it('calls only endpoints this suite knows how the site calls', () => {
		const unknown = siteEndpoints().filter((endpoint) => !(endpoint in CALLS));
		assert.deepEqual(unknown, []);
		assert.ok(siteEndpoints().length >= 18);
	});


	for (const [endpoint, query] of Object.entries(CALLS)) {

		it('gets an answer from /' + endpoint, async () => {
			const reply = await apiGet(world.apiPort, '/' + endpoint + query);
			assert.equal(reply.error, null, reply.error);
			assert.equal(reply.status, 200, reply.body.slice(0, 80));
			assert.notEqual(reply.body, 'Invalid API call');
			if (endpoint !== 'admin_log') assert.notEqual(reply.json, null, reply.body.slice(0, 80));
		});
	}


	it('leaves the API up after every call it makes', async () => {
		assert.equal(world.pools[0].count('API died'), 0);
		assert.equal((await apiGet(world.apiPort, '/stats')).status, 200);
	});
});
