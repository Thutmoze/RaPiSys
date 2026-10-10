/** RaPiSys — rapisys.db backups to the NAS. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

process.env.SECRET_KEY = 'a'.repeat(64);

const { openDatabase } = await import('../server/core/db.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createDbBackup, backupFileName, normalizeBackupConfig } = await import('../server/services/db-backup.js');
const require = createRequire(import.meta.url);

function fixture({ backup = { enabled: true, frequency: 'daily', retain: 3 }, nasUp = true, fsType = 'ext4' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-bk-'));
  const nasDir = path.join(root, 'nas');
  fs.mkdirSync(nasDir);
  const handle = openDatabase({ dbPath: path.join(root, 'data', 'rapisys.db'), fallbackPath: path.join(root, 'f.db') });
  const events = createEventsRepo(handle.db);
  handle.db.prepare(`INSERT INTO metrics (ts, res, metric, value) VALUES (?, '10s', 'cpu.usage', ?)`).run(1000, 42);
  let settings = { rapisys: { nas: { label: 'mybook', mountpoint: nasDir }, dbBackup: backup } };
  let clock = new Date(2026, 9, 5, 3, 0);
  const svc = createDbBackup({
    getDb: () => handle.db,
    dbMeta: () => ({ ...handle.meta, fsType }),
    loadSettings: async () => structuredClone(settings),
    saveSettings: async (s) => { settings = s; },
    withFileLock: async (fn) => fn(),
    events,
    now: () => clock,
    isNetworkMount: () => nasUp,
  });
  return { root, nasDir, handle, events, svc, setClock: (d) => { clock = d; }, getSettings: () => settings,
    setNas: (v) => { nasUp = v; } };
}

function readBackup(file) {
  const out = file.replace(/\.gz$/, '.check');
  fs.writeFileSync(out, zlib.gunzipSync(fs.readFileSync(file)));
  const Database = require('better-sqlite3');
  const db = new Database(out, { readonly: true });
  return db;
}

describe('database backup to NAS', () => {
  it('writes a gzip snapshot that opens and holds the data', async () => {
    const f = fixture();
    const lines = [];
    const res = await f.svc.run((l) => lines.push(l));
    expect(res.name).toBe('rapisys-2026-10-05-0300.db.gz');
    expect(fs.existsSync(path.join(f.nasDir, 'rapisys-backups', res.name))).toBe(true);
    const db = readBackup(res.file);
    expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    expect(db.prepare(`SELECT value FROM metrics WHERE metric = 'cpu.usage'`).get().value).toBe(42);
    expect(lines.some((l) => l.includes('quick_check: ok'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^✓ Backup complete/);
    // no temp or partial files left behind
    expect(fs.readdirSync(path.join(f.root, 'data')).filter((n) => n.startsWith('.rapisys-backup'))).toEqual([]);
    expect(fs.readdirSync(path.join(f.nasDir, 'rapisys-backups')).filter((n) => n.endsWith('.partial'))).toEqual([]);
    expect(f.events.recent(1, 'rapisys.backup.ok').length).toBe(1);
    expect(f.svc.failedMetric()).toBe(0);
  });

  it('keeps only the newest `retain` backups', async () => {
    const f = fixture({ backup: { enabled: true, retain: 2 } });
    for (const d of [1, 2, 3, 4]) { f.setClock(new Date(2026, 9, d, 3, 0)); await f.svc.run(); }
    const names = fs.readdirSync(path.join(f.nasDir, 'rapisys-backups')).sort();
    expect(names).toEqual(['rapisys-2026-10-03-0300.db.gz', 'rapisys-2026-10-04-0300.db.gz']);
    const st = await f.svc.status();
    expect(st.backups.map((b) => b.name)).toEqual(['rapisys-2026-10-04-0300.db.gz', 'rapisys-2026-10-03-0300.db.gz']);
  });

  it('fails cleanly when the NAS is not mounted, and reports it', async () => {
    const f = fixture({ nasUp: false });
    await expect(f.svc.run()).rejects.toThrow(/NAS not mounted/);
    expect(f.events.recent(1, 'rapisys.backup.failed')[0].payload.error).toMatch(/NAS not mounted/);
    expect(f.svc.failedMetric()).toBe(1);
    expect((await f.svc.status()).failure.error).toMatch(/NAS not mounted/);
    expect(fs.existsSync(path.join(f.nasDir, 'rapisys-backups'))).toBe(false);

    f.setNas(true);
    await f.svc.run();
    expect(f.svc.failedMetric()).toBe(0);
    expect((await f.svc.status()).failure).toBeNull();
  });

  it('reports a hung share as not mounted instead of freezing', async () => {
    const f = fixture();
    const hung = createDbBackup({
      getDb: () => f.handle.db, dbMeta: () => ({ ...f.handle.meta, fsType: 'ext4' }),
      loadSettings: async () => structuredClone(f.getSettings()), saveSettings: async () => {},
      withFileLock: async (fn) => fn(), events: f.events,
      isNetworkMount: () => new Promise(() => {}),   // a CIFS stat that never returns
      nasTimeoutMs: 50,
    });
    const started = Date.now();
    const st = await hung.status();
    expect(st.nas.mounted).toBe(false);
    expect(st.backups).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(hung.run()).rejects.toThrow(/NAS not mounted/);
  });

  it('refuses while the database itself is on a network share', async () => {
    const f = fixture({ fsType: 'cifs' });
    await expect(f.svc.run()).rejects.toThrow(/network share/);
  });

  it('scheduler runs only when enabled and due', async () => {
    const off = fixture({ backup: { enabled: false } });
    expect(await off.svc.tick()).toBeNull();

    const f = fixture();
    const first = await f.svc.tick();
    expect(first?.name).toBeTruthy();
    expect(await f.svc.tick()).toBeNull();            // just backed up: not due for a day
  });

  it('saves a normalized schedule', async () => {
    const f = fixture({ backup: undefined });
    const cfg = await f.svc.saveConfig({ enabled: true, frequency: 'hourly', retain: 9999 });
    expect(cfg).toEqual({ enabled: true, frequency: 'daily', retain: 365 });
    expect(f.getSettings().rapisys.dbBackup).toEqual(cfg);
    expect(normalizeBackupConfig(null)).toEqual({ enabled: false, frequency: 'daily', retain: 14 });
    expect(backupFileName(new Date(2026, 0, 2, 4, 5))).toBe('rapisys-2026-01-02-0405.db.gz');
  });
});
