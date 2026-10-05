/**
 * RaPiSys — describe a rapisys.db file without loading it
 * -------------------------------------------------------
 * Used by the database location check (wizard and Settings → Storage) to show
 * what an existing file at the destination holds before anyone chooses to
 * replace it or switch to it. Only index seeks: safe even on a network share.
 */

import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const TIERS = ['10s', '1m', '10m', '1h'];

function openReadOnly(file) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    return { get: (sql, ...a) => db.prepare(sql).get(...a), close: () => db.close() };
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    return { get: (sql, ...a) => db.prepare(sql).get(...a), close: () => db.close() };
  }
}

/** { size, mtime, from, to } for a database file, or null when there is none.
 * size includes a pending -wal (recent writes live there in WAL mode).
 * from/to (oldest/newest sample) are null when the file cannot be read.
 * Looking must not write: SQLite creates -shm/-wal when it opens a WAL
 * database, so any it created (empty) are removed again afterwards. */
export function describeDbFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size === 0) return null;
  let walSize = 0;
  try { walSize = fs.statSync(`${file}-wal`).size; } catch { /* no WAL */ }
  const out = { size: st.size + walSize, mtime: st.mtimeMs, from: null, to: null };
  const hadSidecar = { '-wal': fs.existsSync(`${file}-wal`), '-shm': fs.existsSync(`${file}-shm`) };
  let db;
  try {
    db = openReadOnly(file);
    for (const res of TIERS) {
      // (res, ts) index: one seek each
      const lo = db.get('SELECT MIN(ts) AS t FROM metrics WHERE res = ?', res)?.t;
      const hi = db.get('SELECT MAX(ts) AS t FROM metrics WHERE res = ?', res)?.t;
      if (lo != null && (out.from == null || lo < out.from)) out.from = lo;
      if (hi != null && (out.to == null || hi > out.to)) out.to = hi;
    }
  } catch { /* unreadable or not a RaPiSys database: size/mtime only */ }
  finally {
    try { db?.close(); } catch { /* */ }
    for (const suf of ['-wal', '-shm']) {
      const f = file + suf;
      try { if (!hadSidecar[suf] && fs.existsSync(f) && (suf === '-shm' || fs.statSync(f).size === 0)) fs.rmSync(f, { force: true }); }
      catch { /* best effort */ }
    }
  }
  return out;
}

/** Rename <file><suffix> to <base><suffix> for each suffix present; returns base if anything moved. */
function setAside(file, suffixes, base) {
  let moved = false;
  for (const suf of suffixes) {
    if (fs.existsSync(file + suf)) { fs.renameSync(file + suf, base + suf); moved = true; }
  }
  return moved ? base : null;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Get a relocation destination ready before the current database is copied
 * there (see reopenDb in rapisys.js).
 *   existing 'replace': a database already at dst is set aside as
 *                       <dst>.replaced-<stamp> (kept, never deleted)
 *   existing 'adopt':   it is left alone and used as-is
 * Leftover -wal/-shm/-journal files are always set aside before a copy, or
 * SQLite would replay a stale WAL onto the copied database.
 * Returns { copy, replaced }: whether to copy the current DB in, and the
 * set-aside path (if any).
 */
export function prepareRelocation({ curPath, dstPath, existing = 'replace', now = new Date() }) {
  if (dstPath === curPath) return { copy: false, replaced: null };
  let hasDb = false;
  try { hasDb = fs.existsSync(dstPath) && fs.statSync(dstPath).size > 0; } catch { /* */ }
  if (hasDb && existing === 'adopt') return { copy: false, replaced: null };
  const base = `${dstPath}.replaced-${stamp(now)}`;
  const replaced = hasDb ? setAside(dstPath, [''], base) : null;
  setAside(dstPath, ['-wal', '-shm', '-journal'], base);
  if (!hasDb) { try { fs.rmSync(dstPath, { force: true }); } catch { /* empty file */ } }
  return { copy: true, replaced };
}
