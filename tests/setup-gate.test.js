/** RaPiSys — setup endpoints after setup completes: control, never open. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

process.env.SECRET_KEY = 'a'.repeat(64);
delete process.env.ADMIN_TOKEN;

const agentCall = vi.fn(async () => ({}));
vi.mock('../server/core/agent-client.js', () => ({
  agentCall: (...a) => agentCall(...a),
  agentAvailable: async () => true,
}));

const { openDatabase } = await import('../server/core/db.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createAuth } = await import('../server/services/auth.js');
const { setupRouter } = await import('../server/routes/setup.js');

function harness(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-gate-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const state = { settings: { rapisys: { mode, setupCompleted: true } } };
  const auth = createAuth({ getDb: () => db, loadSettings: async () => state.settings, eventsRepo: createEventsRepo(db) });
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRouter({
    loadSettings: async () => state.settings,
    saveSettings: async (s) => { state.settings = s; },
    withFileLock: async (fn) => fn(),
    secrets: { has: () => false, set: () => {} }, mailer: {}, telegram: {},
    reopenDb: () => { throw new Error('must not be reached'); },
    dbMeta: () => ({ path: path.join(dir, 't.db') }),
    fallbackDbPath: path.join(dir, 'f.db'),
    requireAuth: auth.requireConfig, requireControl: auth.requireControl,
    events: { add: () => {} },
  }));
  return { app, state };
}

const CONTROL = [
  ['post', '/api/setup/mode', { mode: 'full' }],
  ['post', '/api/setup/nas/mount', { host: '10.0.0.66', share: 'x', label: 'x' }],
  ['post', '/api/setup/nas/unmount', { mountpoint: '/mnt/rapisys/x' }],
  ['post', '/api/setup/nas/swap', { label: 'x', host: '10.0.0.66', share: 'x' }],
  ['get', '/api/setup/nas/swap/stream', null],
  ['post', '/api/setup/storage', { dbPath: '/tmp/x/rapisys.db' }],
  ['post', '/api/setup/smtp', { host: 'smtp.evil.example' }],
  ['post', '/api/setup/telegram', { botToken: 'x' }],
  ['post', '/api/setup/complete', {}],
];

describe('setup gate after completion', () => {
  it('refuses every control change in monitor mode, unauthenticated', async () => {
    const { app, state } = harness('monitor');
    for (const [m, url, body] of CONTROL) {
      const r = await request(app)[m](url).send(body || undefined);
      expect([m, url, r.status]).toEqual([m, url, 403]);
    }
    expect(state.settings.rapisys.mode).toBe('monitor');
    expect(agentCall).not.toHaveBeenCalled();
  });

  it('requires sign-in in full mode', async () => {
    const { app } = harness('full');
    for (const [m, url, body] of CONTROL) {
      const r = await request(app)[m](url).send(body || undefined);
      expect([m, url, r.status]).toEqual([m, url, 401]);
    }
  });

  it('keeps retention a plain setting (open in monitor mode, like other settings)', async () => {
    const { app } = harness('monitor');
    const r = await request(app).post('/api/setup/retention').send({ days: 30 });
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });
});

describe('setup status after completion', () => {
  it('tells a signed-out browser only that setup is done (full mode)', async () => {
    const { app, state } = harness('full');
    state.settings.rapisys.smtp = { host: 'smtp.example', user: 'me', to: 'me@example.com' };
    state.settings.rapisys.nas = { host: '10.0.0.9', share: 'backup' };
    const r = await request(app).get('/api/setup/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ completed: true, mode: 'full' });
  });

  it('still returns the full status in monitor mode, where settings are open', async () => {
    const { app } = harness('monitor');
    const r = await request(app).get('/api/setup/status');
    expect(r.body.completed).toBe(true);
    expect(r.body).toHaveProperty('storage');
  });
});
