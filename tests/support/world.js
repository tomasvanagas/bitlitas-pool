// -----------------------------------------------------------
//  [*] Test support — the World (one test file's sandbox)
//
//  Everything one test file runs against, built in its own
//  folder under /tmp/bitlitas-pool-tests: a redis-server, the
//  fake bitlitasd and the fake wallet RPC, each on a port no
//  other file holds, and the pools the file starts. Ports are
//  claimed with an atomic mkdir, so files can run in
//  parallel.
//
//  The pool's configuration is the shipped
//  config_examples/bitlitas.json with only what a sandbox must
//  change: the pool wallet is a real Bitlitas address in place
//  of the placeholder, the daemon, wallet, Redis, API and
//  stratum ports are the claimed ones (the six shipped ports
//  keep their difficulties, descriptions, the hidden flag and
//  the SSL flag), logs go to the world's folder, and one pool
//  worker runs instead of one per CPU, so every share lands in
//  the same process. A test states the rest of what it changes
//  — its deviations — in the call that starts the pool. The
//  `cheapPort` option adds a seventh port of difficulty 1,
//  where one RandomX hash makes a share.
//
//  Used by:
//    - every suite that starts the pool
// -----------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { RedisServer } = require('./redis.js');
const { FakeDaemon } = require('./daemon.js');
const { FakeWallet } = require('./wallet.js');
const { PoolProcess, POOL_ROOT } = require('./pool-process.js');
const { StratumClient } = require('./stratum.js');
const { REAL } = require('./addresses.js');


// The configuration the pool ships for Bitlitas
const SHIPPED_CONFIG = path.join(POOL_ROOT, 'config_examples', 'bitlitas.json');

// Every world lives under one folder
const WORLDS = '/tmp/bitlitas-pool-tests';

// The claims on ports, one folder per port taken
const PORT_CLAIMS = path.join(WORLDS, 'ports');

// Claimed ports start here and count up
const FIRST_PORT = 31000;

// The port this process tries to claim next
let nextPort = FIRST_PORT;

// What each kind of pool start waits for before it is ready
const READY_LINES = {
	api: /API started & listening/,
	unlocker: /\[unlocker\] Started/,
	payments: /\[payments\] Started/,
	chartsDataCollector: /\[chartsDataCollector\] Started/
};







// -----------------------------------------------------------
// claimPort
// -----------------------------------------------------------
//
// A TCP port no other test file holds: the first number from
// FIRST_PORT whose claim folder this process manages to
// create. mkdir either creates or fails, so two files never
// get the same port.
//
// Used by:
//   - World (below), tests/units/api-interfaces.test.js,
//     tests/units/notifications.test.js
// -----------------------------------------------------------

function claimPort () {

	fs.mkdirSync(PORT_CLAIMS, { recursive: true });
	while (true) {
		const port = nextPort++;
		try {
			fs.mkdirSync(path.join(PORT_CLAIMS, String(port)));
			return port;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
	}
}







// -----------------------------------------------------------
// deepMerge
// -----------------------------------------------------------
//
// A test's deviations laid over the configuration: objects
// merge key by key, anything else — arrays included —
// replaces, and `undefined` deletes the key.
//
// Used by:
//   - sandboxConfig, World.config (below)
// -----------------------------------------------------------

function deepMerge (target, changes) {

	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) {
			delete target[key];
		} else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
			deepMerge(target[key], value);
		} else {
			target[key] = value;
		}
	}
	return target;
}







// -----------------------------------------------------------
// portHolders
// -----------------------------------------------------------
//
// The processes listening on a TCP port, read from /proc:
// the socket's inode in /proc/net/tcp and tcp6, then the
// process holding a descriptor of it, with its command line.
// Empty when the port is free.
//
// Used by:
//   - World.startPool (below)
// -----------------------------------------------------------

function portHolders (port) {

	const inodes = new Set();
	for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
		for (const line of fs.readFileSync(table, 'utf8').split('\n').slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10 || fields[3] !== '0A') continue;
			if (parseInt(fields[1].split(':')[1], 16) === port) inodes.add(fields[9]);
		}
	}
	if (!inodes.size) return [];
	const holders = [];
	for (const pid of fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
		try {
			for (const fd of fs.readdirSync('/proc/' + pid + '/fd')) {
				const target = fs.readlinkSync('/proc/' + pid + '/fd/' + fd);
				const match = /^socket:\[(\d+)\]$/.exec(target);
				if (match && inodes.has(match[1])) {
					holders.push(pid + ' ' + fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ').trim());
					break;
				}
			}
		} catch (e) {
			continue;
		}
	}
	return holders.length ? holders : ['an unknown process'];
}







// -----------------------------------------------------------
// sandboxConfig
// -----------------------------------------------------------
//
// The shipped configuration with a real pool wallet in place
// of the placeholder and a test's deviations laid over it —
// for the unit suites that load one module in-process as the
// global `config` and start no server.
//
// Used by:
//   - the unit suites
// -----------------------------------------------------------

function sandboxConfig (deviations = {}) {

	const config = JSON.parse(fs.readFileSync(SHIPPED_CONFIG, 'utf8'));
	config.poolServer.poolAddress = REAL.pool;
	return deepMerge(config, deviations);
}







// -----------------------------------------------------------
// World
// -----------------------------------------------------------
//
// One file's sandbox. `create` claims the ports and starts
// Redis (behind a password when the file asks for one, which
// the configuration then carries) and the two fakes; `config` returns the sandboxed
// configuration with a test's deviations laid over it;
// `startPool` checks the ports it will bind are free, writes
// that configuration and starts the pool (a whole pool or one
// module), waiting until it serves;
// `stratum` connects a miner to a port given by its shipped
// number or as 'cheap'; `close` ends everything the world
// started.
//
// Used by:
//   - every suite that starts the pool
// -----------------------------------------------------------

class World {

	static async create (name, { chain, redisPassword } = {}) {
		fs.mkdirSync(WORLDS, { recursive: true });
		const world = new World(fs.mkdtempSync(path.join(WORLDS, name + '-')));
		world.redis = new RedisServer(claimPort(), world.dir, { password: redisPassword });
		world.daemon = new FakeDaemon(claimPort(), chain);
		world.wallet = new FakeWallet(claimPort());
		await world.redis.start();
		await world.daemon.start();
		await world.wallet.start();
		return world;
	}


	constructor (dir) {
		this.dir = dir;
		this.logs = path.join(dir, 'logs');
		this.pools = [];
		this.clients = [];
		this.configs = 0;
		this.shipped = JSON.parse(fs.readFileSync(SHIPPED_CONFIG, 'utf8'));
		this.stratumPorts = {};
		for (const port of this.shipped.poolServer.ports) this.stratumPorts[port.port] = claimPort();
		this.stratumPorts.cheap = claimPort();
		this.apiPort = claimPort();
		this.apiSslPort = claimPort();
	}


	port (shippedNumber) {
		return this.stratumPorts[shippedNumber];
	}


	config (deviations = {}, { cheapPort = false } = {}) {
		const config = JSON.parse(JSON.stringify(this.shipped));
		config.poolServer.poolAddress = REAL.pool;
		config.poolServer.clusterForks = 1;
		config.poolServer.ports = config.poolServer.ports.map((port) => ({ ...port, port: this.stratumPorts[port.port] }));
		if (cheapPort) config.poolServer.ports.push({ port: this.stratumPorts.cheap, difficulty: 1, desc: 'Test port' });
		config.daemon.port = this.daemon.port;
		config.wallet.port = this.wallet.port;
		config.redis.port = this.redis.port;
		if (this.redis.password) config.redis.auth = this.redis.password;
		config.api.port = this.apiPort;
		config.api.sslPort = this.apiSslPort;
		config.logging.files.directory = this.logs;
		return deepMerge(config, deviations);
	}


	writeConfig (config) {
		const file = path.join(this.dir, 'config-' + (++this.configs) + '.json');
		fs.writeFileSync(file, JSON.stringify(config, null, 1));
		return file;
	}


	async startPool (deviations = {}, { module, cheapPort = false, ready = true, args, env, portsFree = true } = {}) {
		const config = this.config(deviations, { cheapPort });
		// A port still held from an earlier pool fails here, by name,
		// rather than as a worker crashing on EADDRINUSE
		const stratum = !module || module === 'pool' ? config.poolServer.ports.filter(() => config.poolServer.enabled).map((one) => one.port) : [];
		const api = (!module && config.api.enabled) || module === 'api' ? [config.api.port] : [];
		for (const port of portsFree ? stratum.concat(api) : []) {
			const holders = portHolders(port);
			if (holders.length) throw new Error('port ' + port + ' is still held by ' + holders.join('; '));
		}
		const pool = new PoolProcess(this.writeConfig(config), { module, args, env });
		pool.config = config;
		this.pools.push(pool);
		if (ready) await this.waitUntilServing(pool, module);
		return pool;
	}


	async waitUntilServing (pool, module) {
		if (READY_LINES[module]) return pool.waitForOutput(READY_LINES[module]);
		const plain = pool.config.poolServer.ports.filter((port) => !port.ssl);
		for (const port of plain) await pool.waitForOutput('Started server listening on port ' + port.port + '\n');
		if (!module && this.daemon.mode === 'ok') await pool.waitForOutput(/New bitlitas block to mine at height/);
	}


	async stratum (shippedNumber, options) {
		const client = await StratumClient.connect(this.port(shippedNumber), options);
		this.clients.push(client);
		return client;
	}


	async stopPools () {
		for (const client of this.clients) client.close();
		this.clients = [];
		await Promise.all(this.pools.map((pool) => pool.kill()));
		this.pools = [];
	}


	async close () {
		await this.stopPools();
		await this.daemon.stop();
		await this.wallet.stop();
		await this.redis.close();
	}
}







// What the suites take from here
module.exports = { World, claimPort, deepMerge, sandboxConfig, portHolders, WORLDS, SHIPPED_CONFIG };
