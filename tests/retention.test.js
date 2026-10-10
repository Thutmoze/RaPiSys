/** RaPiSys — hourly retention: tiered downsampling and purging every growing table. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createSessionsRepo } = await import('../server/repositories/sessions.js');
const { createAlertsRepo } = await import('../server/repositories/alerts.js');
const { createUpdatesRepo } = await import('../server/repositories/updates.js');
const { createNetTrafficRepo } = await import('../server/repositories/net-traffic.js');
const { createRetention } = await import('../server/services/retention.js');

const D = 86400e3;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-ret-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const repos = {
    metricsRepo: createMetricsRepo(db), eventsRepo: createEventsRepo(db), sessionsRepo: createSessionsRepo(db),
    alertsRepo: createAlertsRepo(db), updatesRepo: createUpdatesRepo(db),
  };
  const retention = createRetention({ ...repos, getRetentionDays: async () => 30 });
  const count = (sql) => db.prepare(sql).get().c;
  return { db, ...repos, retention, count };
}

describe('retention', () => {
  it('downsamples raw rows by age and purges beyond the retention period', async () => {
    const f = fixture();
    const now = Date.now();
    const ins = f.db.prepare(`INSERT INTO metrics (ts, res, metric, value) VALUES (?, ?, 'cpu.usage', ?)`);
    for (let i = 0; i < 6; i++) ins.run(now - 3 * D + i * 10e3, '10s', i);   // 3 days old: becomes 1m
    ins.run(now - 3600e3, '10s', 9);                                          // 1 hour old: stays raw
    ins.run(now - 40 * D, '1h', 1);                                           // past 30 days: purged
    await f.retention.runOnce();
    expect(f.count(`SELECT COUNT(*) c FROM metrics WHERE res = '10s'`)).toBe(1);
    expect(f.count(`SELECT COUNT(*) c FROM metrics WHERE res = '1m'`)).toBeGreaterThan(0);
    expect(f.count(`SELECT COUNT(*) c FROM metrics WHERE ts < ${now - 30 * D}`)).toBe(0);
  });

  it('purges old events, closed sessions, resolved incidents and Update History rows', async () => {
    const f = fixture();
    const old = Date.now() - 40 * D, recent = Date.now() - D;
    const ev = f.db.prepare(`INSERT INTO events (ts, type, severity, payload) VALUES (?, 'x', 'info', '{}')`);
    ev.run(old); ev.run(recent);
    const se = f.db.prepare(`INSERT INTO session_log (kind, started_at, ended_at) VALUES ('ssh', ?, ?)`);
    se.run(old, old + 1000); se.run(old, null); se.run(recent, recent + 1000);   // an old OPEN session stays
    const ah = f.db.prepare(`INSERT INTO alert_history (rule_id, fired_at, resolved_at) VALUES (1, ?, ?)`);
    ah.run(old, old + 1000); ah.run(old, null); ah.run(recent, recent + 1000);   // an old OPEN incident stays
    const uh = f.db.prepare(`INSERT INTO update_history (ts, package, result) VALUES (?, 'curl', 'success')`);
    uh.run(old); uh.run(recent);
    await f.retention.runOnce();
    expect(f.count('SELECT COUNT(*) c FROM events')).toBe(1);
    expect(f.count('SELECT COUNT(*) c FROM session_log')).toBe(2);
    expect(f.count('SELECT COUNT(*) c FROM alert_history')).toBe(2);
    expect(f.count('SELECT COUNT(*) c FROM alert_history WHERE resolved_at IS NULL')).toBe(1);
    expect(f.count('SELECT COUNT(*) c FROM update_history')).toBe(1);
  });

  it('still runs with only the metrics and events repos (optional purgers)', async () => {
    const f = fixture();
    const r = createRetention({ metricsRepo: f.metricsRepo, eventsRepo: f.eventsRepo, getRetentionDays: async () => 30 });
    await expect(r.runOnce()).resolves.toBeUndefined();
  });
});

describe('bandwidth accounting', () => {
  it('adds traffic and moves the counter baseline together, or not at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-nt-'));
    const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const repo = createNetTrafficRepo(db);
    const buckets = { hour: 1000, day: 1000, month: 1000 };
    repo.record([{ iface: 'eth0', rx: 100, tx: 50, buckets }], [{ iface: 'eth0', bootId: 'b', rx: 100, tx: 50, ts: 1 }]);
    expect(repo.totals().eth0).toEqual({ rx: 100, tx: 50 });
    expect(repo.counterState().eth0.rx).toBe(100);
    // The baseline write fails (boot_id is NOT NULL): the traffic must not stay counted.
    expect(() => repo.record([{ iface: 'eth0', rx: 7, tx: 7, buckets }], [{ iface: 'eth0', bootId: null, rx: 1, tx: 1, ts: 2 }])).toThrow();
    expect(repo.totals().eth0).toEqual({ rx: 100, tx: 50 });
  });
});
