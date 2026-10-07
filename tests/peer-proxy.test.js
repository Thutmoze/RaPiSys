/**
 * RaPiSys — unified node view: peer auth on the target + relay on the viewer (§14.7).
 *
 * tests/fixtures/peer-tls.{key,crt} is a throwaway self-signed pair made only
 * for these tests (CN=rapisys-test-peer). It secures nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import express from 'express';
import request from 'supertest';

process.env.SECRET_KEY = 'a'.repeat(64);
delete process.env.ADMIN_TOKEN;

const { openDatabase } = await import('../server/core/db.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createAuth } = await import('../server/services/auth.js');
const { nodesRouter } = await import('../server/routes/nodes.js');

const KEY = 'peer-test-key';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// Target side: what a relayed request may do here
// ---------------------------------------------------------------------------

function targetApp({ peerControl = false, keyHash = sha(KEY), apiEnabled = true, mode = 'full' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-peerauth-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const eventsRepo = createEventsRepo(db);
  const auth = createAuth({
    getDb: () => db,
    loadSettings: async () => ({ rapisys: { mode, peerControl }, api: { enabled: apiEnabled, keyHash } }),
    eventsRepo,
  });
  const app = express();
  app.use(express.json());
  const ok = (req, res) => res.json({ ok: true });
  app.get('/api/thing', auth.requireConfig, ok);
  app.post('/api/thing', auth.requireConfig, ok);
  app.post('/api/updates/upgrade', auth.requireControl, ok);
  app.get('/api/nodes/:id/proxy/*rest', auth.requireConfig, ok);
  app.put('/api/nodes/peer-control', auth.requireControl, ok);
  app.post('/api/setup/storage', auth.requireControl, ok);
  app.post('/api/setup/nas/swap', auth.requireControl, ok);
  return { app, db };
}

const peer = (r, { key = KEY, scope = 'control' } = {}) =>
  r.set('X-RaPiSys-Peer', 'XRPi').set('X-API-Key', key).set('X-RaPiSys-Peer-Scope', scope);

describe('peer access on the target node', () => {
  it('a correct key without the peer marker is not a session', async () => {
    const { app } = targetApp();
    await request(app).get('/api/thing').set('X-API-Key', KEY).expect(401);
  });

  it('wrong key or no key configured gives no access', async () => {
    await peer(request(targetApp().app).get('/api/thing'), { key: 'nope' }).expect(401);
    await peer(request(targetApp({ keyHash: null }).app).get('/api/thing')).expect(401);
    await peer(request(targetApp({ apiEnabled: false }).app).get('/api/thing')).expect(401);
  });

  it('peerControl off: reads pass, writes are refused with a clear reason', async () => {
    const { app } = targetApp({ peerControl: false });
    await peer(request(app).get('/api/thing')).expect(200);
    const w = await peer(request(app).post('/api/thing')).expect(403);
    expect(w.body.auth).toBe('peer-control-off');
    const c = await peer(request(app).post('/api/updates/upgrade')).expect(403);
    expect(c.body.auth).toBe('peer-control-off');
  });

  it('peerControl on: writes pass and are logged on this node', async () => {
    const { app, db } = targetApp({ peerControl: true });
    await peer(request(app).post('/api/updates/upgrade')).expect(200);
    const ev = db.prepare("SELECT * FROM events WHERE type = 'peer.control'").all();
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload)).toMatchObject({ peer: 'XRPi', method: 'POST', path: '/api/updates/upgrade' });
  });

  it('the relaying node caps the scope: a viewer not signed in there gets view only', async () => {
    const { app } = targetApp({ peerControl: true });
    await peer(request(app).get('/api/thing'), { scope: 'view' }).expect(200);
    const r = await peer(request(app).post('/api/updates/upgrade'), { scope: 'view' }).expect(403);
    expect(r.body.auth).toBe('peer-control-off');
  });

  it('never relays onward, never touches federation, setup or sessions', async () => {
    const { app } = targetApp({ peerControl: true });
    const hop = await peer(request(app).get('/api/nodes/3/proxy/stats')).expect(403);
    expect(hop.body.auth).toBe('peer-denied');
    await peer(request(app).put('/api/nodes/peer-control')).expect(403);
    await peer(request(app).post('/api/setup/storage')).expect(403);
    // NAS swap lives under /api/setup but is ordinary control.
    await peer(request(app).post('/api/setup/nas/swap')).expect(200);
  });

  it('monitor mode stays monitor mode', async () => {
    const { app } = targetApp({ peerControl: true, mode: 'monitor' });
    await peer(request(app).get('/api/thing')).expect(200);
    await peer(request(app).post('/api/updates/upgrade')).expect(403);
  });
});

// ---------------------------------------------------------------------------
// Viewer side: the relay
// ---------------------------------------------------------------------------

const tlsKey = fs.readFileSync(new URL('./fixtures/peer-tls.key', import.meta.url));
const tlsCert = fs.readFileSync(new URL('./fixtures/peer-tls.crt', import.meta.url));
const PIN = new crypto.X509Certificate(tlsCert).fingerprint256;

let upstream; let port; let seen = [];

beforeAll(async () => {
  upstream = https.createServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/api/denied')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"no"}'); }
      if (req.url.startsWith('/api/forbidden')) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"Control from other nodes is off on this node."}'); }
      if (req.url.startsWith('/api/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'x=1' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 20);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'rapisys_session=peer' });
      res.end(JSON.stringify({ path: req.url, from: 'peer' }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  port = upstream.address().port;
});
afterAll(() => upstream?.close());

function viewerApp({ pin = PIN, enabled = true, signedIn = false } = {}) {
  const peers = {
    1: { id: 1, name: 'YRPi', baseUrl: `https://127.0.0.1:${port}`, certFingerprint: pin, enabled },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/nodes', nodesRouter({
    peersRepo: {
      get: (id) => peers[id] || null,
      apiKeyFor: () => KEY,
      list: () => Object.values(peers),
      latestHealthAll: () => ({}),
      hasApiKey: () => true,
    },
    requireControl: (req, res, next) => (signedIn ? next() : res.status(401).json({ error: 'Authentication required.', auth: 'login' })),
    loadSettings: async () => ({ rapisys: { nodeLabel: 'XRPi' } }),
    auth: { getMode: async () => 'full', isAuthenticated: () => signedIn },
  }));
  return app;
}

describe('relay to a peer', () => {
  it('forwards a read with the key and peer marker, strips Set-Cookie', async () => {
    seen = [];
    const r = await request(viewerApp()).get('/api/nodes/1/proxy/updates/changelog/libc6%2Bb1?days=7').expect(200);
    expect(r.body).toEqual({ path: '/api/updates/changelog/libc6%2Bb1?days=7', from: 'peer' });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(seen[0].headers['x-api-key']).toBe(KEY);
    expect(seen[0].headers['x-rapisys-peer']).toBe('XRPi');
    expect(seen[0].headers['x-rapisys-peer-scope']).toBe('view');
    expect(seen[0].headers.cookie).toBeUndefined();
  });

  it('forwards a write body with control scope when signed in here', async () => {
    seen = [];
    await request(viewerApp({ signedIn: true })).post('/api/nodes/1/proxy/alerts/rules').send({ name: 'hot' }).expect(200);
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body)).toEqual({ name: 'hot' });
    expect(seen[0].headers['x-rapisys-peer-scope']).toBe('control');
  });

  it('a write needs a session on this node first', async () => {
    seen = [];
    await request(viewerApp()).post('/api/nodes/1/proxy/alerts/rules').send({ a: 1 }).expect(401);
    expect(seen).toHaveLength(0);
  });

  it('a changed certificate stops the request before the key is sent', async () => {
    seen = [];
    const r = await request(viewerApp({ pin: 'AA:BB' })).get('/api/nodes/1/proxy/stats').expect(502);
    expect(r.body.state).toBe('cert-changed');
    await new Promise((res) => setTimeout(res, 30));
    expect(seen).toHaveLength(0);
  });

  it('refuses an unpinned or disabled peer', async () => {
    expect((await request(viewerApp({ pin: null })).get('/api/nodes/1/proxy/stats').expect(502)).body.state).toBe('unpinned');
    await request(viewerApp({ enabled: false })).get('/api/nodes/1/proxy/stats').expect(409);
    await request(viewerApp()).get('/api/nodes/9/proxy/stats').expect(404);
  });

  it("the peer rejecting our key is a 502, so this node's login modal stays out of it", async () => {
    const r = await request(viewerApp()).get('/api/nodes/1/proxy/denied').expect(502);
    expect(r.body.state).toBe('auth-failed');
  });

  it("passes the peer's own 403 through", async () => {
    const r = await request(viewerApp()).get('/api/nodes/1/proxy/forbidden').expect(403);
    expect(r.body.error).toMatch(/off on this node/);
  });

  it('streams server-sent events', async () => {
    const r = await request(viewerApp()).get('/api/nodes/1/proxy/stream').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(r.text).toBe('data: one\n\ndata: two\n\n');
  });

  it('does not relay a request that itself came from a peer', async () => {
    await request(viewerApp()).get('/api/nodes/1/proxy/stats').set('X-RaPiSys-Peer', 'ZRPi').expect(403);
  });

  it('reports an unreachable peer', async () => {
    const app = express();
    app.use('/api/nodes', nodesRouter({
      peersRepo: { get: () => ({ id: 2, name: 'gone', baseUrl: 'https://127.0.0.1:1', certFingerprint: PIN, enabled: true }), apiKeyFor: () => KEY },
      requireControl: (req, res, next) => next(),
      loadSettings: async () => ({}),
    }));
    const r = await request(app).get('/api/nodes/2/proxy/stats').expect(502);
    expect(r.body.state).toBe('unreachable');
  });
});
