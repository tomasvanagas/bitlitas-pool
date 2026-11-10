// -----------------------------------------------------------
//  [*] Test support — a stratum miner
//
//  What XMRig is to the pool: a client speaking the pool's
//  line-delimited JSON-RPC over TCP (or TLS), logging in,
//  taking the jobs the pool pushes, and submitting shares it
//  really mined — RandomX over the job's hashing blob with
//  the nonce at byte 39, keyed by the job's seed hash, which
//  is what the pool verifies. One hash takes about a second
//  and a half in this build of the hashing module (its VM
//  runs interpreted), so tests mine on the difficulty-1 test
//  port, where any hash is a share, and send hand-made
//  results where a test wants a share to be wrong.
//
//  A request the pool never answers resolves to null after a
//  timeout instead of failing, so a test can assert on the
//  silence itself.
//
//  Split into:
//
//    XMRIG_AGENT      — the agent string a stock XMRig sends
//    targetDifficulty — the difficulty a job's target means
//    targetHex        — the target the pool sends for one
//    mineShare        — a real share for a job
//    StratumClient    — one miner connection
//
//  Used by:
//    - tests/support/world.js, the stratum, startup and flow
//      suites
// -----------------------------------------------------------

const net = require('net');
const tls = require('tls');
const cnHashing = require('cryptonight-hashing');
const { meetsDifficulty } = require('./daemon.js');


// What a stock XMRig names itself as at login
const XMRIG_AGENT = 'XMRig/6.21.0 (Linux x86_64) libuv/1.44.2 gcc/12.2.0';

// How long a request waits for the pool's reply by default:
// a first share also pays for the worker's RandomX cache
const REPLY_TIMEOUT = 30000;

// Where the nonce sits in a hashing blob (and a block blob):
// after the versions, the five-byte timestamp and the
// previous block's hash
const NONCE_OFFSET = 39;







// -----------------------------------------------------------
// targetDifficulty
// -----------------------------------------------------------
//
// The difficulty a job's four-byte target stands for, the
// way XMRig reads it: 2^32 - 1 divided by the target taken as
// a little-endian number, rounded. A zero target means no
// share can ever meet it.
//
// Used by:
//   - tests/stratum/vardiff.test.js
// -----------------------------------------------------------

function targetDifficulty (targetHex) {

	const target = Buffer.from(targetHex, 'hex').readUInt32LE(0);
	return target === 0 ? Infinity : Math.round(0xffffffff / target);
}







// -----------------------------------------------------------
// targetHex
// -----------------------------------------------------------
//
// The four-byte target the pool sends for a difficulty, by
// the pool's own arithmetic: the top four bytes of
// (2^256 - 1) / difficulty, written little-endian — zero for
// a difficulty above 2^32.
//
// Used by:
//   - tests/stratum/login.test.js, tests/stratum/defects.test.js,
//     tests/startup/startup.test.js
// -----------------------------------------------------------

function targetHex (difficulty) {

	const quotient = ((1n << 256n) - 1n) / BigInt(difficulty);
	const top = Buffer.from(quotient.toString(16).padStart(64, '0'), 'hex').subarray(0, 4);
	return Buffer.from(top).reverse().toString('hex');
}







// -----------------------------------------------------------
// mineShare
// -----------------------------------------------------------
//
// A share for a job: the nonce written into the job's blob,
// hashed with RandomX under the job's seed. With a
// difficulty it keeps counting the nonce up until the hash
// meets it; without one the first nonce does. Returns the
// submit parameters, the hash and the nonce's number.
//
// Used by:
//   - StratumClient.mine (below)
// -----------------------------------------------------------

function mineShare (job, { nonce = 1, difficulty, seedHash } = {}) {

	const blob = Buffer.from(job.blob, 'hex');
	const seed = Buffer.from(seedHash || job.seed_hash, 'hex');
	let attempt = nonce;
	while (true) {
		blob.writeUInt32LE(attempt >>> 0, NONCE_OFFSET);
		const hash = cnHashing.randomx(blob, seed, 0);
		if (!difficulty || meetsDifficulty(hash, difficulty)) {
			return {
				job_id: job.job_id,
				nonce: blob.subarray(NONCE_OFFSET, NONCE_OFFSET + 4).toString('hex'),
				result: hash.toString('hex'),
				hash,
				nonceNumber: attempt
			};
		}
		attempt++;
	}
}







// -----------------------------------------------------------
// StratumClient
// -----------------------------------------------------------
//
// One connection to a pool port. `request` sends a call and
// resolves with the whole reply object (null when none came
// in time); `login`, `getjob`, `keepalived` and `submit` are
// the four methods of the protocol, `login` keeping the miner
// id and first job. Jobs the pool pushes collect in `jobs`;
// `nextJob` waits for the next one, `jobAtHeight` for one of a
// given height. `send` writes raw bytes,
// for tests of what the pool does with malformed input, and
// `closed` resolves when the pool drops the connection.
//
// Used by:
//   - tests/support/world.js, the stratum and flow suites
// -----------------------------------------------------------

class StratumClient {

	static connect (port, { useTls = false, localAddress } = {}) {
		return new Promise((resolve, reject) => {
			const options = { host: '127.0.0.1', port, localAddress, rejectUnauthorized: false };
			const socket = useTls ? tls.connect(options) : net.connect(options);
			socket.once(useTls ? 'secureConnect' : 'connect', () => resolve(new StratumClient(socket)));
			socket.once('error', reject);
		});
	}


	constructor (socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.jobs = [];
		this.jobWaiters = [];
		this.received = [];
		this.minerId = null;
		this.job = null;
		this.buffer = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => this.receive(chunk));
		socket.on('error', () => {});
		this.closed = new Promise((resolve) => socket.once('close', resolve));
	}


	receive (chunk) {
		this.buffer += chunk;
		let newline;
		while ((newline = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			this.received.push(line);
			let message;
			try {
				message = JSON.parse(line);
			} catch (e) {
				continue;
			}
			if (message.method === 'job') {
				this.jobs.push(message.params);
				this.job = message.params;
				for (const waiter of this.jobWaiters.splice(0)) waiter(message.params);
			} else if (this.pending.has(message.id)) {
				this.pending.get(message.id)(message);
				this.pending.delete(message.id);
			}
		}
	}


	send (text) {
		this.socket.write(text);
	}


	request (method, params, { timeout = REPLY_TIMEOUT, id } = {}) {
		const requestId = id === undefined ? this.nextId++ : id;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				resolve(null);
			}, timeout);
			this.pending.set(requestId, (reply) => {
				clearTimeout(timer);
				resolve(reply);
			});
			this.socket.write(JSON.stringify({ id: requestId, jsonrpc: '2.0', method, params }) + '\n');
		});
	}


	async login (login, pass = 'x', { agent = XMRIG_AGENT, timeout, extra = {} } = {}) {
		const params = { login, agent, ...extra };
		if (pass !== undefined) params.pass = pass;
		const reply = await this.request('login', params, { timeout });
		if (reply && reply.result) {
			this.minerId = reply.result.id;
			this.job = reply.result.job;
		}
		return reply;
	}


	getjob (options) {
		return this.request('getjob', { id: this.minerId }, options);
	}


	keepalived (options) {
		return this.request('keepalived', { id: this.minerId }, options);
	}


	submit (share, options) {
		const params = { id: this.minerId, job_id: share.job_id, nonce: share.nonce, result: share.result };
		return this.request('submit', { ...params, ...(share.extra || {}) }, options);
	}


	mine (options = {}) {
		return mineShare(options.job || this.job, options);
	}


	nextJob ({ timeout = 20000 } = {}) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), timeout);
			this.jobWaiters.push((job) => {
				clearTimeout(timer);
				resolve(job);
			});
		});
	}


	// The pool may still push a job for an older template first,
	// so this waits past those for the height a test expects
	async jobAtHeight (height, { timeout = 20000 } = {}) {
		const deadline = Date.now() + timeout;
		let job = this.job;
		while (!job || job.height !== height) {
			const left = deadline - Date.now();
			if (left <= 0) return null;
			job = await this.nextJob({ timeout: left });
			if (!job) return null;
		}
		return job;
	}


	close () {
		this.socket.destroy();
	}
}







// What the suites take from here
module.exports = { StratumClient, mineShare, targetDifficulty, targetHex, XMRIG_AGENT, NONCE_OFFSET };
