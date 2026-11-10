// -----------------------------------------------------------
//  [*] Test support — the fake bitlitas-wallet-rpc
//
//  A JSON-RPC server answering the two wallet methods the
//  pool calls — transfer (payments) and getbalance (the API's
//  monitoring) — in the shapes bitlitas-wallet-rpc v0.18.3.1
//  answered them when the fixtures were captured. transfer
//  refuses what that wallet refused: an address that does not
//  decode, a zero amount, a standalone payment id (obsolete
//  since v0.18; only integrated addresses and subaddresses
//  carry one) and more than the unlocked balance. It ignores
//  the fee the pool asks for, as the real wallet does, and
//  charges the fee the captured transfers cost: 0.0026052 LTL
//  for one destination, 0.0008184 LTL more for each further
//  one.
//
//  Like the daemon, it can hang, answer an empty body or
//  garbage, or have one method overridden, and it keeps every
//  call.
//
//  Used by:
//    - tests/support/world.js
// -----------------------------------------------------------

const http = require('http');
const crypto = require('crypto');
const cnUtil = require('cryptoforknote-util');


// The fee the real wallet charged for one destination
// (tests/fixtures/bitlitasd-regtest.json)
const FIRST_DESTINATION_FEE = 2605200000;

// And what each further destination added to it
const FURTHER_DESTINATION_FEE = 818400000;

// The pool wallet's unlocked balance unless a test sets one:
// a thousand LTL
const DEFAULT_BALANCE = 1000 * 1e12;







// -----------------------------------------------------------
// decodes
// -----------------------------------------------------------
//
// Whether the wallet would take an address: one the native
// decoder reads as a standard or subaddress (a number back)
// or as an integrated address.
//
// Used by:
//   - FakeWallet.transfer (below)
// -----------------------------------------------------------

function decodes (address) {

	if (typeof address !== 'string' || address === '') return false;
	const buffer = Buffer.from(address);
	return typeof cnUtil.address_decode(buffer) === 'number' || Boolean(cnUtil.address_decode_integrated(buffer));
}







// -----------------------------------------------------------
// FakeWallet
// -----------------------------------------------------------
//
// The wallet of one test world. `balance` is the unlocked
// balance a transfer spends from; `mode` and `override` work
// as the fake daemon's do. Each accepted transfer gets a new
// random transaction hash and is kept in `transfers`.
//
// Used by:
//   - tests/support/world.js
// -----------------------------------------------------------

class FakeWallet {

	constructor (port) {
		this.port = port;
		this.balance = DEFAULT_BALANCE;
		this.mode = 'ok';
		this.overrides = {};
		this.calls = [];
		this.transfers = [];
		this.sockets = new Set();
		this.server = null;
	}


	async start () {
		this.server = http.createServer((request, response) => this.handle(request, response));
		this.server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.port, '127.0.0.1', resolve);
		});
	}


	async stop () {
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		for (const socket of this.sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	}


	override (method, answer) {
		this.overrides[method] = answer;
	}


	callsOf (method) {
		return this.calls.filter((call) => call.method === method);
	}


	handle (request, response) {
		let body = '';
		request.setEncoding('utf8');
		request.on('data', (chunk) => body += chunk);
		request.on('end', () => {
			let one = null;
			try {
				one = JSON.parse(body);
			} catch (e) {
				one = null;
			}
			if (one) this.calls.push({ method: one.method, params: one.params, at: Date.now() });


			if (this.mode === 'hang') return;
			if (this.mode === 'empty') return response.end();
			if (this.mode === 'garbage') return response.end('<html>502 Bad Gateway</html>');
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(this.reply(one)));
		});
	}


	reply (one) {
		const envelope = { id: one ? one.id : '0', jsonrpc: '2.0' };
		if (!one || !one.method) return { ...envelope, error: { code: -32600, message: 'Invalid Request' } };
		const override = this.overrides[one.method];
		if (override) {
			const answer = typeof override === 'function' ? override(one.params, this) : override;
			return { ...envelope, ...answer };
		}
		if (one.method === 'getbalance') {
			return { ...envelope, result: { balance: this.balance, blocks_to_unlock: 0, multisig_import_needed: false, time_to_unlock: 0, unlocked_balance: this.balance } };
		}
		if (one.method === 'transfer') return { ...envelope, ...this.transfer(one.params || {}) };
		return { ...envelope, error: { code: -32601, message: 'Method not found' } };
	}


	transfer (params) {
		const destinations = params.destinations || [];
		for (const destination of destinations) {
			if (!decodes(destination.address)) {
				return { error: { code: -2, message: 'WALLET_RPC_ERROR_CODE_WRONG_ADDRESS: ' + destination.address } };
			}
			if (!destination.amount) return { error: { code: -46, message: 'destination amount is zero' } };
		}
		if (params.payment_id) {
			return { error: { code: -5, message: 'Standalone payment IDs are obsolete. Use subaddresses or integrated addresses instead' } };
		}
		const amount = destinations.reduce((sum, destination) => sum + destination.amount, 0);
		const fee = FIRST_DESTINATION_FEE + FURTHER_DESTINATION_FEE * (destinations.length - 1);
		if (amount + fee > this.balance) return { error: { code: -17, message: 'not enough money' } };


		this.balance -= amount + fee;
		const txHash = crypto.randomBytes(32).toString('hex');
		this.transfers.push({ txHash, amount, fee, destinations, params });
		return {
			result: {
				amount,
				fee,
				multisig_txset: '',
				spent_key_images: { key_images: [crypto.randomBytes(32).toString('hex')] },
				tx_blob: '',
				tx_hash: txHash,
				tx_key: '',
				tx_metadata: '',
				unsigned_txset: '',
				weight: 2166 + 687 * (destinations.length - 1)
			}
		};
	}
}







// What the suites take from here
module.exports = { FakeWallet, FIRST_DESTINATION_FEE, FURTHER_DESTINATION_FEE, DEFAULT_BALANCE };
