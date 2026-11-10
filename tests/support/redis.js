// -----------------------------------------------------------
//  [*] Test support — a Redis of the test world's own
//
//  Every test file starts its own redis-server, on a port of
//  its own, keeping nothing on disk — so files run side by
//  side without seeing each other's keys, and a test can stop
//  the database under the pool, make it a read-only replica
//  that refuses every write, or make it run out of memory. The
//  client is the pool's own `redis` package (v3, callback
//  style), wrapped so a test awaits a command and gets the
//  reply the pool would get.
//
//  Used by:
//    - tests/support/world.js
// -----------------------------------------------------------

const { spawn } = require('child_process');
const redis = require('redis');
const { waitFor } = require('./wait.js');







// -----------------------------------------------------------
// RedisServer
// -----------------------------------------------------------
//
// One redis-server process bound to 127.0.0.1 with saving
// and the append-only file off, its working directory the
// world's own, behind a password when one is given. `call`
// runs any command and resolves with its reply, rejecting
// with the error Redis gives; `stop` kills the server,
// `start` brings back a fresh empty one on the same port.
// `refuseWrites` turns the server into a replica of a master
// that does not exist — as a failover gone wrong leaves a
// pool's Redis — so every write, and every transaction
// holding one, is refused with READONLY while reads and
// read-only transactions are served from the data it has.
// `runOutOfMemory` caps the memory at one byte under the
// noeviction policy instead: every write fails with OOM, and
// so does every transaction, reads included, since Redis
// queues nothing more once it is full. `recover` undoes
// either.
//
// Used by:
//   - tests/support/world.js
// -----------------------------------------------------------

class RedisServer {

	constructor (port, dir, { password } = {}) {
		this.port = port;
		this.dir = dir;
		this.password = password;
		this.process = null;
		this.client = null;
	}


	async start () {
		if (this.client) this.client.end(false);
		const args = [
			'--port', String(this.port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no',
			'--dir', this.dir, '--protected-mode', 'no', '--loglevel', 'warning', '--maxmemory-policy', 'noeviction'
		];
		if (this.password) args.push('--requirepass', this.password);
		this.process = spawn('redis-server', args, { stdio: 'ignore' });
		this.exited = new Promise((resolve) => this.process.once('exit', resolve));
		this.client = redis.createClient(this.port, '127.0.0.1', this.password ? { auth_pass: this.password } : {});
		// The client retries on its own while the server comes up
		this.client.on('error', () => {});
		await waitFor(() => this.call('ping').then((reply) => reply === 'PONG'), { what: 'redis-server on port ' + this.port });
	}


	async stop () {
		if (!this.process) return;
		this.process.kill('SIGKILL');
		await this.exited;
		this.process = null;
	}


	async close () {
		if (this.client) this.client.end(false);
		this.client = null;
		await this.stop();
	}


	refuseWrites () {
		return this.call('replicaof', '127.0.0.1', '1');
	}


	runOutOfMemory () {
		return this.call('config', 'set', 'maxmemory', '1');
	}


	async recover () {
		await this.call('config', 'set', 'maxmemory', '0');
		await this.call('replicaof', 'no', 'one');
	}


	call (command, ...args) {
		return new Promise((resolve, reject) => {
			this.client.send_command(command, args.flat(), (error, reply) => error ? reject(error) : resolve(reply));
		});
	}


	multi (commands) {
		return new Promise((resolve, reject) => {
			this.client.multi(commands).exec((error, replies) => error ? reject(error) : resolve(replies));
		});
	}
}







// What the suites take from here
module.exports = { RedisServer };
