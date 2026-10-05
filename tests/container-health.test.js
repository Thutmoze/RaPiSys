/** RaPiSys — container health alert rules: per-container engine, config, bells. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

process.env.SECRET_KEY = 'a'.repeat(64);

const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createAlertsRepo } = await import('../server/repositories/alerts.js');
const { createAlertEngine } = await import('../server/services/alerting.js');
const { alertsRouter } = await import('../server/routes/alerts.js');
const {
  normalizeHealthConfig, validateHealthConfig, coversContainer, setContainerWatched,
} = await import('../server/services/container-health.js');

function fixture(containers = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-ch-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const metricsRepo = createMetricsRepo(db);
  const eventsRepo = createEventsRepo(db);
  const alertsRepo = createAlertsRepo(db);
  const sent = [];
  const sampler = {
    getLiveNames: () => ({ containers: new Map(containers.map((c) => [c.slug, c.name])) }),
    getContainers: () => containers,
  };
  const engine = createAlertEngine({
    alertsRepo, metricsRepo, eventsRepo, sampler,
    mailer: { send: async (m) => sent.push(m) },
    getSettings: async () => ({ rapisys: { smtp: { host: 'x', to: 'a@b' } } }),
  });
  return { db, metricsRepo, eventsRepo, alertsRepo, engine, sent, sampler };
}

const healthRule = (config, extra = {}) => ({
  name: 'Container health', metric: 'docker.health', op: '<', threshold: 1, sustain_s: 0,
  severity: 'critical', enabled: 1, cooldown_s: 900, escalate_after_s: null, channels: ['ui', 'email'],
  config, ...extra,
});

describe('container health engine', () => {
  it('fires and resolves per container, skipping excluded ones', async () => {
    const f = fixture([
      { slug: 'pihole', name: 'pihole', state: 'running', health: 'unhealthy', failingStreak: 3,
        healthOutput: "dig: couldn't get address" },
      { slug: 'watchtower', name: 'watchtower', state: 'exited', health: 'none', exitCode: 0 },
      { slug: 'web', name: 'web', state: 'running', health: 'healthy' },
    ]);
    const id = f.alertsRepo.createRule(healthRule({ scope: 'all', exclude: ['watchtower'], conditions: ['down', 'unhealthy'] }));
    const t0 = Date.now();
    f.metricsRepo.writeBatch(t0, [
      { metric: 'docker.pihole.up', value: 1 }, { metric: 'docker.pihole.health', value: 0 },
      { metric: 'docker.watchtower.up', value: 0 },
      { metric: 'docker.web.up', value: 1 }, { metric: 'docker.web.health', value: 1 },
    ]);
    await f.engine.evaluateOnce(t0);           // ok -> pending
    await f.engine.evaluateOnce(t0 + 1000);    // pending -> firing (sustain 0)

    expect(f.alertsRepo.getTargetState(id, 'pihole').state).toBe('firing');
    expect(f.alertsRepo.getTargetState(id, 'watchtower').state).toBe('ok');   // excluded
    expect(f.alertsRepo.getTargetState(id, 'web').state).toBe('ok');
    expect(f.alertsRepo.getState(id).state).toBe('ok');                       // no rule-level state

    const active = f.alertsRepo.active();
    expect(active.length).toBe(1);
    expect(active[0]).toMatchObject({ target: 'pihole' });
    expect(active[0].reason).toContain('unhealthy');

    expect(f.sent.length).toBe(1);
    expect(f.sent[0].subject).toContain('pihole');
    expect(f.sent[0].text).toContain('is unhealthy: healthcheck failed 3 times in a row');
    expect(f.sent[0].text).toContain("Last check output: dig: couldn't get address");

    f.metricsRepo.writeBatch(t0 + 2000, [{ metric: 'docker.pihole.up', value: 1 }, { metric: 'docker.pihole.health', value: 1 }]);
    await f.engine.evaluateOnce(t0 + 3000);
    expect(f.alertsRepo.getTargetState(id, 'pihole').state).toBe('ok');
    expect(f.sent[1].text).toContain('running normally again');
    const hist = f.alertsRepo.history();
    expect(hist.length).toBe(1);
    expect(hist[0]).toMatchObject({ target: 'pihole' });
    expect(hist[0].resolved_at).not.toBeNull();
  });

  it('"All containers" ignores removed containers; a picked one still counts', async () => {
    const f = fixture([{ slug: 'tmp', name: 'tmp', state: 'removed', health: 'none' },
      { slug: 'job', name: 'job', state: 'exited', health: 'none', exitCode: 2 }]);
    const all = f.alertsRepo.createRule(healthRule({ scope: 'all', conditions: ['down'] }));
    // 'ghost': stale samples from before a restart, unknown to the sampler now
    f.metricsRepo.writeBatch(Date.now() - 5000, [{ metric: 'docker.ghost.up', value: 0 }]);
    const picked = f.alertsRepo.createRule(healthRule({ scope: 'some', containers: ['tmp'], conditions: ['down'] }));
    const t0 = Date.now();
    f.metricsRepo.writeBatch(t0, [{ metric: 'docker.tmp.up', value: 0 }, { metric: 'docker.job.up', value: 0 }]);
    await f.engine.evaluateOnce(t0);
    await f.engine.evaluateOnce(t0 + 1000);
    expect(f.alertsRepo.getTargetState(all, 'tmp').state).toBe('ok');
    expect(f.alertsRepo.getTargetState(all, 'ghost').state).toBe('ok');
    expect(f.alertsRepo.getTargetState(all, 'job').state).toBe('firing');
    expect(f.alertsRepo.getTargetState(picked, 'tmp').state).toBe('firing');
    const texts = f.sent.map((m) => m.text);
    expect(texts).toContain('Container job has stopped (last exit code 2).');
    expect(texts).toContain('Container tmp was removed.');
  });

  it('detects a restart loop from the restart count, ignoring a recreate reset', async () => {
    const f = fixture([{ slug: 'ha', name: 'homeassistant', state: 'running', health: 'none', exitCode: 137, oomKilled: true }]);
    const id = f.alertsRepo.createRule(healthRule({ scope: 'one', containers: ['ha'], conditions: ['restarts'], restarts: { count: 3, window_min: 10 } }));
    const t0 = Date.now();
    // recreated (5 -> 0) then crash-looping 0 -> 1 -> 3: 3 real restarts
    for (const [dt, v] of [[-240000, 5], [-180000, 0], [-120000, 1], [-60000, 3]]) {
      f.metricsRepo.writeBatch(t0 + dt, [{ metric: 'docker.ha.restarts', value: v }]);
    }
    f.metricsRepo.writeBatch(t0, [{ metric: 'docker.ha.up', value: 1 }, { metric: 'docker.ha.restarts', value: 3 }]);
    await f.engine.evaluateOnce(t0);
    await f.engine.evaluateOnce(t0 + 1000);
    expect(f.alertsRepo.getTargetState(id, 'ha').state).toBe('firing');
    expect(f.sent[0].text).toContain('keeps restarting: 3 restarts in the last 10 min (last exit code 137, out of memory)');
  });

  it('does not fire for 2 restarts when the threshold is 3', async () => {
    const f = fixture([{ slug: 'ha', name: 'ha', state: 'running', health: 'none' }]);
    const id = f.alertsRepo.createRule(healthRule({ scope: 'some', containers: ['ha'], conditions: ['restarts'] }));
    const t0 = Date.now();
    f.metricsRepo.writeBatch(t0 - 60000, [{ metric: 'docker.ha.restarts', value: 0 }]);
    f.metricsRepo.writeBatch(t0, [{ metric: 'docker.ha.up', value: 1 }, { metric: 'docker.ha.restarts', value: 2 }]);
    await f.engine.evaluateOnce(t0);
    expect(f.alertsRepo.getTargetState(id, 'ha').state).toBe('ok');
  });

  it('quietly closes a firing container once it leaves the rule scope', async () => {
    const f = fixture([{ slug: 'db', name: 'db', state: 'exited', health: 'none' }]);
    const id = f.alertsRepo.createRule(healthRule({ scope: 'some', containers: ['db'], conditions: ['down'] }));
    const t0 = Date.now();
    f.metricsRepo.writeBatch(t0, [{ metric: 'docker.db.up', value: 0 }]);
    await f.engine.evaluateOnce(t0);
    await f.engine.evaluateOnce(t0 + 1000);
    expect(f.alertsRepo.getTargetState(id, 'db').state).toBe('firing');
    expect(f.sent[0].text).toContain('Container db has stopped');

    const rule = f.alertsRepo.getRule(id);
    f.alertsRepo.updateRule(id, { ...rule, channels: ['ui', 'email'], config: { scope: 'some', containers: [], conditions: ['down'], managed: true } });
    await f.engine.evaluateOnce(t0 + 2000);
    expect(f.alertsRepo.listTargetStates(id).length).toBe(0);
    expect(f.alertsRepo.active().length).toBe(0);
    expect(f.alertsRepo.history()[0].resolved_at).not.toBeNull();
    expect(f.sent.length).toBe(1);                 // no "recovered" notice for an unwatched container
  });

  it('leaves ordinary threshold rules untouched', async () => {
    const f = fixture();
    const id = f.alertsRepo.createRule({ name: 'hot', metric: 'temp.cpu', op: '>', threshold: 80, sustain_s: 0,
      severity: 'critical', enabled: 1, cooldown_s: 900, escalate_after_s: null, channels: ['ui'] });
    const t0 = Date.now();
    f.metricsRepo.writeBatch(t0, [{ metric: 'temp.cpu', value: 90 }]);
    await f.engine.evaluateOnce(t0);
    await f.engine.evaluateOnce(t0 + 1000);
    expect(f.alertsRepo.getState(id).state).toBe('firing');
    expect(f.alertsRepo.active()[0].target).toBeUndefined();
  });
});

describe('container health config', () => {
  it('normalizes, validates and toggles', () => {
    const c = normalizeHealthConfig('{"scope":"all","exclude":["Watch Tower"],"conditions":["unhealthy","bogus"]}');
    expect(c).toMatchObject({ scope: 'all', exclude: ['watch-tower'], conditions: ['unhealthy'], restarts: { count: 3, window_min: 10 } });
    expect(coversContainer(c, 'pihole')).toBe(true);
    expect(coversContainer(c, 'watch-tower')).toBe(false);
    expect(coversContainer(setContainerWatched(c, 'watch-tower', true), 'watch-tower')).toBe(true);

    expect(validateHealthConfig({ scope: 'some', containers: [], conditions: ['down'] })).not.toEqual([]);
    expect(validateHealthConfig({ scope: 'some', containers: [], conditions: ['down'], managed: true })).toEqual([]);
    expect(validateHealthConfig({ scope: 'one', containers: ['a'], conditions: [] })).not.toEqual([]);
    expect(validateHealthConfig({ scope: 'one', containers: ['a'], conditions: ['down'] })).toEqual([]);

    const one = normalizeHealthConfig({ scope: 'one', containers: ['a'] });
    expect(setContainerWatched(one, 'b', true)).toMatchObject({ scope: 'some', containers: ['a', 'b'] });
  });
});

describe('alerts routes: container health', () => {
  function app(f, settings = { rapisys: { smtp: { host: 'x' } } }) {
    const a = express();
    a.use(express.json());
    a.use('/api/alerts', alertsRouter({
      alertsRepo: f.alertsRepo, metricsRepo: f.metricsRepo, sampler: f.sampler,
      requireAuth: (req, res, next) => next(), getSettings: async () => settings,
    }));
    return a;
  }

  it('bell creates the managed rule once, then toggles containers in it', async () => {
    const f = fixture([{ slug: 'pihole', name: 'pihole', state: 'running', health: 'healthy' },
      { slug: 'web', name: 'web', state: 'running', health: 'none' }]);
    const a = app(f);
    const r1 = await request(a).post('/api/alerts/containers/pihole/watch').send({ watch: true });
    expect(r1.body.created).toBe(true);
    await request(a).post('/api/alerts/containers/web/watch').send({ watch: true });
    expect(f.alertsRepo.countRules()).toBe(1);

    const rule = (await request(a).get('/api/alerts/rules')).body.rules[0];
    expect(rule.metric).toBe('docker.health');
    expect(rule.channels).toEqual(['ui', 'email']);
    expect(rule.config).toMatchObject({ scope: 'some', containers: ['pihole', 'web'], managed: true });

    await request(a).post('/api/alerts/containers/pihole/watch').send({ watch: false });
    const list = (await request(a).get('/api/alerts/containers')).body;
    expect(list.containers.find((c) => c.slug === 'pihole').bell).toBe(false);
    expect(list.containers.find((c) => c.slug === 'web')).toMatchObject({ bell: true, watchedBy: [{ id: rule.id }] });

    // editing the rule in the form keeps it the bells' rule
    const put = await request(a).put(`/api/alerts/rules/${rule.id}`).send({ ...rule, config: { scope: 'all', exclude: [], conditions: ['down'] } });
    expect(put.status).toBe(200);
    expect((await request(a).get('/api/alerts/rules')).body.rules[0].config.managed).toBe(true);
  });

  it('validates health rules and lists the picker entry without raw inputs', async () => {
    const f = fixture();
    const a = app(f);
    const bad = await request(a).post('/api/alerts/rules').send({ name: 'x', metric: 'docker.health', severity: 'warning', config: { scope: 'some', containers: [], conditions: ['down'] } });
    expect(bad.status).toBe(400);
    const ok = await request(a).post('/api/alerts/rules').send({ name: 'x', metric: 'docker.health', severity: 'warning', config: { scope: 'all', conditions: ['down'] } });
    expect(ok.status).toBe(200);

    f.metricsRepo.writeBatch(Date.now(), [{ metric: 'docker.pihole.up', value: 1 }, { metric: 'docker.pihole.health', value: 1 },
      { metric: 'docker.pihole.restarts', value: 0 }, { metric: 'cpu.usage', value: 5 }]);
    const keys = (await request(a).get('/api/alerts/metrics')).body.metrics.map((m) => m.key);
    expect(keys).toContain('docker.health');
    expect(keys).toContain('cpu.usage');
    expect(keys).not.toContain('docker.pihole.up');
    expect(keys).not.toContain('docker.pihole.health');
    expect(keys).not.toContain('docker.pihole.restarts');
  });
});

describe('metrics repo: listMetrics', () => {
  it('lists each metric once, sorted, via index seeks rather than a table scan', () => {
    const f = fixture();
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      f.metricsRepo.writeBatch(t0 - i * 10000, [{ metric: 'temp.cpu', value: 50 }, { metric: 'a.first', value: 1 }, { metric: 'docker.x.up', value: 1 }]);
    }
    expect(f.metricsRepo.listMetrics()).toEqual(['a.first', 'docker.x.up', 'temp.cpu']);
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT (SELECT MIN(metric) FROM metrics WHERE metric > 'a')`).all().map((r) => r.detail).join(' ');
    expect(plan).toMatch(/SEARCH metrics/);
  });

  it('returns an empty list for an empty table', () => {
    expect(fixture().metricsRepo.listMetrics()).toEqual([]);
  });
});
