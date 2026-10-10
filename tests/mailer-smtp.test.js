/**
 * RaPiSys — alert mail goes out end to end through nodemailer: STARTTLS
 * upgrade (requireTLS), AUTH PLAIN, envelope and message, against a small
 * local SMTP server. Guards the transport options across nodemailer upgrades.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import nodemailer from 'nodemailer';

const cert = {
  key: fs.readFileSync(new URL('./fixtures/peer-tls.key', import.meta.url)),
  cert: fs.readFileSync(new URL('./fixtures/peer-tls.crt', import.meta.url)),
};

/** Minimal ESMTP server: STARTTLS, AUTH PLAIN, one message. Records what it saw. */
function fakeSmtp() {
  const seen = { tls: false, auth: null, from: null, to: [], data: '' };
  const server = net.createServer((raw) => {
    let sock = raw;
    let buf = '';
    let inData = false;
    const say = (s) => sock.write(`${s}\r\n`);
    const onLine = (line) => {
      if (inData) {
        if (line === '.') { inData = false; return say('250 2.0.0 queued'); }
        seen.data += `${line}\n`;
        return;
      }
      const [cmd, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (cmd.toUpperCase()) {
        case 'EHLO':
          return sock.write(`250-fake.test\r\n${seen.tls ? '' : '250-STARTTLS\r\n'}250 AUTH PLAIN LOGIN\r\n`);
        case 'STARTTLS': {
          say('220 2.0.0 ready');
          raw.removeAllListeners('data');
          sock = new tls.TLSSocket(raw, { isServer: true, ...cert });
          seen.tls = true;
          buf = '';
          sock.on('data', onData);
          return;
        }
        case 'AUTH':
          seen.auth = Buffer.from(arg.split(' ')[1] || '', 'base64').toString().split('\u0000');
          return say('235 2.7.0 ok');
        case 'MAIL': seen.from = arg; return say('250 ok');
        case 'RCPT': seen.to.push(arg); return say('250 ok');
        case 'DATA': inData = true; return say('354 go');
        case 'QUIT': say('221 bye'); return sock.end();
        default: return say('502 unknown');
      }
    };
    function onData(chunk) {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); }
    }
    raw.on('data', onData);
    raw.on('error', () => {});
    say('220 fake.test ESMTP');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
}

let srv;
afterEach(() => new Promise((r) => (srv ? srv.server.close(() => r()) : r())));

describe('SMTP delivery through nodemailer', () => {
  it('upgrades with STARTTLS, logs in, and delivers the message', async () => {
    srv = await fakeSmtp();
    // The options RaPiSys uses (server/services/mailer.js), plus trust for the
    // test certificate.
    const transport = nodemailer.createTransport({
      host: '127.0.0.1', port: srv.port, secure: false, requireTLS: true,
      auth: { user: 'alerts@example.com', pass: 's3cret' },
      connectionTimeout: 10000, greetingTimeout: 15000, socketTimeout: 20000,
      tls: { rejectUnauthorized: false },
    });
    const info = await transport.sendMail({
      from: 'alerts@example.com', to: 'me@example.com',
      subject: '[XRPi] CPU hot', text: 'Node: XRPi\n\nCPU at 91%', html: '<p>CPU at 91%</p>',
    });
    expect(info.accepted).toEqual(['me@example.com']);
    expect(srv.seen.tls).toBe(true);
    expect(srv.seen.auth).toEqual(['', 'alerts@example.com', 's3cret']);
    expect(srv.seen.from).toMatch(/alerts@example\.com/);
    expect(srv.seen.to.join()).toMatch(/me@example\.com/);
    expect(srv.seen.data).toMatch(/Subject: \[XRPi\] CPU hot/);
    expect(srv.seen.data).toMatch(/CPU at 91%/);
  });

  it('refuses to send in clear text when the server offers no STARTTLS (requireTLS)', async () => {
    srv = await fakeSmtp();
    srv.seen.tls = true;   // makes the fake server stop advertising STARTTLS
    const transport = nodemailer.createTransport({
      host: '127.0.0.1', port: srv.port, secure: false, requireTLS: true,
      auth: { user: 'a@example.com', pass: 'x' }, connectionTimeout: 5000,
    });
    await expect(transport.sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' }))
      .rejects.toThrow();
    expect(srv.seen.auth).toBeNull();
  });
});
