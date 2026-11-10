// -----------------------------------------------------------
//  [*] Test support — a mail server that keeps what it gets
//
//  The smallest SMTP server nodemailer will talk to: it
//  greets, says yes to EHLO, MAIL, RCPT and DATA, and keeps
//  each message — sender, recipients and the raw message —
//  instead of delivering it. The pool's email notifications
//  go here when a test turns email on with the smtp
//  transport, so what a miner would read can be checked
//  without a real mail server.
//
//  Used by:
//    - tests/units/notifications.test.js
// -----------------------------------------------------------

const net = require('net');







// -----------------------------------------------------------
// readMessage
// -----------------------------------------------------------
//
// The subject and the plain text of a raw message, the body
// decoded from the quoted-printable or base64 nodemailer
// picks for long or non-ASCII lines, line ends made "\n".
//
// Used by:
//   - FakeSmtp.serve (below)
// -----------------------------------------------------------

function readMessage (data) {

	const split = data.indexOf('\r\n\r\n');
	const headers = data.slice(0, split);
	let body = data.slice(split + 4).replace(/\r\n$/, '');
	const encoding = (headers.match(/^Content-Transfer-Encoding: *(\S+)/im) || [])[1] || '7bit';
	if (/quoted-printable/i.test(encoding)) {
		body = Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
	} else if (/base64/i.test(encoding)) {
		body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
	}
	return {
		subject: (headers.match(/^Subject: *(.*)$/im) || [])[1],
		text: body.replace(/\r\n/g, '\n')
	};
}







// -----------------------------------------------------------
// FakeSmtp
// -----------------------------------------------------------
//
// One listening server. `messages` fills as mail arrives;
// each holds `from`, `to` (a list), `data` (the message as
// sent, headers included) and the decoded `subject` and
// `text`. `close` stops listening.
//
// Used by:
//   - tests/units/notifications.test.js
// -----------------------------------------------------------

class FakeSmtp {

	static async start (port) {
		const smtp = new FakeSmtp(port);
		await new Promise((resolve, reject) => {
			smtp.server.once('error', reject);
			smtp.server.listen(port, '127.0.0.1', resolve);
		});
		return smtp;
	}


	constructor (port) {
		this.port = port;
		this.messages = [];
		this.server = net.createServer((socket) => this.serve(socket));
	}


	serve (socket) {
		let buffer = '';
		let message = null;
		let inData = false;
		socket.setEncoding('utf8');
		socket.write('220 fake-smtp ESMTP\r\n');
		socket.on('error', () => {});
		socket.on('data', (chunk) => {
			buffer += chunk;
			let end;
			while ((end = buffer.indexOf('\r\n')) !== -1) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (inData) {
					if (line === '.') {
						inData = false;
						this.messages.push({ ...message, ...readMessage(message.data) });
						socket.write('250 2.0.0 kept\r\n');
					} else {
						message.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
					}
					continue;
				}
				const verb = line.slice(0, 4).toUpperCase();
				if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake-smtp\r\n250 8BITMIME\r\n');
				else if (verb === 'MAIL') {
					message = { from: line.slice(10).replace(/[<>]/g, '').split(' ')[0], to: [], data: '' };
					socket.write('250 2.1.0 ok\r\n');
				} else if (verb === 'RCPT') {
					message.to.push(line.slice(8).replace(/[<>]/g, '').split(' ')[0]);
					socket.write('250 2.1.5 ok\r\n');
				} else if (verb === 'DATA') {
					inData = true;
					socket.write('354 go ahead\r\n');
				} else if (verb === 'QUIT') {
					socket.end('221 2.0.0 bye\r\n');
				} else socket.write('250 ok\r\n');
			}
		});
	}


	close () {
		return new Promise((resolve) => this.server.close(resolve));
	}
}







// What the suites take from here
module.exports = { FakeSmtp };
