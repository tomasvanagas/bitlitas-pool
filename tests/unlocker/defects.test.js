// -----------------------------------------------------------
//  [*] Tests — pinned defects of the block unlocker
//
//  Each test states what the unlocker should do; pinDefect
//  keeps the run green while the defect lives and fails once
//  it is gone (tests/README.md, "Pinned defects"). The solo
//  block that takes the shared round with it is pinned where
//  it starts, in tests/stratum/defects.test.js: the pool
//  closes the shared round under the solo block's height,
//  and the unlocker deletes that round when the solo block
//  matures.
// -----------------------------------------------------------

const { describe, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { seedCandidate, settled } = require('../support/rounds.js');
const { sleep } = require('../support/wait.js');
const { pinDefect } = require('../support/defects.js');







// -----------------------------------------------------------
// Orphans and broken replies
// -----------------------------------------------------------
//
// An orphaned round, and a daemon reply with no header in
// it.
// -----------------------------------------------------------

describe('the block unlocker', () => {

	let world;
	let pool;

	before(async () => {
		world = await World.create('unlocker-defects');
		pool = await world.startPool({ blockUnlocker: { interval: 1 } }, { module: 'unlocker' });
	});

	after(() => world.close());


	pinDefect('orphan-shares-to-unread-key', 'give an orphaned round\'s shares back to the current shared round', async () => {
		const height = world.daemon.chain.tipHeight - 100;
		const miner = addresses.address('unlucky');
		await seedCandidate(world, { height, finder: miner, scores: { [miner]: 4000 }, orphan: true });
		await settled(world, height);
		const misplaced = await world.redis.call('hget', 'bitlitas:scores:roundCurrent', miner);
		assert.equal(await world.redis.call('hget', 'bitlitas:scores:prop:roundCurrent', miner), '4000', 'the shares went to bitlitas:scores:roundCurrent (' + misplaced + '), which no round ever reads');
	});


	pinDefect('empty-daemon-reply-crashes-unlocker', 'keep running when the daemon answers a header request with an empty reply', async () => {
		const height = world.daemon.chain.tipHeight - 101;
		const miner = addresses.address('empty-reply');
		world.daemon.override('getblockheaderbyheight', {});
		const mark = pool.mark();
		await seedCandidate(world, { height, finder: miner, scores: { [miner]: 1 } });
		await sleep(3000);
		delete world.daemon.overrides.getblockheaderbyheight;
		assert.equal(pool.count('Block unlocker died, spawning replacement...', mark), 0, 'the unlocker crashed on reading the reply\'s block_header');
	});
});
