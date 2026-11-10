// -----------------------------------------------------------
//  [*] Test support — the fake bitlitasd
//
//  A JSON-RPC server on /json_rpc answering the six methods
//  the pool calls — getlastblockheader, getblocktemplate,
//  getblockheaderbyheight, get_info, submitblock and the
//  monitoring's getblockcount — in the shapes a real
//  bitlitasd v0.18.3.1 answered them when the fixtures were
//  captured, errors included: an unknown height, a blob that
//  does not parse, a block that is not accepted.
//
//  submitblock checks what the real daemon checks that a
//  pool can get wrong: the blob must parse, extend the
//  current tip, and its RandomX hash under the template's
//  seed must meet the difficulty. A difficulty of 1 is met by
//  every hash, so that case skips the second-long hash. An
//  accepted block becomes the new tip.
//
//  Tests take the daemon down, make it hang, answer garbage
//  or override one method, and read back every call it got.
//
//  Used by:
//    - tests/support/world.js; its difficulty check also
//      tests/support/stratum.js and tests/hashing/randomx.test.js
// -----------------------------------------------------------

const http = require('http');
const cnHashing = require('cryptonight-hashing');
const cnUtil = require('cryptoforknote-util');
const bignum = require('bignum');
const { FakeChain, seedHeight } = require('./chain.js');


// 2^256 - 1, the pool's own "difficulty 1" target
const DIFF1 = bignum('f'.repeat(64), 16);







// -----------------------------------------------------------
// meetsDifficulty
// -----------------------------------------------------------
//
// Whether a RandomX hash, read as the little-endian number
// the pool and the daemon read it as, meets a difficulty.
//
// Used by:
//   - FakeDaemon (below), tests/support/stratum.js,
//     tests/hashing/randomx.test.js
// -----------------------------------------------------------

function meetsDifficulty (hash, difficulty) {

	const value = bignum.fromBuffer(Buffer.from(hash).reverse());
	return DIFF1.div(value).ge(difficulty);
}







// -----------------------------------------------------------
// FakeDaemon
// -----------------------------------------------------------
//
// The daemon of one test world. `mode` is how the whole
// server behaves: answering, `hang` (the request is read and
// never answered), `empty` (a 200 with no body), `garbage`
// (a 200 that is not JSON) or `error` (a JSON-RPC error for
// every call). `override` replaces one method's answer for
// the calls that follow. Requests are kept in `calls`, newest
// last; `stop` and `start` take the port away and back.
//
// Used by:
//   - tests/support/world.js
// -----------------------------------------------------------

class FakeDaemon {

	constructor (port, chainOptions) {
		this.port = port;
		this.chain = new FakeChain(chainOptions);
		this.mode = 'ok';
		this.overrides = {};
		this.calls = [];
		this.submitted = [];
		this.sockets = new Set();
		this.server = null;
	}


	async start () {
		this.server = http.createServer((request, response) => this.handle(request, response));
		this.server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.port, '127.0.0.1', resolve);
		});
	}


	async stop () {
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		for (const socket of this.sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	}


	override (method, answer) {
		this.overrides[method] = answer;
	}


	callsOf (method) {
		return this.calls.filter((call) => call.method === method);
	}


	handle (request, response) {
		let body = '';
		request.setEncoding('utf8');
		request.on('data', (chunk) => body += chunk);
		request.on('end', () => {
			let parsed = null;
			try {
				parsed = JSON.parse(body);
			} catch (e) {
				parsed = null;
			}
			const batch = Array.isArray(parsed);
			const requests = batch ? parsed : [parsed];
			for (const one of requests) {
				if (one) this.calls.push({ method: one.method, params: one.params, at: Date.now() });
			}


			if (this.mode === 'hang') return;
			if (this.mode === 'empty') return response.end();
			if (this.mode === 'garbage') return response.end('<html>502 Bad Gateway</html>');
			const replies = requests.map((one) => this.reply(one));
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(batch ? replies : replies[0]));
		});
	}


	reply (one) {
		const envelope = { id: one ? one.id : '0', jsonrpc: '2.0' };
		if (!one || !one.method) return { ...envelope, error: { code: -32600, message: 'Invalid Request' } };
		if (this.mode === 'error') return { ...envelope, error: { code: -9, message: 'Core is busy' } };
		const override = this.overrides[one.method];
		if (override) {
			const answer = typeof override === 'function' ? override(one.params, this) : override;
			return { ...envelope, ...answer };
		}
		const handler = this.methods()[one.method];
		if (!handler) return { ...envelope, error: { code: -32601, message: 'Method not found' } };
		return { ...envelope, ...handler(one.params || {}) };
	}


	methods () {
		const chain = this.chain;
		return {
			getlastblockheader: () => ({ result: { block_header: chain.header(chain.tipHeight), credits: 0, status: 'OK', top_hash: '', untrusted: false } }),
			getblocktemplate: (params) => ({ result: chain.template(params.reserve_size) }),
			getblockheaderbyheight: (params) => {
				if (params.height > chain.tipHeight) {
					return { error: { code: -2, message: 'Requested block height: ' + params.height + ' greater than current top block height: ' + chain.tipHeight } };
				}
				return { result: { block_header: chain.header(params.height), credits: 0, status: 'OK', top_hash: '', untrusted: false } };
			},
			get_info: () => ({ result: this.info() }),
			getblockcount: () => ({ result: { count: chain.tipHeight + 1, status: 'OK', untrusted: false } }),
			submitblock: (params) => this.submit(params)
		};
	}


	info () {
		const chain = this.chain;
		return {
			alt_blocks_count: 0,
			busy_syncing: false,
			cumulative_difficulty: 1000000 + chain.tipHeight,
			difficulty: chain.difficulty,
			height: chain.tipHeight + 1,
			mainnet: true,
			nettype: 'mainnet',
			offline: false,
			status: 'OK',
			synchronized: true,
			target: 120,
			target_height: 0,
			top_block_hash: chain.tipHash,
			tx_count: 0,
			tx_pool_size: 0,
			untrusted: false,
			version: '0.18.3.1-release',
			wide_difficulty: '0x' + chain.difficulty.toString(16)
		};
	}


	submit (params) {
		const chain = this.chain;
		const hex = Array.isArray(params) ? params[0] : null;
		let blob;
		let hashingBlob;
		try {
			blob = Buffer.from(hex, 'hex');
			hashingBlob = cnUtil.convert_blob(blob, 0);
		} catch (e) {
			return { error: { code: -6, message: 'Wrong block blob' } };
		}
		this.submitted.push(hex);


		const id = cnUtil.get_block_id(blob, 0).toString('hex');
		for (const [, block] of chain.blocks) {
			if (block.hash === id) return { result: { block_id: id, status: 'OK', untrusted: false } };
		}
		const prevHash = blob.subarray(7, 39).toString('hex');
		if (prevHash !== chain.tipHash) return { error: { code: -7, message: 'Block not accepted' } };
		const difficulty = chain.difficultyAt(chain.tipHeight + 1);
		if (difficulty > 1) {
			const seed = Buffer.from(chain.hashAt(seedHeight(chain.tipHeight + 1)), 'hex');
			if (!meetsDifficulty(cnHashing.randomx(hashingBlob, seed, 0), difficulty)) {
				return { error: { code: -7, message: 'Block not accepted' } };
			}
		}
		chain.accept(blob, blob.readUInt32LE(39));
		return { result: { block_id: id, status: 'OK', untrusted: false } };
	}
}







// What the suites take from here
module.exports = { FakeDaemon, meetsDifficulty, DIFF1 };
