/**
 * RaPiSys — metrics query plans.
 *
 * The retention and alerting queries filter on (res, ts) without naming a
 * metric, so they could not use the WITHOUT ROWID primary key and scanned the
 * whole table. With the database on a network mount and a synchronous driver,
 * one cold scan blocks the event loop for tens of seconds. These tests pin the
 * plans so a future query change cannot silently reintroduce a full scan.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);

const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-metrics-'));
  return openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
}

const plan = (db, sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');

describe('metrics index', () => {
  it('creates the (res, ts) index', () => {
    const { db } = tmpDb();
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_metrics_res_ts'`).get();
    expect(idx).toBeTruthy();
  });

  it('seeks rather than scans for the alert engine lookup', () => {
    const { db } = tmpDb();
    const p = plan(db, `SELECT metric, value, MAX(ts) AS ts FROM metrics
                        WHERE res = '10s' AND ts > 1 GROUP BY metric`);
    expect(p).toMatch(/idx_metrics_res_ts/);
    expect(p).not.toMatch(/SCAN metrics(?! USING)/);
  });

  it('seeks rather than scans when downsampling', () => {
    const { db } = tmpDb();
    const sel = plan(db, `SELECT metric, (ts/60000)*60000 AS bts, AVG(value) AS v
                          FROM metrics WHERE res = '10s' AND ts < 1 GROUP BY metric, bts`);
    const del = plan(db, `DELETE FROM metrics WHERE res = '10s' AND ts < 1`);
    expect(sel).toMatch(/idx_metrics_res_ts/);
    expect(del).toMatch(/idx_metrics_res_ts/);
    expect(sel).not.toMatch(/SCAN metrics(?! USING)/);
  });

  it('purges every tier', () => {
    const { db } = tmpDb();
    const repo = createMetricsRepo(db);
    const ins = db.prepare(
      `INSERT INTO metrics (ts, res, metric, value, vmin, vmax) VALUES (?, ?, ?, ?, NULL, NULL)`);
    for (const res of ['10s', '1m', '10m', '1h']) {
      ins.run(1000, res, 'temp.cpu', 40);      // old, should go
      ins.run(9000, res, 'temp.cpu', 41);      // recent, should stay
    }
    const out = repo.purgeOlderThan(5000);
    expect(out.changes).toBe(4);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM metrics`).get().n;
    expect(left).toBe(4);
  });

  it('leaves rows newer than the cutoff alone', () => {
    const { db } = tmpDb();
    const repo = createMetricsRepo(db);
    db.prepare(`INSERT INTO metrics (ts, res, metric, value, vmin, vmax)
                VALUES (5000, '10s', 'cpu.usage', 12, NULL, NULL)`).run();
    expect(repo.purgeOlderThan(5000).changes).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM metrics`).get().n).toBe(1);
  });
});
