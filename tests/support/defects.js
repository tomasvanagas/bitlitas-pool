// -----------------------------------------------------------
//  [*] Test support — pinned defects
//
//  No bug is fixed from the suite. A test that finds a defect
//  in the pool states the behaviour the pool should have and
//  is pinned with pinDefect under an id from the README's
//  list. While the defect lives, its assertion fails, the
//  test is reported as TODO with the id and the first line of
//  the failure, and the run stays green. When a fix makes the
//  assertion pass, the test FAILS with "no longer reproduces"
//  — the cue to drop the pin and move the test into its home
//  file. Only a failed assertion counts as the defect
//  reproducing; any other error (the harness breaking, the
//  pool never starting) fails the test, so a pin cannot hide
//  a broken test.
//
//  Used by:
//    - every defects.test.js
// -----------------------------------------------------------

const assert = require('node:assert');
const { it } = require('node:test');







// -----------------------------------------------------------
// pinDefect
// -----------------------------------------------------------
//
// Declares one pinned test inside the current describe: the
// title says what the pool should do, the id ties it to the
// README, and the test body asserts that behaviour. Extra
// node:test options (a timeout) pass through.
//
// Used by:
//   - every defects.test.js
// -----------------------------------------------------------

function pinDefect (id, title, body, options = {}) {

	it(title + ' [' + id + ']', { timeout: 120000, ...options }, async (t) => {
		try {
			await body(t);
		} catch (error) {
			if (!(error instanceof assert.AssertionError)) throw error;
			t.todo('pinned defect ' + id + ': ' + String(error.message).split('\n')[0]);
			return;
		}
		throw new Error('pinned defect ' + id + ' no longer reproduces: drop the pin and move the test into its home file');
	});
}







// What the suites take from here
module.exports = { pinDefect };
