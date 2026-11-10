// -----------------------------------------------------------
//  [*] Test support — waiting for the pool
//
//  The pool works on timers and in other processes, so tests
//  wait for what it does instead of sleeping a guessed time:
//  waitFor polls a check until it yields something, and fails
//  with what it waited for when the time is up. sleep is for
//  the few tests that prove something does NOT happen within
//  a window.
//
//  Used by:
//    - every suite and the other support modules
// -----------------------------------------------------------

const { setTimeout: delay } = require('timers/promises');







// -----------------------------------------------------------
// waitFor
// -----------------------------------------------------------
//
// Polls `check` (sync or async) until it returns something
// truthy and returns that; a check that throws counts as not
// yet. Gives up after `timeout` ms with an error naming
// `what`, the last error the check threw, and `explain()`
// when the caller hands one in — the pool's latest output.
//
// Used by:
//   - every suite
// -----------------------------------------------------------

async function waitFor (check, { timeout = 15000, interval = 50, what = 'a condition', explain } = {}) {

	const deadline = Date.now() + timeout;
	let lastError = null;
	while (true) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() > deadline) break;
		await delay(interval);
	}


	let message = 'timed out after ' + timeout + ' ms waiting for ' + what;
	if (lastError) message += '\nlast error: ' + lastError.message;
	if (explain) message += '\n' + explain();
	throw new Error(message);
}







// -----------------------------------------------------------
// sleep
// -----------------------------------------------------------
//
// A plain pause, for windows in which something must not
// happen.
//
// Used by:
//   - the defect and timing tests
// -----------------------------------------------------------

function sleep (ms) {

	return delay(ms);
}







// What the suites take from here
module.exports = { waitFor, sleep };
