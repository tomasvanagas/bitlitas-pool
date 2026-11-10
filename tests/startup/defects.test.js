// -----------------------------------------------------------
//  [*] Tests — pinned defects of starting the pool
//
//  Each test states what init.js should do; pinDefect keeps
//  the run green while the defect lives and fails once it is
//  gone (tests/README.md, "Pinned defects"). Both are about a
//  pool wallet that will not do: one the master turns down
//  but reports as a clean exit, which a supervisor reads as a
//  normal stop, and one it does not turn down at all, which
//  sends every pool worker into a crash every two seconds.
// -----------------------------------------------------------

const { describe, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { World } = require('../support/world.js');
const { PoolProcess } = require('../support/pool-process.js');
const { REAL } = require('../support/addresses.js');
const { sleep } = require('../support/wait.js');
const { pinDefect } = require('../support/defects.js');







// -----------------------------------------------------------
// The pool wallet
// -----------------------------------------------------------
//
// The two wallets the master should refuse and how it
// deals with them now.
// -----------------------------------------------------------

describe('a pool wallet that will not do', () => {

	let world;

	before(async () => {
		world = await World.create('startup-defects');
	});

	after(() => world.close());


	pinDefect('placeholder-address-exits-zero', 'stop with a failing exit status when the pool wallet is the placeholder', async () => {
		const pool = new PoolProcess(world.writeConfig(world.config({ poolServer: { poolAddress: '** Your pool wallet address **' } })));
		world.pools.push(pool);
		const { code } = await pool.exited;
		assert.match(pool.output, /Invalid pool wallet address/);
		assert.notEqual(code, 0, 'the master refused the wallet and exited with status 0');
	});


	pinDefect('undecodable-pool-address-crash-loop', 'turn down a pool wallet that is no address, as it turns down the placeholder', async () => {
		const pool = new PoolProcess(world.writeConfig(world.config({ poolServer: { poolAddress: 'BitlitasWalletTypo' } })));
		world.pools.push(pool);
		await sleep(6000);
		const deaths = pool.count('Pool fork 1 died, spawning replacement worker...');
		assert.equal(pool.running, false, 'the master kept running, its pool worker dying ' + deaths + ' times in six seconds');
	});
});







// -----------------------------------------------------------
// Settings the pool starts with anyway
// -----------------------------------------------------------
//
// A stratum port another program already holds, and an
// algorithm the hashing module does not have.
// -----------------------------------------------------------

describe('a setting the pool cannot work with', () => {

	let world;

	before(async () => {
		world = await World.create('startup-defects-settings');
	});

	after(() => world.close());


	pinDefect('port-in-use-crash-loop', 'skip a stratum port another program holds, and serve the others', async () => {
		const squatter = net.createServer();
		await new Promise((resolve) => squatter.listen(world.port(4444), resolve));
		try {
			const pool = await world.startPool({}, { ready: false, portsFree: false });
			await pool.waitForOutput('Started server listening on port ' + world.port(3333) + '\n');
			await sleep(5000);
			const deaths = pool.count('Pool fork 1 died, spawning replacement worker...');
			assert.equal(deaths, 0, 'the pool worker crashed on the port in use ' + deaths + ' times in five seconds');
		} finally {
			squatter.close();
			await world.stopPools();
		}
	});


	pinDefect('unknown-algorithm-starts-anyway', 'answer a share when the configured algorithm is one the hashing module lacks', async () => {
		const pool = await world.startPool({ cnAlgorithm: 'randomxx' }, { cheapPort: true });
		try {
			assert.match(pool.output, /Invalid cryptonight algorithm: randomxx/);
			const miner = await world.stratum('cheap');
			await miner.login(REAL.miner);
			const reply = await miner.submit({ job_id: miner.job.job_id, nonce: '00000001', result: 'ab'.repeat(32) }, { timeout: 5000 });
			assert.ok(reply, 'the pool logged the bad algorithm, started, and leaves every share unanswered');
		} finally {
			await world.stopPools();
		}
	});
});
