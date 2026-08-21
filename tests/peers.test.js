/** RaPiSys — peers repository + peer address normalization tests (§14). */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createPeersRepo } = await import('../server/repositories/peers.js');
const { normalizeBaseUrl, probePeer } = await import('../server/services/peer-client.js');

/** In-memory stand-in for the encrypted secrets repo. */
function fakeSecrets() {
  const m = new Map();
  return {
    store: m,
    set: (k, v) => m.set(k, v),
    get: (k) => (m.has(k) ? m.get(k) : null),
    has: (k) => m.has(k),
    remove: (k) => m.delete(k),
  };
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-peers-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const secrets = fakeSecrets();
  return { peers: createPeersRepo(db, { secrets }), secrets, db };
}

describe('peers repository', () => {
  it('creates the peers tables without touching existing ones', () => {
    const { db } = repo();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(names).toContain('peers');
    expect(names).toContain('peer_health');
    // The federation design turns on each node owning its own data, so no
    // existing table may have gained a node_id column.
    const metricCols = db.prepare('PRAGMA table_info(metrics)').all().map((c) => c.name);
    expect(metricCols).not.toContain('node_id');
  });

  it('stores the API key in secrets, never as a peers column', () => {
    const { peers, secrets, db } = repo();
    const p = peers.add({ name: 'rapi-02', baseUrl: 'https://rapi-02.local:3443', apiKey: 'sekret' });
    const cols = db.prepare('PRAGMA table_info(peers)').all().map((c) => c.name);
    expect(cols).not.toContain('api_key');
    expect(cols).not.toContain('api_key_enc');
    expect(secrets.get(`peer.${p.id}.apikey`)).toBe('sekret');
    expect(peers.apiKeyFor(p.id)).toBe('sekret');
    expect(peers.hasApiKey(p.id)).toBe(true);
  });

  it('removes the stored key and cached health along with the peer', () => {
    const { peers, secrets, db } = repo();
    const p = peers.add({ name: 'rapi-02', baseUrl: 'https://rapi-02.local:3443', apiKey: 'sekret' });
    peers.recordHealth({ peerId: p.id, reachable: true, latencyMs: 12, snapshot: { cpu: { usage: 4 } } });
    peers.remove(p.id);
    expect(peers.get(p.id)).toBeFalsy();
    expect(secrets.has(`peer.${p.id}.apikey`)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM peer_health WHERE peer_id = ?').get(p.id).n).toBe(0);
  });

  it('round-trips a snapshot and reports the latest health per peer', () => {
    const { peers } = repo();
    const a = peers.add({ name: 'a', baseUrl: 'https://a:3443' });
    const b = peers.add({ name: 'b', baseUrl: 'https://b:3443' });
    peers.recordHealth({ peerId: a.id, ts: 1000, reachable: true, latencyMs: 5, snapshot: { cpu: { usage: 9 } } });
    peers.recordHealth({ peerId: a.id, ts: 2000, reachable: false, state: 'unreachable' });
    peers.recordHealth({ peerId: b.id, ts: 1500, reachable: true, snapshot: { cpu: { usage: 1 } } });

    expect(peers.latestHealth(a.id).ts).toBe(2000);
    expect(peers.latestHealth(a.id).reachable).toBe(false);

    const all = peers.latestHealthAll();
    expect(all[a.id].state).toBe('unreachable');
    expect(all[b.id].snapshot.cpu.usage).toBe(1);
  });

  it('measures how long a peer has been continuously unreachable', () => {
    const { peers } = repo();
    const p = peers.add({ name: 'a', baseUrl: 'https://a:3443' });
    const now = Date.now();
    peers.recordHealth({ peerId: p.id, ts: now - 600_000, reachable: true });
    peers.recordHealth({ peerId: p.id, ts: now - 300_000, reachable: false });
    peers.recordHealth({ peerId: p.id, ts: now - 60_000, reachable: false });
    // Measured from the first failure after the last success, not the newest row.
    expect(peers.unreachableSince(p.id)).toBeGreaterThanOrEqual(299_000);
    peers.recordHealth({ peerId: p.id, ts: now, reachable: true });
    expect(peers.unreachableSince(p.id)).toBe(0);
  });

  it('prunes cached health by age', () => {
    const { peers, db } = repo();
    const p = peers.add({ name: 'a', baseUrl: 'https://a:3443' });
    peers.recordHealth({ peerId: p.id, ts: Date.now() - 30 * 24 * 3600_000, reachable: true });
    peers.recordHealth({ peerId: p.id, ts: Date.now(), reachable: true });
    peers.pruneHealth();
    expect(db.prepare('SELECT COUNT(*) AS n FROM peer_health').get().n).toBe(1);
  });

  it('rejects a duplicate name at the schema level', () => {
    const { peers } = repo();
    peers.add({ name: 'dup', baseUrl: 'https://a:3443' });
    expect(() => peers.add({ name: 'dup', baseUrl: 'https://b:3443' })).toThrow();
  });
});

describe('peer address normalization', () => {
  it('expands a bare LAN IP to https on the default port', () => {
    expect(normalizeBaseUrl('192.168.10.6')).toBe('https://192.168.10.6:3443');
  });

  it('expands an mDNS or tailnet name the same way', () => {
    expect(normalizeBaseUrl('rapi-02.local')).toBe('https://rapi-02.local:3443');
    expect(normalizeBaseUrl(' rapi-02.tailnet ')).toBe('https://rapi-02.tailnet:3443');
  });

  it('honours an explicit port', () => {
    expect(normalizeBaseUrl('192.168.10.6:8443')).toBe('https://192.168.10.6:8443');
    expect(normalizeBaseUrl('https://rapi-02.local:9999')).toBe('https://rapi-02.local:9999');
  });

  it('refuses plain HTTP rather than silently downgrading the key', () => {
    expect(() => normalizeBaseUrl('http://192.168.10.6:3001')).toThrow(/TLS/i);
  });

  it('rejects empty or unparseable input', () => {
    expect(() => normalizeBaseUrl('')).toThrow();
    expect(() => normalizeBaseUrl('   ')).toThrow();
  });
});

describe('trust on first use', () => {
  const FP_A = 'AA:BB:CC';
  const FP_B = 'DD:EE:FF';

  it('reports an unreachable peer as a state, not an exception', async () => {
    // Port 1 is reserved and refuses immediately: no network dependency.
    const out = await probePeer({ baseUrl: 'https://127.0.0.1:1', apiKey: 'k', timeout: 1500 });
    expect(out.ok).toBe(false);
    expect(out.state).toBe('unreachable');
  });

  it('offers the observed fingerprint for pinning when none is stored', () => {
    const { peers } = repo();
    const p = peers.add({ name: 'a', baseUrl: 'https://a:3443' });
    expect(peers.get(p.id).certFingerprint).toBeNull();
    peers.pinFingerprint(p.id, FP_A);
    expect(peers.get(p.id).certFingerprint).toBe(FP_A);
  });

  it('re-pinning is an explicit operation, not an automatic overwrite', () => {
    const { peers } = repo();
    const p = peers.add({ name: 'a', baseUrl: 'https://a:3443' });
    peers.pinFingerprint(p.id, FP_A);
    // The repo stores what it is told; the cert-changed decision lives in the
    // client, which compares before anyone calls pinFingerprint again.
    peers.pinFingerprint(p.id, FP_B);
    expect(peers.get(p.id).certFingerprint).toBe(FP_B);
  });
});
