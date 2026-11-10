// -----------------------------------------------------------
//  [*] Tests — shares and blocks
//
//  What the pool does with a submitted share: the nonce must
//  be eight hex characters and new for its job, the result
//  must be the RandomX hash the pool gets from the job's blob
//  with that nonce under the job's seed, and the hash must
//  meet the job's difficulty. An accepted share adds its
//  difficulty to the miner's score in the current round and
//  to the hashrate records; one that also meets the
//  template's difficulty is submitted to the daemon as a
//  block, and once the daemon takes it, the round closes
//  under the block's height and the block waits as a
//  candidate for the unlocker.
//
//  The shares are really mined, on the difficulty-1 test
//  port; a nonce that is malformed or repeated bans the IP at
//  once, so those tests connect from addresses of their own
//  (127.0.0.5, 127.0.0.6), which leaves 127.0.0.1 unbanned.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const cnUtil = require('cryptoforknote-util');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { waitFor } = require('../support/wait.js');
const { NONCE_OFFSET } = require('../support/stratum.js');


// The world and its pool
let world;
let pool;

before(async () => {
	world = await World.create('shares');
	pool = await world.startPool({}, { cheapPort: true });
});

after(() => world.close());







// -----------------------------------------------------------
// loggedIn
// -----------------------------------------------------------
//
// A miner logged in on the test port with the given login and
// password, from 127.0.0.1 unless another address is named,
// holding a job for the current tip — after a block the pool
// may still hand out the template before it for a moment.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function loggedIn (login, pass = 'rig1', localAddress) {

	const miner = await world.stratum('cheap', { localAddress });
	const reply = await miner.login(login, pass);
	assert.equal(reply.result.status, 'OK');
	assert.ok(await miner.jobAtHeight(world.daemon.chain.tipHeight + 1), 'no job for the current tip');
	return miner;
}







// -----------------------------------------------------------
// findBlock
// -----------------------------------------------------------
//
// A block found elsewhere, then a template of difficulty 1 at
// the next height, so the miner's share there is a block;
// waits until the daemon has taken it. Returns the job, the
// share and the height of the block.
//
// Used by:
//   - the block tests (below)
// -----------------------------------------------------------

async function findBlock (miner) {

	const chain = world.daemon.chain;
	const height = chain.tipHeight + 2;
	chain.easyHeights.add(height);
	chain.mineElsewhere();
	const job = await miner.jobAtHeight(height);
	assert.ok(job, 'no job at the block\'s height');
	const share = miner.mine({ job });
	const reply = await miner.submit(share);
	assert.equal(reply.result.status, 'OK');
	await waitFor(() => chain.tipHeight === height, { what: 'the daemon to take the block', explain: () => pool.tail() });
	return { job, share, height };
}







// -----------------------------------------------------------
// Accepted shares
// -----------------------------------------------------------
//
// A share that holds, and the records it leaves in Redis.
// -----------------------------------------------------------

describe('a share mined for the job', () => {

	it('is accepted', async () => {
		const miner = await loggedIn(addresses.address('kate'));
		const reply = await miner.submit(miner.mine());
		assert.deepEqual(reply, { id: reply.id, jsonrpc: '2.0', error: null, result: { status: 'OK' } });
	});


	it('adds its difficulty to the round and to the miner\'s and the worker\'s records', async () => {
		const login = addresses.address('leo');
		const miner = await loggedIn(login, 'rig7');
		await miner.submit(miner.mine());
		await waitFor(() => world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login), { what: 'the score' });
		assert.equal(await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login), '1');
		assert.equal(await world.redis.call('hget', 'bitlitas:shares_actual:prop:roundCurrent', login), '1');
		const worker = await world.redis.call('hgetall', 'bitlitas:workers:' + login);
		assert.equal(worker.hashes, '1');
		assert.match(worker.lastShare, /^\d{10}$/);
		assert.equal((await world.redis.call('hgetall', 'bitlitas:unique_workers:' + login + '~rig7')).hashes, '1');
		const hashrate = (await world.redis.call('zrange', 'bitlitas:hashrate', 0, -1)).filter((entry) => entry.includes(login));
		assert.equal(hashrate.length, 2);
		assert.ok(hashrate.some((entry) => new RegExp('^1:' + login + ':\\d{13}:prop$').test(entry)));
		assert.ok(hashrate.some((entry) => new RegExp('^1:' + login + '~rig7:\\d{13}:prop$').test(entry)));
	});


	it('keeps the miner\'s records for 15 days from the last share', async () => {
		const login = addresses.address('mia');
		const miner = await loggedIn(login);
		await miner.submit(miner.mine());
		await waitFor(() => world.redis.call('exists', 'bitlitas:workers:' + login), { what: 'the record' });
		const ttl = await world.redis.call('ttl', 'bitlitas:workers:' + login);
		assert.ok(ttl > 15 * 86400 - 60 && ttl <= 15 * 86400, String(ttl));
	});


	it('with an empty password is credited to the miner alone, no worker recorded', async () => {
		const login = addresses.address('nina');
		const miner = await loggedIn(login, '');
		await miner.submit(miner.mine());
		await waitFor(() => world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', login), { what: 'the score' });
		const hashrate = (await world.redis.call('zrange', 'bitlitas:hashrate', 0, -1)).filter((entry) => entry.includes(login));
		assert.equal(hashrate.length, 1);
		assert.equal(hashrate[0].includes('~'), false);
		assert.deepEqual(await world.redis.call('keys', 'bitlitas:unique_workers:' + login + '*'), []);
	});
});







// -----------------------------------------------------------
// Refused shares
// -----------------------------------------------------------
//
// Each way a share can be wrong, and what the pool answers
// and does about it.
// -----------------------------------------------------------

describe('a share that is wrong', () => {

	it('is refused when its result is not the hash of the job', async () => {
		const miner = await loggedIn(addresses.address('oscar'));
		const share = { job_id: miner.job.job_id, nonce: '0000002a', result: crypto.randomBytes(32).toString('hex') };
		const reply = await miner.submit(share);
		assert.equal(reply.error.message, 'Rejected share: invalid result');
		await pool.waitForOutput('Bad hash from miner ' + addresses.address('oscar'));
	});


	it('is refused when it was hashed under another seed', async () => {
		const miner = await loggedIn(addresses.address('paul'));
		const share = miner.mine({ seedHash: crypto.createHash('sha256').update('another epoch').digest('hex') });
		const reply = await miner.submit(share);
		assert.equal(reply.error.message, 'Rejected share: invalid result');
	});


	it('is refused when its hash misses the job\'s difficulty', async () => {
		const miner = await loggedIn(addresses.address('quinn') + '.1000000');
		const reply = await miner.submit(miner.mine());
		assert.equal(reply.error.message, 'Rejected share: invalid result');
		await pool.waitForOutput('Rejected low difficulty share');
	});


	it('is refused as an attack when it lacks a nonce or a result', async () => {
		const miner = await loggedIn(addresses.address('rose'));
		assert.equal((await miner.submit({ job_id: miner.job.job_id, result: 'ab'.repeat(32) })).error.message, 'Attack detected');
		assert.equal((await miner.submit({ job_id: miner.job.job_id, nonce: '00000001' })).error.message, 'Attack detected');
	});


	it('is refused for a job the miner never got', async () => {
		const miner = await loggedIn(addresses.address('sam'));
		const reply = await miner.submit({ job_id: '123456789012345', nonce: '00000001', result: 'ab'.repeat(32) });
		assert.equal(reply.error.message, 'Invalid job id');
	});


	it('with a nonce that is not eight hex characters is refused and bans the IP at once', async () => {
		const miner = await loggedIn(addresses.address('tina'), 'rig1', '127.0.0.5');
		const reply = await miner.submit({ job_id: miner.job.job_id, nonce: 'xyz', result: 'ab'.repeat(32) });
		assert.equal(reply.error.message, 'Duplicate share1');
		assert.equal((await miner.getjob()).error.message, 'Your IP is banned');
		await pool.waitForOutput('Banned ' + addresses.address('tina') + '@::ffff:127.0.0.5');
	});


	it('sent twice is refused the second time, whatever the letter case, and bans the IP at once', async () => {
		const miner = await loggedIn(addresses.address('uma'), 'rig1', '127.0.0.6');
		const first = await miner.submit({ job_id: miner.job.job_id, nonce: 'abcdef01', result: 'ab'.repeat(32) });
		assert.equal(first.error.message, 'Rejected share: invalid result');
		const again = await miner.submit({ job_id: miner.job.job_id, nonce: 'ABCDEF01', result: 'ab'.repeat(32) });
		assert.equal(again.error.message, 'Duplicate share2');
		assert.equal((await miner.keepalived()).error.message, 'Your IP is banned');
	});
});







// -----------------------------------------------------------
// Blocks
// -----------------------------------------------------------
//
// A share at a template of difficulty 1, so it is a block:
// what the daemon gets, what Redis keeps, what miners see.
// -----------------------------------------------------------

describe('a share that meets the template\'s difficulty', () => {

	it('is submitted to the daemon as the block the miner hashed', async () => {
		const miner = await loggedIn(addresses.address('victor'));
		const { job, share } = await findBlock(miner);
		const submitted = Buffer.from(world.daemon.submitted[world.daemon.submitted.length - 1], 'hex');
		const hashed = Buffer.from(job.blob, 'hex');
		Buffer.from(share.nonce, 'hex').copy(hashed, NONCE_OFFSET);
		assert.equal(cnUtil.convert_blob(submitted, 0).toString('hex'), hashed.toString('hex'));
		assert.equal(cnUtil.get_block_id(submitted, 0).toString('hex'), world.daemon.chain.tipHash);
		await pool.waitForOutput('found at height ' + job.height + ' by miner ' + addresses.address('victor'));
	});


	it('becomes a candidate at its height, the round closed under that height', async () => {
		const login = addresses.address('wendy');
		const miner = await loggedIn(login);
		await miner.submit(miner.mine());
		const { height } = await findBlock(miner);
		const candidates = await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height).then((list) => list.length && list), { what: 'the candidate' });
		const [rewardType, finder, hash, time, difficulty, shares, score] = candidates[0].split(':');
		const roundScores = await world.redis.call('hgetall', 'bitlitas:scores:prop:round' + height);
		const roundShares = await world.redis.call('hgetall', 'bitlitas:shares_actual:prop:round' + height);
		assert.equal(rewardType, 'prop');
		assert.equal(finder, login);
		assert.equal(hash, world.daemon.chain.hashAt(height));
		assert.ok(Math.abs(Number(time) - Date.now() / 1000) < 60);
		assert.equal(difficulty, '1');
		assert.equal(roundScores[login], '2');
		assert.equal(Number(shares), Object.values(roundShares).reduce((sum, value) => sum + Number(value), 0));
		assert.equal(Number(score), Object.values(roundScores).reduce((sum, value) => sum + Number(value), 0));
		assert.equal(await world.redis.call('exists', 'bitlitas:scores:prop:roundCurrent'), 0);
		assert.match(await world.redis.call('hget', 'bitlitas:stats', 'lastBlockFoundprop'), /^\d{13}$/);
	});


	it('of a solo miner becomes a solo candidate', async () => {
		const login = addresses.address('xena');
		const miner = await loggedIn('solo:' + login);
		const { height } = await findBlock(miner);
		const candidates = await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height).then((list) => list.length && list), { what: 'the candidate' });
		assert.equal(candidates[0].split(':')[0], 'solo');
		assert.equal(candidates[0].split(':')[1], login);
		assert.equal(await world.redis.call('hget', 'bitlitas:scores:solo:round' + height, login), '1');
	});


	it('moves every miner on to the next height once the daemon took it', async () => {
		const miner = await loggedIn(addresses.address('yuri'));
		const watcher = await loggedIn(addresses.address('zoe'));
		const { height } = await findBlock(miner);
		assert.ok(await watcher.jobAtHeight(height + 1));
	});
});
