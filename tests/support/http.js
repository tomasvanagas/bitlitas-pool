// -----------------------------------------------------------
//  [*] Test support — talking to the pool's API
//
//  A plain HTTP client for the API on 127.0.0.1 that never
//  throws: every request resolves with the status, the
//  headers, the body as text and, when it parses, as JSON —
//  or with the connection error when there was no answer, so
//  a test can assert on a crash or a hang as calmly as on a
//  404. A request can come from another loopback address
//  (127.0.0.2), which the API does not count as local, so
//  the password check is reachable at all.
//
//  Used by:
//    - the API, flow and website suites
// -----------------------------------------------------------

const http = require('http');


// How long a request waits before it counts as hanging
const REQUEST_TIMEOUT = 10000;







// -----------------------------------------------------------
// apiGet
// -----------------------------------------------------------
//
// One request to the API: GET unless the options name another
// method, with any extra headers. Resolves with status,
// headers, body, json (when the body parses) and error (a
// connection error code, or TIMEOUT when nothing came back in
// time).
//
// Used by:
//   - the API, flow and website suites
// -----------------------------------------------------------

function apiGet (port, path, { headers = {}, localAddress, timeout = REQUEST_TIMEOUT, method = 'GET' } = {}) {

	return new Promise((resolve) => {
		const request = http.request({ host: '127.0.0.1', port, path, method, headers, localAddress, agent: false }, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('error', (error) => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), json: null, error: error.code || error.message }));
			response.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				let json = null;
				try {
					json = JSON.parse(body);
				} catch (e) {
					json = null;
				}
				resolve({ status: response.statusCode, headers: response.headers, body, json, error: null });
			});
		});
		request.setTimeout(timeout, () => {
			request.destroy();
			resolve({ status: null, headers: {}, body: '', json: null, error: 'TIMEOUT' });
		});
		request.on('error', (error) => resolve({ status: null, headers: {}, body: '', json: null, error: error.code || error.message }));
		request.end();
	});
}







// What the suites take from here
module.exports = { apiGet };
