// -----------------------------------------------------------
//  [*] Tests — templates that are not quite what the pool asked
//
//  lib/pool.js does not trust the daemon's reserved_offset:
//  it searches the template for the extra-nonce tag, the
//  length 17 and 17 zero bytes it asked for, writes its extra
//  nonce and instance id there, and only logs an "INTERNAL
//  ERROR" when the daemon's offset says otherwise. A template
//  without those 17 bytes — a daemon that gave less reserve —
//  is mined at the daemon's offset. With daemon.alwaysPoll on,
//  the poller fetches a template on every round and every job
//  request makes a new job. The shares here are really mined
//  on the test port: what counts is that the pool checks them
//  against the bytes it handed out.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { sleep } = require('../support/wait.js');







// -----------------------------------------------------------
// Odd reserves
// -----------------------------------------------------------
//
// Each test has the fake daemon answer the next templates in
// one odd way, and moves the chain so the pool fetches one.
// -----------------------------------------------------------

describe('a template with an odd reserve', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('templates');
		pool = await world.startPool({ api: { enabled: false } }, { cheapPort: true });
	});

	after(() => world.close());


	it('whose reserved offset the daemon misreports is mined at the bytes the pool finds', async () => {
		const chain = world.daemon.chain;
		world.daemon.override('getblocktemplate', (params) => {
			const template = chain.template(params.reserve_size);
			return { result: { ...template, reserved_offset: template.reserved_offset + 5 } };
		});
		try {
			const miner = await world.stratum('cheap');
			await miner.login(addresses.address('odd-offset'));
			const mark = pool.mark();
			chain.mineElsewhere();
			const job = await miner.jobAtHeight(chain.tipHeight + 1);
			await pool.waitForOutput(/INTERNAL ERROR: found reserve offset in unexpected place \(found at (\d+), expected at \d+\)/, { from: mark });
			assert.equal((await miner.submit(miner.mine({ job }))).result.status, 'OK');
		} finally {
			delete world.daemon.overrides.getblocktemplate;
		}
	});


	it('without the 17 reserved bytes is mined at the offset the daemon gives', async () => {
		const chain = world.daemon.chain;
		world.daemon.override('getblocktemplate', () => ({ result: chain.template(8) }));
		try {
			const miner = await world.stratum('cheap');
			await miner.login(addresses.address('small-reserve'));
			const mark = pool.mark();
			chain.mineElsewhere();
			const job = await miner.jobAtHeight(chain.tipHeight + 1);
			await pool.waitForOutput('INTERNAL ERROR: Couldn\'t find extra nonce data in blob!', { from: mark });
			assert.equal((await miner.submit(miner.mine({ job }))).result.status, 'OK');
		} finally {
			delete world.daemon.overrides.getblocktemplate;
		}
	});
});







// -----------------------------------------------------------
// alwaysPoll
// -----------------------------------------------------------
//
// A pool told to fetch a template on every round, whether or
// not the tip moved.
// -----------------------------------------------------------

describe('a pool with alwaysPoll on', () => {

	let world;

	before(async () => {
		world = await World.create('templates-always');
		await world.startPool({ daemon: { alwaysPoll: true }, api: { enabled: false } });
	});

	after(() => world.close());


	it('asks for a template every round, though the tip stays', async () => {
		const before = world.daemon.callsOf('getblocktemplate').length;
		await sleep(3500);
		assert.ok(world.daemon.callsOf('getblocktemplate').length - before >= 3);
	});


	it('makes a new job for every job request, on the same template', async () => {
		const miner = await world.stratum(3333);
		await miner.login(addresses.address('always'));
		const first = (await miner.getjob()).result;
		const second = (await miner.getjob()).result;
		assert.notEqual(first.job_id, second.job_id);
		assert.notEqual(first.blob, second.blob);
		assert.equal(first.blob.slice(0, 78), second.blob.slice(0, 78));
	});


	it('pushes no job while the tip stays', async () => {
		const miner = await world.stratum(3333);
		await miner.login(addresses.address('always-quiet'));
		assert.equal(await miner.nextJob({ timeout: 3000 }), null);
	});
});
