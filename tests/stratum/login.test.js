// -----------------------------------------------------------
//  [*] Tests — logging a miner in
//
//  What a login takes and what it hands back under the
//  shipped configuration. The login is an address, optionally
//  behind "solo:" or "prop:", optionally followed by
//  ".difficulty" (fixedDiff) or ".paymentid" — the shipped
//  file uses "." for both, so a suffix shorter than 31
//  characters is read as a difficulty and anything longer as
//  a payment id. The password is the worker name. An accepted
//  login gets a miner id and its first job: the template's
//  hashing blob with the pool's extra nonce in it, the target
//  of the port's difficulty, the height and the RandomX seed.
//  xmr-node-proxy logs in for its own miners and gets the
//  whole template instead.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const addresses = require('../support/addresses.js');
const { targetHex } = require('../support/stratum.js');
const { waitFor } = require('../support/wait.js');


// The real wallet's addresses
const { REAL } = addresses;

// A payment id of 64 characters
const PAYMENT_ID = 'ab'.repeat(32);

// The world and its pool
let world;
let pool;

before(async () => {
	world = await World.create('login');
	pool = await world.startPool();
});

after(() => world.close());







// -----------------------------------------------------------
// login
// -----------------------------------------------------------
//
// One fresh connection logging in on a shipped port, with the
// reply.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function login (text, pass = 'x', { port = 3333, agent } = {}) {

	const miner = await world.stratum(port);
	const reply = await miner.login(text, pass, agent ? { agent } : {});
	return { miner, reply };
}







// -----------------------------------------------------------
// recorded
// -----------------------------------------------------------
//
// A Redis reply once it holds something: the pool records a
// login just after it answers it.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function recorded (command, ...args) {

	return waitFor(async () => {
		const reply = await world.redis.call(command, ...args);
		return (Array.isArray(reply) ? reply.length : reply) && reply;
	}, { what: command + ' ' + args.join(' ') });
}







// -----------------------------------------------------------
// Addresses
// -----------------------------------------------------------
//
// Which addresses a login may carry, and what an accepted
// one gets back.
// -----------------------------------------------------------

describe('a login\'s address', () => {

	it('may be the real wallet\'s address, answered with a miner id, a job and OK', async () => {
		const { reply } = await login(REAL.miner);
		const template = world.daemon.chain.template();
		assert.equal(reply.error, null);
		assert.equal(reply.result.status, 'OK');
		assert.match(reply.result.id, /^\d{15}$/);
		assert.equal(reply.result.job.id, reply.result.id);
		assert.match(reply.result.job.job_id, /^\d{15}$/);
		assert.equal(reply.result.job.height, template.height);
		assert.equal(reply.result.job.seed_hash, template.seed_hash);
		assert.equal(reply.result.job.next_seed_hash, template.next_seed_hash);
	});


	it('gets the template\'s header to hash, the pool\'s extra nonce changing the merkle root', async () => {
		const { reply } = await login(REAL.miner);
		const job = Buffer.from(reply.result.job.blob, 'hex');
		const template = Buffer.from(world.daemon.chain.template().blockhashing_blob, 'hex');
		assert.equal(job.length, template.length);
		assert.equal(job.subarray(0, 43).toString('hex'), template.subarray(0, 43).toString('hex'));
		assert.notEqual(job.subarray(43, 75).toString('hex'), template.subarray(43, 75).toString('hex'));
	});


	it('gets a job of its own, every miner another extra nonce', async () => {
		const first = await login(REAL.miner);
		const second = await login(REAL.miner);
		assert.notEqual(first.reply.result.job.blob, second.reply.result.job.blob);
	});


	it('may be an integrated address', async () => {
		const { reply } = await login(REAL.integrated);
		assert.equal(reply.result.status, 'OK');
	});


	it('may be any well-formed Bitlitas address', async () => {
		const { reply } = await login(addresses.address('dave'));
		assert.equal(reply.result.status, 'OK');
	});


	it('is refused with its last characters mistyped', async () => {
		const { reply } = await login(addresses.withBadChecksum(REAL.miner));
		assert.equal(reply.error.message, 'Invalid address used for login');
	});


	it('is refused when it belongs to the Bitlitas testnet', async () => {
		const decoded = addresses.decodeAddress(REAL.miner);
		const { reply } = await login(addresses.makeAddress(53, decoded.spendKey, decoded.viewKey));
		assert.equal(reply.error.message, 'Invalid address used for login');
	});


	it('is refused when it is no address, or has a space in front', async () => {
		assert.equal((await login('BitlitasMiner')).reply.error.message, 'Invalid address used for login');
		assert.equal((await login(' ' + REAL.miner)).reply.error.message, 'Invalid address used for login');
	});


	it('is refused when it is missing or empty', async () => {
		const miner = await world.stratum(3333);
		assert.equal((await miner.request('login', { pass: 'x' })).error.message, 'Missing login');
		assert.equal((await miner.request('login', { login: '', pass: 'x' })).error.message, 'Missing login');
	});


	it('is refused when only a difficulty is left of it', async () => {
		const { reply } = await login('.5000');
		assert.equal(reply.error.message, 'Invalid address used for login');
	});
});







// -----------------------------------------------------------
// What a login records
// -----------------------------------------------------------
//
// The Redis records an accepted login leaves, which the
// notifications and the API read.
// -----------------------------------------------------------

describe('an accepted login', () => {

	it('counts the worker as connected under the address and the password', async () => {
		await login(addresses.address('erin'), 'rig1');
		assert.equal(await recorded('hget', 'bitlitas:active_connections', addresses.address('erin') + '~rig1'), '1');
	});


	it('takes the whole password as the worker name, an "@" in it included', async () => {
		await login(addresses.address('erin'), 'rig@farm');
		assert.equal(await recorded('hget', 'bitlitas:active_connections', addresses.address('erin') + '~rig@farm'), '1');
	});


	it('mines solo behind "solo:", counted apart, the prefix not part of the address', async () => {
		const { reply } = await login('solo:' + addresses.address('frank'), 'solo-rig');
		assert.equal(reply.result.status, 'OK');
		assert.equal(await recorded('hget', 'bitlitas:active_connections:solo', addresses.address('frank') + '~solo-rig'), '1');
	});


	it('keeps the miner\'s IP for the address and counts a user on the port', async () => {
		await login(addresses.address('grace'));
		assert.deepEqual(await recorded('smembers', 'bitlitas:workers_ip:' + addresses.address('grace')), ['::ffff:127.0.0.1']);
		assert.ok(Number(await recorded('hget', 'bitlitas:ports:' + world.port(3333), 'users')) >= 1);
	});
});







// -----------------------------------------------------------
// Difficulty
// -----------------------------------------------------------
//
// The share difficulty a login starts at: its port's, or
// the one it fixes itself.
// -----------------------------------------------------------

describe('the difficulty a login gets', () => {

	it('is its port\'s, as each shipped port describes it — the hidden one included', async () => {
		for (const [port, difficulty] of [[3333, 5000], [4444, 15000], [5555, 25000], [7777, 500000], [8888, 25000]]) {
			const { reply } = await login(REAL.miner, 'x', { port });
			assert.equal(reply.result.job.target, targetHex(difficulty), 'port ' + port);
		}
	});


	it('is fixed by a ".difficulty" behind the address', async () => {
		const { reply } = await login(REAL.miner + '.20000');
		assert.equal(reply.result.job.target, targetHex(20000));
	});


	it('is raised to the vardiff minimum of 100 when the fixed one is lower', async () => {
		const { reply } = await login(REAL.miner + '.10');
		assert.equal(reply.result.job.target, targetHex(100));
	});


	it('stays the port\'s when the suffix is no number, the suffix dropped from the login', async () => {
		const { reply } = await login(addresses.address('heidi') + '.fast');
		assert.equal(reply.result.job.target, targetHex(5000));
		assert.equal(await recorded('hget', 'bitlitas:active_connections', addresses.address('heidi') + '~x'), '1');
	});


	it('cannot be named twice', async () => {
		const { reply } = await login(REAL.miner + '.5000.6000');
		assert.equal(reply.error.message, 'Invalid difficulty specified for parent login, ::ffff:127.0.0.1');
	});
});







// -----------------------------------------------------------
// Payment ids
// -----------------------------------------------------------
//
// Payment ids behind an address, read with the shipped
// separators.
// -----------------------------------------------------------

describe('a payment id in a login', () => {

	it('of 64 characters is kept with the address', async () => {
		const { reply } = await login(addresses.address('ivan') + '.' + PAYMENT_ID);
		assert.equal(reply.result.status, 'OK');
		assert.equal(await recorded('hget', 'bitlitas:active_connections', addresses.address('ivan') + '.' + PAYMENT_ID + '~x'), '1');
	});


	it('of 16 characters is read as a difficulty and dropped, the "." being both separators', async () => {
		await login(addresses.address('judy') + '.00112233aabbccdd');
		assert.equal(await recorded('hget', 'bitlitas:active_connections', addresses.address('judy') + '~x'), '1');
	});


	it('behind two "+" signs is refused', async () => {
		const { reply } = await login(REAL.miner + '+one+two');
		assert.equal(reply.error.message, 'Invalid paymentId specified for parent login, ::ffff:127.0.0.1');
	});
});







// -----------------------------------------------------------
// xmr-node-proxy
// -----------------------------------------------------------
//
// A proxy fans one pool job out to many miners, so it gets
// the template itself and the offsets where it writes its
// own nonces.
// -----------------------------------------------------------

describe('a login from xmr-node-proxy', () => {

	it('gets the whole template with the pool\'s extra nonce in it, its offsets and the difficulties', async () => {
		const { reply } = await login(REAL.miner, 'proxy', { agent: 'xmr-node-proxy/0.15.0' });
		const job = reply.result.job;
		const template = world.daemon.chain.template();
		assert.equal(job.blob, undefined);
		assert.equal(job.target, undefined);
		assert.equal(job.blocktemplate_blob.length, template.blocktemplate_blob.length);
		assert.notEqual(job.blocktemplate_blob, template.blocktemplate_blob);
		assert.equal(job.reserved_offset, template.reserved_offset);
		assert.equal(job.client_nonce_offset, template.reserved_offset + 12);
		assert.equal(job.difficulty, template.difficulty);
		assert.equal(job.target_diff, 5000);
		assert.equal(job.height, template.height);
	});
});
