// -----------------------------------------------------------
//  [*] Tests — which addresses the pool takes (lib/utils.js)
//
//  The address rules a login and a payment go through, loaded
//  the way a pool worker loads them: with the shipped
//  configuration (and a real pool wallet) as the global
//  `config`. lib/utils.js reads the standard prefix off the
//  pool's own address, the integrated prefix from
//  intAddressPrefix and the subaddress prefix from
//  subAddressPrefix, which the shipped file does not set. The
//  real addresses are a wallet's of bitlitas-wallet-rpc
//  v0.18.3.1; the suite's own builder is held to them first,
//  since every other suite logs in with addresses it builds.
// -----------------------------------------------------------

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const cnUtil = require('cryptoforknote-util');
const { sandboxConfig } = require('../support/world.js');
const addresses = require('../support/addresses.js');


// The real addresses of the fixture wallet
const { REAL } = addresses;

// The Bitlitas testnet prefix (src/cryptonote_config.h)
const TESTNET_PREFIX = 53;







// -----------------------------------------------------------
// The suite's address builder
// -----------------------------------------------------------
//
// The builder the other suites take their addresses from,
// held to a real wallet's and to the native decoder.
// -----------------------------------------------------------

describe('the suite\'s address builder', () => {

	it('hashes with the original Keccak-256, not SHA3', () => {
		assert.equal(addresses.keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
		assert.equal(addresses.keccak256(Buffer.from('a'.repeat(200))).length, 32);
	});


	it('takes a real wallet\'s addresses apart and puts them back together unchanged', () => {
		for (const text of [REAL.pool, REAL.miner, REAL.subaddress, REAL.integrated]) {
			const decoded = addresses.decodeAddress(text);
			assert.equal(decoded.checksumValid, true);
			assert.equal(addresses.makeAddress(decoded.prefix, decoded.spendKey, decoded.viewKey, decoded.paymentId), text);
		}
	});


	it('reads the Bitlitas prefixes and the integrated address\'s payment id off the real addresses', () => {
		assert.equal(addresses.decodeAddress(REAL.miner).prefix, 18);
		assert.equal(addresses.decodeAddress(REAL.subaddress).prefix, 42);
		assert.equal(addresses.decodeAddress(REAL.integrated).prefix, 19);
		assert.equal(addresses.decodeAddress(REAL.integrated).paymentId.toString('hex'), addresses.REAL.integrated_payment_id);
		assert.deepEqual(addresses.decodeAddress(REAL.integrated).spendKey, addresses.decodeAddress(REAL.miner).spendKey);
	});


	it('builds addresses the native decoder accepts, the same for the same label', () => {
		assert.equal(addresses.address('alice'), addresses.address('alice'));
		assert.notEqual(addresses.address('alice'), addresses.address('bob'));
		assert.equal(cnUtil.address_decode(Buffer.from(addresses.address('alice'))), 18);
		assert.equal(cnUtil.address_decode_integrated(Buffer.from(addresses.integratedAddress('alice', '00112233aabbccdd'))), 19);
		assert.equal(cnUtil.address_decode(Buffer.from(addresses.subaddress('alice'))), 42);
	});
});







// -----------------------------------------------------------
// The pool's rules under the shipped configuration
// -----------------------------------------------------------
//
// lib/utils.js deciding on addresses with the shipped
// prefixes.
// -----------------------------------------------------------

describe('the pool\'s address rules under the shipped configuration', () => {

	let utils;

	before(() => {
		global.config = sandboxConfig();
		utils = require('../../lib/utils.js');
	});


	it('take a real standard address and a built one', () => {
		assert.equal(utils.validateMinerAddress(REAL.miner), true);
		assert.equal(utils.validateMinerAddress(REAL.pool), true);
		assert.equal(utils.validateMinerAddress(addresses.address('carol')), true);
	});


	it('take an integrated address and know it for one', () => {
		assert.equal(utils.validateMinerAddress(REAL.integrated), true);
		assert.equal(utils.isIntegratedAddress(REAL.integrated), true);
		assert.equal(utils.isIntegratedAddress(REAL.miner), false);
	});


	it('read each kind\'s prefix, and nothing off text that is no address', () => {
		assert.equal(utils.getAddressPrefix(REAL.miner), 18);
		assert.equal(utils.getAddressPrefix(REAL.integrated), 19);
		assert.equal(utils.getAddressPrefix(REAL.subaddress), 42);
		assert.equal(utils.getAddressPrefix('not an address'), null);
	});


	it('refuse an address whose last characters were mistyped', () => {
		assert.equal(utils.validateMinerAddress(addresses.withBadChecksum(REAL.miner)), false);
	});


	it('refuse a testnet address', () => {
		const decoded = addresses.decodeAddress(REAL.miner);
		assert.equal(utils.validateMinerAddress(addresses.makeAddress(TESTNET_PREFIX, decoded.spendKey, decoded.viewKey)), false);
	});


	it('take a Monero address too, since both coins use prefix 18', () => {
		// The XMR donation address lib/configReader.js carries
		const moneroAddress = '49WyMy9Q351C59dT913ieEgqWjaN12dWM5aYqJxSTZCZZj1La5twZtC3DyfUsmVD3tj2Zud7m6kqTVDauRz53FqA9zphHaj';
		assert.equal(utils.validateMinerAddress(moneroAddress), true);
	});


	it('refuse a subaddress, because the shipped file names no subaddress prefix', () => {
		assert.equal(global.config.poolServer.subAddressPrefix, undefined);
		assert.equal(utils.validateMinerAddress(REAL.subaddress), false);
	});
});
