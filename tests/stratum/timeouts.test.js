// -----------------------------------------------------------
//  [*] Tests — idle miners and old bans
//
//  Every 30 seconds each pool worker sweeps its miners and
//  bans. A miner whose last request (a login, a job, a share
//  or a keepalive) is older than minerTimeout is dropped:
//  counted off its connections and its port, its id answered
//  "Unauthenticated" from then on — the connection itself
//  stays open. A ban older than banning.time is lifted, with
//  the IP's share counts. The sweep's 30 seconds are fixed in
//  lib/pool.js; minerTimeout (15 minutes as shipped) and the
//  ban time (10 minutes) are two seconds and one here, so one
//  sweep shows both.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { waitFor } = require('../support/wait.js');


// The miner left idle
const IDLE = addresses.address('timeout-idle');

// The miner kept alive
const KEEPER = addresses.address('timeout-keeper');

// The miner whose IP is banned before the sweep
const BANNED = addresses.address('timeout-banned');

// Where the banned miner connects from
const BANNED_IP = '127.0.0.11';







// -----------------------------------------------------------
// The sweep
// -----------------------------------------------------------
//
// One pool, three miners, one sweep: the tests after the
// first read what that sweep left.
// -----------------------------------------------------------

describe('the 30-second sweep', () => {

	let world;
	let pool;
	let idle;
	let keeper;
	let usersBefore;
	let keepAlive;

	before(async () => {
		world = await World.create('timeouts');
		pool = await world.startPool({ poolServer: { minerTimeout: 2, banning: { time: 1 } } });
		idle = await world.stratum(3333);
		await idle.login(IDLE, 'idle-rig');
		keeper = await world.stratum(3333);
		await keeper.login(KEEPER, 'keeper-rig');
		keepAlive = setInterval(() => keeper.keepalived({ timeout: 2000 }), 500);
		const banned = await world.stratum(3333, { localAddress: BANNED_IP });
		await banned.login(BANNED);
		await banned.submit({ job_id: banned.job.job_id, nonce: 'bad', result: 'ab'.repeat(32) });
		await pool.waitForOutput('Banned ' + BANNED + '@::ffff:' + BANNED_IP);
		usersBefore = Number(await world.redis.call('hget', 'bitlitas:ports:' + world.port(3333), 'users'));
	});

	after(() => {
		clearInterval(keepAlive);
		return world.close();
	});


	it('drops a miner whose last request is older than minerTimeout', async () => {
		await pool.waitForOutput('Miner timed out and disconnected ' + IDLE + '@::ffff:127.0.0.1', { timeout: 40000 });
		assert.equal((await idle.getjob()).error.message, 'Unauthenticated');
	});


	it('counts the dropped worker off its connections and its port', async () => {
		await waitFor(async () => await world.redis.call('hget', 'bitlitas:active_connections', IDLE + '~idle-rig') === '0', { what: 'the connection count to drop' });
		assert.equal(Number(await world.redis.call('hget', 'bitlitas:ports:' + world.port(3333), 'users')), usersBefore - 1);
	});


	it('leaves the dropped miner\'s connection open, its requests answered', async () => {
		const reply = await idle.keepalived();
		assert.equal(reply.error.message, 'Unauthenticated');
		assert.equal((await idle.login(IDLE, 'idle-rig')).result.status, 'OK');
	});


	it('keeps a miner that kept its connection alive', async () => {
		assert.equal(pool.count('Miner timed out and disconnected ' + KEEPER), 0);
		assert.deepEqual((await keeper.keepalived()).result, { status: 'KEEPALIVED' });
	});


	it('lifts a ban older than the ban time', async () => {
		await pool.waitForOutput('Ban dropped for ::ffff:' + BANNED_IP);
		const back = await world.stratum(3333, { localAddress: BANNED_IP });
		assert.equal((await back.login(BANNED)).result.status, 'OK');
	});
});
