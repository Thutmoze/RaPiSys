/** RaPiSys — alert engine state machine + session tracker tests. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);

const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createAlertsRepo } = await import('../server/repositories/alerts.js');
const { createSessionsRepo } = await import('../server/repositories/sessions.js');
const { createAlertEngine } = await import('../server/services/alerting.js');
const { createSessionTracker } = await import('../server/services/session-tracker.js');
const { parseUtmp } = await import('../server/collectors/sessions.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-al-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const metricsRepo = createMetricsRepo(db);
  const eventsRepo = createEventsRepo(db);
  const alertsRepo = createAlertsRepo(db);
  const sent = [];
  const mailer = { send: async (m) => sent.push(m) };
  const engine = createAlertEngine({
    alertsRepo, metricsRepo, eventsRepo, mailer,
    getSettings: async () => ({ rapisys: { smtp: { host: 'x', to: 'a@b' } } }),
  });
  return { db, metricsRepo, eventsRepo, alertsRepo, engine, sent };
}

describe('alert engine state machine', () => {
  it('fires only after the sustain window, then resolves', async () => {
    const f = fixture();
    const id = f.alertsRepo.createRule({ name: 'hot', metric: 'temp.cpu', op: '>', threshold: 80,
      sustain_s: 60, severity: 'critical', enabled: 1, cooldown_s: 900, escalate_after_s: null, channels: ['ui', 'email'] });
    const t0 = Date.now();

    f.metricsRepo.writeBatch(t0, [{ metric: 'temp.cpu', value: 85 }]);
    await f.engine.evaluateOnce(t0);
    expect(f.alertsRepo.getState(id).state).toBe('pending');   // breach starts

    await f.engine.evaluateOnce(t0 + 30000);
    expect(f.alertsRepo.getState(id).state).toBe('pending');   // not sustained yet

    await f.engine.evaluateOnce(t0 + 61000);
    expect(f.alertsRepo.getState(id).state).toBe('firing');    // sustained -> fires
    expect(f.sent.length).toBe(1);                              // email sent
    expect(f.alertsRepo.active().length).toBe(1);

    f.metricsRepo.writeBatch(t0 + 90000, [{ metric: 'temp.cpu', value: 60 }]);
    await f.engine.evaluateOnce(t0 + 91000);
    expect(f.alertsRepo.getState(id).state).toBe('ok');        // resolves
    const hist = f.alertsRepo.history();
    expect(hist.length).toBe(1);
    expect(hist[0].resolved_at).not.toBeNull();
    expect(hist[0].peak_value).toBe(85);
  });

  it('clears pending if the breach goes away before sustain', async () => {
    const f = fixture();
    const id = f.alertsRepo.createRule({ name: 'cpu', metric: 'cpu.usage', op: '>', threshold: 90,
      sustain_s: 300, severity: 'warning', enabled: 1, cooldown_s: 900, escalate_after_s: null, channels: ['ui'] });
    const t0 = Date.now();
    f.metricsRepo.writeBatch(t0, [{ metric: 'cpu.usage', value: 95 }]);
    await f.engine.evaluateOnce(t0);
    f.metricsRepo.writeBatch(t0 + 30000, [{ metric: 'cpu.usage', value: 40 }]);
    await f.engine.evaluateOnce(t0 + 31000);
    expect(f.alertsRepo.getState(id).state).toBe('ok');
    expect(f.alertsRepo.history().length).toBe(0);
  });

  it('seeds default rules exactly once', () => {
    const f = fixture();
    f.engine.seedDefaults();
    const n = f.alertsRepo.countRules();
    expect(n).toBeGreaterThan(0);
    f.engine.seedDefaults();
    expect(f.alertsRepo.countRules()).toBe(n);
  });
});

describe('session tracker', () => {
  it('opens rows for new sessions and closes ended ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-ss-'));
    const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const sessionsRepo = createSessionsRepo(db);
    const eventsRepo = createEventsRepo(db);
    let live = [{ kind: 'ssh', key: 'ssh:pi:pts/0', username: 'pi', source: '10.0.0.5', startedAt: Date.now() - 5000, meta: { tty: 'pts/0' } }];
    const tracker = createSessionTracker({
      sessions: { snapshot: async () => ({ ssh: live, vnc: [], tailscale: { peers: [] } }) },
      sessionsRepo, eventsRepo,
    });
    await tracker.trackOnce();
    expect(sessionsRepo.openRows().length).toBe(1);
    await tracker.trackOnce();                                  // same session -> no dup
    expect(sessionsRepo.openRows().length).toBe(1);
    live = [];
    await tracker.trackOnce();                                  // session ended -> closed
    expect(sessionsRepo.openRows().length).toBe(0);
    const hist = sessionsRepo.history({ from: 0, to: Date.now() + 1000 });
    expect(hist.length).toBe(1);
    expect(hist[0].ended_at).not.toBeNull();
  });
});

describe('utmp parser', () => {
  it('extracts USER_PROCESS records', () => {
    const buf = Buffer.alloc(384);
    buf.writeInt16LE(7, 0);                  // USER_PROCESS
    buf.writeInt32LE(1234, 4);               // pid
    buf.write('pts/0', 8);                   // line
    buf.write('akhenaten', 44);              // user
    buf.write('192.168.10.2', 76);           // host
    buf.writeInt32LE(1770000000, 340);       // tv_sec
    const out = parseUtmp(buf);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ pid: 1234, tty: 'pts/0', user: 'akhenaten', host: '192.168.10.2' });
    expect(out[0].loginAt).toBe(1770000000000);
  });
});
