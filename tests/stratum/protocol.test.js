// -----------------------------------------------------------
//  [*] Tests — the stratum protocol on the wire
//
//  How a pool port reads what arrives: line-delimited
//  JSON-RPC, lines split or joined anyhow by TCP, every
//  request answered on its own line with the same id and an
//  error of code -1 or a result. What is not a request is
//  dealt with on the spot — a browser's GET gets a "Mining
//  server online" page, a line that is not JSON or 10 KB
//  without a newline ends the connection, a request without
//  an id, a method or params is dropped unanswered — and the
//  methods other than login refuse a connection that has not
//  logged in. The pool runs whole, as shipped; no share is
//  mined here.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { World } = require('../support/world.js');
const { REAL } = require('../support/addresses.js');
const { sleep } = require('../support/wait.js');


// The world and its pool
let world;
let pool;

before(async () => {
	world = await World.create('protocol');
	pool = await world.startPool();
});

after(() => world.close());







// -----------------------------------------------------------
// rawExchange
// -----------------------------------------------------------
//
// Writes raw text to a pool port and collects what comes
// back until the pool closes the connection or a quiet
// moment passes; tells whether the pool closed it.
//
// Used by:
//   - the framing tests (below)
// -----------------------------------------------------------

function rawExchange (port, text, { quiet = 1500 } = {}) {

	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		let received = '';
		let timer = null;
		const finish = (closed) => {
			clearTimeout(timer);
			socket.destroy();
			resolve({ received, closed });
		};
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => {
			received += chunk;
			clearTimeout(timer);
			timer = setTimeout(() => finish(false), quiet);
		});
		socket.on('close', () => finish(true));
		socket.on('error', () => {});
		socket.on('connect', () => {
			socket.write(text);
			timer = setTimeout(() => finish(false), quiet);
		});
	});
}







// -----------------------------------------------------------
// Framing
// -----------------------------------------------------------
//
// How the pool cuts what arrives into requests, and what
// it does with input that is no request.
// -----------------------------------------------------------

describe('a pool port reading the wire', () => {

	it('puts a login split over several writes back together', async () => {
		const miner = await world.stratum(3333);
		const line = JSON.stringify({ id: 7, jsonrpc: '2.0', method: 'login', params: { login: REAL.miner, pass: 'x', agent: 'test' } }) + '\n';
		const answered = new Promise((resolve) => miner.pending.set(7, resolve));
		for (let i = 0; i < line.length; i += 40) {
			miner.send(line.slice(i, i + 40));
			await sleep(20);
		}
		const reply = await answered;
		assert.equal(reply.result.status, 'OK');
	});


	it('answers two requests that arrive in one write, each with its own id', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const replies = [];
		miner.pending.set(21, (reply) => replies.push(reply));
		miner.pending.set(22, (reply) => replies.push(reply));
		miner.send(
			JSON.stringify({ id: 21, jsonrpc: '2.0', method: 'keepalived', params: { id: miner.minerId } }) + '\n' +
			JSON.stringify({ id: 22, jsonrpc: '2.0', method: 'getjob', params: { id: miner.minerId } }) + '\n'
		);
		await sleep(500);
		assert.deepEqual(replies.map((reply) => reply.id), [21, 22]);
		assert.deepEqual(replies[0].result, { status: 'KEEPALIVED' });
	});


	it('skips blank lines', async () => {
		const { received } = await rawExchange(world.port(3333), '\n\r\n  \n' + JSON.stringify({ id: 1, method: 'getjob', params: {} }) + '\n');
		assert.equal(JSON.parse(received).error.message, 'Unauthenticated');
	});


	it('answers a browser\'s GET with a plain page and closes', async () => {
		const { received, closed } = await rawExchange(world.port(3333), 'GET / HTTP/1.1\r\nHost: pool.bitlitas.lt\r\n\r\n');
		assert.equal(received, 'HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nMining server online');
		assert.equal(closed, true);
	});


	it('answers an HTTP/1.0 GET the same way', async () => {
		const { received } = await rawExchange(world.port(3333), 'GET /stats HTTP/1.0\r\n\r\n');
		assert.match(received, /^HTTP\/1\.0 200 OK\n/);
	});


	it('closes a connection that sends a line that is not JSON', async () => {
		const { received, closed } = await rawExchange(world.port(3333), 'hello pool\n');
		assert.equal(received, '');
		assert.equal(closed, true);
		await pool.waitForOutput('Malformed message from ::ffff:127.0.0.1: hello pool');
	});


	it('closes a connection that sends more than 10 KB without a newline', async () => {
		const { closed } = await rawExchange(world.port(3333), 'x'.repeat(10241));
		assert.equal(closed, true);
		await pool.waitForOutput('Socket flooding detected and prevented from ::ffff:127.0.0.1');
	});


	it('keeps a connection that sends more than 10 KB over time, line by line', async () => {
		const miner = await world.stratum(3333);
		for (let i = 0; i < 11; i++) {
			const reply = await miner.request('getjob', { padding: 'p'.repeat(900) });
			assert.equal(reply.error.message, 'Unauthenticated');
		}
	});
});







// -----------------------------------------------------------
// Requests
// -----------------------------------------------------------
//
// Requests the pool drops, refuses or answers before and
// after a login.
// -----------------------------------------------------------

describe('a request on a pool port', () => {

	it('without an id, a method or params goes unanswered', async () => {
		for (const request of [
			{ jsonrpc: '2.0', method: 'getjob', params: {} },
			{ id: 1, jsonrpc: '2.0', params: {} },
			{ id: 1, jsonrpc: '2.0', method: 'getjob' }
		]) {
			const { received, closed } = await rawExchange(world.port(3333), JSON.stringify(request) + '\n', { quiet: 700 });
			assert.equal(received, '');
			assert.equal(closed, false);
		}
	});


	it('sent as a JSON-RPC batch goes unanswered, as a request without an id', async () => {
		const batch = [{ id: 1, method: 'getjob', params: {} }, { id: 2, method: 'keepalived', params: {} }];
		const { received } = await rawExchange(world.port(3333), JSON.stringify(batch) + '\n', { quiet: 700 });
		assert.equal(received, '');
	});


	it('for a method the pool does not have is refused with code -1', async () => {
		const miner = await world.stratum(3333);
		const reply = await miner.request('mining.subscribe', {});
		assert.deepEqual(reply, { id: reply.id, jsonrpc: '2.0', error: { code: -1, message: 'Invalid method' } });
	});


	it('other than login is refused before a login', async () => {
		const miner = await world.stratum(3333);
		for (const method of ['getjob', 'submit', 'keepalived']) {
			const reply = await miner.request(method, { id: '123456789012345' });
			assert.equal(reply.error.message, 'Unauthenticated', method);
		}
	});


	it('to keep alive is answered KEEPALIVED once logged in', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const reply = await miner.keepalived();
		assert.deepEqual(reply.result, { status: 'KEEPALIVED' });
		assert.equal(reply.error, null);
	});


	it('for a job hands back the same job while nothing has changed', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const first = miner.job;
		const again = await miner.getjob();
		assert.equal(again.result.job_id, first.job_id);
		assert.equal(again.result.blob, first.blob);
	});


	it('with another miner\'s id is answered as that miner', async () => {
		const owner = await world.stratum(3333);
		await owner.login(REAL.miner, 'owner-rig');
		const stranger = await world.stratum(3333);
		const reply = await stranger.request('getjob', { id: owner.minerId });
		assert.equal(reply.result.id, owner.minerId);
	});
});
