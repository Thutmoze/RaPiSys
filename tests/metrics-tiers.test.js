/**
 * RaPiSys — history queries across retention tiers.
 *
 * Retention keeps tiers by AGE: raw 10s rows for 48 h, 1m buckets to 30 d,
 * 10m to 90 d, 1h beyond. A chart range must be served from whichever tiers
 * overlap it. Picking one tier from the span used to return an empty tier for
 * 24 h / 7 d / 30 d, then the OLDEST 5000 raw rows: the 24 h chart lost its
 * newest ~10 h and the 7 d chart showed a ~14 h slice.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');

const H = 3600e3, D = 24 * H;
const now = Math.floor(Date.now() / 3600e3) * 3600e3 + 1234; // fixed, not bucket-aligned
let repo, db;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-tiers-'));
  ({ db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') }));
  repo = createMetricsRepo(db);
  const ins = db.prepare(`INSERT INTO metrics (ts, res, metric, value, vmin, vmax) VALUES (?, ?, 'temp.cpu', ?, ?, ?)`);
  // Lay data out exactly as retention leaves it: raw newest, coarser older.
  const tiers = [['10s', 10e3, 0, 2 * D], ['1m', 60e3, 2 * D, 30 * D], ['10m', 600e3, 30 * D, 90 * D], ['1h', H, 90 * D, 120 * D]];
  db.transaction(() => {
    for (const [res, step, newestAge, oldestAge] of tiers) {
      const first = Math.ceil((now - oldestAge) / step) * step;
      for (let ts = first; ts < now - newestAge; ts += step) {
        const v = 50 + 10 * Math.sin(ts / H);
        if (res === '10s') ins.run(ts, res, v, null, null);
        else ins.run(ts, res, v, v - 1, v + 1);
      }
    }
  })();
});

const RANGES = { '1h': [H, 10e3], '6h': [6 * H, 10e3], '24h': [D, 60e3], '7d': [7 * D, 600e3],
  '30d': [30 * D, 600e3], '90d': [90 * D, H], '365d': [365 * D, H] };

describe('history query across tiers', () => {
  for (const [range, [span, bucket]] of Object.entries(RANGES)) {
    it(`${range} reaches the newest data and covers the whole stored window`, () => {
      const { points } = repo.query('temp.cpu', now - span, now);
      expect(points.length).toBeGreaterThan(0);
      const newestAge = now - points[points.length - 1].ts;
      expect(newestAge).toBeLessThanOrEqual(bucket + 10e3);
      // Data only goes back 120 d in this fixture.
      const expectOldest = now - Math.min(span, 120 * D);
      expect(points[0].ts - expectOldest).toBeLessThanOrEqual(H + bucket);
      // Bucketed to the target size: never more points than buckets in range.
      expect(points.length).toBeLessThanOrEqual(Math.ceil(Math.min(span, 120 * D) / bucket) + 2);
      // Strictly ordered, no duplicate timestamps.
      for (let i = 1; i < points.length; i++) expect(points[i].ts).toBeGreaterThan(points[i - 1].ts);
    });
  }

  it('reports the target resolution and keeps min/max through bucketing', () => {
    const { res, points } = repo.query('temp.cpu', now - 7 * D, now);
    expect(res).toBe('10m');
    const old = points.find((p) => p.ts < now - 3 * D); // came from 1m rows
    expect(old.vmin).toBeLessThan(old.value);
    expect(old.vmax).toBeGreaterThan(old.value);
  });

  it('still honours an explicit tier', () => {
    const { res, points } = repo.query('temp.cpu', now - 40 * D, now, '10m');
    expect(res).toBe('10m');
    expect(points.every((p) => p.ts < now - 30 * D)).toBe(true);
  });
});

describe('downsample only takes whole buckets', () => {
  it('leaves a bucket that straddles the cutoff raw until it is complete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-ds-'));
    const { db: db2 } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const r = createMetricsRepo(db2);
    const minute = 1700000040000; // a minute boundary
    for (let i = 0; i < 6; i++) r.writeBatch(minute + i * 10000, [{ metric: 'm', value: i }]);
    // Cutoff in the middle of the minute: nothing in that minute moves yet.
    r.downsample('10s', '1m', 60000, minute + 35000);
    expect(db2.prepare(`SELECT COUNT(*) c FROM metrics WHERE res = '10s'`).get().c).toBe(6);
    // Once the cutoff passes the minute, the whole minute is aggregated at once.
    r.downsample('10s', '1m', 60000, minute + 60000);
    const row = db2.prepare(`SELECT value, vmin, vmax FROM metrics WHERE res = '1m'`).get();
    expect(row).toEqual({ value: 2.5, vmin: 0, vmax: 5 });
  });
});
