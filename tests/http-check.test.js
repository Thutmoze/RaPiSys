/** RaPiSys — HTTP(S) service health check, including TLS-only ports. */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';

const { checkHttpService } = await import('../server/services/http-check.js');
const tls = {
  key: fs.readFileSync(new URL('./fixtures/peer-tls.key', import.meta.url)),
  cert: fs.readFileSync(new URL('./fixtures/peer-tls.crt', import.meta.url)),
};

let server;
let sockets = [];
afterEach(() => new Promise((r) => {
  sockets.forEach((s) => s.destroy());
  sockets = [];
  server ? server.close(() => r()) : r();
}));

function listen(s) {
  server = s;
  s.on('connection', (c) => sockets.push(c));
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
}
const svc = (port, checkType) => ({ name: 't', host: '127.0.0.1', port, path: '/', checkType });

describe('http service check', () => {
  it('reports a plain HTTP service online', async () => {
    const port = await listen(http.createServer((req, res) => res.end()));
    const r = await checkHttpService(svc(port, 'http'));
    expect(r.status).toBe('online');
    expect(r.statusCode).toBe(200);
  });

  it('falls back to HTTPS when an http-checked port only speaks TLS', async () => {
    const port = await listen(https.createServer(tls, (req, res) => res.end()));
    const r = await checkHttpService(svc(port, 'http'));
    expect(r.status).toBe('online');
    expect(r.statusCode).toBe(200);
  });

  it('checks https services over TLS, accepting a self-signed cert', async () => {
    const port = await listen(https.createServer(tls, (req, res) => res.end()));
    const r = await checkHttpService(svc(port, 'https'));
    expect(r.status).toBe('online');
  });

  it('reports a 5xx response as error', async () => {
    const port = await listen(http.createServer((req, res) => { res.statusCode = 503; res.end(); }));
    const r = await checkHttpService(svc(port, 'http'));
    expect(r.status).toBe('error');
  });

  it('reports a closed port offline', async () => {
    const port = await listen(net.createServer());
    await new Promise((r) => { server.close(() => r()); server = null; });
    const r = await checkHttpService(svc(port, 'http'));
    expect(r.status).toBe('offline');
    expect(r.latency).toBeNull();
  });

  it('times out a port that accepts but never answers', async () => {
    const port = await listen(net.createServer(() => {}));
    const started = Date.now();
    const r = await checkHttpService(svc(port, 'http'), { timeoutMs: 200 });
    expect(r.status).toBe('offline');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
