// -----------------------------------------------------------
//  [*] Tests — the administration API
//
//  The calls behind the website's admin pages and the charts
//  collector: pool totals, the miners, the ports, the
//  monitoring of daemon and wallet, the log files, the
//  hashrates per miner and per worker, the test
//  notifications. Each asks authorize() first. A request from
//  the machine itself passes without a password; any other
//  needs the API password, and gets a session cookie for a
//  day with it. A request from 127.0.0.2 is "another machine"
//  here, since the API counts only 127.0.0.1 and ::1 as
//  local. Monitoring polls the daemon (getblockcount) and the
//  wallet (getbalance) every second instead of the shipped
//  minute.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { seedMatured } = require('../support/rounds.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// The miners of this file's records
const [ALICE, BOB] = [addresses.address('admin-alice'), addresses.address('admin-bob')];

// The shipped API password
const PASSWORD = 'your_password';

// Where a request from another machine comes from
const ELSEWHERE = '127.0.0.2';

// The world, its API, and when the records were written
let world;
let pool;
let now;

before(async () => {
	world = await World.create('api-admin');
	now = Math.floor(Date.now() / 1000);
	await world.redis.multi([
		['hset', 'bitlitas:workers:' + ALICE, 'balance', 300000000000, 'paid', 5000000000000, 'hashes', 9000, 'lastShare', now - 30],
		['hset', 'bitlitas:workers:' + BOB, 'balance', 100000000000, 'paid', 0, 'hashes', 3000, 'lastShare', now - 60],
		['zadd', 'bitlitas:hashrate', now - 5, '6000:' + ALICE + ':' + Date.now() + ':prop'],
		['zadd', 'bitlitas:hashrate', now - 5, '6000:' + ALICE + '~rig1:' + Date.now() + ':prop'],
		['hset', 'bitlitas:ports:' + world.port(3333), 'port', world.port(3333), 'users', 4]
	]);
	await seedMatured(world, { height: 353000, finder: ALICE, reward: 35000000000000, difficulty: 2000000, shares: 1800000 });
	await seedMatured(world, { height: 353010, finder: BOB, rewardType: 'solo', reward: 34000000000000, difficulty: 2100000, shares: 900000 });
	await seedMatured(world, { height: 353020, finder: BOB, orphan: true });
	pool = await world.startPool({
		api: { updateInterval: 1 },
		monitoring: { daemon: { checkInterval: 1 }, wallet: { checkInterval: 1 } },
		logging: { files: { flushInterval: 1 } }
	}, { module: 'api' });
});

after(() => world.close());







// -----------------------------------------------------------
// Who may ask
// -----------------------------------------------------------
//
// Which requests authorize() lets through: local ones, ones
// with the password, and ones with the session cookie.
// -----------------------------------------------------------

describe('an administration call', () => {

	it('from the machine itself passes without a password', async () => {
		const reply = await apiGet(world.apiPort, '/admin_stats');
		assert.equal(reply.status, 200);
		assert.ok(reply.json);
	});


	it('from another machine without the password is refused', async () => {
		const reply = await apiGet(world.apiPort, '/admin_stats', { localAddress: ELSEWHERE });
		assert.equal(reply.status, 401);
		assert.equal(reply.body, 'Invalid password');
	});


	it('with a wrong password is refused, even from the machine itself', async () => {
		const reply = await apiGet(world.apiPort, '/admin_stats?password=guess');
		assert.equal(reply.status, 401);
	});


	it('with the password passes, and sets a session cookie for a day', async () => {
		const reply = await apiGet(world.apiPort, '/admin_stats?password=' + PASSWORD, { localAddress: ELSEWHERE });
		assert.equal(reply.status, 200);
		const [cookie] = reply.headers['set-cookie'];
		assert.match(cookie, /^sid=\d+; path=\/; expires=/);
		const expires = Date.parse(cookie.split('expires=')[1]);
		assert.ok(Math.abs(expires - Date.now() - 86400000) < 60000);
	});


	it('with the session cookie passes without the password', async () => {
		const login = await apiGet(world.apiPort, '/admin_stats?password=' + PASSWORD, { localAddress: ELSEWHERE });
		const sid = login.headers['set-cookie'][0].split(';')[0];
		const reply = await apiGet(world.apiPort, '/admin_users', { localAddress: ELSEWHERE, headers: { Cookie: sid } });
		assert.equal(reply.status, 200);
		const forged = await apiGet(world.apiPort, '/admin_users', { localAddress: ELSEWHERE, headers: { Cookie: 'sid=123' } });
		assert.equal(forged.status, 401);
	});


	it('covers the hashrate lists and the test notifications too', async () => {
		for (const path of ['/miners_hashrate', '/workers_hashrate', '/admin_monitoring', '/admin_ports', '/admin_log?file=api_info.log', '/test_email_notification', '/test_telegram_notification']) {
			assert.equal((await apiGet(world.apiPort, path, { localAddress: ELSEWHERE })).status, 401, path);
		}
	});
});







// -----------------------------------------------------------
// What it gives
// -----------------------------------------------------------
//
// The figures each administration call hands the admin
// pages, from the records seeded above.
// -----------------------------------------------------------

describe('the administration data', () => {

	it('adds up what is owed and paid, and the blocks, revenue, difficulty and shares by kind', async () => {
		const { json } = await apiGet(world.apiPort, '/admin_stats');
		assert.deepEqual(json, {
			totalOwed: 400000000000,
			totalPaid: 5000000000000,
			totalRevenue: 35000000000000,
			totalRevenueSolo: 34000000000000,
			totalDiff: 2000000,
			totalDiffSolo: 2100000,
			totalShares: 1800000,
			totalSharesSolo: 900000,
			blocksOrphaned: 1,
			blocksUnlocked: 1,
			blocksUnlockedSolo: 1,
			totalWorkers: 2
		});
	});


	it('lists every miner with their balance, payments, last share, hashes and hashrate', async () => {
		const { json } = await waitFor(async () => {
			const reply = await apiGet(world.apiPort, '/admin_users');
			return reply.json && reply.json[ALICE] && reply.json[ALICE].hashrate && reply;
		}, { what: 'the users with their hashrate' });
		assert.deepEqual(json[ALICE], { pending: '300000000000', paid: '5000000000000', lastShare: String(now - 30), hashes: '9000', childWallet: null, hashrate: 10, roundScore: 0, roundHashes: 0 });
		assert.equal(json[BOB].pending, '100000000000');
	});


	it('counts the users on each port', async () => {
		const { json } = await apiGet(world.apiPort, '/admin_ports');
		assert.deepEqual(json['bitlitas:ports:' + world.port(3333)], { port: String(world.port(3333)), users: '4' });
	});


	it('shows the daemon and the wallet answering their monitoring calls', async () => {
		const { json } = await waitFor(async () => {
			const reply = await apiGet(world.apiPort, '/admin_monitoring');
			return reply.json && reply.json.monitoring.daemon && reply.json.monitoring.wallet && reply;
		}, { what: 'monitoring data' });
		assert.equal(json.monitoring.daemon.lastStatus, 'ok');
		assert.equal(json.monitoring.wallet.lastStatus, 'ok');
		assert.equal(JSON.parse(json.monitoring.daemon.lastResponse).count, world.daemon.chain.tipHeight + 1);
		assert.ok(world.daemon.callsOf('getblockcount').length >= 1);
		assert.ok(world.wallet.callsOf('getbalance').length >= 1);
	});


	it('marks the daemon failed while it is away', async () => {
		await world.daemon.stop();
		try {
			const { json } = await waitFor(async () => {
				const reply = await apiGet(world.apiPort, '/admin_monitoring');
				return reply.json && reply.json.monitoring.daemon.lastStatus === 'fail' && reply;
			}, { what: 'the daemon marked failed' });
			assert.match(json.monitoring.daemon.lastFail, /^\d{10}$/);
		} finally {
			await world.daemon.start();
		}
	});


	it('lists the log files and hands one out', async () => {
		await waitFor(async () => {
			const reply = await apiGet(world.apiPort, '/admin_monitoring');
			return reply.json && reply.json.logs['api_info.log'];
		}, { what: 'the API log file' });
		const reply = await apiGet(world.apiPort, '/admin_log?file=api_info.log');
		assert.equal(reply.headers['content-type'], 'text/plain');
		assert.match(reply.body, /API started & listening on 0\.0\.0\.0 port/);
	});


	it('gives the hashrate of every miner and of every worker for the charts', async () => {
		const miners = await apiGet(world.apiPort, '/miners_hashrate');
		const workers = await apiGet(world.apiPort, '/workers_hashrate');
		assert.deepEqual(miners.json, { minersHashrate: { [ALICE]: 10 } });
		assert.deepEqual(workers.json, { workersHashrate: { [ALICE + '~rig1']: 10 } });
	});


	it('says email and Telegram are off when asked for a test notification', async () => {
		assert.deepEqual((await apiGet(world.apiPort, '/test_email_notification?email=a@b.lt')).json, { status: 'Email system is not enabled' });
		assert.deepEqual((await apiGet(world.apiPort, '/test_telegram_notification')).json, { status: 'Telegram is not enabled' });
	});
});
