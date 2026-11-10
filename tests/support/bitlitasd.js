// -----------------------------------------------------------
//  [*] Test support — the real bitlitasd and wallet RPC
//
//  The Bitlitas v0.18.3.1 daemon and wallet RPC the test
//  image copies from the stack's bitlitasd image, run in a
//  world's folder on a regtest chain of their own: offline,
//  at a fixed difficulty of 1, so every RandomX hash meets
//  the network's difficulty and every share the pool checks
//  is a block. A regtest chain runs under mainnet's address
//  prefixes and is at hard fork 16 from its first block. The
//  wallet RPC needs --allow-mismatched-daemon-version to
//  follow it (the fork heights are not mainnet's), and keeps
//  its ring database in the world's folder, the image's root
//  being read-only.
//
//  Used by:
//    - tests/flows/real-daemon.test.js
// -----------------------------------------------------------

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { claimPort } = require('./world.js');
const { waitFor } = require('./wait.js');







// -----------------------------------------------------------
// jsonRpc
// -----------------------------------------------------------
//
// One JSON-RPC 2.0 call to /json_rpc on a local port; resolves
// with the whole reply, rejects when the connection fails or
// the reply is no JSON.
//
// Used by:
//   - RealBitlitas (below)
// -----------------------------------------------------------

function jsonRpc (port, method, params = {}) {

	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
		const request = http.request({ host: '127.0.0.1', port, path: '/json_rpc', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => text += chunk);
			response.on('end', () => {
				try {
					resolve(JSON.parse(text));
				} catch (error) {
					reject(new Error(method + ' answered ' + text.slice(0, 200)));
				}
			});
		});
		request.on('error', reject);
		request.end(body);
	});
}







// -----------------------------------------------------------
// RealBitlitas
// -----------------------------------------------------------
//
// One bitlitasd and one bitlitas-wallet-rpc on ports of their
// own. `start` brings both up and waits until each answers;
// `daemon` and `wallet` make a JSON-RPC call and hand back the
// result, throwing with the error the binary gave;
// `createWallet` makes and opens a wallet and returns its
// address; `generate` mines blocks to an address; `stop` ends
// both processes.
//
// Used by:
//   - tests/flows/real-daemon.test.js
// -----------------------------------------------------------

class RealBitlitas {

	constructor (dir) {
		this.dir = path.join(dir, 'bitlitas');
		this.rpcPort = claimPort();
		this.walletPort = claimPort();
		this.p2pPort = claimPort();
		this.processes = [];
		fs.mkdirSync(path.join(this.dir, 'wallets'), { recursive: true });
	}


	run (binary, args) {
		const child = spawn(binary, args, { cwd: this.dir, env: { ...process.env, HOME: this.dir }, stdio: 'ignore' });
		this.processes.push(child);
		return child;
	}


	async start () {
		this.run('bitlitasd', [
			'--regtest', '--offline', '--fixed-difficulty', '1', '--non-interactive', '--no-igd', '--no-zmq',
			'--data-dir', path.join(this.dir, 'chain'), '--log-file', path.join(this.dir, 'bitlitasd.log'), '--log-level', '0',
			'--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(this.rpcPort),
			'--p2p-bind-ip', '127.0.0.1', '--p2p-bind-port', String(this.p2pPort)
		]);
		await waitFor(() => jsonRpc(this.rpcPort, 'get_info').then((reply) => reply.result && reply.result.status === 'OK'), { what: 'bitlitasd to answer', timeout: 60000, interval: 250 });
		this.run('bitlitas-wallet-rpc', [
			'--daemon-address', '127.0.0.1:' + this.rpcPort, '--trusted-daemon', '--allow-mismatched-daemon-version',
			'--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(this.walletPort), '--disable-rpc-login', '--non-interactive',
			'--wallet-dir', path.join(this.dir, 'wallets'), '--shared-ringdb-dir', path.join(this.dir, 'ringdb'),
			'--log-file', path.join(this.dir, 'wallet.log'), '--log-level', '0'
		]);
		await waitFor(() => jsonRpc(this.walletPort, 'get_version').then((reply) => reply.result), { what: 'the wallet RPC to answer', timeout: 60000, interval: 250 });
	}


	async call (port, method, params) {
		const reply = await jsonRpc(port, method, params);
		if (reply.error) throw new Error(method + ': ' + reply.error.message);
		return reply.result;
	}


	daemon (method, params) {
		return this.call(this.rpcPort, method, params);
	}


	wallet (method, params) {
		return this.call(this.walletPort, method, params);
	}


	async createWallet (name) {
		await this.wallet('create_wallet', { filename: name, language: 'English' });
		return (await this.wallet('get_address', {})).address;
	}


	generate (count, address) {
		return this.daemon('generateblocks', { amount_of_blocks: count, wallet_address: address });
	}


	stop () {
		for (const child of this.processes) child.kill('SIGKILL');
		this.processes = [];
	}
}







// What the suites take from here
module.exports = { RealBitlitas };
