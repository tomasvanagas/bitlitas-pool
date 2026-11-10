// -----------------------------------------------------------
//  [*] Tests — the shipped Bitlitas configuration
//
//  config_examples/bitlitas.json held to the coin it is for.
//  The constants come from src/cryptonote_config.h and
//  src/hardforks/hardforks.cpp of the Bitlitas v0.18 source
//  (the GitLab tree, release 0.18.3.1), the version whose
//  daemon and wallet produced the fixtures: atomic units per
//  coin, the block target, the base58 prefixes, the RPC port
//  and the coinbase unlock window. A value here that drifts
//  from the coin makes the pool pay, display or validate
//  wrongly without any error, which only these tests notice.
//  What the values DO at run time — the addresses a login
//  takes, the hash a share needs — is tested by the suites
//  that run the pool.
// -----------------------------------------------------------

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { POOL_ROOT } = require('../support/pool-process.js');


// Atomic units per LTL (COIN)
const COIN = 1e12;

// The block target in seconds (DIFFICULTY_TARGET_V2)
const DIFFICULTY_TARGET_V2 = 120;

// The base58 prefix of integrated addresses
const INTEGRATED_ADDRESS_PREFIX = 19;

// The daemon's RPC port on mainnet
const RPC_DEFAULT_PORT = 18281;

// The blocks a coinbase stays locked
// (CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW)
const MINED_MONEY_UNLOCK_WINDOW = 60;

// The shipped configuration
const CONFIG = JSON.parse(fs.readFileSync(path.join(POOL_ROOT, 'config_examples', 'bitlitas.json'), 'utf8'));







// -----------------------------------------------------------
// The coin
// -----------------------------------------------------------
//
// What the configuration says Bitlitas is, held to the
// coin's own source.
// -----------------------------------------------------------

describe('the coin the configuration names', () => {

	it('is Bitlitas, LTL, on the pool host the explorer links share', () => {
		assert.equal(CONFIG.coin, 'bitlitas');
		assert.equal(CONFIG.symbol, 'LTL');
		assert.equal(CONFIG.poolHost, 'pool.bitlitas.lt');
		assert.equal(CONFIG.blockchainExplorer, 'https://explorer.bitlitas.lt/block/{id}');
		assert.equal(CONFIG.transactionExplorer, 'https://explorer.bitlitas.lt/tx/{id}');
	});


	it('counts in the atomic units of the coin, shown with four decimals', () => {
		assert.equal(CONFIG.coinUnits, COIN);
		assert.equal(CONFIG.coinDecimalPlaces, 4);
	});


	it('expects a block every 120 seconds, the target the daemon keeps', () => {
		assert.equal(CONFIG.coinDifficultyTarget, DIFFICULTY_TARGET_V2);
	});


	it('mines RandomX as Monero does: variant 0, the standard blob, the height in each job', () => {
		assert.equal(CONFIG.cnAlgorithm, 'randomx');
		assert.equal(CONFIG.cnVariant, 0);
		assert.equal(CONFIG.cnBlobType, 0);
		assert.equal(CONFIG.isRandomX, true);
		assert.equal(CONFIG.includeHeight, true);
		assert.equal(CONFIG.poolServer.mergedMining, false);
	});
});







// -----------------------------------------------------------
// Addresses and services
// -----------------------------------------------------------
//
// The address prefixes, the placeholders an operator must
// replace, and where the pool finds its daemon, wallet and
// database.
// -----------------------------------------------------------

describe('addresses and the services the pool reaches', () => {

	it('takes integrated addresses under the Bitlitas prefix', () => {
		assert.equal(CONFIG.poolServer.intAddressPrefix, INTEGRATED_ADDRESS_PREFIX);
	});


	it('leaves the pool wallet as a placeholder the operator must replace', () => {
		assert.equal(CONFIG.poolServer.poolAddress, '** Your pool wallet address **');
	});


	it('finds the daemon on its default RPC port and the wallet RPC beside it, both local', () => {
		assert.deepEqual(CONFIG.daemon, { host: '127.0.0.1', port: RPC_DEFAULT_PORT });
		assert.deepEqual(CONFIG.wallet, { host: '127.0.0.1', port: 18283 });
		assert.equal(CONFIG.redis.host, '127.0.0.1');
		assert.equal(CONFIG.redis.port, 6379);
	});


	it('keeps the API password at its placeholder', () => {
		assert.equal(CONFIG.api.password, 'your_password');
		assert.equal(CONFIG.api.trustProxyIP, true);
	});


	it('names certificate files for its SSL port that the repository does not ship', () => {
		const sslPorts = CONFIG.poolServer.ports.filter((port) => port.ssl);
		assert.deepEqual(sslPorts.map((port) => port.port), [9999]);
		assert.equal(fs.existsSync(path.join(POOL_ROOT, CONFIG.poolServer.sslCert)), false);
		assert.equal(fs.existsSync(path.join(POOL_ROOT, CONFIG.poolServer.sslKey)), false);
	});


	it('sends no email and no telegram message', () => {
		assert.equal(CONFIG.email.enabled, false);
		assert.equal(CONFIG.telegram.enabled, false);
	});
});







// -----------------------------------------------------------
// Rewards and payments
// -----------------------------------------------------------
//
// The unlocker credits a block only at a depth where its
// coinbase is spendable; a shallower depth would have the
// wallet pay from coins it cannot spend yet.
// -----------------------------------------------------------

describe('rewards and payments', () => {

	it('credits a block no earlier than its coinbase unlocks', () => {
		assert.ok(CONFIG.blockUnlocker.depth >= MINED_MONEY_UNLOCK_WINDOW);
	});


	it('keeps a one percent pool fee and gives nothing to the developers or the network', () => {
		assert.equal(CONFIG.blockUnlocker.poolFee, 1);
		assert.equal(CONFIG.blockUnlocker.devDonation, 0);
		assert.equal(CONFIG.blockUnlocker.networkFee, 0);
		assert.equal(CONFIG.blockUnlocker.finderReward, undefined);
	});


	it('pays from one LTL in steps of a tenth, charging each miner a 0.014 LTL fee', () => {
		assert.equal(CONFIG.payments.minPayment, COIN);
		assert.equal(CONFIG.payments.denomination, COIN / 10);
		assert.equal(CONFIG.payments.transferFee, 0.014 * COIN);
		assert.equal(CONFIG.payments.dynamicTransferFee, true);
		assert.equal(CONFIG.payments.minerPayFee, true);
		assert.equal(CONFIG.payments.maxAddresses, 50);
	});


	it('asks the wallet for a mixin, a field the v0.18 wallet RPC no longer reads', () => {
		// COMMAND_RPC_TRANSFER of the v0.18 wallet reads ring_size only,
		// so the wallet picks the ring size its hard fork requires
		assert.equal(CONFIG.payments.mixin, 7);
		assert.equal(CONFIG.payments.ringSize, undefined);
	});
});







// -----------------------------------------------------------
// Market prices
// -----------------------------------------------------------
//
// Bitlitas trades nowhere. The price source names an exchange
// lib/market.js does not support, so a price lookup never
// leaves the pool, and the charts that would need a price are
// off.
// -----------------------------------------------------------

describe('market prices', () => {

	it('names a price source the market module does not support', () => {
		const market = fs.readFileSync(path.join(POOL_ROOT, 'lib', 'market.js'), 'utf8');
		const marketsBranch = market.slice(market.indexOf('function getExchangeMarkets'), market.indexOf('exports.getExchangeMarkets'));
		assert.equal(CONFIG.prices.source, 'cryptonator');
		assert.equal(marketsBranch.includes('exchange == "cryptonator"'), false);
	});


	it('keeps the price and profit charts off', () => {
		assert.equal(CONFIG.charts.pool.price.enabled, false);
		assert.equal(CONFIG.charts.pool.profit.enabled, false);
	});
});
