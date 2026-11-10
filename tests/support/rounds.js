// -----------------------------------------------------------
//  [*] Test support — found blocks and balances in Redis
//
//  The unlocker, the payment run and the API start from what
//  the pool has written into Redis by the time a block is
//  found, matured and paid. These builders write that state
//  directly, in the shapes the pool writes it
//  (tests/stratum/shares.test.js holds the pool to them), so a
//  suite of those modules can start from any moment of a
//  block's life without mining it.
//
//  Used by:
//    - the unlocker, payment and API suites
// -----------------------------------------------------------

const { madeUpHash } = require('./chain.js');
const { waitFor } = require('./wait.js');







// -----------------------------------------------------------
// seedCandidate
// -----------------------------------------------------------
//
// A found block as lib/pool.js leaves it: the candidate entry
// at its height (reward type, finder, hash, time, difficulty,
// the round's shares and score) and the round's scores and
// shares, closed under that height. The fake chain gets the
// block at that height — or, for an orphan, another block.
// Returns the candidate's text.
//
// Used by:
//   - the unlocker suites, the API suites
// -----------------------------------------------------------

async function seedCandidate (world, { height, finder, rewardType = 'prop', scores = {}, orphan = false, difficulty = 1000000, time }) {

	const hash = madeUpHash('candidate:' + height + ':' + finder);
	const total = Object.values(scores).reduce((sum, score) => sum + score, 0);
	const at = time || Math.floor(Date.now() / 1000) - 7200;
	const member = [rewardType, finder, hash, at, difficulty, total, total].join(':');
	await world.redis.call('zadd', 'bitlitas:blocks:candidates', height, member);
	for (const [miner, score] of Object.entries(scores)) {
		await world.redis.call('hset', 'bitlitas:scores:' + rewardType + ':round' + height, miner, score);
		await world.redis.call('hset', 'bitlitas:shares_actual:' + rewardType + ':round' + height, miner, score);
	}
	const chain = world.daemon.chain;
	chain.blocks.set(height, { hash: orphan ? madeUpHash('someone else:' + height) : hash, timestamp: at, reward: chain.reward, difficulty, nonce: 0 });
	return member;
}







// -----------------------------------------------------------
// seedMatured
// -----------------------------------------------------------
//
// A block as the unlocker leaves it in blocks:matured: the
// candidate's fields, the orphan flag, and for a matured block
// its reward. Returns the entry's text.
//
// Used by:
//   - the API suites
// -----------------------------------------------------------

async function seedMatured (world, { height, finder, rewardType = 'prop', orphan = false, reward = 35168236092881, difficulty = 1000000, shares = 900000, time }) {

	const at = time || Math.floor(Date.now() / 1000) - 3600;
	const fields = [rewardType, finder, madeUpHash('matured:' + height), at, difficulty, shares, orphan ? 1 : 0];
	if (!orphan) fields.push(reward);
	const member = fields.join(':');
	await world.redis.call('zadd', 'bitlitas:blocks:matured', height, member);
	return member;
}







// -----------------------------------------------------------
// settled
// -----------------------------------------------------------
//
// The matured entry of a height once the unlocker has written
// it, split into its fields.
//
// Used by:
//   - the unlocker suites
// -----------------------------------------------------------

async function settled (world, height, explain) {

	const entries = await waitFor(async () => {
		const found = await world.redis.call('zrangebyscore', 'bitlitas:blocks:matured', height, height);
		return found.length && found;
	}, { what: 'the block at ' + height + ' to settle', explain });
	return entries[0].split(':');
}







// -----------------------------------------------------------
// balance
// -----------------------------------------------------------
//
// A miner's credited balance in atomic units, 0 when it has
// none.
//
// Used by:
//   - the unlocker and payment suites
// -----------------------------------------------------------

async function balance (world, miner) {

	return Number(await world.redis.call('hget', 'bitlitas:workers:' + miner, 'balance') || 0);
}







// What the suites take from here
module.exports = { seedCandidate, seedMatured, settled, balance };
