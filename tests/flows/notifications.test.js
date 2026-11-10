// -----------------------------------------------------------
//  [*] Tests — the mail the running pool sends
//
//  The whole pool with email on, its smtp transport pointed at
//  the suite's mail server, and three addresses registered
//  for notifications the way the settings page registers
//  them. Each event a miner or the pool's users hear about is
//  brought about the way it happens in production — a worker
//  connecting, the pool finding a block, the block maturing,
//  another orphaned by a longer chain, a payment going out, a
//  worker banned, a worker going idle — and the mail it sends
//  is read back, worded as the shipped file words it. The
//  tests run in order. The unlocker runs every second, the
//  payments every two; minerTimeout is two seconds, so the
//  30-second sweep drops an idle worker within the file.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World, claimPort } = require('../support/world.js');
const { FakeSmtp } = require('../support/smtp.js');
const addresses = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');
const { waitFor, sleep } = require('../support/wait.js');


// The miner who mines here
const MINER = addresses.address('mail-miner');

// The miner whose worker is banned
const OFFENDER = addresses.address('mail-offender');

// A pool user who only follows the pool's news
const FOLLOWER = addresses.address('mail-follower');

// The registered addresses, by miner
const MAILBOXES = { [MINER]: 'miner@example.lt', [OFFENDER]: 'offender@example.lt', [FOLLOWER]: 'follower@example.lt' };







// -----------------------------------------------------------
// short
// -----------------------------------------------------------
//
// An address the way the notifications shorten it: the first
// and last seven characters around three dots.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function short (address) {

	return address.substring(0, 7) + '...' + address.substring(address.length - 7);
}







// -----------------------------------------------------------
// Mail on pool events
// -----------------------------------------------------------
//
// One pool and one mailbox server; each test waits for the
// mail its event sends.
// -----------------------------------------------------------

describe('the mail a running pool sends', () => {

	let world;
	let pool;
	let smtp;
	let miner;
	let blockHeight;
	let orphanHeight;
	let keepAlive;

	before(async () => {
		world = await World.create('mail');
		smtp = await FakeSmtp.start(claimPort());
		await world.redis.call('hset', 'bitlitas:notifications', ...Object.entries(MAILBOXES).flat());
		pool = await world.startPool({
			email: { enabled: true, transport: 'smtp', fromAddress: 'pool@bitlitas.lt', smtp: { host: '127.0.0.1', port: smtp.port, secure: false, auth: undefined, ignoreTLS: true } },
			poolServer: { minerTimeout: 2 },
			blockUnlocker: { interval: 1 },
			payments: { interval: 2 },
			api: { updateInterval: 1 }
		}, { cheapPort: true });
	});

	after(async () => {
		clearInterval(keepAlive);
		await world.close();
		await smtp.close();
	});


	// Waits for the mail with a subject, sent to an address
	const mail = (subject, to) => waitFor(() => smtp.messages.find((one) => one.subject === subject && (!to || one.to.includes(to))), { what: 'the mail "' + subject + '"' + (to ? ' to ' + to : ''), timeout: 40000, explain: () => pool.tail() });

	// Finds a block at the next height but one, as the shares suite does
	const findBlock = async () => {
		const chain = world.daemon.chain;
		const height = chain.tipHeight + 2;
		chain.easyHeights.add(height);
		chain.mineElsewhere();
		const job = await miner.jobAtHeight(height);
		assert.equal((await miner.submit(miner.mine({ job }))).result.status, 'OK');
		await waitFor(() => chain.tipHeight === height, { what: 'the block taken' });
		return height;
	};


	it('tells a miner its first worker connected, from which IP', async () => {
		miner = await world.stratum('cheap');
		await miner.login(MINER, 'rig-1');
		// Kept alive through the blocks, so the sweep drops it only
		// once the tests let it go quiet
		keepAlive = setInterval(() => miner.keepalived({ timeout: 2000 }), 500);
		const message = await mail('Worker rig-1 connected', MAILBOXES[MINER]);
		assert.match(message.text, new RegExp('Your worker rig-1 for address ' + short(MINER).replace(/\./g, '\\.') + ' is now connected from ip 127\\.0\\.0\\.1\\.'));
		assert.equal(message.from, 'pool@bitlitas.lt');
	});


	it('says nothing when a second connection of the same worker comes', async () => {
		const second = await world.stratum('cheap');
		await second.login(MINER, 'rig-1');
		await sleep(1500);
		assert.equal(smtp.messages.filter((one) => one.subject === 'Worker rig-1 connected').length, 1);
	});


	it('tells everyone registered that the pool found a block', async () => {
		blockHeight = await findBlock();
		for (const address of Object.values(MAILBOXES)) {
			const message = await mail('Block ' + blockHeight + ' found !', address);
			assert.match(message.text, new RegExp('Block found at height ' + blockHeight + ' by miner ' + short(MINER).replace(/\./g, '\\.') + ' on '));
		}
	});


	it('tells everyone when the block matures, and when a longer chain orphans the next one', async () => {
		orphanHeight = await findBlock();
		world.daemon.chain.reorg(orphanHeight, 61);
		const unlocked = await mail('Block ' + blockHeight + ' unlocked !', MAILBOXES[FOLLOWER]);
		assert.match(unlocked.text, new RegExp('Block mined at height ' + blockHeight + ' with 35\\.1682 LTL and \\d+% effort on '));
		const orphaned = await mail('Block ' + orphanHeight + ' orphaned !', MAILBOXES[FOLLOWER]);
		assert.match(orphaned.text, new RegExp('Block orphaned at height ' + orphanHeight + ' :\\('));
	});


	it('tells the miner a payment went out, how much and to which address', async () => {
		const message = await mail('We sent you a payment !', MAILBOXES[MINER]);
		const [transfer] = world.wallet.transfers;
		const amount = (transfer.destinations[0].amount / 1e12).toFixed(4);
		assert.match(message.text, new RegExp('A payment of ' + amount.replace('.', '\\.') + ' LTL has been sent to ' + short(MINER).replace(/\./g, '\\.') + ' wallet\\.'));
	});


	it('tells a miner its worker was banned', async () => {
		clearInterval(keepAlive);
		const offender = await world.stratum('cheap', { localAddress: '127.0.0.12' });
		await offender.login(OFFENDER, 'bad-rig');
		await offender.submit({ job_id: offender.job.job_id, nonce: 'bad', result: 'ab'.repeat(32) });
		const message = await mail('Worker bad-rig banned', MAILBOXES[OFFENDER]);
		assert.match(message.text, new RegExp('Your worker bad-rig for address ' + short(OFFENDER).replace(/\./g, '\\.') + ' has been banned\\.'));
	});


	it('tells a miner its worker stopped hashing once the sweep drops the last connection', async () => {
		const message = await mail('Worker rig-1 stopped hashing', MAILBOXES[MINER]);
		assert.match(message.text, /has stopped submitting hashes on \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+\./);
		assert.equal(smtp.messages.filter((one) => one.subject === 'Worker rig-1 stopped hashing').length, 1);
	});


	it('sends the administrator\'s test mail', async () => {
		const reply = await apiGet(world.apiPort, '/test_email_notification?email=admin@example.lt');
		assert.deepEqual(reply.json, { status: 'done' });
		const message = await mail('Test notification', 'admin@example.lt');
		assert.match(message.text, /This is a test notification from the pool\./);
	});
});
