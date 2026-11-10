// -----------------------------------------------------------
//  [*] Tests — templates in, jobs out
//
//  The daemon worker (lib/daemon.js) asks the daemon for its
//  last block header every blockRefreshInterval (a second in
//  the shipped file) and, when the tip has moved, for a new
//  template with the 17 bytes of reserve the pool writes its
//  extra nonce into, addressed to the pool wallet. The master
//  hands the template to every pool worker, which pushes a new
//  job to every miner. Each job carries the RandomX seed, and
//  the next one as soon as the daemon announces it. While the
//  daemon is away the miners keep the job they have.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const { REAL } = require('../support/addresses.js');
const { FORK_HEIGHTS, SEEDHASH_EPOCH_BLOCKS } = require('../support/chain.js');
const { sleep, waitFor } = require('../support/wait.js');


// The world and its pool, on a chain a few blocks before a
// RandomX epoch boundary, so the next seed gets announced.
// The API stays off: it reads the last block header too, and
// the poller's own calls are counted here.
let world;
let pool;

// The first multiple of 2048 past the fork-12 height
const BOUNDARY = Math.ceil(FORK_HEIGHTS[12] / SEEDHASH_EPOCH_BLOCKS + 1) * SEEDHASH_EPOCH_BLOCKS;

before(async () => {
	world = await World.create('jobs', { chain: { major: 12, height: BOUNDARY - 3 } });
	pool = await world.startPool({ api: { enabled: false } });
});

after(() => world.close());







// -----------------------------------------------------------
// mineUntilTemplateHeight
// -----------------------------------------------------------
//
// Moves the chain in one step to where the next template is
// for the given height, and waits for the miner's new job.
//
// Used by:
//   - the seed tests (below)
// -----------------------------------------------------------

async function mineUntilTemplateHeight (miner, height) {

	const missing = height - (world.daemon.chain.tipHeight + 1);
	if (missing <= 0) return miner.job;
	world.daemon.chain.mineElsewhere(missing);
	return miner.nextJob();
}







// -----------------------------------------------------------
// Asking the daemon
// -----------------------------------------------------------
//
// What the poller asks the daemon for, and how often.
// -----------------------------------------------------------

describe('the template poller', () => {

	it('asks for a template with 17 bytes of reserve, for the pool\'s wallet', () => {
		const asked = world.daemon.callsOf('getblocktemplate')[0].params;
		assert.deepEqual(asked, { reserve_size: 17, wallet_address: REAL.pool });
	});


	it('asks for the last block header every second and for a template only when the tip moves', async () => {
		const headersBefore = world.daemon.callsOf('getlastblockheader').length;
		const templatesBefore = world.daemon.callsOf('getblocktemplate').length;
		await sleep(3500);
		const headers = world.daemon.callsOf('getlastblockheader').length - headersBefore;
		assert.ok(headers >= 3 && headers <= 4, headers + ' header calls');
		assert.equal(world.daemon.callsOf('getblocktemplate').length, templatesBefore);
	});
});







// -----------------------------------------------------------
// New blocks
// -----------------------------------------------------------
//
// A new tip on the chain, and the new job every miner gets
// for it.
// -----------------------------------------------------------

describe('a block found elsewhere', () => {

	it('brings every connected miner a new job for the next height', async () => {
		const miners = [await world.stratum(3333), await world.stratum(5555)];
		for (const miner of miners) await miner.login(REAL.miner);
		const before = miners.map((miner) => miner.job);
		world.daemon.chain.mineElsewhere();
		const jobs = await Promise.all(miners.map((miner) => miner.nextJob()));
		for (let i = 0; i < miners.length; i++) {
			assert.ok(jobs[i], 'no job pushed');
			assert.equal(jobs[i].height, before[i].height + 1);
			assert.notEqual(jobs[i].job_id, before[i].job_id);
			assert.notEqual(jobs[i].blob.slice(14, 78), before[i].blob.slice(14, 78));
		}
	});


	it('leaves the new job to a getjob as well', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		world.daemon.chain.mineElsewhere();
		await miner.nextJob();
		const reply = await miner.getjob();
		assert.equal(reply.result.job_id, miner.job.job_id);
	});


	it('changes the job\'s previous-block hash to the new tip', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const tip = world.daemon.chain.mineElsewhere();
		const job = await miner.nextJob();
		assert.equal(job.blob.slice(14, 78), tip);
	});
});







// -----------------------------------------------------------
// Seeds
// -----------------------------------------------------------
//
// The chain starts three blocks below a multiple of 2048, so
// within the test the template's height enters the lag in
// which the daemon names the next seed, then passes the point
// where that seed takes over.
// -----------------------------------------------------------

describe('the RandomX seed in a job', () => {

	it('is the template\'s, and the next seed is passed on once announced', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const job = await mineUntilTemplateHeight(miner, BOUNDARY + 1);
		const template = world.daemon.chain.template();
		assert.notEqual(template.next_seed_hash, '');
		assert.equal(job.seed_hash, template.seed_hash);
		assert.equal(job.next_seed_hash, template.next_seed_hash);
	});


	it('turns into the announced one when the lag has passed', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		await mineUntilTemplateHeight(miner, BOUNDARY + 1);
		const announced = world.daemon.chain.template().next_seed_hash;
		const job = await mineUntilTemplateHeight(miner, BOUNDARY + 65);
		assert.equal(job.seed_hash, announced);
		assert.equal(job.next_seed_hash, '');
	});
});







// -----------------------------------------------------------
// The daemon away
// -----------------------------------------------------------
//
// A daemon stopped, answering garbage or answering errors,
// and the pool picking up again after it.
// -----------------------------------------------------------

describe('a daemon that is away', () => {

	it('leaves the miners their job, and the next block arrives once it is back', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const job = miner.job;
		const mark = pool.mark();
		await world.daemon.stop();
		await pool.waitForOutput('bitlitas error from daemon', { from: mark });
		assert.equal((await miner.getjob()).result.job_id, job.job_id);
		world.daemon.chain.mineElsewhere();
		await world.daemon.start();
		const next = await miner.nextJob();
		assert.equal(next.height, job.height + 1);
	});


	it('that answers garbage is retried, and its next good answer is used', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const mark = pool.mark();
		world.daemon.mode = 'garbage';
		await pool.waitForOutput('bitlitas error from daemon', { from: mark });
		world.daemon.chain.mineElsewhere();
		world.daemon.mode = 'ok';
		assert.ok(await miner.nextJob());
	});


	it('that answers with errors is reported as a bad response and retried', async () => {
		const miner = await world.stratum(3333);
		await miner.login(REAL.miner);
		const mark = pool.mark();
		world.daemon.mode = 'error';
		await pool.waitForOutput('bad reponse from daemon', { from: mark });
		world.daemon.chain.mineElsewhere();
		world.daemon.mode = 'ok';
		assert.ok(await miner.nextJob());
	});
});







// -----------------------------------------------------------
// Fork 16
// -----------------------------------------------------------
//
// A chain past Bitlitas's last fork, where block version
// 16 and view-tagged outputs take over.
// -----------------------------------------------------------

describe('a chain past fork 16', () => {

	it('gives jobs of block version 16, which miners log in to as before', async () => {
		const forked = await World.create('jobs-v16', { chain: { major: 16 } });
		try {
			await forked.startPool();
			const miner = await forked.stratum(3333);
			const reply = await miner.login(REAL.miner);
			assert.equal(reply.result.job.blob.slice(0, 4), '1010');
			assert.equal(reply.result.job.height, forked.daemon.chain.tipHeight + 1);
			await waitFor(() => forked.daemon.callsOf('getblocktemplate').length > 0, { what: 'a template call' });
		} finally {
			await forked.close();
		}
	});
});
