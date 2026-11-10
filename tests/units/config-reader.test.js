// -----------------------------------------------------------
//  [*] Tests — reading the configuration (lib/configReader.js)
//
//  The first module every process loads. It reads the JSON
//  file the -config= argument names into the global `config`,
//  names the pool's version, and turns blockUnlocker's
//  devDonation into a donation to the upstream developer's
//  wallet for the configured coin — when lib/configReader.js
//  has a wallet for it. It has none for LTL, so for Bitlitas
//  a donation set in the file goes nowhere. Each test runs
//  the module in a process of its own, as each pool process
//  does.
// -----------------------------------------------------------

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandboxConfig, WORLDS } = require('../support/world.js');
const { runNode } = require('../support/pool-process.js');


// The worlds' folder, which this file may be the first to need
fs.mkdirSync(WORLDS, { recursive: true });

// A folder of this file's own
const DIR = fs.mkdtempSync(path.join(WORLDS, 'config-reader-'));







// -----------------------------------------------------------
// readWith
// -----------------------------------------------------------
//
// What the module leaves in its globals for a configuration
// with the given deviations: the coin, the version, the
// developer fee and the donations.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

async function readWith (deviations, name) {

	const file = path.join(DIR, name + '.json');
	fs.writeFileSync(file, JSON.stringify(sandboxConfig(deviations)));
	const run = await runNode(`
		require(POOL + '/lib/configReader.js');
		console.log(JSON.stringify({ coin: config.coin, version: version, devFee: devFee, donations: donations }));
	`, { args: ['-config=' + file] });
	return JSON.parse(run.output.trim().split('\n').pop());
}







// -----------------------------------------------------------
// The globals
// -----------------------------------------------------------
//
// The configuration, the version and the donations every
// module finds in place.
// -----------------------------------------------------------

describe('the configuration reader', () => {

	it('reads the file -config= names and names the pool v2.0.0', async () => {
		const read = await readWith({}, 'shipped');
		assert.equal(read.coin, 'bitlitas');
		assert.equal(read.version, 'v2.0.0');
	});


	it('sends no developer donation for LTL, whatever devDonation says: it has no LTL wallet', async () => {
		const read = await readWith({ blockUnlocker: { devDonation: 0.5 } }, 'donating');
		assert.equal(read.devFee, 0.5);
		assert.deepEqual(read.donations, {});
	});


	it('turns devDonation into a donation for a coin it has a wallet for', async () => {
		const read = await readWith({ symbol: 'XMR', blockUnlocker: { devDonation: 0.5 } }, 'monero');
		assert.deepEqual(Object.values(read.donations), [0.5]);
		assert.match(Object.keys(read.donations)[0], /^4/);
	});
});
