// -----------------------------------------------------------
//  [*] Tests — the pool against the real bitlitasd and wallet
//
//  No fake in the pool's way: the whole pool runs against
//  bitlitasd and bitlitas-wallet-rpc v0.18.3.1 on a regtest
//  chain of their own, offline. The daemon checks what the
//  pool submits the way the network's nodes would — the blob,
//  the previous block, the RandomX proof of work — and the
//  wallet builds, signs and relays a real transaction. The
//  chain's difficulty is fixed at 1, so the share a miner
//  sends on the test port is a block; the 60 blocks a block
//  must be buried under, and the decoys a transaction's ring
//  needs, the daemon mines itself. The tests run in order, one
//  block's life from template to payment. The unlocker runs
//  every second, the payments every two, and the API collects
//  every second.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { World } = require('../support/world.js');
const { RealBitlitas } = require('../support/bitlitasd.js');
const { REAL } = require('../support/addresses.js');
const { apiGet } = require('../support/http.js');
const { waitFor } = require('../support/wait.js');


// The genesis block's hash, which keys RandomX for the first
// 2112 blocks of every Bitlitas chain
const GENESIS = '418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3';

// The pool fee of the shipped file
const POOL_FEE = 0.01;







// -----------------------------------------------------------
// A block on the real chain
// -----------------------------------------------------------
//
// The block one share makes, from the real template to the
// real transaction that pays its miner.
// -----------------------------------------------------------

describe('a block on a real Bitlitas chain', () => {

	let world;
	let bitlitas;
	let pool;
	let miner;
	let height;
	let blockHash;

	before(async () => {
		world = await World.create('real-daemon');
		bitlitas = new RealBitlitas(world.dir);
		await bitlitas.start();
		const poolWallet = await bitlitas.createWallet('pool');
		// Outputs old enough to be the decoys of a transaction's ring
		await bitlitas.generate(80, REAL.miner);
		const config = {
			poolServer: { poolAddress: poolWallet },
			daemon: { port: bitlitas.rpcPort },
			wallet: { port: bitlitas.walletPort },
			blockUnlocker: { interval: 1 },
			payments: { interval: 2 },
			api: { updateInterval: 1 }
		};
		pool = await world.startPool(config, { cheapPort: true });
		miner = await world.stratum('cheap');
		await miner.login(REAL.miner, 'regtest-rig');
	});

	after(() => {
		if (bitlitas) bitlitas.stop();
		return world.close();
	});


	it('hands out jobs for the real chain\'s next height, keyed by the genesis seed', async () => {
		const info = await bitlitas.daemon('get_info');
		assert.equal(miner.job.height, info.height);
		assert.equal(miner.job.seed_hash, GENESIS);
		assert.equal(miner.job.blob.slice(14, 78), info.top_block_hash);
	});


	it('turns a share into a block bitlitasd takes as its new tip', async () => {
		height = miner.job.height;
		assert.equal((await miner.submit(miner.mine())).result.status, 'OK');
		const tip = await waitFor(async () => {
			const header = (await bitlitas.daemon('getlastblockheader')).block_header;
			return header.height === height && header;
		}, { what: 'bitlitasd to take the block', explain: () => pool.tail() });
		blockHash = tip.hash;
		const [candidate] = await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:candidates', height, height).then((list) => list.length && list), { what: 'the candidate' });
		assert.equal(candidate.split(':')[2], blockHash);
		assert.equal(candidate.split(':')[1], REAL.miner);
	});


	it('moves the miner on to the height after it', async () => {
		assert.ok(await miner.jobAtHeight(height + 1));
	});


	it('shows the real network and the real last block through the API', async () => {
		const reply = await waitFor(async () => {
			const answer = await apiGet(world.apiPort, '/stats');
			return answer.json && answer.json.lastblock && answer.json.lastblock.hash === blockHash && answer;
		}, { what: 'the block in /stats' });
		assert.equal(reply.json.network.height, height + 1);
		assert.equal(reply.json.lastblock.height, height);
	});


	it('matures the block once the chain is 60 blocks deeper, crediting its real reward', async () => {
		await bitlitas.generate(60, REAL.miner);
		const header = (await bitlitas.daemon('getblockheaderbyheight', { height })).block_header;
		const [matured] = await waitFor(() => world.redis.call('zrangebyscore', 'bitlitas:blocks:matured', height, height).then((list) => list.length && list), { what: 'the block matured', explain: () => pool.tail() });
		assert.equal(matured.split(':')[7], String(header.reward));
		const balance = Number(await world.redis.call('hget', 'bitlitas:workers:' + REAL.miner, 'balance'));
		assert.equal(balance, Math.round(header.reward - header.reward * POOL_FEE));
	});


	it('pays the miner with a transaction the real wallet builds and signs', async () => {
		// A new wallet starts scanning near mainnet's height, past
		// every block of this regtest chain
		await bitlitas.wallet('refresh', { start_height: 0 });
		const record = await waitFor(async () => {
			const list = await world.redis.call('zrange', 'bitlitas:payments:' + REAL.miner, 0, -1);
			return list[0];
		}, { what: 'the payment', timeout: 60000, explain: () => pool.tail() });
		const [txHash, amount] = record.split(':');
		const transfer = (await bitlitas.wallet('get_transfer_by_txid', { txid: txHash })).transfer;
		assert.deepEqual(transfer.destinations, [{ address: REAL.miner, amount: Number(amount) }]);
		assert.equal(transfer.type, 'pending');
	});


	it('sees the payment mined into the next block', async () => {
		const [record] = await world.redis.call('zrange', 'bitlitas:payments:' + REAL.miner, 0, -1);
		await bitlitas.generate(1, REAL.miner);
		await bitlitas.wallet('refresh', {});
		const transfer = (await bitlitas.wallet('get_transfer_by_txid', { txid: record.split(':')[0] })).transfer;
		assert.equal(transfer.type, 'out');
		assert.equal(transfer.height, (await bitlitas.daemon('get_info')).height - 1);
	});
});
