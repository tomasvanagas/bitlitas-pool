// -----------------------------------------------------------
//  [*] Tests — the API over HTTPS
//
//  With api.ssl on, the API serves the same calls on sslPort
//  over TLS as well, from the certificate, key and authority
//  files the configuration names — the shipped file leaves it
//  off and names files the repository does not ship. A
//  missing file, or one not named, is logged and leaves the
//  API on plain HTTP alone. The certificate here is a
//  throwaway one openssl makes for the test.
// -----------------------------------------------------------

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { World } = require('../support/world.js');
const { apiGet } = require('../support/http.js');







// -----------------------------------------------------------
// httpsGet
// -----------------------------------------------------------
//
// One HTTPS request to the API's SSL port, the throwaway
// certificate accepted; resolves with the status, headers and
// body, or the connection error.
//
// Used by:
//   - the tests (below)
// -----------------------------------------------------------

function httpsGet (port, requestPath, method = 'GET') {

	return new Promise((resolve) => {
		const request = https.request({ host: '127.0.0.1', port, path: requestPath, method, rejectUnauthorized: false, agent: false }, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => body += chunk);
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
		});
		request.on('error', (error) => resolve({ status: null, error: error.code }));
		request.end();
	});
}







// -----------------------------------------------------------
// HTTPS
// -----------------------------------------------------------
//
// One API with the files in place, then one without its
// authority file.
// -----------------------------------------------------------

describe('the API with SSL on', () => {

	let world;
	let files;

	before(async () => {
		world = await World.create('api-ssl');
		files = { sslKey: path.join(world.dir, 'privkey.pem'), sslCert: path.join(world.dir, 'cert.pem') };
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', files.sslKey, '-out', files.sslCert, '-days', '2', '-subj', '/CN=pool.bitlitas.lt'], { stdio: 'ignore' });
		await world.startPool({ api: { ssl: true, updateInterval: 1, ...files, sslCA: files.sslCert } }, { module: 'api' });
		await world.pools[0].waitForOutput(/API started & listening on 0\.0\.0\.0 port \d+ \(SSL\)/);
	});

	after(() => world.close());


	it('answers the same calls over TLS on the SSL port', async () => {
		const reply = await httpsGet(world.apiSslPort, '/block_explorers');
		assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(reply.body).bitlitas.blockchainExplorer, 'https://explorer.bitlitas.lt/block/{id}');
	});


	it('keeps answering plain HTTP on the API port', async () => {
		assert.equal((await apiGet(world.apiPort, '/block_explorers')).status, 200);
	});


	it('asks browsers to keep to HTTPS for a week in its CORS preflight', async () => {
		const reply = await httpsGet(world.apiSslPort, '/stats', 'OPTIONS');
		assert.equal(reply.status, 204);
		assert.equal(reply.headers['strict-transport-security'], 'max-age=604800');
	});


	it('stays on plain HTTP when the authority file is not named', async () => {
		await world.stopPools();
		const pool = await world.startPool({ api: { ssl: true, ...files, sslCA: '' } }, { module: 'api' });
		await pool.waitForOutput('(SSL): SSL certificate authority not configured');
		assert.notEqual((await httpsGet(world.apiSslPort, '/stats')).status, 200);
		assert.equal((await apiGet(world.apiPort, '/block_explorers')).status, 200);
	});


	it('stays on plain HTTP when the key file is missing', async () => {
		await world.stopPools();
		const pool = await world.startPool({ api: { ssl: true, ...files, sslKey: path.join(world.dir, 'gone.pem'), sslCA: files.sslCert } }, { module: 'api' });
		await pool.waitForOutput('(SSL): SSL key file not found (configuration error)');
		assert.notEqual((await httpsGet(world.apiSslPort, '/stats')).status, 200);
	});
});
