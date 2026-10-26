/** RaPiSys — Disk page instant load: saved last scan, streamed scan, streamed recommendations. */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

process.env.SECRET_KEY = 'a'.repeat(64);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';

const require = createRequire(import.meta.url);
const { DISK_SCAN_STEPS } = require('../agent/rapisys-agent.cjs');
const { openDatabase } = await import('../server/core/db.js');
const { createDiskRepo } = await import('../server/repositories/disk.js');
const { diskRouter } = await import('../server/routes/disk.js');
const { inventoryRouter } = await import('../server/routes/inventory.js');

function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-disk-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  return createDiskRepo(db);
}

// Parse an SSE body into [{ event, data }].
const events = (text) => text.trim().split('\n\n').map((block) => {
  const ev = block.match(/^event: (.*)$/m)?.[1];
  const data = block.match(/^data: (.*)$/m)?.[1];
  return { event: ev, data: data ? JSON.parse(data) : null };
});

const CATS = [
  { id: 'apt-cache', name: 'APT package cache', bytes: 1000, default: true },
  { id: 'journal', name: 'Systemd journal', bytes: 2000, default: true },
];

function diskApp(disk, diskRepo) {
  const app = express();
  app.use('/api/disk', diskRouter({ disk, diskRepo, requireControl: (q, s, n) => n(), loadSettings: async () => ({}), saveSettings: async () => {}, withFileLock: (f) => f(), events: { add() {} } }));
  return app;
}

describe('disk scan steps', () => {
  it('cover every cleanup category the server accepts, in scan order', () => {
    expect(DISK_SCAN_STEPS.map((s) => s.id)).toEqual(['apt-cache', 'journal', 'logs-rotated', 'tmp-stale',
      'apt-autoremove', 'docker-prune', 'crash-dumps', 'user-cache', 'user-old-files']);
  });

  it('match the placeholder rows the Disk page shows on a first scan', () => {
    const src = fs.readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf-8');
    for (const { id, name } of DISK_SCAN_STEPS) expect(src).toContain(`['${id}', '${name}']`);
  });
});

describe('disk repository', () => {
  it('has no scan before the first one, then returns the latest', () => {
    const repo = freshRepo();
    expect(repo.lastScan()).toBeNull();
    repo.saveScan({ categories: CATS, totalDefaultBytes: 3000, scannedAt: 111 });
    repo.saveScan({ categories: CATS.slice(0, 1), totalDefaultBytes: 1000, scannedAt: 222 });
    expect(repo.lastScan()).toEqual({ categories: CATS.slice(0, 1), totalDefaultBytes: 1000, scannedAt: 222 });
  });
});

describe('/api/disk scan routes', () => {
  it('streams steps and categories, then the full result, and saves it', async () => {
    const repo = freshRepo();
    const scan = { categories: CATS, totalDefaultBytes: 3000, scannedAt: 333 };
    const disk = {
      scan: vi.fn(async (target, onProgress) => {
        onProgress({ step: { id: 'apt-cache', name: 'APT package cache', index: 0, total: 9 } });
        onProgress({ category: CATS[0] });
        onProgress({ step: { id: 'journal', name: 'Systemd journal', index: 1, total: 9 } });
        onProgress({ category: CATS[1] });
        return scan;
      }),
    };
    const res = await request(diskApp(disk, repo)).get('/api/disk/scan/stream?journalTargetMB=300');
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(disk.scan.mock.calls[0][0]).toBe(300);
    const evs = events(res.text);
    expect(evs.map((e) => e.event)).toEqual(['step', 'category', 'step', 'category', 'done']);
    expect(evs[0].data).toMatchObject({ id: 'apt-cache', index: 0, total: 9 });
    expect(evs[3].data).toEqual(CATS[1]);
    expect(evs[4].data).toEqual(scan);
    const last = await request(diskApp(disk, repo)).get('/api/disk/scan/last');
    expect(last.body.scan).toEqual(scan);
  });

  it('reports a failed scan as an error event and keeps the previous result', async () => {
    const repo = freshRepo();
    repo.saveScan({ categories: CATS, totalDefaultBytes: 3000, scannedAt: 1 });
    const disk = { scan: async () => { throw new Error('agent unreachable: ENOENT'); } };
    const res = await request(diskApp(disk, repo)).get('/api/disk/scan/stream');
    expect(events(res.text)).toEqual([{ event: 'error', data: { message: 'agent unreachable: ENOENT' } }]);
    expect(repo.lastScan().scannedAt).toBe(1);
  });

  it('answers /scan/last with null before any scan, and saves plain /scan results too', async () => {
    const repo = freshRepo();
    const scan = { categories: CATS, totalDefaultBytes: 3000, scannedAt: 444 };
    const app = diskApp({ scan: async () => scan }, repo);
    expect((await request(app).get('/api/disk/scan/last')).body).toEqual({ scan: null });
    expect((await request(app).get('/api/disk/scan')).body).toEqual(scan);
    expect((await request(app).get('/api/disk/scan/last')).body.scan).toEqual(scan);
  });
});

describe('/api/inventory recommendations routes', () => {
  function invApp(inventory, snapshot = null) {
    let saved = snapshot;
    const inventoryRepo = { getRecommendations: () => saved, saveRecommendations: (r) => { saved = r; } };
    const app = express();
    app.use('/api/inventory', inventoryRouter({ inventory, inventoryRepo, requireControl: (q, s, n) => n(), events: { add() {} } }));
    return { app, saved: () => saved };
  }
  const result = { recommendations: [], counts: { total: 0, safe: 0, review: 0 }, generatedAt: 5 };

  it('cachedOnly answers at once when nothing was analyzed yet', async () => {
    const inventory = { recommendations: vi.fn(async () => result) };
    const { app } = invApp(inventory);
    expect((await request(app).get('/api/inventory/recommendations?cachedOnly=1')).body).toEqual({ none: true });
    expect(inventory.recommendations).not.toHaveBeenCalled();
  });

  it('streams each check, then the result, and saves it as the snapshot', async () => {
    const inventory = {
      recommendations: async ({ onCheck }) => { ['services', 'packages', 'containers', 'orphans'].forEach(onCheck); return result; },
    };
    const { app, saved } = invApp(inventory, { recommendations: [{ name: 'old' }], generatedAt: 1 });
    const res = await request(app).get('/api/inventory/recommendations/stream');
    const evs = events(res.text);
    expect(evs.slice(0, 4).map((e) => e.data.id)).toEqual(['services', 'packages', 'containers', 'orphans']);
    expect(evs[4]).toEqual({ event: 'done', data: { ...result, cached: false } });
    expect(saved()).toEqual(result);
  });
});
