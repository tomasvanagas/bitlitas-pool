// -----------------------------------------------------------
//  [*] Tests — the JSON-RPC client (lib/apiInterfaces.js)
//
//  Every call the pool makes to the daemon, the wallet and
//  its own API goes through this module: a JSON-RPC 2.0 POST
//  to /json_rpc (a batch for several calls), or a GET for the
//  API. What it hands its callers when the far side fails
//  decides what the modules built on it do — and an answer
//  with neither an error nor a result is what lets the
//  unlocker and the payment run crash (their defects files
//  pin that). The far side here is the suite's fake daemon,
//  plus servers made on the spot for the broken answers.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { World, claimPort, sandboxConfig } = require('../support/world.js');


// The world whose fake daemon answers, and the client under
// test built for it
let world;
let rpc;

before(async () => {
	world = await World.create('api-interfaces');
	global.config = sandboxConfig({ api: { port: world.apiPort } });
	rpc = require('../../lib/apiInterfaces.js')({ host: '127.0.0.1', port: world.daemon.port }, { host: '127.0.0.1', port: world.wallet.port }, global.config.api);
});

after(() => world.close());







// -----------------------------------------------------------
// call
// -----------------------------------------------------------
//
// One callback-style call as a promise of its two values.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function call (fn, ...args) {

	return new Promise((resolve) => fn(...args, (error, result) => resolve({ error, result })));
}







// -----------------------------------------------------------
// oneShotServer
// -----------------------------------------------------------
//
// A server on a fresh port that answers every request with a
// fixed status and body — or never, for a hang.
//
// Used by:
//   - the broken-answer tests (below)
// -----------------------------------------------------------

async function oneShotServer (status, body) {

	const port = claimPort();
	const server = http.createServer((request, response) => {
		request.resume();
		if (body === null) return;
		response.writeHead(status, { 'Content-Type': 'application/json' });
		response.end(body);
	});
	await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
	return { port, close: () => { server.closeAllConnections(); server.close(); } };
}







// -----------------------------------------------------------
// Calls that work
// -----------------------------------------------------------
//
// Calls the fake daemon and wallet answer, single and in
// a batch.
// -----------------------------------------------------------

describe('a JSON-RPC call', () => {

	it('posts JSON-RPC 2.0 with id "0" to /json_rpc and hands back the result', async () => {
		const { error, result } = await call(rpc.rpcDaemon, 'getblockcount', {});
		assert.equal(error, undefined);
		assert.equal(result.count, world.daemon.chain.tipHeight + 1);
		assert.equal(world.daemon.callsOf('getblockcount').length, 1);
	});


	it('hands back the daemon\'s error object as the error', async () => {
		const { error, result } = await call(rpc.rpcDaemon, 'getblockheaderbyheight', { height: 99999999 });
		assert.equal(error.code, -2);
		assert.match(error.message, /^Requested block height: 99999999 greater than current top block height/);
		assert.equal(result, undefined);
	});


	it('goes to another server when the caller names one', async () => {
		const { result } = await call((method, params, callback) => rpc.rpcDaemon(method, params, callback, { host: '127.0.0.1', port: world.wallet.port }), 'getbalance', {});
		assert.equal(result.unlocked_balance, world.wallet.balance);
	});


	it('reaches the wallet for wallet calls', async () => {
		const { result } = await call(rpc.rpcWallet, 'getbalance', {});
		assert.equal(result.balance, world.wallet.balance);
	});


	it('sends several calls as one batch and hands back the replies in order', async () => {
		const replies = await new Promise((resolve) => rpc.batchRpcDaemon([['getblockcount', {}], ['get_info', {}]], (error, reply) => resolve(reply)));
		assert.deepEqual(replies.map((reply) => reply.id), ['0', '1']);
		assert.equal(replies[1].result.height, world.daemon.chain.tipHeight + 1);
	});
});







// -----------------------------------------------------------
// Calls that fail
// -----------------------------------------------------------
//
// A refused connection, a body that is no JSON, an empty
// body and an error status, as the callers get them.
// -----------------------------------------------------------

describe('a JSON-RPC call that fails', () => {

	it('hands back the connection error and an empty result when nobody listens', async () => {
		const client = require('../../lib/apiInterfaces.js')({ host: '127.0.0.1', port: claimPort() }, {}, global.config.api);
		const { error, result } = await call(client.rpcDaemon, 'get_info', {});
		assert.equal(error.code, 'ECONNREFUSED');
		assert.deepEqual(result, {});
	});


	it('hands back a parse error for a body that is not JSON', async () => {
		const server = await oneShotServer(502, '<html>502 Bad Gateway</html>');
		const { error, result } = await call((callback) => rpc.jsonHttpRequest('127.0.0.1', server.port, '{}', callback));
		server.close();
		assert.ok(error instanceof SyntaxError);
		assert.deepEqual(result, {});
	});


	it('reads an empty body as no error and no result at all', async () => {
		const server = await oneShotServer(200, '');
		const client = require('../../lib/apiInterfaces.js')({ host: '127.0.0.1', port: server.port }, {}, global.config.api);
		const { error, result } = await call(client.rpcDaemon, 'getblockheaderbyheight', { height: 1 });
		server.close();
		assert.equal(error, undefined);
		assert.equal(result, undefined);
	});


	it('ignores the HTTP status of a JSON answer', async () => {
		const server = await oneShotServer(500, JSON.stringify({ id: '0', jsonrpc: '2.0', result: { status: 'OK' } }));
		const client = require('../../lib/apiInterfaces.js')({ host: '127.0.0.1', port: server.port }, {}, global.config.api);
		const { error, result } = await call(client.rpcDaemon, 'get_info', {});
		server.close();
		assert.equal(error, undefined);
		assert.deepEqual(result, { status: 'OK' });
	});
});







// -----------------------------------------------------------
// The pool's own API
// -----------------------------------------------------------
//
// The GET the charts collector and the Telegram bot make
// to the pool's own API.
// -----------------------------------------------------------

describe('a request to the pool\'s own API', () => {

	it('is a GET to 127.0.0.1 on the API port while the API binds every address', async () => {
		let seen = null;
		const server = http.createServer((request, response) => {
			seen = { method: request.method, url: request.url };
			response.end(JSON.stringify({ pool: { hashrate: 7 } }));
		});
		await new Promise((resolve) => server.listen(world.apiPort, '127.0.0.1', resolve));
		const { error, result } = await call(rpc.pool, '/stats');
		server.close();
		assert.equal(error, null);
		assert.deepEqual(result, { pool: { hashrate: 7 } });
		assert.deepEqual(seen, { method: 'GET', url: '/stats' });
	});
});
