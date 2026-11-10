// -----------------------------------------------------------
//  [*] Tests — pinned defects of the shared modules
//
//  Defects in the log system and the notification senders,
//  each test stating what the module should do; pinDefect
//  keeps the run green while the defect lives and fails once
//  it is gone (tests/README.md, "Pinned defects"). None of
//  them bites under the shipped configuration as it stands —
//  email and Telegram are off, the disk has room — but each
//  takes the pool down the day that changes.
// -----------------------------------------------------------

const { describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandboxConfig, WORLDS } = require('../support/world.js');
const { runNode } = require('../support/pool-process.js');
const { waitFor } = require('../support/wait.js');
const { pinDefect } = require('../support/defects.js');


// The worlds' folder, which this file may be the first to need
fs.mkdirSync(WORLDS, { recursive: true });

// A folder of this file's own
const DIR = fs.mkdtempSync(path.join(WORLDS, 'unit-defects-'));

// What the modules logged
const logged = [];

before(() => {
	global.config = sandboxConfig({
		logging: { files: { directory: path.join(DIR, 'logs') } },
		email: { enabled: true },
		telegram: { enabled: true, token: 'test-token', channel: '@bitlitas_pool' }
	});
	global.log = (severity, system, text, data) => logged.push({ severity, system, text, data });
});







// -----------------------------------------------------------
// The log system
// -----------------------------------------------------------
//
// A log folder that disappears under a running process.
// -----------------------------------------------------------

describe('the log system', () => {

	pinDefect('log-write-crash', 'reports a log file it cannot write and carries on', async () => {
		const logs = path.join(DIR, 'vanishing-logs');
		const run = await runNode(`
			global.config = ${JSON.stringify(sandboxConfig({ logging: { files: { directory: logs, flushInterval: 1 } } }))};
			require(POOL + '/lib/logger.js');
			require(POOL + '/lib/exceptionWriter.js')('pool');
			global.log('info', 'pool', 'a line for a folder that is gone');
			require('fs').rmSync(${JSON.stringify(logs)}, { recursive: true });
			setTimeout(() => process.exit(0), 1600);
		`);
		assert.doesNotMatch(run.output, /ReferenceError: callback is not defined/, 'the failed write called a callback the logger never defined, which crashes the process');
	});
});







// -----------------------------------------------------------
// Notifications
// -----------------------------------------------------------
//
// The Telegram and Mailgun client libraries, the sendmail
// transport and a missing email template.
// -----------------------------------------------------------

describe('the notification senders', () => {

	pinDefect('telegram-client-gone', 'send a Telegram message through the installed client library', () => {
		// package.json asks for node-telegram-bot-api "*", which now
		// installs 2.x — a different framework without the
		// TelegramBot class lib/telegram.js and lib/telegramBot.js build
		const telegram = require('../../lib/telegram.js');
		assert.doesNotThrow(() => telegram.sendMessage('424242', 'Block 353201 found !'), 'node-telegram-bot-api 2.x has no TelegramBot class to construct');
	});


	pinDefect('mailgun-client-gone', 'send mail through Mailgun with the installed client library', () => {
		// mailgun.js 3.x, which package.json's ^3.7.3 installs, has to be
		// built with new Mailgun(formData); lib/email.js still calls the
		// 2.x client() off the module
		global.config.email.transport = 'mailgun';
		try {
			assert.doesNotThrow(() => require('../../lib/email.js').sendEmail('miner@example.lt', 'Block found', 'text'), 'mailgun.client is not a function in mailgun.js 3.x');
		} finally {
			global.config.email.transport = 'sendmail';
		}
	});


	pinDefect('sendmail-transport-is-smtp', 'send mail through sendmail when the transport says sendmail', async () => {
		// nodemailer builds its sendmail transport for `sendmail: true`;
		// lib/email.js hands it `transport: 'sendmail'`, which it reads
		// as SMTP options for localhost:587
		const nodemailer = require('nodemailer');
		const built = [];
		const createTransport = nodemailer.createTransport;
		nodemailer.createTransport = (...args) => {
			const transport = createTransport(...args);
			built.push(transport.transporter.name);
			return transport;
		};
		global.config.email.transport = 'sendmail';
		try {
			require('../../lib/email.js').sendEmail('miner@example.lt', 'Block found', 'text');
		} finally {
			nodemailer.createTransport = createTransport;
		}
		await waitFor(() => logged.find((entry) => /Unable to send e-mail/.test(entry.text)), { what: 'the send to fail' });
		assert.deepEqual(built, ['Sendmail'], 'nodemailer built ' + built.join(', ') + ' for the sendmail transport');
	});


	pinDefect('missing-email-template-crash', 'send the bare message when the email template file is missing', () => {
		global.config.notifications.emailTemplate = path.join(DIR, 'no-such-template.txt');
		const notifications = require('../../lib/notifications.js');
		assert.doesNotThrow(() => notifications.sendToEmail('miner@example.lt', 'payment', { AMOUNT: '1.0000 LTL', ADDRESS: '4BHHDKJ...g2Z8CbS7' }), 'after warning that the template is missing, the sender reads it anyway and throws');
	});
});
