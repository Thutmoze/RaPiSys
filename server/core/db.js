/**
 * RaPiSys — Core database layer
 * -----------------------------
 * SQLite storage with two engines:
 *   1. better-sqlite3 (preferred, native, used in the production image)
 *   2. node:sqlite    (built into Node >= 22, automatic fallback so the app
 *                      never fails to start because a native build failed)
 *
 * Handles three deployment realities of a Raspberry Pi 5:
 *   - The DB may live on a NAS (CIFS/NFS). WAL mode requires shared memory
 *     and POSIX locks that network filesystems do not provide, so we detect
 *     the filesystem type and pick a safe journal mode automatically.
 *   - The NAS may be offline at boot. We then fall back to a local DB file
 *     and expose `degraded: true` so the UI can show a warning banner.
 *   - SD cards wear out. When the DB is local we still use WAL with a
 *     relaxed sync level and batched transactions to minimise writes.
 *
 * All SQL elsewhere in the codebase goes through repositories/, never here.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** Filesystem types where SQLite locking/WAL is unsafe. */
const NETWORK_FS = new Set(['cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'fuse.sshfs']);

/** Resolve the filesystem type of the mount that contains `dir`. */
export function fsTypeOf(dir) {
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf-8')
      .split('\n')
      .map((l) => l.split(' '))
      .filter((p) => p.length >= 3)
      .map(([dev, mnt, type]) => ({ dev, mnt, type }));
    const abs = path.resolve(dir);
    let best = { mnt: '/', type: 'unknown' };
    for (const m of mounts) {
      if ((abs === m.mnt || abs.startsWith(m.mnt.endsWith('/') ? m.mnt : m.mnt + '/'))
          && m.mnt.length >= best.mnt.length) {
        best = m;
      }
    }
    return best.type;
  } catch {
    return 'unknown';
  }
}

/** Load whichever SQLite engine is available. */
function loadEngine() {
  try {
    const Database = require('better-sqlite3');
    return { name: 'better-sqlite3', open: (file) => new Database(file) };
  } catch {
    // Fall back to the built-in engine (Node >= 22).
    const { DatabaseSync } = require('node:sqlite');
    return {
      name: 'node:sqlite',
      open: (file) => {
        const raw = new DatabaseSync(file);
        // Adapt to the (subset of the) better-sqlite3 API we use.
        return {
          exec: (sql) => raw.exec(sql),
          prepare: (sql) => {
            const st = raw.prepare(sql);
            return {
              run: (...a) => st.run(...a),
              get: (...a) => st.get(...a),
              all: (...a) => st.all(...a),
            };
          },
          pragma: (p) => raw.exec(`PRAGMA ${p}`),
          transaction: (fn) => (...args) => {
            raw.exec('BEGIN');
            try { const r = fn(...args); raw.exec('COMMIT'); return r; }
            catch (e) { raw.exec('ROLLBACK'); throw e; }
          },
          close: () => raw.close(),
        };
      },
    };
  }
}

/** Run versioned .sql migrations from server/core/migrations. */
function migrate(db, migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, Date.now());
    });
    apply();
    console.log(`[db] applied migration ${file}`);
  }
}

/**
 * Open (or reopen) the database.
 * @param {object} opts
 * @param {string} opts.dbPath        desired DB file (may be on a NAS mount)
 * @param {string} opts.fallbackPath  local DB used when dbPath is unusable
 * @param {string} [opts.migrationsDir]
 * @returns {{ db, meta }} meta = { path, engine, fsType, journalMode, degraded, error }
 */
export function openDatabase({ dbPath, fallbackPath, migrationsDir }) {
  const engine = loadEngine();
  const dir = migrationsDir
    || path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations');

  const tryOpen = (file, degraded, error) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const type = fsTypeOf(path.dirname(file));
    const network = NETWORK_FS.has(type);
    const db = engine.open(file);
    // Safe pragmas per storage medium (see header comment).
    const journalMode = network ? 'TRUNCATE' : 'WAL';
    db.pragma(`journal_mode = ${journalMode}`);
    // Network shares (esp. SMB1 NAS boxes) have high write/fsync latency,
    // and better-sqlite3 is synchronous — slow commits freeze the whole
    // event loop. Metrics data is reconstructible, so on network storage
    // we trade fsync guarantees for responsiveness and lean on a large
    // page cache to keep reads off the wire.
    db.pragma(`synchronous = ${network ? 'OFF' : 'NORMAL'}`);
    db.pragma(`cache_size = ${network ? -16000 : -4000}`);  // KB, negative = KiB
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = ON');
    migrate(db, dir);
    // Round-trip write test (catches read-only/flaky NAS mounts early).
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(-1, 0);
    db.prepare('DELETE FROM schema_migrations WHERE version = -1').run();
    return {
      db,
      meta: { path: file, engine: engine.name, fsType: type, journalMode, degraded, error: error || null },
    };
  };

  try {
    return tryOpen(dbPath, false, null);
  } catch (err) {
    console.error(`[db] cannot use ${dbPath} (${err.message}) — falling back to ${fallbackPath}`);
    const res = tryOpen(fallbackPath, true, `primary storage unavailable: ${err.message}`);
    return res;
  }
}
