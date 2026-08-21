/**
 * RaPiSys — NAS share replacement robustness.
 *
 * Regression cover for the failure that motivated this work: the agent's
 * unmount reported success while the share was still mounted, and the route
 * deleted the recorded share before writing an event that then threw against a
 * read-only database living on that very share. The result was a 502 that read
 * as "nothing happened" while settings had already been cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const agentCall = vi.fn();
vi.mock('../server/core/agent-client.js', () => ({
  agentCall: (...a) => agentCall(...a),
  agentAvailable: async () => true,
}));

const { setupRouter, buildMountOptions, mountpointFor } =
  await import('../server/routes/setup.js');

const NAS = { label: 'mybook', proto: 'cifs', host: '192.168.10.6', share: 'rapisys',
  mountpoint: '/mnt/rapisys/mybook', smbVersion: '1.0' };

/** Router under test with in-memory settings and a controllable DB location. */
function harness({ dbPath = '/mnt/rapisys/mybook/rapisys.db', nas = { ...NAS } } = {}) {
  const state = { settings: { rapisys: { nas, setupCompleted: true } }, dbPath, events: [], reopened: [] };
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRouter({
    loadSettings: async () => state.settings,
    saveSettings: async (s) => { state.settings = s; },
    withFileLock: async (fn) => fn(),
    secrets: { has: () => false }, mailer: {}, telegram: {},
    reopenDb: (p) => { state.reopened.push(p); state.dbPath = p; return { path: p }; },
    dbMeta: () => ({ path: state.dbPath }),
    fallbackDbPath: '/app/data/rapisys.db',
    requireAuth: (req, res, next) => next(),
    events: { add: (type, sev, payload) => { state.events.push({ type, payload }); } },
  }));
  return { app, state };
}

// mockClear rather than mockReset: resetting the implementation makes Vitest
// report a mocked rejection as an unhandled test error even when the route
// catches it, which is exactly the behaviour several of these tests exercise.
beforeEach(() => { agentCall.mockClear(); agentCall.mockImplementation(async () => ({})); });

describe('mount option building', () => {
  it('adds nobrl and nounix for SMB1 so SQLite can lock on old Samba', () => {
    const o = buildMountOptions({ proto: 'cifs', smbVersion: '1.0' });
    expect(o).toContain('vers=1.0');
    expect(o).toContain('nobrl');
    expect(o).toContain('nounix');
  });

  it('leaves byte-range locking alone on modern dialects', () => {
    const o = buildMountOptions({ proto: 'cifs', smbVersion: '3.0' });
    expect(o).toContain('vers=3.0');
    expect(o).not.toContain('nobrl');
  });

  it('rejects an unknown dialect rather than passing it to mount', () => {
    expect(buildMountOptions({ proto: 'cifs', smbVersion: '9.9' })).toContain('vers=3.0');
  });

  it('never leaks an SMB version into an NFS mount', () => {
    const o = buildMountOptions({ proto: 'nfs', smbVersion: '1.0' });
    expect(o).toContain('vers=4.1');
    expect(o).not.toContain('nobrl');
  });

  it('defaults to read-write and honours readOnly', () => {
    expect(buildMountOptions({ proto: 'cifs' })).toContain('rw');
    expect(buildMountOptions({ proto: 'cifs', readOnly: true })).toContain('ro');
  });

  it('sanitises the label into the mountpoint', () => {
    expect(mountpointFor('my book/../etc')).toBe('/mnt/rapisys/mybooketc');
  });
});

describe('preflight', () => {
  it('reports the database as on-share and names the holder', async () => {
    agentCall.mockResolvedValue({ mounted: true, holders: [{ pid: 3180857, comm: 'node' }] });
    const { app } = harness();
    const r = await request(app).get('/api/setup/nas/preflight?mountpoint=/mnt/rapisys/mybook');
    expect(r.status).toBe(200);
    expect(r.body.dbOnShare).toBe(true);
    expect(r.body.holders[0]).toMatchObject({ pid: 3180857, comm: 'node' });
  });

  it('reports clear when the database lives elsewhere', async () => {
    agentCall.mockResolvedValue({ mounted: true, holders: [] });
    const { app } = harness({ dbPath: '/app/data/rapisys.db' });
    const r = await request(app).get('/api/setup/nas/preflight?mountpoint=/mnt/rapisys/mybook');
    expect(r.body.dbOnShare).toBe(false);
  });

  it('does not treat a sibling directory as being on the share', async () => {
    agentCall.mockResolvedValue({ mounted: true, holders: [] });
    const { app } = harness({ dbPath: '/mnt/rapisys/mybook-old/rapisys.db' });
    const r = await request(app).get('/api/setup/nas/preflight?mountpoint=/mnt/rapisys/mybook');
    expect(r.body.dbOnShare).toBe(false);
  });

  it('still answers when the agent is unreachable', async () => {
    agentCall.mockImplementation(async () => { throw new Error('agent op timed out'); });
    const { app } = harness();
    const r = await request(app).get('/api/setup/nas/preflight?mountpoint=/mnt/rapisys/mybook');
    expect(r.status).toBe(200);
    expect(r.body.dbOnShare).toBe(true);
    expect(r.body.mounted).toBe(null);
  });

  it('refuses a mountpoint outside /mnt/rapisys', async () => {
    const { app } = harness();
    expect((await request(app).get('/api/setup/nas/preflight?mountpoint=/etc')).status).toBe(400);
  });
});

describe('unmount', () => {
  it('refuses when the database is on the share, and keeps the share recorded', async () => {
    const { app, state } = harness();
    const r = await request(app).post('/api/setup/nas/unmount').send({ mountpoint: '/mnt/rapisys/mybook' });
    expect(r.status).toBe(409);
    expect(r.body.dbOnShare).toBe(true);
    expect(agentCall).not.toHaveBeenCalled();
    expect(state.settings.rapisys.nas).toBeTruthy();
  });

  it('keeps the share recorded when the agent reports it is still mounted', async () => {
    agentCall.mockImplementation(async () => { throw new Error('/mnt/rapisys/mybook is still mounted: held by node (pid 3180857)'); });
    const { app, state } = harness({ dbPath: '/app/data/rapisys.db' });
    const r = await request(app).post('/api/setup/nas/unmount').send({ mountpoint: '/mnt/rapisys/mybook' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/still mounted/);
    // The regression: settings must survive a failed unmount.
    expect(state.settings.rapisys.nas).toMatchObject({ label: 'mybook' });
  });

  it('clears the share once the unmount is verified', async () => {
    agentCall.mockResolvedValue({ ok: true, unmounted: '/mnt/rapisys/mybook' });
    const { app, state } = harness({ dbPath: '/app/data/rapisys.db' });
    const r = await request(app).post('/api/setup/nas/unmount').send({ mountpoint: '/mnt/rapisys/mybook' });
    expect(r.status).toBe(200);
    expect(state.settings.rapisys.nas).toBeUndefined();
  });

  it('still succeeds when the event write fails, since the DB may have lived on the share', async () => {
    agentCall.mockResolvedValue({ ok: true });
    const { app, state } = harness({ dbPath: '/app/data/rapisys.db' });
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/setup', setupRouter({
      loadSettings: async () => state.settings,
      saveSettings: async (s) => { state.settings = s; },
      withFileLock: async (fn) => fn(),
      secrets: { has: () => false }, mailer: {}, telegram: {},
      reopenDb: (p) => ({ path: p }),
      dbMeta: () => ({ path: '/app/data/rapisys.db' }),
      fallbackDbPath: '/app/data/rapisys.db',
      requireAuth: (req, res, next) => next(),
      events: { add: () => { throw new Error('attempt to write a readonly database'); } },
    }));
    const r = await request(app2).post('/api/setup/nas/unmount').send({ mountpoint: '/mnt/rapisys/mybook' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('guided swap', () => {
  it('hands back a job id without echoing the password', async () => {
    const { app } = harness();
    const r = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: '192.168.10.6', share: 'rapisys/xrpi', password: 'hunter2' });
    expect(r.status).toBe(200);
    expect(r.body.job).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
  });

  it('requires the share fields', async () => {
    const { app } = harness();
    expect((await request(app).post('/api/setup/nas/swap').send({ label: 'x' })).status).toBe(400);
  });

  it('rejects an unknown or reused job', async () => {
    const { app } = harness();
    const { body } = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: 'h', share: 's' });
    agentCall.mockResolvedValue({ mounted: true });
    const first = await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(first.text).not.toContain('expired');
    // Single use: the credentials are consumed by the first stream.
    const second = await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(second.text).toContain('expired');
  });

  it('moves the database aside, swaps, and moves it back on success', async () => {
    agentCall.mockResolvedValue({ mounted: true });
    const { app, state } = harness();
    const { body } = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: '192.168.10.6', share: 'rapisys/xrpi', smbVersion: '1.0' });
    const r = await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(r.text).toContain('event: done');
    expect(state.reopened).toEqual(['/app/data/rapisys.db', '/mnt/rapisys/mybook/rapisys.db']);
    expect(state.settings.rapisys.nas.share).toBe('rapisys/xrpi');
    expect(state.settings.rapisys.storage.dbPath).toBe('/mnt/rapisys/mybook/rapisys.db');
  });

  it('passes SMB1 options through to the agent swap op', async () => {
    agentCall.mockResolvedValue({ mounted: true });
    const { app } = harness();
    const { body } = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: 'h', share: 's', smbVersion: '1.0' });
    await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    const swap = agentCall.mock.calls.find((c) => c[0] === 'nas.swap');
    expect(swap[1].options).toContain('nobrl');
    expect(swap[1].mountpoint).toBe('/mnt/rapisys/mybook');
  });

  it('puts the database back and leaves settings untouched when the swap fails', async () => {
    agentCall.mockImplementation(async () => { throw new Error('mount error(13): permission denied (previous share restored)'); });
    const { app, state } = harness();
    const { body } = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: 'h', share: 'rapisys/xrpi' });
    const r = await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(r.text).toContain('event: failed');
    expect(r.text).toContain('permission denied');
    // Moved to local, then back to where it started.
    expect(state.reopened).toEqual(['/app/data/rapisys.db', '/mnt/rapisys/mybook/rapisys.db']);
    expect(state.settings.rapisys.nas.share).toBe('rapisys');
  });

  it('does not touch the share when the database cannot be moved aside', async () => {
    const { app, state } = harness();
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/setup', setupRouter({
      loadSettings: async () => state.settings,
      saveSettings: async (s) => { state.settings = s; },
      withFileLock: async (fn) => fn(),
      secrets: { has: () => false }, mailer: {}, telegram: {},
      reopenDb: () => { throw new Error('directory not writable'); },
      dbMeta: () => ({ path: '/mnt/rapisys/mybook/rapisys.db' }),
      fallbackDbPath: '/app/data/rapisys.db',
      requireAuth: (req, res, next) => next(),
      events: { add: () => {} },
    }));
    const { body } = await request(app2).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: 'h', share: 'rapisys/xrpi' });
    const r = await request(app2).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(r.text).toContain('event: failed');
    expect(agentCall).not.toHaveBeenCalled();
    expect(state.settings.rapisys.nas.share).toBe('rapisys');
  });
});
