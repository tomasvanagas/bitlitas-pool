// -----------------------------------------------------------
//  [*] Tests — shares from xmr-node-proxy
//
//  A proxy logs in once for many miners and hands each a
//  slice of the pool's job: it writes a pool nonce and a
//  worker nonce into the template's reserved bytes, so its
//  share carries both beside the nonce, and the pool takes the
//  triple as the share's identity. Both must be integers; a
//  share that is not, or repeats a triple, is refused at once
//  and bans the proxy's IP — every miner behind it. Whether a
//  correctly built proxy share holds is pinned in
//  defects.test.js: the pool writes the pool nonce where the
//  job never said. The tests connect from addresses of their
//  own, so the bans stay theirs.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');


// What xmr-node-proxy names itself as
const PROXY_AGENT = 'xmr-node-proxy/0.15.0';

// A result that is no RandomX hash of anything
const WRONG_RESULT = 'ab'.repeat(32);







// -----------------------------------------------------------
// Proxy shares
// -----------------------------------------------------------
//
// The checks a proxy share meets before its hash is looked at.
// -----------------------------------------------------------

describe('a share from xmr-node-proxy', () => {

	let world;

	before(async () => {
		world = await World.create('proxy');
		await world.startPool({ api: { enabled: false } }, { cheapPort: true });
	});

	after(() => world.close());


	// A proxy logged in on the test port from an address of its own
	const proxy = async (localAddress, label) => {
		const client = await world.stratum('cheap', { localAddress });
		assert.equal((await client.login(addresses.address(label), 'proxy', { agent: PROXY_AGENT })).result.status, 'OK');
		return client;
	};


	it('is refused, and its IP banned, when its pool or worker nonce is no integer', async () => {
		const client = await proxy('127.0.0.13', 'proxy-nonces');
		const reply = await client.submit({ job_id: client.job.job_id, nonce: '00000001', result: WRONG_RESULT, extra: { poolNonce: '1', workerNonce: 2 } });
		assert.equal(reply.error.message, 'Duplicate share3');
		assert.equal((await client.getjob()).error.message, 'Your IP is banned');
	});


	it('is refused, and its IP banned, when it repeats a nonce, pool nonce and worker nonce', async () => {
		const client = await proxy('127.0.0.14', 'proxy-repeat');
		const share = { job_id: client.job.job_id, nonce: '00000002', result: WRONG_RESULT, extra: { poolNonce: 1, workerNonce: 1 } };
		assert.equal((await client.submit(share)).error.message, 'Rejected share: invalid result');
		assert.equal((await client.submit(share)).error.message, 'Duplicate share4');
		assert.equal((await client.keepalived()).error.message, 'Your IP is banned');
	});


	it('may repeat a nonce under another worker nonce', async () => {
		const client = await proxy('127.0.0.15', 'proxy-workers');
		const share = { job_id: client.job.job_id, nonce: '00000003', result: WRONG_RESULT, extra: { poolNonce: 1, workerNonce: 1 } };
		assert.equal((await client.submit(share)).error.message, 'Rejected share: invalid result');
		const again = { ...share, extra: { poolNonce: 1, workerNonce: 2 } };
		assert.equal((await client.submit(again)).error.message, 'Rejected share: invalid result');
	});


	it('is refused for a job the proxy never got', async () => {
		const client = await proxy('127.0.0.1', 'proxy-job');
		const reply = await client.submit({ job_id: '123456789012345', nonce: '00000004', result: WRONG_RESULT, extra: { poolNonce: 1, workerNonce: 1 } });
		assert.equal(reply.error.message, 'Invalid job id');
	});
});
