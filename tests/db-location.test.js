/** RaPiSys — database location safety: share warning, existing-database choice, swap. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

process.env.SECRET_KEY = 'a'.repeat(64);

// Directories containing "/nas" are reported as a CIFS share.
vi.mock('../server/core/db.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fsTypeOf: (d) => (String(d).includes('/nas') ? 'cifs' : 'ext4') };
});
const agentCall = vi.fn();
vi.mock('../server/core/agent-client.js', () => ({
  agentCall: (...a) => agentCall(...a),
  agentAvailable: async () => true,
}));

const { openDatabase } = await import('../server/core/db.js');
const { setupRouter } = await import('../server/routes/setup.js');
const { describeDbFile, prepareRelocation } = await import('../server/services/db-file-info.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-loc-'));

/** A real RaPiSys database with samples between `from` and `to`. */
function makeDb(file, from, to) {
  const root = path.dirname(file);
  const { db } = openDatabase({ dbPath: file, fallbackPath: path.join(root, 'fallback.db') });
  db.prepare(`INSERT INTO metrics (ts, res, metric, value) VALUES (?, '10s', 'cpu.usage', 1)`).run(from);
  db.prepare(`INSERT INTO metrics (ts, res, metric, value) VALUES (?, '1m', 'cpu.usage', 1)`).run(to);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

function harness({ curPath }) {
  const state = { settings: { rapisys: { setupCompleted: true } }, dbPath: curPath, reopened: [], events: [] };
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRouter({
    loadSettings: async () => state.settings,
    saveSettings: async (s) => { state.settings = s; },
    withFileLock: async (fn) => fn(),
    secrets: { has: () => false }, mailer: {}, telegram: {},
    reopenDb: (p, opts) => { state.reopened.push([p, opts]); state.dbPath = p; return { path: p, replaced: null }; },
    dbMeta: () => ({ path: state.dbPath, fsType: 'ext4' }),
    fallbackDbPath: '/app/data/rapisys.db',
    requireAuth: (req, res, next) => next(),
    events: { add: (type, sev, payload) => state.events.push({ type, payload }) },
  }));
  return { app, state };
}

beforeEach(() => { agentCall.mockClear(); agentCall.mockImplementation(async () => ({ mounted: true })); });

describe('describeDbFile', () => {
  it('reports size, mtime and the history span', () => {
    const f = path.join(tmp(), 'rapisys.db');
    makeDb(f, 1000, 5000);
    const d = describeDbFile(f);
    expect(d.size).toBeGreaterThan(0);
    expect(d.from).toBe(1000);
    expect(d.to).toBe(5000);
  });
  it('leaves no -wal/-shm files behind when it looks at a database', () => {
    const f = path.join(tmp(), 'rapisys.db');
    makeDb(f, 1000, 5000);
    fs.rmSync(`${f}-wal`, { force: true }); fs.rmSync(`${f}-shm`, { force: true });
    describeDbFile(f);
    expect(fs.existsSync(`${f}-wal`)).toBe(false);
    expect(fs.existsSync(`${f}-shm`)).toBe(false);
  });
  it('is null for a missing or empty file', () => {
    const dir = tmp();
    expect(describeDbFile(path.join(dir, 'none.db'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'empty.db'), '');
    expect(describeDbFile(path.join(dir, 'empty.db'))).toBeNull();
  });
});

describe('prepareRelocation', () => {
  const now = new Date(2026, 9, 5, 20, 4, 9);
  it('replace: sets the existing database and its WAL aside, keeping them', () => {
    const dir = tmp();
    const dst = path.join(dir, 'rapisys.db');
    fs.writeFileSync(dst, 'old'); fs.writeFileSync(`${dst}-wal`, 'oldwal');
    const r = prepareRelocation({ curPath: '/elsewhere/rapisys.db', dstPath: dst, existing: 'replace', now });
    expect(r).toEqual({ copy: true, replaced: `${dst}.replaced-2026-10-05-200409` });
    expect(fs.existsSync(dst)).toBe(false);
    expect(fs.readFileSync(`${dst}.replaced-2026-10-05-200409`, 'utf8')).toBe('old');
    expect(fs.readFileSync(`${dst}.replaced-2026-10-05-200409-wal`, 'utf8')).toBe('oldwal');
  });
  it('adopt: leaves the existing database in place and copies nothing', () => {
    const dir = tmp();
    const dst = path.join(dir, 'rapisys.db');
    fs.writeFileSync(dst, 'old'); fs.writeFileSync(`${dst}-wal`, 'w');
    expect(prepareRelocation({ curPath: '/x/rapisys.db', dstPath: dst, existing: 'adopt', now })).toEqual({ copy: false, replaced: null });
    expect(fs.readFileSync(dst, 'utf8')).toBe('old');
    expect(fs.existsSync(`${dst}-wal`)).toBe(true);
  });
  it('sets an orphaned WAL aside even when there is no database file', () => {
    const dir = tmp();
    const dst = path.join(dir, 'rapisys.db');
    fs.writeFileSync(`${dst}-wal`, 'stale');
    const r = prepareRelocation({ curPath: '/x/rapisys.db', dstPath: dst, now });
    expect(r.copy).toBe(true);
    expect(fs.existsSync(`${dst}-wal`)).toBe(false);
  });
  it('does nothing when the destination is the current database', () => {
    expect(prepareRelocation({ curPath: '/a/rapisys.db', dstPath: '/a/rapisys.db' })).toEqual({ copy: false, replaced: null });
  });
});

describe('POST /setup/storage/check and /setup/storage', () => {
  it('describes an existing database and the current one', async () => {
    const root = tmp();
    const cur = path.join(root, 'cur', 'rapisys.db'); fs.mkdirSync(path.dirname(cur)); makeDb(cur, 3000, 9000);
    const dst = path.join(root, 'old'); fs.mkdirSync(dst); makeDb(path.join(dst, 'rapisys.db'), 1000, 2000);
    const { app } = harness({ curPath: cur });
    const r = await request(app).post('/api/setup/storage/check').send({ dbDir: dst });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ network: false, sameAsCurrent: false, existing: { from: 1000, to: 2000 }, current: { from: 3000, to: 9000 } });
  });

  it('refuses an existing database until told to replace or switch to it', async () => {
    const root = tmp();
    const dst = path.join(root, 'old'); fs.mkdirSync(dst); makeDb(path.join(dst, 'rapisys.db'), 1000, 2000);
    const { app, state } = harness({ curPath: path.join(root, 'cur', 'rapisys.db') });
    const r1 = await request(app).post('/api/setup/storage').send({ dbDir: dst });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('exists');
    expect(state.reopened).toEqual([]);

    const r2 = await request(app).post('/api/setup/storage').send({ dbDir: dst, existing: 'adopt' });
    expect(r2.status).toBe(200);
    expect(state.reopened).toEqual([[path.join(dst, 'rapisys.db'), { existing: 'adopt' }]]);
    expect(state.settings.rapisys.storage.dbPath).toBe(path.join(dst, 'rapisys.db'));
  });

  it('refuses a network share until it is confirmed', async () => {
    const root = tmp();
    const share = path.join(root, 'nas', 'mybook'); fs.mkdirSync(share, { recursive: true });
    const { app, state } = harness({ curPath: path.join(root, 'cur', 'rapisys.db') });
    const check = await request(app).post('/api/setup/storage/check').send({ dbDir: share });
    expect(check.body).toMatchObject({ network: true, fsType: 'cifs' });
    const r1 = await request(app).post('/api/setup/storage').send({ dbDir: share });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('network');
    const r2 = await request(app).post('/api/setup/storage').send({ dbDir: share, allowNetwork: true });
    expect(r2.status).toBe(200);
    expect(state.reopened[0][1]).toEqual({ existing: 'replace' });
  });

  it('moves to an empty local folder without any question', async () => {
    const root = tmp();
    const dst = path.join(root, 'fresh');
    const { app } = harness({ curPath: path.join(root, 'cur', 'rapisys.db') });
    expect((await request(app).post('/api/setup/storage').send({ dbDir: dst })).status).toBe(200);
  });
});

describe('NAS swap with a local database', () => {
  it('swaps the share without moving the database onto it', async () => {
    const { app, state } = harness({ curPath: '/app/data/rapisys.db' });
    state.settings.rapisys.nas = { label: 'mybook', mountpoint: '/mnt/rapisys/mybook' };
    state.settings.rapisys.storage = { dbPath: '/app/data/rapisys.db' };
    const { body } = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: '192.168.10.6', share: 'rapisys/xrpi' });
    const r = await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(r.text).toContain('event: done');
    expect(r.text).toContain('database stays on local storage');
    expect(state.reopened).toEqual([]);
    expect(state.settings.rapisys.storage.dbPath).toBe('/app/data/rapisys.db');
    expect(state.settings.rapisys.nas.share).toBe('rapisys/xrpi');
  });

  it('moves a database that lived on the share with "replace", never adopting a stale local file', async () => {
    const { app, state } = harness({ curPath: '/mnt/rapisys/mybook/rapisys.db' });
    state.settings.rapisys.nas = { label: 'mybook', mountpoint: '/mnt/rapisys/mybook' };
    const { body } = await request(app).post('/api/setup/nas/swap')
      .send({ label: 'mybook', proto: 'cifs', host: 'h', share: 's' });
    await request(app).get(`/api/setup/nas/swap/stream?job=${body.job}`);
    expect(state.reopened).toEqual([
      ['/app/data/rapisys.db', { existing: 'replace' }],
      ['/mnt/rapisys/mybook/rapisys.db', { existing: 'replace' }],
    ]);
  });
});
