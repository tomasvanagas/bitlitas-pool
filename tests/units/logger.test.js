// -----------------------------------------------------------
//  [*] Tests — the log system and the crash handler
//
//  lib/logger.js gives every process its global `log`: a
//  line on the console from the console level up, and a line
//  in <system>_<severity>.log from the file level up, the
//  files written in one batch every flushInterval seconds.
//  lib/exceptionWriter.js catches what nothing else caught,
//  appends its stack to <system>_crash.log and ends a worker,
//  so the master forks a fresh one. The logger is loaded here
//  in the test's own process, as a module loads it; what only
//  shows at start or in a crash runs in a process of its own.
// -----------------------------------------------------------

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandboxConfig, WORLDS } = require('../support/world.js');
const { runNode } = require('../support/pool-process.js');
const { waitFor } = require('../support/wait.js');


// The worlds' folder, which this file may be the first to need
fs.mkdirSync(WORLDS, { recursive: true });

// A folder of this file's own
const DIR = fs.mkdtempSync(path.join(WORLDS, 'logger-'));

// The folder this file's logger writes to
const LOGS = path.join(DIR, 'logs');

// The console lines the logger printed while a test listened
let printed = [];

before(() => {
	global.config = sandboxConfig({ logging: { files: { directory: LOGS, flushInterval: 1 }, console: { level: 'warn' } } });
	require('../../lib/logger.js');
});







// -----------------------------------------------------------
// listen
// -----------------------------------------------------------
//
// Runs `fn` with console.log captured into `printed`.
//
// Used by:
//   - the console tests (below)
// -----------------------------------------------------------

function listen (fn) {

	const original = console.log;
	printed = [];
	console.log = (...args) => printed.push(args.join(' ').replace(/\x1b\[[0-9;]*m/g, ''));
	try {
		fn();
	} finally {
		console.log = original;
	}
}







// -----------------------------------------------------------
// readLog
// -----------------------------------------------------------
//
// One log file's text once it holds a pattern — the flush
// comes up to a second later.
//
// Used by:
//   - the file tests (below)
// -----------------------------------------------------------

function readLog (name, pattern) {

	const file = path.join(LOGS, name);
	return waitFor(() => fs.existsSync(file) && pattern.test(fs.readFileSync(file, 'utf8')) && fs.readFileSync(file, 'utf8'), { what: pattern + ' in ' + name, timeout: 5000 });
}







// -----------------------------------------------------------
// Files
// -----------------------------------------------------------
//
// What reaches the log files, how it is worded, and when.
// -----------------------------------------------------------

describe('a log entry in the files', () => {

	it('lands in <system>_<severity>.log with the date first', async () => {
		global.log('info', 'pool', 'Accepted %s share at difficulty %d', ['valid', 5000]);
		const text = await readLog('pool_info.log', /Accepted valid share/);
		assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d Accepted valid share at difficulty 5000\n/m);
	});


	it('formats objects with %j', async () => {
		global.log('error', 'unlocker', 'Error with getblockheaderbyheight %j', [{ code: -2 }]);
		const text = await readLog('unlocker_error.log', /code/);
		assert.match(text, /Error with getblockheaderbyheight \{"code":-2\}/);
	});


	it('is not written below the file level', async () => {
		global.config.logging.files.level = 'error';
		global.log('warn', 'payments', 'too quiet to keep');
		global.log('error', 'payments', 'kept');
		global.config.logging.files.level = 'info';
		await readLog('payments_error.log', /kept/);
		assert.equal(fs.existsSync(path.join(LOGS, 'payments_warn.log')), false);
	});


	it('waits for the flush interval before it reaches the disk', async () => {
		global.log('info', 'api', 'buffered line');
		assert.equal(fs.existsSync(path.join(LOGS, 'api_info.log')), false);
		await readLog('api_info.log', /buffered line/);
	});
});







// -----------------------------------------------------------
// Console
// -----------------------------------------------------------
//
// What reaches the console, and at which levels.
// -----------------------------------------------------------

describe('a log entry on the console', () => {

	it('is printed from the console level up, with the system in brackets', () => {
		listen(() => {
			global.log('info', 'pool', 'below the console level');
			global.log('warn', 'pool', 'Banned %s@%s', ['miner', '::ffff:10.0.0.1']);
		});
		assert.equal(printed.length, 1);
		assert.match(printed[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[pool\] Banned miner@::ffff:10\.0\.0\.1$/);
	});


	it('is printed plain, without colour codes, when colours are off', () => {
		const original = console.log;
		const raw = [];
		console.log = (...args) => raw.push(args.join(' '));
		global.config.logging.console.colors = false;
		try {
			global.log('error', 'daemon', 'bad reponse from daemon');
		} finally {
			global.config.logging.console.colors = true;
			console.log = original;
		}
		assert.match(raw[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[daemon\] bad reponse from daemon$/);
	});


	it('is printed for every severity when the console level is one the logger does not know', () => {
		global.config.logging.console.level = 'debug';
		listen(() => global.log('info', 'api', 'shown anyway'));
		global.config.logging.console.level = 'warn';
		assert.equal(printed.length, 1);
	});
});







// -----------------------------------------------------------
// Start and crashes
// -----------------------------------------------------------
//
// In a process of its own, with the config set the way
// lib/configReader.js sets it.
// -----------------------------------------------------------

describe('the log system at start and in a crash', () => {

	it('creates its folder when the folder is missing', async () => {
		const logs = path.join(DIR, 'created-at-start');
		const run = await runNode(`
			global.config = ${JSON.stringify(sandboxConfig({ logging: { files: { directory: logs } } }))};
			require(POOL + '/lib/logger.js');
			process.exit(0);
		`);
		assert.equal(run.code, 0, run.output);
		assert.equal(fs.statSync(logs).isDirectory(), true);
	});


	it('stops the process at start when the folder\'s parent is missing too', async () => {
		const logs = path.join(DIR, 'no-such-parent', 'logs');
		const run = await runNode(`
			global.config = ${JSON.stringify(sandboxConfig({ logging: { files: { directory: logs } } }))};
			require(POOL + '/lib/logger.js');
		`);
		assert.notEqual(run.code, 0);
		assert.match(run.output, /ENOENT: no such file or directory, mkdir/);
	});


	it('keeps a process that is not a worker running after an uncaught exception, its stack in the crash log', async () => {
		const logs = path.join(DIR, 'master-crash');
		fs.mkdirSync(logs);
		const run = await runNode(`
			global.config = ${JSON.stringify(sandboxConfig({ logging: { files: { directory: logs } } }))};
			require(POOL + '/lib/exceptionWriter.js')('master');
			setTimeout(() => { throw new Error('nobody caught this'); }, 10);
			setTimeout(() => { console.log('still running'); process.exit(0); }, 500);
		`);
		assert.equal(run.code, 0);
		assert.match(run.output, /still running/);
		assert.match(fs.readFileSync(path.join(logs, 'master_crash.log'), 'utf8'), /Error: nobody caught this/);
	});


	it('ends a worker after an uncaught exception, once its stack is in the crash log', async () => {
		const logs = path.join(DIR, 'worker-crash');
		fs.mkdirSync(logs);
		const run = await runNode(`
			const cluster = require('cluster');
			global.config = ${JSON.stringify(sandboxConfig({ logging: { files: { directory: logs } } }))};
			if (cluster.isWorker) {
				require(POOL + '/lib/exceptionWriter.js')('pool');
				setTimeout(() => { throw new Error('worker broke'); }, 10);
				setTimeout(() => console.log('worker survived'), 2000);
			} else {
				cluster.fork().on('exit', (code) => { console.log('worker exited with ' + code); process.exit(0); });
			}
		`);
		assert.match(run.output, /worker exited with 0/);
		assert.doesNotMatch(run.output, /worker survived/);
		assert.match(fs.readFileSync(path.join(logs, 'pool_crash.log'), 'utf8'), /Error: worker broke/);
	});
});
