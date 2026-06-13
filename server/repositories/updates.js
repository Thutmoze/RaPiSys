/** RaPiSys — update_history repository. */

export function createUpdatesRepo(db) {
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
  return { record, recordBatch, recent };
}
