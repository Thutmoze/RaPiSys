/** RaPiSys — a peer that never finishes its response cannot hang the poller. */
import { describe, it, expect, afterEach } from 'vitest';
import https from 'https';
import fs from 'fs';

const { fetchNodeSummary } = await import('../server/services/peer-client.js');
const tls = {
  key: fs.readFileSync(new URL('./fixtures/peer-tls.key', import.meta.url)),
  cert: fs.readFileSync(new URL('./fixtures/peer-tls.crt', import.meta.url)),
};

let server;
afterEach(() => new Promise((r) => (server ? server.close(() => r()) : r())));

function listen(handler) {
  server = https.createServer(tls, handler);
  server.on('connection', (s) => server.once('close', () => s.destroy()));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`https://127.0.0.1:${server.address().port}`)));
}

describe('peer summary fetch', () => {
  it('gives up on a peer that trickles bytes forever', async () => {
    const base = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const t = setInterval(() => res.write(' '), 50);   // never idle, never done
      res.on('close', () => clearInterval(t));
    });
    const started = Date.now();
    const out = await fetchNodeSummary(base, 'k', { timeout: 200, deadline: 600 });
    expect(out.ok).toBe(false);
    expect(out.state).toBe('unreachable');
    expect(out.error).toMatch(/no complete response/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('settles on an oversized response instead of waiting for its end', async () => {
    const base = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('"' + 'x'.repeat(1_100_000));
      // no end: only the size cap can settle this
    });
    const out = await fetchNodeSummary(base, 'k', { timeout: 2000, deadline: 5000 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('response too large');
  });

  it('still returns a normal summary', async () => {
    const base = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ node: 'peer' }));
    });
    const out = await fetchNodeSummary(base, 'k', { timeout: 2000 });
    expect(out.ok).toBe(true);
    expect(out.json).toEqual({ node: 'peer' });
  });
});
