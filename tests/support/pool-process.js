// -----------------------------------------------------------
//  [*] Test support — the pool as a running process
//
//  The pool under test is started the way the image starts
//  it — node init.js with a -config= path, from the image's
//  /pool folder — optionally with -module= to run one module
//  on its own. The master forks its workers as in production;
//  they share its output, which is kept here with the colour
//  codes stripped, so tests wait for what the pool logs and
//  error messages carry its latest lines. The process gets a
//  process group of its own, and kill() ends master and
//  workers together, the way a container stop would.
//
//  Used by:
//    - tests/support/world.js, the startup and unit suites
// -----------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { waitFor } = require('./wait.js');


// The pool's own folder: the tests live in /pool/tests
const POOL_ROOT = path.resolve(__dirname, '..', '..');

// What the logger's cli-color codes look like
const COLOUR_CODES = /\x1b\[[0-9;]*m/g;







// -----------------------------------------------------------
// childPids
// -----------------------------------------------------------
//
// The ids of the live processes whose parent is the given
// one, read from /proc — the pool's workers, for tests that
// kill one of them.
//
// Used by:
//   - PoolProcess.workers, PoolProcess.kill (below)
// -----------------------------------------------------------

function childPids (parent) {

	const children = [];
	for (const entry of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = fs.readFileSync('/proc/' + entry + '/stat', 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			if (Number(fields[1]) === parent && fields[0] !== 'Z') children.push(Number(entry));
		} catch (e) {
			continue;
		}
	}
	return children;
}







// -----------------------------------------------------------
// runNode
// -----------------------------------------------------------
//
// A short Node program run to its end in a process of its
// own, from the pool's folder — for module behaviour that
// only shows in a fresh process: what one does at load time,
// or when it crashes. The program is written to a script
// file first (cluster can fork only a script) and finds the
// pool's folder in the constant POOL. Resolves with the exit
// code, the signal and everything it printed; a program
// still running after the timeout is killed.
//
// Used by:
//   - tests/units/logger.test.js, tests/units/defects.test.js
// -----------------------------------------------------------

function runNode (code, { timeout = 20000, args = [] } = {}) {

	const dir = fs.mkdtempSync(path.join('/tmp', 'bitlitas-pool-tests-script-'));
	const script = path.join(dir, 'program.js');
	fs.writeFileSync(script, 'const POOL = ' + JSON.stringify(POOL_ROOT) + ';\n' + code);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...args], { cwd: POOL_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', (chunk) => output += chunk);
		child.stderr.on('data', (chunk) => output += chunk);
		const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
		child.once('exit', (exitCode, signal) => {
			clearTimeout(timer);
			resolve({ code: exitCode, signal, output: output.replace(COLOUR_CODES, '') });
		});
	});
}







// -----------------------------------------------------------
// PoolProcess
// -----------------------------------------------------------
//
// One running pool. `output` grows with everything master
// and workers print; `waitForOutput` resolves once a pattern
// shows up after a mark (by default anywhere), `count` tells
// how often it did. `exited` resolves with the exit code and
// signal. `tail` gives the latest lines for error messages;
// `workers` lists the worker processes, all or of one type
// (pool, daemon, blockUnlocker, paymentProcessor, api,
// chartsDataCollector). `kill` ends master and workers, and any
// process still carrying the pool's arguments after that.
//
// Used by:
//   - tests/support/world.js, the startup suites
// -----------------------------------------------------------

class PoolProcess {

	constructor (configPath, { module, args = [], env = {} } = {}) {
		// Without a path the pool reads config.json from /pool
		const argv = configPath ? ['init.js', '-config=' + configPath] : ['init.js'];
		this.argv = argv;
		if (module) argv.push('-module=' + module);
		this.output = '';
		this.child = spawn(process.execPath, argv.concat(args), {
			cwd: POOL_ROOT,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...env }
		});
		const keep = (chunk) => this.output += chunk.toString('utf8').replace(COLOUR_CODES, '');
		this.child.stdout.on('data', keep);
		this.child.stderr.on('data', keep);
		this.exitInfo = null;
		this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => {
			this.exitInfo = { code, signal };
			resolve(this.exitInfo);
		}));
	}


	get pid () {
		return this.child.pid;
	}


	get running () {
		return this.exitInfo === null;
	}


	mark () {
		return this.output.length;
	}


	count (pattern, from = 0) {
		const text = this.output.slice(from);
		if (typeof pattern === 'string') return text.split(pattern).length - 1;
		return (text.match(new RegExp(pattern.source, 'g')) || []).length;
	}


	async waitForOutput (pattern, { from = 0, timeout = 20000, times = 1 } = {}) {
		await waitFor(() => this.count(pattern, from) >= times, {
			timeout,
			what: 'the pool to print ' + pattern + (times > 1 ? ' ' + times + ' times' : ''),
			explain: () => this.tail()
		});
	}


	tail (lines = 25) {
		return '--- pool output (last ' + lines + ' lines) ---\n' + this.output.split('\n').slice(-lines - 1).join('\n');
	}


	workers (type) {
		const pids = childPids(this.pid);
		if (!type) return pids;
		// init.js forks each worker with its type in the environment
		return pids.filter((pid) => {
			try {
				return fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').includes('workerType=' + type);
			} catch (e) {
				return false;
			}
		});
	}


	async kill () {
		if (this.running) {
			try {
				process.kill(-this.pid, 'SIGKILL');
			} catch (e) {
				this.child.kill('SIGKILL');
			}
		}
		await this.exited;
		// A worker that left the group (a respawn caught mid-fork, a
		// master the kernel killed first) still carries the pool's
		// arguments: each is killed until none is left holding a port
		const deadline = Date.now() + 10000;
		let survivors = this.survivors();
		while (survivors.length && Date.now() < deadline) {
			for (const pid of survivors) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch (e) {
					continue;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
			survivors = this.survivors();
		}
	}


	survivors () {
		const found = [];
		for (const entry of fs.readdirSync('/proc')) {
			if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
			try {
				const cmdline = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\0');
				const state = fs.readFileSync('/proc/' + entry + '/stat', 'utf8');
				if (cmdline.includes(this.argv[1]) && state.slice(state.lastIndexOf(')') + 2, state.lastIndexOf(')') + 3) !== 'Z') found.push(Number(entry));
			} catch (e) {
				continue;
			}
		}
		return found;
	}
}







// What the suites take from here
module.exports = { PoolProcess, POOL_ROOT, childPids, runNode };
