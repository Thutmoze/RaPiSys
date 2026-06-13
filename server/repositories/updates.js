/** RaPiSys — update_history repository. */

export function createUpdatesRepo(db) {
  // Cache the upgradable list + last-check time in a tiny kv row (reuse the
  // secrets-style pattern via a dedicated table created on demand).
  db.exec(`CREATE TABLE IF NOT EXISTS update_cache (id INTEGER PRIMARY KEY CHECK (id=1), checked_at INTEGER, payload TEXT)`);
  function saveCache(updates) {
    db.prepare(`INSERT INTO update_cache (id, checked_at, payload) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, payload=excluded.payload`)
      .run(Date.now(), JSON.stringify(updates));
  }
  function getCache() {
    const row = db.prepare(`SELECT checked_at AS checkedAt, payload FROM update_cache WHERE id=1`).get();
    if (!row) return { checkedAt: null, updates: [] };
    return { checkedAt: row.checkedAt, updates: JSON.parse(row.payload || '[]') };
  }

  function record({ ts, packageName, fromV, toV, result, log }) {
    db.prepare(`INSERT INTO update_history (ts, package, from_v, to_v, result, log)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(ts, packageName, fromV || null, toV || null, result, (log || '').slice(0, 20000));
  }
  function recordBatch(entries) {
    const tx = db.transaction((rows) => { for (const r of rows) record(r); });
    tx(entries);
  }
  function recent(limit = 50) {
    return db.prepare(`SELECT id, ts, package, from_v AS fromV, to_v AS toV, result, log
                       FROM update_history ORDER BY ts DESC LIMIT ?`).all(Math.min(limit, 200));
  }
  return { record, recordBatch, recent, saveCache, getCache };
}
