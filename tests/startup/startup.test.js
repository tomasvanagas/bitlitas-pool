// -----------------------------------------------------------
//  [*] Tests — starting the pool, and keeping it up
//
//  init.js as the image runs it. It reads the configuration
//  named by -config=, refuses the placeholder pool wallet,
//  waits for Redis to answer its version check, and forks a
//  worker per module: as many pool workers as clusterForks
//  says (one per CPU for "auto"), the template poller, the
//  unlocker, the payment run, the API and the charts — or,
//  with -module=, one of them alone. A worker that dies is
//  forked again. A stratum port opens unless its certificate
//  files are missing (an SSL port), which leaves the other
//  ports serving.
// -----------------------------------------------------------

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { World } = require('../support/world.js');
const { PoolProcess, POOL_ROOT } = require('../support/pool-process.js');
const { REAL } = require('../support/addresses.js');
const { targetHex } = require('../support/stratum.js');
const { waitFor, sleep } = require('../support/wait.js');


// The world every test here starts its pools in
let world;

before(async () => {
	world = await World.create('startup');
});

after(() => world.close());







// -----------------------------------------------------------
// start
// -----------------------------------------------------------
//
// A pool started from a configuration the test wrote itself
// (or a path that holds none), not waited for: the startup
// tests watch it start.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function start (configPath, options) {

	const pool = new PoolProcess(configPath, options);
	world.pools.push(pool);
	return pool;
}







// -----------------------------------------------------------
// refused
// -----------------------------------------------------------
//
// Whether nothing listens on a port: a connection attempt is
// refused.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function refused (port) {

	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolve(false);
		});
		socket.once('error', () => resolve(true));
	});
}







// -----------------------------------------------------------
// A bad configuration
// -----------------------------------------------------------
//
// Configurations init.js cannot run with, and how it stops
// on each.
// -----------------------------------------------------------

describe('a configuration the pool cannot run', () => {

	it('with the placeholder pool wallet is refused, the reason logged', async () => {
		const pool = start(world.writeConfig(world.config({ poolServer: { poolAddress: '** Your pool wallet address **' } })));
		await pool.exited;
		assert.match(pool.output, /\[master\] Invalid pool wallet address in configuration file \(poolServer\.poolAddress\)/);
		assert.doesNotMatch(pool.output, /Pool spawned/);
	});


	it('is read from config.json in the working directory when -config= is not given', async () => {
		const pool = start(null);
		await pool.exited;
		assert.match(pool.output, /Failed to read config file config\.json/);
	});


	it('that is missing stops the pool with the read error', async () => {
		const pool = start('/no/such/config.json');
		const { code } = await pool.exited;
		assert.match(pool.output, /Failed to read config file \/no\/such\/config\.json/);
		assert.notEqual(code, 0);
	});


	it('that is not JSON stops the pool with the parse error', async () => {
		const file = path.join(world.dir, 'broken.json');
		fs.writeFileSync(file, '{ "coin": "bitlitas", ');
		const pool = start(file);
		const { code } = await pool.exited;
		assert.match(pool.output, /Failed to read config file .*broken\.json\s+SyntaxError/);
		assert.notEqual(code, 0);
	});


	it('with the shipped log folder stops on a read-only image: it writes logs/ into the working directory', async () => {
		assert.throws(() => fs.accessSync(POOL_ROOT, fs.constants.W_OK), 'this suite runs with the image read-only (runTests.sh)');
		const pool = start(world.writeConfig(world.config({ logging: { files: { directory: 'logs' } } })));
		const { code } = await pool.exited;
		assert.notEqual(code, 0);
		assert.match(pool.output, /EROFS: read-only file system, mkdir 'logs'/);
	});
});







// -----------------------------------------------------------
// Modules and workers
// -----------------------------------------------------------
//
// Which workers the master forks for a whole pool and for
// one module, and how many pool workers.
// -----------------------------------------------------------

describe('the workers the pool starts', () => {

	// A test that fails leaves no pool behind for the next
	afterEach(() => world.stopPools());


	it('are one module alone with -module=, here the API, no stratum port open', async () => {
		const pool = await world.startPool({}, { module: 'api' });
		assert.match(pool.output, /Running in single module mode: api/);
		assert.equal(await refused(world.port(3333)), true);
		assert.equal(pool.workers().length, 1);
		await world.stopPools();
	});


	it('refuse a module the pool does not have, naming the ones it has', async () => {
		const pool = start(world.writeConfig(world.config()), { module: 'miner' });
		await pool.exited;
		assert.match(pool.output, /Invalid module "miner", valid modules: pool, api, unlocker, payments, chartsDataCollector, telegramBot/);
	});


	it('are every module, with the pool workers clusterForks asks for', async () => {
		const pool = await world.startPool({ poolServer: { clusterForks: 2 } });
		await pool.waitForOutput('Pool spawned on 2 thread(s)');
		await waitFor(() => pool.workers('pool').length === 2, { what: 'two pool workers' });
		for (const type of ['daemon', 'blockUnlocker', 'paymentProcessor', 'api', 'chartsDataCollector']) {
			assert.equal(pool.workers(type).length, 1, type);
		}
		assert.equal(pool.workers('telegramBot').length, 0);
		await world.stopPools();
	});


	it('are one pool worker per CPU the container sees for "auto", the shipped value', async () => {
		const pool = start(world.writeConfig(world.config({ poolServer: { clusterForks: 'auto' } })));
		await pool.waitForOutput('Pool spawned on ' + os.cpus().length + ' thread(s)');
		await pool.kill();
	});


	it('are one pool worker when clusterForks is no number, or none', async () => {
		for (const clusterForks of ['many', 0]) {
			const pool = start(world.writeConfig(world.config({ poolServer: { clusterForks } })));
			await pool.waitForOutput('Pool spawned on 1 thread(s)');
			await pool.kill();
		}
	});


	it('are no pool worker and no template poller with the pool server off, the other modules running', async () => {
		const pool = await world.startPool({ poolServer: { enabled: false } }, { ready: false });
		await pool.waitForOutput(/API started & listening/);
		await pool.waitForOutput('[payments] Started');
		assert.equal(pool.workers('pool').length, 0);
		assert.equal(pool.workers('daemon').length, 0);
		assert.equal(await refused(world.port(3333)), true);
		await world.stopPools();
	});
});







// -----------------------------------------------------------
// Ports
// -----------------------------------------------------------
//
// The stratum ports a pool opens, the SSL one with and
// without its certificate files.
// -----------------------------------------------------------

describe('the stratum ports', () => {

	// A test that fails leaves no pool behind for the next
	afterEach(() => world.stopPools());


	it('open without the SSL port when its certificate files are missing', async () => {
		const pool = await world.startPool();
		await pool.waitForOutput('Could not start server listening on port ' + world.port(9999) + ' (SSL): SSL certificate file not found (configuration error)');
		assert.equal(await refused(world.port(9999)), true);
		const miner = await world.stratum(3333);
		assert.equal((await miner.login(REAL.miner)).result.status, 'OK');
		await world.stopPools();
	});


	it('include the SSL port, over TLS, when the certificate files are there', async () => {
		const key = path.join(world.dir, 'privkey.pem');
		const cert = path.join(world.dir, 'cert.pem');
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=pool.bitlitas.lt'], { stdio: 'ignore' });
		const pool = await world.startPool({ poolServer: { sslCert: cert, sslKey: key, sslCA: cert } });
		await pool.waitForOutput('Started server listening on port ' + world.port(9999) + ' (SSL)');
		const miner = await world.stratum(9999, { useTls: true });
		const reply = await miner.login(REAL.miner);
		assert.equal(reply.result.status, 'OK');
		assert.equal(miner.job.target, targetHex(20000));
		await world.stopPools();
	});


	it('skip the SSL port when its key file is missing', async () => {
		const cert = path.join(world.dir, 'only-cert.pem');
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(world.dir, 'unused-key.pem'), '-out', cert, '-days', '2', '-subj', '/CN=pool.bitlitas.lt'], { stdio: 'ignore' });
		const pool = await world.startPool({ poolServer: { sslCert: cert, sslKey: path.join(world.dir, 'no-such-key.pem') } });
		await pool.waitForOutput('Could not start server listening on port ' + world.port(9999) + ' (SSL): SSL key file not found (configuration error)');
		assert.equal(await refused(world.port(9999)), true);
		await world.stopPools();
	});


	it('start without the connection counts a previous run left in Redis', async () => {
		await world.redis.call('hset', 'bitlitas:active_connections', 'stale~rig', 5);
		await world.startPool();
		await waitFor(async () => await world.redis.call('exists', 'bitlitas:active_connections') === 0, { what: 'the stale counts cleared' });
		await world.stopPools();
	});
});







// -----------------------------------------------------------
// Keeping up
// -----------------------------------------------------------
//
// Workers that die are forked again, and a pool started
// before Redis waits for it.
// -----------------------------------------------------------

describe('a pool whose parts fail', () => {

	// A test that fails leaves no pool behind for the next
	afterEach(() => world.stopPools());


	it('replaces a pool worker that died, its ports serving again', async () => {
		const pool = await world.startPool();
		const mark = pool.mark();
		process.kill(pool.workers('pool')[0], 'SIGKILL');
		await pool.waitForOutput('Pool fork 1 died, spawning replacement worker...', { from: mark });
		await pool.waitForOutput('Started server listening on port ' + world.port(3333) + '\n', { from: mark });
		const miner = await world.stratum(3333);
		assert.equal((await miner.request('getjob', { id: '1' })).error.message, 'Unauthenticated');
		await world.stopPools();
	});


	it('replaces a template poller that died, the new one reading the tip again', async () => {
		const pool = await world.startPool();
		const mark = pool.mark();
		process.kill(pool.workers('daemon')[0], 'SIGKILL');
		await pool.waitForOutput('Daemon died, spawning replacement...', { from: mark });
		await pool.waitForOutput('bitlitas found new hash ' + world.daemon.chain.tipHash, { from: mark });
		await world.stopPools();
	});


	it('waits for Redis before it starts any worker, and starts once Redis answers', async () => {
		await world.redis.stop();
		const pool = start(world.writeConfig(world.config()));
		await sleep(2000);
		assert.equal(pool.running, true);
		assert.doesNotMatch(pool.output, /Pool spawned/);
		await world.redis.start();
		await pool.waitForOutput('Pool spawned on 1 thread(s)', { timeout: 30000 });
		await pool.kill();
	});
});







// -----------------------------------------------------------
// Redis behind a password
// -----------------------------------------------------------
//
// A Redis that asks for a password, as redis.auth names one.
// -----------------------------------------------------------

describe('a Redis behind a password', () => {

	let locked;

	before(async () => {
		locked = await World.create('startup-redis-auth', { redisPassword: 'redis-secret-for-tests' });
	});

	after(() => locked.close());


	it('is used with the password the configuration names', async () => {
		const pool = await locked.startPool();
		assert.match(pool.output, /Pool spawned on 1 thread\(s\)/);
		const miner = await locked.stratum(3333);
		assert.equal((await miner.login(REAL.miner)).result.status, 'OK');
		await waitFor(() => locked.redis.call('exists', 'bitlitas:workers_ip:' + REAL.miner), { what: 'the login recorded' });
		await locked.stopPools();
	});


	it('without the password never gets past the client\'s ready check, and starts no worker', async () => {
		const pool = start(locked.writeConfig(locked.config({ redis: { auth: null } })));
		await pool.waitForOutput('Ready check failed: NOAUTH Authentication required.');
		await sleep(1500);
		assert.equal(pool.running, true);
		assert.doesNotMatch(pool.output, /Pool spawned/);
		await pool.kill();
	});
});
