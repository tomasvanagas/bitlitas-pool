// -----------------------------------------------------------
//  [*] Tests — pinned defects of the stratum side
//
//  Defects in what miners meet — logins, jobs, shares, blocks
//  — each test stating what the pool should do; pinDefect
//  keeps the run green while the defect lives and fails once
//  it is gone (tests/README.md, "Pinned defects"). Several
//  matter more for Bitlitas than for a busy coin: while the
//  pool is the network's only miner, a pool that stops
//  getting templates, or mines on a stale one, holds up the
//  chain itself.
// -----------------------------------------------------------

const { describe, before, after } = require('node:test');
const assert = require('node:assert');
const cnHashing = require('cryptonight-hashing');
const cnUtil = require('cryptoforknote-util');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { targetHex } = require('../support/stratum.js');
const regtest = require('../fixtures/bitlitasd-regtest.json');
const { waitFor, sleep } = require('../support/wait.js');
const { pinDefect } = require('../support/defects.js');


// The real wallet's addresses
const { REAL } = addresses;







// -----------------------------------------------------------
// Logins
// -----------------------------------------------------------
//
// Logins the pool turns down, lets in, or leaves
// unanswered, though it should not.
// -----------------------------------------------------------

describe('logins', () => {

	let world;

	before(async () => {
		world = await World.create('stratum-defects-logins');
		await world.startPool();
	});

	after(() => world.close());


	pinDefect('subaddress-refused', 'take a Bitlitas subaddress', async () => {
		// The shipped file names no subAddressPrefix; Bitlitas's is 42
		const miner = await world.stratum(3333);
		const reply = await miner.login(REAL.subaddress);
		assert.equal(reply.error, null, reply.error && reply.error.message);
	});


	pinDefect('login-without-password-unanswered', 'answer a login that carries no password', async () => {
		const miner = await world.stratum(3333);
		const reply = await miner.request('login', { login: REAL.miner, agent: 'test' }, { timeout: 5000 });
		assert.ok(reply, 'the login was never answered');
	});


	pinDefect('standalone-payment-id-accepted', 'refuse a payment id the Bitlitas wallet can no longer pay to', async () => {
		// bitlitas-wallet-rpc v0.18 refuses every transfer with a
		// standalone payment id; the pool credits such a login anyway
		assert.match(regtest.wallet.transfer_payment_id.error.message, /Standalone payment IDs are obsolete/);
		const miner = await world.stratum(3333);
		const reply = await miner.login(REAL.miner + '.' + 'cd'.repeat(32));
		assert.notEqual(reply.result && reply.result.status, 'OK');
	});


	pinDefect('fixed-difficulty-not-capped', 'cap a fixed difficulty at the vardiff maximum, as it raises one to the minimum', async () => {
		const miner = await world.stratum(3333);
		const reply = await miner.login(REAL.miner + '.99999999999');
		assert.equal(reply.result.job.target, targetHex(1e8));
	});


	pinDefect('proxy-job-missing-pool-offset', 'tell xmr-node-proxy where its pool nonce goes', async () => {
		const miner = await world.stratum(3333);
		const reply = await miner.login(REAL.miner, 'proxy', { agent: 'xmr-node-proxy/0.15.0' });
		const job = reply.result.job;
		assert.equal(job.client_pool_offset, job.reserved_offset + 8);
	});
});







// -----------------------------------------------------------
// Templates
// -----------------------------------------------------------
//
// Ways the pool ends up mining a stale template; the API
// is off, so only the poller asks the daemon.
// -----------------------------------------------------------

describe('templates', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('stratum-defects-templates');
		pool = await world.startPool({ api: { enabled: false } });
	});

	after(() => world.close());


	pinDefect('template-fetch-not-retried', 'fetch the template again when the first fetch for a new tip failed', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const asked = world.daemon.callsOf('getblocktemplate').length;
		world.daemon.override('getblocktemplate', { error: { code: -9, message: 'Core is busy' } });
		world.daemon.chain.mineElsewhere();
		await waitFor(() => world.daemon.callsOf('getblocktemplate').length > asked, { what: 'the failed fetch' });
		delete world.daemon.overrides.getblocktemplate;
		const job = await miner.nextJob({ timeout: 6000 });
		assert.ok(job, 'the pool kept the miner on the stale template');
	});


	pinDefect('same-height-template-keeps-old-job', 'give miners a new job when the tip is replaced at the same height', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		world.daemon.chain.mineElsewhere();
		const before = await miner.nextJob();
		assert.ok(before, 'no job for the current tip');
		const mark = pool.mark();
		const pushed = miner.nextJob({ timeout: 8000 });
		const tip = world.daemon.chain.replaceTip();
		await pool.waitForOutput('New bitlitas block to mine at height ' + before.height, { from: mark });
		const job = await pushed;
		assert.ok(job, 'no job pushed');
		assert.notEqual(job.job_id, before.job_id, 'the pool pushed the job it had cached for the replaced block again');
		assert.equal(job.blob.slice(14, 78), tip);
	});


	pinDefect('unparsable-template-replaces-good-one', 'keep serving the last good template when the daemon hands out one that does not parse', async () => {
		const chain = world.daemon.chain;
		const watcher = await world.stratum(3333);
		await watcher.login(REAL.miner);
		const size = chain.template().blocktemplate_blob.length / 2;
		world.daemon.override('getblocktemplate', () => ({ result: { ...chain.template(), blocktemplate_blob: 'ff'.repeat(size) } }));
		const mark = pool.mark();
		try {
			chain.mineElsewhere();
			await pool.waitForOutput(/BlockTemplate Error/, { from: mark });
			const miner = await world.stratum(3333);
			const reply = await miner.login(REAL.miner, 'x', { timeout: 5000 });
			assert.ok(reply, 'the broken template took the good one\'s place, and no login is answered');
		} finally {
			delete world.daemon.overrides.getblocktemplate;
			const recovered = pool.mark();
			chain.mineElsewhere();
			await pool.waitForOutput(/New bitlitas block to mine at height/, { from: recovered });
		}
	});


	pinDefect('daemon-hang-stalls-templates', 'keep polling a daemon that left one request unanswered', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const polled = world.daemon.callsOf('getlastblockheader').length;
		world.daemon.mode = 'hang';
		await waitFor(() => world.daemon.callsOf('getlastblockheader').length > polled, { what: 'a request to hang' });
		world.daemon.mode = 'ok';
		world.daemon.chain.mineElsewhere();
		const job = await miner.nextJob({ timeout: 8000 });
		assert.ok(job, 'the poller waits for the hung request for ever');
	});
});







// -----------------------------------------------------------
// A respawned pool worker
// -----------------------------------------------------------
//
// A pool worker with no template: one forked again after a
// crash, and one that started before the daemon answered.
// -----------------------------------------------------------

describe('a pool worker that died', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('stratum-defects-respawn');
		pool = await world.startPool({ api: { enabled: false } });
	});

	after(() => world.close());


	pinDefect('respawned-worker-has-no-template', 'serve the current template again once the master has replaced it', async () => {
		const [worker] = pool.workers('pool');
		const mark = pool.mark();
		process.kill(worker, 'SIGKILL');
		await pool.waitForOutput('Pool fork 1 died, spawning replacement worker...', { from: mark });
		await pool.waitForOutput('Started server listening on port ' + world.port(3333) + '\n', { from: mark });
		const miner = await world.stratum(3333);
		const reply = await miner.login(REAL.miner, 'x', { timeout: 5000 });
		assert.ok(reply, 'the new worker has no template until the next block, and answers no login');
	});


	pinDefect('login-before-template-unanswered', 'answer a login that arrives before the pool has a template', async () => {
		const quiet = await World.create('stratum-defects-no-template');
		try {
			quiet.daemon.mode = 'error';
			await quiet.startPool({ api: { enabled: false } });
			const miner = await quiet.stratum(3333);
			const reply = await miner.login(REAL.miner, 'x', { timeout: 5000 });
			assert.ok(reply, 'the login was never answered');
		} finally {
			await quiet.close();
		}
	});
});







// -----------------------------------------------------------
// Shares and blocks
// -----------------------------------------------------------
//
// Shares the pool checks against the wrong template or
// does not credit, and the round a solo block takes away.
// -----------------------------------------------------------

describe('shares and blocks', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('stratum-defects-shares');
		pool = await world.startPool({ api: { enabled: false } }, { cheapPort: true });
	});

	after(() => world.close());


	pinDefect('stale-share-against-new-template', 'take a share mined for the job of the block before', async () => {
		const miner = await world.stratum('cheap');
		await miner.login(addresses.address('stale'));
		const share = miner.mine();
		world.daemon.chain.mineElsewhere();
		assert.ok(await miner.jobAtHeight(world.daemon.chain.tipHeight + 1), 'no new job');
		const reply = await miner.submit(share);
		assert.equal(reply.result && reply.result.status, 'OK', reply.error && reply.error.message);
	});


	pinDefect('refused-block-share-not-credited', 'credit a share whose block the daemon refused, as the share it still is', async () => {
		const login = addresses.address('refused');
		const chain = world.daemon.chain;
		const miner = await world.stratum('cheap');
		await miner.login(login);
		world.daemon.override('submitblock', { error: { code: -7, message: 'Block not accepted' } });
		const height = chain.tipHeight + 2;
		chain.easyHeights.add(height);
		chain.mineElsewhere();
		const job = await miner.jobAtHeight(height);
		const mark = pool.mark();
		assert.equal((await miner.submit(miner.mine({ job }))).result.status, 'OK');
		await pool.waitForOutput('Error submitting block at height ' + height, { from: mark });
		delete world.daemon.overrides.submitblock;
		await sleep(500);
		assert.equal(await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login), '1');
	});


	pinDefect('solo-block-closes-shared-round', 'leave the shared round open when a solo miner finds a block', async () => {
		const shared = addresses.address('shared-miner');
		const chain = world.daemon.chain;
		const sharer = await world.stratum('cheap');
		await sharer.login(shared);
		chain.mineElsewhere();
		const ordinary = await sharer.jobAtHeight(chain.tipHeight + 1);
		assert.equal((await sharer.submit(sharer.mine({ job: ordinary }))).result.status, 'OK');
		await waitFor(() => world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', shared), { what: 'the shared score' });
		const soloist = await world.stratum('cheap');
		await soloist.login('solo:' + addresses.address('solo-miner'));
		const height = chain.tipHeight + 2;
		chain.easyHeights.add(height);
		chain.mineElsewhere();
		const job = await soloist.jobAtHeight(height);
		assert.equal((await soloist.submit(soloist.mine({ job }))).result.status, 'OK');
		await waitFor(() => chain.tipHeight === height, { what: 'the solo block' });
		await waitFor(() => world.redis.call('zcard', 'bitlitas:blocks:candidates'), { what: 'the candidate' });
		assert.equal(await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', shared), '1', 'the shared miners\' round went into the solo block\'s round and is deleted when it unlocks');
	});
});







// -----------------------------------------------------------
// Slush mining
// -----------------------------------------------------------
//
// The scoring that weighs newer shares more, switched on as
// the shipped file describes it (a weight of 300).
// -----------------------------------------------------------

describe('slush mining', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('stratum-defects-slush');
		pool = await world.startPool({ poolServer: { slushMining: { enabled: true } }, api: { enabled: false } }, { cheapPort: true });
	});

	after(() => world.close());


	pinDefect('slush-mining-scores-nothing', 'score a share in the round the unlocker pays from', async () => {
		const login = addresses.address('slush');
		const miner = await world.stratum('cheap');
		await miner.login(login);
		assert.equal((await miner.submit(miner.mine())).result.status, 'OK');
		await pool.waitForOutput('Accepted valid share');
		await sleep(500);
		const legacy = await world.redis.call('hget', 'bitlitas:scores:roundCurrent', login);
		const score = await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login);
		assert.ok(Number(score) > 0, 'scores:prop:roundCurrent holds ' + score + ', the slush script\'s own key ' + legacy);
	});
});







// -----------------------------------------------------------
// xmr-node-proxy
// -----------------------------------------------------------
//
// A proxy share built the way xmr-node-proxy builds one: its
// pool nonce eight bytes into the reserve, its worker nonce at
// the job's client_nonce_offset.
// -----------------------------------------------------------

describe('xmr-node-proxy', () => {

	let world;

	before(async () => {
		world = await World.create('stratum-defects-proxy');
		await world.startPool({ api: { enabled: false } }, { cheapPort: true });
	});

	after(() => world.close());


	pinDefect('proxy-share-pool-nonce-misplaced', 'take a share xmr-node-proxy built at the offsets of its job', async () => {
		const client = await world.stratum('cheap');
		await client.login(REAL.miner, 'proxy', { agent: 'xmr-node-proxy/0.15.0' });
		const job = client.job;
		const template = Buffer.from(job.blocktemplate_blob, 'hex');
		template.writeUInt32BE(7, job.reserved_offset + 8);
		template.writeUInt32BE(9, job.client_nonce_offset);
		const block = cnUtil.construct_block_blob(template, Buffer.from('00000001', 'hex'), 0);
		const hash = cnHashing.randomx(cnUtil.convert_blob(block, 0), Buffer.from(job.seed_hash, 'hex'), 0);
		const reply = await client.submit({ job_id: job.job_id, nonce: '00000001', result: hash.toString('hex'), extra: { poolNonce: 7, workerNonce: 9 } });
		assert.equal(reply.result && reply.result.status, 'OK', 'the pool wrote the pool nonce at byte 0 of the block: ' + (reply.error && reply.error.message));
	});
});







// -----------------------------------------------------------
// The "+" payment-id separator
// -----------------------------------------------------------
//
// Upstream's separator, under which a short payment id
// reaches its own refusal; validation stays off as shipped.
// -----------------------------------------------------------

describe('the "+" payment-id separator', () => {

	let world;

	before(async () => {
		world = await World.create('stratum-defects-plus');
		await world.startPool({ poolServer: { paymentId: { addressSeparator: '+' } }, api: { enabled: false } });
	});

	after(() => world.close());


	pinDefect('short-payment-id-refusal-names-undefined', 'refuse a short payment id naming the miner\'s IP, and claim no ban it did not make', async () => {
		const miner = await world.stratum(3333, { localAddress: '127.0.0.18' });
		const reply = await miner.login(addresses.address('plus-short') + '+abc');
		const message = reply.error.message;
		assert.equal((await miner.login(addresses.address('plus-short'))).result.status, 'OK');
		assert.doesNotMatch(message, /undefined|banned/, 'the refusal reads "' + message + '"');
	});
});
