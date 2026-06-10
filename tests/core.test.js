/** RaPiSys — unit tests for core primitives. */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);

const { encrypt, decrypt, hasSecretKey } = await import('../server/core/crypto.js');
const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createSecretsRepo } = await import('../server/repositories/secrets.js');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-'));
  return openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
}

describe('crypto', () => {
  it('round-trips secrets', () => {
    expect(hasSecretKey()).toBe(true);
    const enc = encrypt('hunter2');
    expect(decrypt(enc)).toBe('hunter2');
  });
  it('rejects tampered ciphertext', () => {
    const enc = encrypt('hunter2');
    enc.ciphertext[0] ^= 0xff;
    expect(() => decrypt(enc)).toThrow();
  });
});

describe('database + migrations', () => {
  it('opens, migrates, and reports meta', () => {
    const { db, meta } = tmpDb();
    expect(meta.degraded).toBe(false);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['metrics', 'events', 'session_log', 'alert_rules', 'secrets', 'layouts']) {
      expect(tables).toContain(t);
    }
  });
});

describe('metrics repo', () => {
  it('writes batches and queries by range', () => {
    const { db } = tmpDb();
    const repo = createMetricsRepo(db);
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      repo.writeBatch(t0 + i * 10000, [{ metric: 'temp.cpu', value: 40 + i }]);
    }
    const { points } = repo.query('temp.cpu', t0 - 1000, t0 + 200000);
    expect(points.length).toBe(10);
    expect(points[0].value).toBe(40);
  });

  it('downsamples raw 10s rows into 1m buckets with min/max', () => {
    const { db } = tmpDb();
    const repo = createMetricsRepo(db);
    const base = 1700000000000; // aligned past timestamp
    for (let i = 0; i < 6; i++) {
      repo.writeBatch(base + i * 10000, [{ metric: 'cpu.usage', value: i * 10 }]);
    }
    const moved = repo.downsample('10s', '1m', 60000, base + 7 * 10000);
    expect(moved).toBeGreaterThan(0);
    const { res, points } = repo.query('cpu.usage', base - 60000, base + 70000, '1m');
    expect(res).toBe('1m');
    // values 0..50 split across minute buckets; check aggregate bounds
    expect(Math.min(...points.map((p) => p.vmin))).toBe(0);
    expect(Math.max(...points.map((p) => p.vmax))).toBe(50);
    // raw rows are gone
    const raw = db.prepare("SELECT COUNT(*) c FROM metrics WHERE res='10s'").get().c;
    expect(raw).toBe(0);
  });
});

describe('events + secrets repos', () => {
  it('logs and filters events', () => {
    const { db } = tmpDb();
    const repo = createEventsRepo(db);
    repo.add('hw.undervoltage.start', 'critical', { v: 4.6 });
    repo.add('setup.completed');
    expect(repo.recent(10).length).toBe(2);
    expect(repo.recent(10, 'setup.completed').length).toBe(1);
    expect(repo.countSince('hw.undervoltage.start', Date.now() - 1000)).toBe(1);
  });
  it('stores secrets encrypted', () => {
    const { db } = tmpDb();
    const repo = createSecretsRepo(db);
    repo.set('smtp.password', 'p@ss');
    expect(repo.get('smtp.password')).toBe('p@ss');
    const raw = db.prepare('SELECT ciphertext FROM secrets').get();
    expect(Buffer.from(raw.ciphertext).toString()).not.toContain('p@ss');
  });
});
