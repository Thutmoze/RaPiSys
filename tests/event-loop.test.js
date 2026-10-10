/** RaPiSys — event-loop delay monitor (health signal for blocking work). */
import { describe, it, expect } from 'vitest';
import { createEventLoopMonitor } from '../server/core/event-loop.js';

describe('event-loop monitor', () => {
  it('sees a synchronous block on the main thread', async () => {
    const mon = createEventLoopMonitor({ resolutionMs: 10, windowMs: 60e3 });
    await new Promise((r) => setTimeout(r, 50));
    const until = Date.now() + 120;
    while (Date.now() < until) { /* block the loop like execSync would */ }
    await new Promise((r) => setTimeout(r, 30));
    const s = mon.status();
    mon.stop();
    expect(s.current.maxMs).toBeGreaterThanOrEqual(80);
    expect(s.last).toBeNull();
    expect(s.resolutionMs).toBe(10);
  });
});

describe('stall detector', () => {
  it('records a stall with what was running', async () => {
    const { createStallDetector } = await import('../server/core/event-loop.js');
    const logs = [];
    const det = createStallDetector({ thresholdMs: 60, intervalMs: 10, log: (m) => logs.push(m),
      attribute: (from, to) => ({ jobs: to >= from ? ['retention'] : [] }) });
    await new Promise((r) => setTimeout(r, 30));
    const until = Date.now() + 150;
    while (Date.now() < until) { /* sync block */ }
    await new Promise((r) => setTimeout(r, 300));   // attribution is recorded a moment later
    det.stop();
    const [s] = det.stalls();
    expect(s.blockedMs).toBeGreaterThanOrEqual(100);
    expect(s.jobs).toEqual(['retention']);
    expect(logs[0]).toMatch(/blocked \d+ ms/);
  });

  it('attributes a forced major GC pause', async () => {
    const { createStallDetector } = await import('../server/core/event-loop.js');
    const { setFlagsFromString } = await import('v8');
    const { runInNewContext } = await import('vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    const det = createStallDetector({ thresholdMs: 1, intervalMs: 5, log: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    const junk = Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x'.repeat(20) }));
    gc();
    junk.length = 0;
    await new Promise((r) => setTimeout(r, 300));
    det.stop();
    expect(det.stalls().some((s) => s.gcMs && Object.keys(s.gcMs).length)).toBe(true);
  });
});

describe('scheduler activity', () => {
  it('names the job that ran in a span', async () => {
    const { createScheduler } = await import('../server/core/scheduler.js');
    const sched = createScheduler();
    let done;
    const finished = new Promise((r) => { done = r; });
    sched.register('retention', 60e3, () => { const u = Date.now() + 30; while (Date.now() < u) { /* */ } done(); }, { runNow: true });
    const t0 = Date.now();
    await finished;
    await new Promise((r) => setTimeout(r, 5));
    expect(sched.activity(t0, Date.now())).toEqual(['retention']);
    expect(sched.activity(0, 1)).toEqual([]);
    sched.stop();
  });
});

describe('request log', () => {
  it('matches requests to a span by path only', async () => {
    const { trackRequests, requestsBetween } = await import('../server/core/request-log.js');
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const app = express();
    app.use(trackRequests);
    app.get('/api/stats', (req, res) => res.json({}));
    const t0 = Date.now();
    await request(app).get('/api/stats?secret=1');
    expect(requestsBetween(t0, Date.now())).toContain('GET /api/stats');
  });
});
