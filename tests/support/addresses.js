// -----------------------------------------------------------
//  [*] Test support — Bitlitas addresses
//
//  Every wallet address the suite logs in with or pays to.
//  Four are real: a throwaway bitlitas-wallet-rpc v0.18.3.1
//  made them on a regtest chain when the fixtures were
//  captured (tests/fixtures/bitlitasd-regtest.json) — a
//  standard address, a subaddress and an integrated address
//  of one wallet, and the pool wallet's own address. Their
//  keys lived in that container's tmpfs and are gone.
//
//  The rest are built here the way the Bitlitas wallet
//  builds them: the network prefix as a varint, the spend and
//  view public keys (and the payment id of an integrated
//  address), and the first four bytes of their Keccak-256 as
//  the checksum, all in Monero's block-wise base58. The keys
//  are real Ed25519 points derived from a label, so the
//  pool's native decoder accepts them, and the same label
//  always gives the same address. The prefixes are those of
//  Bitlitas mainnet in src/cryptonote_config.h of the v0.18
//  source: 18 standard, 19 integrated, 42 subaddress.
//
//  Split into:
//
//    keccak256          — the original Keccak-256 (cn_fast_hash)
//    base58Encode       — Monero's block-wise base58
//    base58Decode       — its inverse
//    encodeVarint       — the prefix varint
//    publicKey          — a real Ed25519 point from a label
//    makeAddress        — any address from prefix, keys, payment id
//    address            — a standard Bitlitas address by label
//    integratedAddress  — an integrated one by label and id
//    subaddress         — a subaddress by label
//    decodeAddress      — prefix, keys and checksum check
//    withBadChecksum    — the same address, checksum broken
//
//  Used by:
//    - every suite that logs a miner in or pays one
// -----------------------------------------------------------

const crypto = require('crypto');
const fixtures = require('../fixtures/bitlitasd-regtest.json');


// Bitlitas mainnet base58 prefixes (src/cryptonote_config.h)
const PREFIX = { standard: 18, integrated: 19, subaddress: 42 };

// The base58 alphabet of Monero and its forks
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// How many base58 characters a block of 0..8 bytes takes
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

// Keccak-f[1600]'s round constants
const ROUND_CONSTANTS = [
	0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
	0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
	0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
	0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
	0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
	0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

// The rho rotation of each Keccak lane, indexed by x + 5 * y
const ROTATIONS = [
	0, 1, 62, 28, 27,
	36, 44, 6, 55, 20,
	3, 10, 43, 25, 39,
	41, 45, 15, 21, 8,
	18, 2, 61, 56, 14
];
// A lane is 64 bits
const MASK64 = 2n ** 64n - 1n;

// Keccak-256 absorbs 136 bytes per permutation
const RATE = 136;

// DER wrappers around a raw Ed25519 seed and public key
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

// The real addresses of the fixture wallet
const REAL = fixtures.addresses;







// -----------------------------------------------------------
// keccak256
// -----------------------------------------------------------
//
// The original Keccak-256, the cn_fast_hash of CryptoNote —
// not the SHA3-256 Node ships, which pads differently. The
// state is 25 lanes of 64 bits held as BigInts; speed does
// not matter for a few dozen addresses.
//
// Used by:
//   - makeAddress, decodeAddress (below),
//     tests/units/addresses.test.js
// -----------------------------------------------------------

function keccak256 (data) {

	const state = new Array(25).fill(0n);
	const padded = Buffer.alloc(Math.floor(data.length / RATE + 1) * RATE);
	data.copy(padded);
	padded[data.length] ^= 0x01;
	padded[padded.length - 1] ^= 0x80;


	for (let offset = 0; offset < padded.length; offset += RATE) {
		for (let lane = 0; lane < RATE / 8; lane++) {
			state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
		}
		permute(state);
	}


	const out = Buffer.alloc(32);
	for (let lane = 0; lane < 4; lane++) {
		out.writeBigUInt64LE(state[lane], lane * 8);
	}
	return out;
}







// -----------------------------------------------------------
// permute
// -----------------------------------------------------------
//
// The 24 rounds of Keccak-f[1600] over the state in place:
// theta, rho and pi, chi, iota.
//
// Used by:
//   - keccak256 (above)
// -----------------------------------------------------------

function permute (state) {

	const rotl = (value, by) => by === 0 ? value : ((value << BigInt(by)) | (value >> BigInt(64 - by))) & MASK64;
	for (let round = 0; round < 24; round++) {
		const columns = [0, 1, 2, 3, 4].map(x => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
		for (let x = 0; x < 5; x++) {
			const d = columns[(x + 4) % 5] ^ rotl(columns[(x + 1) % 5], 1);
			for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
		}


		const moved = new Array(25);
		for (let x = 0; x < 5; x++) {
			for (let y = 0; y < 5; y++) {
				moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATIONS[x + 5 * y]);
			}
		}


		for (let y = 0; y < 25; y += 5) {
			for (let x = 0; x < 5; x++) {
				state[x + y] = moved[x + y] ^ ((~moved[(x + 1) % 5 + y] & MASK64) & moved[(x + 2) % 5 + y]);
			}
		}
		state[0] ^= ROUND_CONSTANTS[round];
	}
}







// -----------------------------------------------------------
// base58Encode
// -----------------------------------------------------------
//
// Monero's base58: the data in blocks of eight bytes, each
// written as eleven characters (a shorter last block takes
// the size ENCODED_BLOCK_SIZES gives it), every block padded
// with the alphabet's first character on the left.
//
// Used by:
//   - makeAddress, withBadChecksum (below)
// -----------------------------------------------------------

function base58Encode (data) {

	let text = '';
	for (let offset = 0; offset < data.length; offset += 8) {
		const block = data.subarray(offset, offset + 8);
		let value = BigInt('0x' + (block.toString('hex') || '0'));
		let chars = '';
		while (value > 0n) {
			chars = ALPHABET[Number(value % 58n)] + chars;
			value /= 58n;
		}
		text += chars.padStart(ENCODED_BLOCK_SIZES[block.length], ALPHABET[0]);
	}
	return text;
}







// -----------------------------------------------------------
// base58Decode
// -----------------------------------------------------------
//
// The inverse of base58Encode: blocks of eleven characters,
// the last one's length telling how many bytes it held.
// Returns nothing for text that is not this base58.
//
// Used by:
//   - decodeAddress, withBadChecksum (below)
// -----------------------------------------------------------

function base58Decode (text) {

	const parts = [];
	for (let offset = 0; offset < text.length; offset += 11) {
		const chars = text.slice(offset, offset + 11);
		const size = ENCODED_BLOCK_SIZES.indexOf(chars.length);
		if (size < 0) return null;
		let value = 0n;
		for (const char of chars) {
			const digit = ALPHABET.indexOf(char);
			if (digit < 0) return null;
			value = value * 58n + BigInt(digit);
		}
		const hex = value.toString(16).padStart(size * 2, '0');
		if (hex.length > size * 2) return null;
		parts.push(Buffer.from(hex, 'hex'));
	}
	return Buffer.concat(parts);
}







// -----------------------------------------------------------
// encodeVarint
// -----------------------------------------------------------
//
// A CryptoNote varint: seven bits per byte, low bits first,
// the high bit set on every byte but the last.
//
// Used by:
//   - makeAddress (below), tests/support/chain.js
// -----------------------------------------------------------

function encodeVarint (number) {

	let value = BigInt(number);
	const bytes = [];
	do {
		let byte = Number(value & 0x7fn);
		value >>= 7n;
		if (value > 0n) byte |= 0x80;
		bytes.push(byte);
	} while (value > 0n);
	return Buffer.from(bytes);
}







// -----------------------------------------------------------
// publicKey
// -----------------------------------------------------------
//
// A real Ed25519 public key whose secret seed is the SHA-256
// of the label — a valid curve point, which is what the
// wallet's check_key (and so the pool's address decoder)
// insists on.
//
// Used by:
//   - address, integratedAddress, subaddress (below)
// -----------------------------------------------------------

function publicKey (label) {

	const seed = crypto.createHash('sha256').update(label).digest();
	const secret = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
	return crypto.createPublicKey(secret).export({ format: 'der', type: 'spki' }).subarray(-32);
}







// -----------------------------------------------------------
// makeAddress
// -----------------------------------------------------------
//
// Any CryptoNote address from its parts: the network prefix,
// the spend and view keys, and for an integrated address the
// eight-byte payment id, sealed with the Keccak checksum.
// Tests use it directly for addresses of other networks.
//
// Used by:
//   - address, integratedAddress, subaddress (below),
//     tests/units/addresses.test.js, tests/stratum/login.test.js
// -----------------------------------------------------------

function makeAddress (prefix, spendKey, viewKey, paymentId) {

	const body = Buffer.concat([encodeVarint(prefix), spendKey, viewKey, paymentId || Buffer.alloc(0)]);
	return base58Encode(Buffer.concat([body, keccak256(body).subarray(0, 4)]));
}







// -----------------------------------------------------------
// address
// -----------------------------------------------------------
//
// The standard Bitlitas address of a label — the same label
// gives the same address in every run.
//
// Used by:
//   - the stratum, unlocker, payment and API suites
// -----------------------------------------------------------

function address (label) {

	return makeAddress(PREFIX.standard, publicKey(label + ':spend'), publicKey(label + ':view'));
}







// -----------------------------------------------------------
// integratedAddress
// -----------------------------------------------------------
//
// The integrated address of a label's wallet with the given
// eight-byte payment id (sixteen hex characters).
//
// Used by:
//   - tests/units/addresses.test.js, tests/payments/payments.test.js
// -----------------------------------------------------------

function integratedAddress (label, paymentIdHex) {

	return makeAddress(PREFIX.integrated, publicKey(label + ':spend'), publicKey(label + ':view'), Buffer.from(paymentIdHex, 'hex'));
}







// -----------------------------------------------------------
// subaddress
// -----------------------------------------------------------
//
// A subaddress-prefixed address for a label. Its keys are
// not derived from a wallet the way a real subaddress's are,
// which no decoder can tell.
//
// Used by:
//   - tests/units/addresses.test.js
// -----------------------------------------------------------

function subaddress (label) {

	return makeAddress(PREFIX.subaddress, publicKey(label + ':sub-spend'), publicKey(label + ':sub-view'));
}







// -----------------------------------------------------------
// decodeAddress
// -----------------------------------------------------------
//
// Takes an address apart: its prefix, the keys, the payment
// id when it carries one, and whether the checksum holds.
// Returns nothing for text that is not base58 at all.
//
// Used by:
//   - tests/units/addresses.test.js, tests/stratum/login.test.js
// -----------------------------------------------------------

function decodeAddress (text) {

	const raw = base58Decode(text);
	if (!raw || raw.length < 69) return null;
	let prefix = 0;
	let shift = 0;
	let offset = 0;
	while (true) {
		const byte = raw[offset++];
		prefix += (byte & 0x7f) * 2 ** shift;
		shift += 7;
		if (!(byte & 0x80)) break;
	}
	const body = raw.subarray(0, raw.length - 4);
	return {
		prefix,
		spendKey: raw.subarray(offset, offset + 32),
		viewKey: raw.subarray(offset + 32, offset + 64),
		paymentId: raw.length - 4 - offset > 64 ? raw.subarray(offset + 64, raw.length - 4) : null,
		checksumValid: keccak256(body).subarray(0, 4).equals(raw.subarray(raw.length - 4))
	};
}







// -----------------------------------------------------------
// withBadChecksum
// -----------------------------------------------------------
//
// The same address with the last checksum byte flipped — the
// shape a typo in the last characters leaves.
//
// Used by:
//   - tests/units/addresses.test.js, tests/stratum/login.test.js
// -----------------------------------------------------------

function withBadChecksum (text) {

	const raw = base58Decode(text);
	raw[raw.length - 1] ^= 0xff;
	return base58Encode(raw);
}







// What the suites take from here
module.exports = {
	PREFIX,
	REAL,
	keccak256,
	base58Encode,
	base58Decode,
	encodeVarint,
	publicKey,
	makeAddress,
	address,
	integratedAddress,
	subaddress,
	decodeAddress,
	withBadChecksum
};
