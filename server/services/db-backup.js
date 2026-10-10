/**
 * RaPiSys — database backups to the NAS
 * -------------------------------------
 * rapisys.db lives on local storage (on a CIFS share its synchronous reads
 * freeze the event loop). The NAS gets compressed snapshots instead, the same
 * pattern as the Pi-hole log backups:
 *
 *   1. SQLite online backup of the live DB into a temp file next to it (local)
 *   2. PRAGMA quick_check on the snapshot
 *   3. gzip streamed to <nas>/rapisys-backups/rapisys-YYYY-MM-DD-HHMM.db.gz
 *      (written as .partial, renamed when complete)
 *   4. prune to the newest `retain` backups
 *
 * Steps 1-2 only touch local disk. Step 3 is a stream (zlib and fs run on the
 * libuv threadpool), so a slow share delays the backup, never the server.
 *
 * Config: settings.rapisys.dbBackup = { enabled, frequency: daily|weekly, retain }
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { pipeline } from 'stream/promises';
import { fsTypeOf, NETWORK_FS } from '../core/db.js';

const require = createRequire(import.meta.url);

export const DB_BACKUP_DIR = 'rapisys-backups';
export const DEFAULT_DB_BACKUP = Object.freeze({ enabled: false, frequency: 'daily', retain: 14 });
const NAME_RE = /^rapisys-\d{4}-\d{2}-\d{2}-\d{4}\.db\.gz$/;
const RETRY_AFTER_FAIL_MS = 6 * 3600e3;

export function normalizeBackupConfig(c) {
  const x = c && typeof c === 'object' ? c : {};
  return {
    enabled: !!x.enabled,
    frequency: x.frequency === 'weekly' ? 'weekly' : 'daily',
    retain: Math.min(Math.max(parseInt(x.retain, 10) || DEFAULT_DB_BACKUP.retain, 1), 365),
  };
}

/** rapisys-2026-10-05-0300.db.gz, in the Pi's local time (TZ is passed to the container). */
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `rapisys-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.db.gz`;
}

/** Open a file read-only for verification with whichever engine is available. */
function openReadOnly(file) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    return { get: (sql) => db.prepare(sql).get(), close: () => db.close() };
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    return { get: (sql) => db.prepare(sql).get(), close: () => db.close() };
  }
}

export function createDbBackup({ getDb, dbMeta, loadSettings, withFileLock, saveSettings, events, now = () => new Date(), isNetworkMount, nasTimeoutMs = 5000 }) {
  let running = null;
  let lastAttempt = { at: 0, ok: null, error: null };
  let enabledCache = false;   // refreshed on every settings read (tick is hourly)

  // Every touch of the share is async and bounded: a hung CIFS mount puts a
  // synchronous stat/readdir into uninterruptible sleep and would freeze the
  // whole server (the same reason the database itself stays local).
  const bounded = (p, fallback) => Promise.race([
    p.catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), nasTimeoutMs).unref?.()),
  ]);

  // Injected in tests; in production: the mountpoint must really be a share,
  // otherwise an unmounted NAS would silently fill the Pi's own disk.
  const mounted = (dir) => bounded(isNetworkMount
    ? Promise.resolve().then(() => isNetworkMount(dir))
    : fs.promises.stat(dir).then((st) => st.isDirectory() && NETWORK_FS.has(fsTypeOf(dir))), false);

  // status() is polled by the Storage page; the share is read at most this often.
  const STATUS_TTL_MS = 30e3;
  let statusCache = null;   // { at, value }

  async function settings() {
    const s = await loadSettings();
    const config = normalizeBackupConfig(s.rapisys?.dbBackup);
    enabledCache = config.enabled;
    return { nas: s.rapisys?.nas || null, config };
  }

  async function listBackups(mountpoint) {
    const dir = path.join(mountpoint, DB_BACKUP_DIR);
    return bounded((async () => {
      const names = (await fs.promises.readdir(dir)).filter((n) => NAME_RE.test(n));
      const rows = await Promise.all(names.map((name) => fs.promises.stat(path.join(dir, name))
        .then((st) => ({ name, size: st.size, mtime: st.mtimeMs }), () => null)));
      return rows.filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
    })(), []);
  }

  /** Last failure, if it is newer than the last success (survives restarts via the event log). */
  function lastFailure(backups) {
    if (lastAttempt.at) return lastAttempt.ok ? null : { at: lastAttempt.at, error: lastAttempt.error };
    try {
      const [f] = events.recent(1, 'rapisys.backup.failed');
      const newestOk = backups[0]?.mtime || 0;
      if (f && f.ts > newestOk) return { at: f.ts, error: f.payload?.error || 'backup failed' };
    } catch { /* events unavailable */ }
    return null;
  }

  async function status() {
    const { nas, config } = await settings();
    let share = statusCache && Date.now() - statusCache.at < STATUS_TTL_MS ? statusCache.value : null;
    if (!share) {
      const isMounted = !!(nas?.mountpoint && await mounted(nas.mountpoint));
      share = { isMounted, backups: isMounted ? await listBackups(nas.mountpoint) : [] };
      statusCache = { at: Date.now(), value: share };
    }
    const { isMounted, backups } = share;
    return {
      nasConfigured: !!nas?.mountpoint,
      nas: nas ? { label: nas.label, mountpoint: nas.mountpoint, mounted: isMounted } : null,
      dir: nas?.mountpoint ? path.join(nas.mountpoint, DB_BACKUP_DIR) : null,
      config, backups, running: !!running, failure: lastFailure(backups),
      db: { path: dbMeta().path, fsType: dbMeta().fsType },
    };
  }

  async function saveConfig(body) {
    const config = normalizeBackupConfig(body);
    await withFileLock(async () => {
      const s = await loadSettings();
      s.rapisys = s.rapisys || {};
      s.rapisys.dbBackup = config;
      await saveSettings(s);
    });
    enabledCache = config.enabled;
    return config;
  }

  async function doBackup(log) {
    const t0 = Date.now();
    const { nas, config } = await settings();
    if (!nas?.mountpoint) throw new Error('No NAS is configured. Set one up in Settings → Storage first');
    if (!await mounted(nas.mountpoint)) throw new Error(`NAS not mounted: ${nas.mountpoint} is not available`);
    const meta = dbMeta();
    if (NETWORK_FS.has(meta.fsType)) {
      throw new Error('The database itself is on a network share. Move it to local storage first');
    }

    const dir = path.join(nas.mountpoint, DB_BACKUP_DIR);
    const name = backupFileName(now());
    const tmp = path.join(path.dirname(meta.path), `.rapisys-backup-${process.pid}.db`);
    const dest = path.join(dir, name);
    const partial = `${dest}.partial`;
    try {
      // 1. consistent snapshot on local disk
      const size = (() => { try { return fs.statSync(meta.path).size; } catch { return 0; } })();
      log(`Snapshotting ${path.basename(meta.path)} (${mb(size)}) with SQLite online backup…`);
      const t1 = Date.now();
      removeSnapshot(tmp);
      const db = getDb();
      if (typeof db.backup === 'function') await db.backup(tmp);
      else db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);

      // 2. verify
      const ro = openReadOnly(tmp);
      let check;
      try { check = Object.values(ro.get('PRAGMA quick_check'))[0]; } finally { ro.close(); }
      if (check !== 'ok') throw new Error(`snapshot failed its integrity check: ${check}`);
      log(`Snapshot done in ${secs(Date.now() - t1)}, verifying (quick_check: ok)`);

      // 3. compress + copy (streamed)
      log(`Compressing and copying to ${dest}…`);
      const t2 = Date.now();
      await fs.promises.mkdir(dir, { recursive: true });
      await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(partial));
      await fs.promises.rename(partial, dest);
      const out = (await fs.promises.stat(dest)).size;
      log(`Copied ${mb(out)} in ${secs(Date.now() - t2)}`);

      // 4. prune
      const all = await listBackups(nas.mountpoint);
      const old = all.slice(config.retain);
      for (const b of old) await fs.promises.rm(path.join(dir, b.name), { force: true });
      for (const n of await bounded(fs.promises.readdir(dir), [])) {
        if (n.endsWith('.partial') && path.join(dir, n) !== partial) await fs.promises.rm(path.join(dir, n), { force: true });
      }
      if (old.length) log(`Pruned ${old.length} old backup${old.length === 1 ? '' : 's'} (keeping ${config.retain})`);

      const result = { file: dest, name, size: out, dbSize: size, ms: Date.now() - t0 };
      log(`✓ Backup complete (${mb(out)}).`);
      return result;
    } catch (err) {
      await fs.promises.rm(partial, { force: true }).catch(() => {});
      throw err;
    } finally {
      removeSnapshot(tmp);
    }
  }

  /** Run one backup now. Concurrent calls share the run in progress. */
  async function run(onLine = () => {}) {
    if (running) { onLine('A backup is already running, waiting for it…'); return running; }
    running = (async () => {
      try {
        const res = await doBackup(onLine);
        lastAttempt = { at: Date.now(), ok: true, error: null };
        events.add('rapisys.backup.ok', 'info', { file: res.file, size: res.size, ms: res.ms });
        return res;
      } catch (err) {
        lastAttempt = { at: Date.now(), ok: false, error: err.message };
        events.add('rapisys.backup.failed', 'warning', { error: err.message });
        throw err;
      } finally {
        running = null;
        statusCache = null;   // the share changed: show it on the next status()
      }
    })();
    return running;
  }

  /** Scheduler tick (hourly): back up when enabled and the last backup is due. */
  async function tick() {
    const { nas, config } = await settings();
    if (!config.enabled || !nas?.mountpoint || running) return null;
    if (!lastAttempt.ok && lastAttempt.at && Date.now() - lastAttempt.at < RETRY_AFTER_FAIL_MS) return null;
    const interval = config.frequency === 'weekly' ? 7 * 24 * 3600e3 : 24 * 3600e3;
    const newest = await mounted(nas.mountpoint) ? (await listBackups(nas.mountpoint))[0] : null;
    if (newest && Date.now() - newest.mtime < interval - 3600e3) return null;   // 1 h slack, like Pi-hole
    try { return await run(); } catch { return null; }   // recorded as an event
  }

  /** 1 while scheduled backups are on and the most recent attempt failed (alertable). */
  function failedMetric() {
    if (!enabledCache) return 0;
    return lastAttempt.at && !lastAttempt.ok ? 1 : 0;
  }

  return { status, saveConfig, run, tick, failedMetric, listBackups };
}

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** The snapshot plus the -wal/-shm files SQLite creates when it is opened to verify. */
function removeSnapshot(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}
