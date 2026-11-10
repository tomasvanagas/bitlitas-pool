// -----------------------------------------------------------
//  [*] Tests — what miners are told (notifications, email, telegram)
//
//  lib/notifications.js turns a pool event — a worker
//  connecting, timing out or banned, a block found, unlocked
//  or orphaned, a payment — into the subject and text the
//  shipped configuration words, and hands them to email
//  (lib/email.js) and Telegram (lib/telegram.js). The shipped
//  file turns both off. Here email is on, with the smtp
//  transport pointed at the suite's mail server, so the mail
//  a miner would get is read back; Telegram's sender is
//  replaced by a recorder, since its API is on the internet.
//  The real sender runs here only as far as its checks before
//  the network; the send itself is pinned in defects.test.js,
//  since the installed client library no longer has the
//  class it constructs.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World, claimPort } = require('../support/world.js');
const { FakeSmtp } = require('../support/smtp.js');
const { waitFor } = require('../support/wait.js');
const { REAL } = require('../support/addresses.js');


// The world (for its Redis), the mail server, the modules
// under test and the real Telegram sender
let world;
let smtp;
let notifications;
let realTelegramSend;

// What the Telegram recorder caught
const telegrams = [];

// Every line the modules logged
const logged = [];

before(async () => {
	world = await World.create('notifications');
	smtp = await FakeSmtp.start(claimPort());
	global.config = world.config({
		email: { enabled: true, transport: 'smtp', fromAddress: 'pool@bitlitas.lt', smtp: { host: '127.0.0.1', port: smtp.port, secure: false, auth: undefined, ignoreTLS: true } },
		telegram: { enabled: true, token: 'test-token', channel: '@bitlitas_pool' }
	});
	global.log = (severity, system, text, data) => logged.push({ severity, system, text, data });
	global.redisClient = world.redis.client;
	const telegram = require('../../lib/telegram.js');
	realTelegramSend = telegram.sendMessage;
	telegram.sendMessage = (chatId, message) => telegrams.push({ chatId, message });
	notifications = require('../../lib/notifications.js');
});

after(async () => {
	await smtp.close();
	await world.close();
});







// -----------------------------------------------------------
// Email
// -----------------------------------------------------------
//
// Mail to one miner and to every registered address, read
// back from the suite's mail server.
// -----------------------------------------------------------

describe('an email notification', () => {

	it('reaches the address a miner registered, worded as the shipped file words it', async () => {
		await world.redis.call('hset', 'bitlitas:notifications', REAL.miner, 'miner@example.lt');
		notifications.sendToMiner(REAL.miner, 'workerConnected', { WORKER_NAME: 'rig1', MINER: '4BHHDKJ...g2Z8CbS7', IP: '10.0.0.5' });
		const mail = await waitFor(() => smtp.messages.find((message) => message.text.includes('rig1')), { what: 'the mail' });
		assert.deepEqual(mail.to, ['miner@example.lt']);
		assert.equal(mail.from, 'pool@bitlitas.lt');
		assert.equal(mail.subject, 'Worker rig1 connected');
		assert.match(mail.text, /Your worker rig1 for address 4BHHDKJ...g2Z8CbS7 is now connected from ip 10\.0\.0\.5\./);
	});


	it('wraps the message in the email template, the pool host filled in', async () => {
		await world.redis.call('hset', 'bitlitas:notifications', REAL.pool, 'pool-owner@example.lt');
		notifications.sendToMiner(REAL.pool, 'payment', { AMOUNT: '1.2340 LTL', ADDRESS: '45Mnieh...JrC8v' });
		const mail = await waitFor(() => smtp.messages.find((message) => message.to.includes('pool-owner@example.lt')), { what: 'the payment mail' });
		assert.match(mail.text, /^Hello,/);
		assert.match(mail.text, /A payment of 1\.2340 LTL has been sent to 45Mnieh\.\.\.JrC8v wallet\./);
		assert.match(mail.text, /the allmighty BlockMaster at pool\.bitlitas\.lt/);
	});


	it('goes to every registered address when it is pool news', async () => {
		smtp.messages.length = 0;
		notifications.sendToAll('blockFound', { HEIGHT: 353201, MINER: '4BHHDKJ...g2Z8CbS7' });
		await waitFor(() => smtp.messages.length >= 2, { what: 'two block mails' });
		assert.deepEqual(smtp.messages.map((message) => message.to[0]).sort(), ['miner@example.lt', 'pool-owner@example.lt']);
		assert.equal(smtp.messages[0].subject, 'Block 353201 found !');
	});


	it('is not sent to a miner who registered no address', async () => {
		smtp.messages.length = 0;
		notifications.sendToMiner('no-such-miner', 'workerBanned', { WORKER_NAME: 'x' });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(smtp.messages.length, 0);
	});


	it('goes to the one address an administrator names, as the test notification', async () => {
		notifications.sendToEmail('admin@example.lt', 'test', {});
		const mail = await waitFor(() => smtp.messages.find((message) => message.to.includes('admin@example.lt')), { what: 'the test mail' });
		assert.equal(mail.subject, 'Test notification');
		assert.match(mail.text, /This is a test notification from the pool\./);
	});


	it('is not sent to every address for pool news the configuration gives no text', async () => {
		smtp.messages.length = 0;
		const kept = global.config.notifications.emailMessage.blockOrphaned;
		global.config.notifications.emailMessage.blockOrphaned = '';
		try {
			notifications.sendToAll('blockOrphaned', { HEIGHT: 9 });
		} finally {
			global.config.notifications.emailMessage.blockOrphaned = kept;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(smtp.messages.length, 0);
	});


	it('is not sent at all for an event the configuration gives no text', async () => {
		smtp.messages.length = 0;
		global.config.notifications.emailMessage.workerTimeout = '';
		notifications.sendToMiner(REAL.miner, 'workerTimeout', { WORKER_NAME: 'rig1' });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(smtp.messages.length, 0);
		assert.ok(logged.some((entry) => /Notification disabled for %s: empty email content/.test(entry.text)));
	});
});







// -----------------------------------------------------------
// Telegram
// -----------------------------------------------------------
//
// Messages to the channel, to a miner's chat and to the
// chats that want block news, as the recorder caught them.
// -----------------------------------------------------------

describe('a telegram notification', () => {

	it('goes to the channel for pool news, its variables freed of Markdown stars and underscores', () => {
		telegrams.length = 0;
		notifications.sendToAll('blockFound', { HEIGHT: 353202, MINER: 'my_*miner' });
		const channel = telegrams.find((sent) => sent.chatId === '@bitlitas_pool');
		assert.equal(channel.message, '*Block found at height* _353202_ *by miner* _my .miner_*! Waiting maturity.*');
	});


	it('reaches a miner who linked a chat', async () => {
		telegrams.length = 0;
		await world.redis.call('hset', 'bitlitas:telegram', REAL.miner, '424242');
		notifications.sendToMiner(REAL.miner, 'workerBanned', { WORKER_NAME: 'rig1', MINER: '4BHHDKJ...g2Z8CbS7' });
		const sent = await waitFor(() => telegrams.find((one) => one.chatId === '424242'), { what: 'the miner\'s telegram' });
		assert.equal(sent.message, 'Your worker _rig1_ for address _4BHHDKJ...g2Z8CbS7_ has been banned.');
	});


	it('reaches every chat that asked for block news', async () => {
		telegrams.length = 0;
		await world.redis.call('hset', 'bitlitas:telegram:blocks', '111', '1', '222', '1');
		notifications.sendToAll('blockUnlocked', { HEIGHT: 353100, REWARD: '35.1682 LTL', EFFORT: '87%' });
		await waitFor(() => telegrams.filter((one) => one.chatId === '111' || one.chatId === '222').length === 2, { what: 'two block telegrams' });
	});


	it('is not sent to the channel when none is configured', () => {
		logged.length = 0;
		telegrams.length = 0;
		global.config.telegram.channel = '';
		try {
			notifications.sendToTelegramChannel('blockFound', { HEIGHT: 1 });
		} finally {
			global.config.telegram.channel = '@bitlitas_pool';
		}
		assert.equal(telegrams.length, 0);
		assert.ok(logged.some((entry) => entry.text === 'No telegram channel specified in configuration!'));
	});


	it('is not sent for an event the configuration gives no text', () => {
		logged.length = 0;
		telegrams.length = 0;
		const kept = global.config.notifications.telegramMessage.payment;
		global.config.notifications.telegramMessage.payment = '';
		try {
			notifications.sendToMinerTelegram(REAL.miner, 'payment', { AMOUNT: '1 LTL' });
		} finally {
			global.config.notifications.telegramMessage.payment = kept;
		}
		assert.equal(telegrams.length, 0);
		assert.ok(logged.some((entry) => /Notification disabled for %s: empty telegram message/.test(entry.text)));
	});


	it('is not attempted without a text, nor without a telegram section', () => {
		logged.length = 0;
		realTelegramSend('424242', '');
		const telegram = global.config.telegram;
		delete global.config.telegram;
		try {
			realTelegramSend('424242', 'hello');
		} finally {
			global.config.telegram = telegram;
		}
		assert.deepEqual(logged.map((entry) => entry.text), ['No text to send.', 'Telegram is not configured!']);
	});


	it('is not attempted without a token or a chat id', () => {
		logged.length = 0;
		realTelegramSend('', 'hello');
		realTelegramSend('@', 'hello');
		global.config.telegram.token = '';
		realTelegramSend('424242', 'hello');
		global.config.telegram.token = 'test-token';
		assert.deepEqual(logged.map((entry) => entry.text), [
			'No telegram chat id specified!',
			'No telegram chat id specified!',
			'No telegram token specified in configuration!'
		]);
	});
});







// -----------------------------------------------------------
// Email without a mail server
// -----------------------------------------------------------
//
// Sends that cannot succeed, and the errors they leave in
// the log.
// -----------------------------------------------------------

describe('an email the transport cannot deliver', () => {

	it('is logged as unsent when sendmail is not installed', async () => {
		logged.length = 0;
		global.config.email.transport = 'sendmail';
		require('../../lib/email.js').sendEmail('miner@example.lt', 'subject', 'text');
		global.config.email.transport = 'smtp';
		const failure = await waitFor(() => logged.find((entry) => /Unable to send e-mail/.test(entry.text)), { what: 'the logged failure' });
		assert.equal(failure.severity, 'error');
	});


	it('is not attempted when the configuration has no email section', () => {
		logged.length = 0;
		const email = global.config.email;
		delete global.config.email;
		try {
			require('../../lib/email.js').sendEmail('miner@example.lt', 'subject', 'text');
		} finally {
			global.config.email = email;
		}
		assert.equal(logged[0].text, 'Email system not configured!');
	});


	it('is not attempted without a destination address', () => {
		logged.length = 0;
		require('../../lib/email.js').sendEmail('', 'subject', 'text');
		assert.equal(logged[0].text, 'Unable to send e-mail: no destination email.');
	});
});
