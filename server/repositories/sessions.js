/** RaPiSys — session_log repository: open/close session rows, history. */

export function createSessionsRepo(db) {
  function openRows() {
    return db.prepare(`SELECT * FROM session_log WHERE ended_at IS NULL`).all();
  }
  function open(kind, key, username, source, startedAt, meta) {
    return db.prepare(
      `INSERT INTO session_log (kind, username, source, started_at, last_active, meta)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(kind, username, source, startedAt, Date.now(),
      JSON.stringify({ ...meta, key })).lastInsertRowid;
  }
  function touch(id, lastActive) {
    db.prepare(`UPDATE session_log SET last_active = ? WHERE id = ?`).run(lastActive, id);
  }
  function close(id, endedAt) {
    db.prepare(`UPDATE session_log SET ended_at = ? WHERE id = ?`).run(endedAt, id);
  }
  function history({ from, to, kind, limit = 200 }) {
    let sql = `SELECT * FROM session_log WHERE started_at BETWEEN ? AND ?`;
    const args = [from, to];
    if (kind) { sql += ` AND kind = ?`; args.push(kind); }
    sql += ` ORDER BY started_at DESC LIMIT ?`; args.push(limit);
    return db.prepare(sql).all(...args);
  }
  function loginsPerDay(days = 7) {
    return db.prepare(
      `SELECT date(started_at / 1000, 'unixepoch') AS day, kind, COUNT(*) AS logins
       FROM session_log WHERE started_at > ? GROUP BY day, kind ORDER BY day`
    ).all(Date.now() - days * 86400e3);
  }
  function purgeOlderThan(ts) {
    db.prepare(`DELETE FROM session_log WHERE started_at < ? AND ended_at IS NOT NULL`).run(ts);
  }
  return { openRows, open, touch, close, history, loginsPerDay, purgeOlderThan };
}
