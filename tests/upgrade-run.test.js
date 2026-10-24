/**
 * RaPiSys — one apt upgrade at a time, and recovering a run whose stream
 * dropped (upgrading docker-ce restarts the dashboard container mid-run).
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const SECRET = 'test-secret-not-used-for-any-real-hmac';
process.env.AGENT_SECRET = SECRET;
const { beginAptRun, aptRunStatus, dispatch } = require('../agent/rapisys-agent.cjs');
const { updatesRouter } = await import('../server/routes/updates.js');

let n = 0;
function signed(op, params = {}) {
  const id = `u${++n}`;
  const ts = Date.now();
  const hmac = crypto.createHmac('sha256', SECRET).update(`${id}.${op}.${JSON.stringify(params)}.${ts}`).digest('hex');
  return { id, op, params, ts, hmac };
}

describe('agent upgrade run', () => {
  it('refuses a second upgrade while one runs, and allows one after it ends', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = beginAptRun({ runId: 'aaaaaaaa1', packages: ['docker-ce'], full: false });
    expect(() => beginAptRun({ runId: 'bbbbbbbb2', packages: ['curl'], full: false }))
      .toThrow(/another upgrade is already running on this host \(docker-ce, started \d\d:\d\d:\d\d\)/);
    // Through dispatch too: refused before apt-get is ever started.
    const out = await dispatch(signed('apt.upgrade', { packages: ['docker-ce'], runId: 'cccccccc3' }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already running/);
    run.end(0);
    expect(() => beginAptRun({ runId: 'dddddddd4', packages: ['curl'], full: false }).end(0)).not.toThrow();
  });

  it('reports state and only the lines after what the page saw', () => {
    const run = beginAptRun({ runId: 'eeeeeeee5', packages: ['docker-ce'], full: false });
    for (const l of ['a', 'b', 'c', 'd']) run.push(l);
    expect(aptRunStatus('eeeeeeee5', 2)).toMatchObject({ found: true, running: true, code: null, total: 4, gap: 0, lines: ['c', 'd'] });
    run.end(100);
    expect(aptRunStatus('eeeeeeee5', 4)).toMatchObject({ running: false, code: 100, lines: [] });
    expect(aptRunStatus('ffffffff6', 0)).toEqual({ found: false });
  });

  it('says how many missed lines the tail no longer holds', () => {
    const run = beginAptRun({ runId: 'gggggggg7', packages: ['x'], full: false });
    for (let i = 1; i <= 1005; i++) run.push(`l${i}`);
    run.end(0);
    const st = aptRunStatus('gggggggg7', 2);
    expect(st.gap).toBe(3);                 // lines 3..5 were dropped
    expect(st.lines[0]).toBe('l6');
    expect(st.lines).toHaveLength(1000);
  });

  it('validates the run id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await dispatch(signed('apt.upgradeStatus', { runId: '../x' }));
    expect(out).toMatchObject({ ok: false, error: 'invalid run id' });
  });
});

function harness(status) {
  const recorded = [];
  const updates = {
    cached: () => ({ updates: [{ package: 'docker-ce', installed: '29.9.0', candidate: '29.9.2' }] }),
    list: async () => ({ available: true, updates: [] }),
    upgradeStatus: vi.fn(async () => status()),
    upgrade: vi.fn(async ({ runId }, onLine) => { onLine('Setting up docker-ce'); return { code: 0, runId }; }),
  };
  const updatesRepo = { recordBatch: (rows) => recorded.push(...rows), record: (r) => recorded.push(r), saveCache: () => {} };
  const app = express();
  app.use('/api/updates', updatesRouter({ updates, updatesRepo, updateScheduler: {}, requireControl: (q, s, next) => next() }));
  return { app, updates, recorded };
}

describe('GET /api/updates/run/:id', () => {
  const finished = { found: true, running: false, code: 0, packages: ['docker-ce'], full: false, total: 2, gap: 0, lines: ['x', 'y'] };

  it('records History once for a finished run no live stream recorded', async () => {
    const { app, recorded } = harness(() => finished);
    const a = await request(app).get('/api/updates/run/abcdef123456?after=1');
    expect(a.body).toMatchObject({ found: true, running: false, code: 0, recorded: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ packageName: 'docker-ce', fromV: '29.9.0', toV: '29.9.2', result: 'success' });
    await request(app).get('/api/updates/run/abcdef123456?after=2');
    expect(recorded).toHaveLength(1);
  });

  it('does not record a run that is still going', async () => {
    const { app, recorded } = harness(() => ({ ...finished, running: true, code: null }));
    const r = await request(app).get('/api/updates/run/abcdef123456');
    expect(r.body.running).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it('leaves a run streamed by this process to the stream', async () => {
    const { app, recorded } = harness(() => finished);
    await request(app).get('/api/updates/stream?packages=docker-ce&run=abcdef123456');
    expect(recorded).toHaveLength(1);
    await request(app).get('/api/updates/run/abcdef123456');
    expect(recorded).toHaveLength(1);
  });

  it('records nothing when the agent refuses a concurrent upgrade', async () => {
    const { app, updates, recorded } = harness(() => finished);
    updates.upgrade.mockRejectedValueOnce(new Error('another upgrade is already running on this host (docker-ce, started 17:41:08)'));
    const r = await request(app).get('/api/updates/stream?packages=docker-ce&run=abcdef123456');
    expect(r.text).toMatch(/event: failed/);
    expect(recorded).toHaveLength(0);
  });

  it('rejects a malformed run id', async () => {
    const { app } = harness(() => finished);
    expect((await request(app).get('/api/updates/run/x')).status).toBe(400);
  });
});
