/** RaPiSys — events repository (throttle/undervoltage/alerts/audit log). */

export function createEventsRepo(db) {
  const ins = db.prepare(
    `INSERT INTO events (ts, type, severity, payload) VALUES (?, ?, ?, ?)`
  );
  function add(type, severity = 'info', payload = {}) {
    ins.run(Date.now(), type, severity, JSON.stringify(payload));
  }
  function recent(limit = 100, type = null) {
    const rows = type
      ? db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY ts DESC LIMIT ?`).all(type, limit)
      : db.prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT ?`).all(limit);
    return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
  }
  function countSince(type, sinceTs) {
    return db.prepare(`SELECT COUNT(*) c FROM events WHERE type = ? AND ts >= ?`).get(type, sinceTs).c;
  }
  function countByTypeBetween(fromTs, toTs) {
    const rows = db.prepare(
      `SELECT type, COUNT(*) AS n FROM events WHERE ts BETWEEN ? AND ? GROUP BY type`
    ).all(fromTs, toTs);
    const out = {};
    for (const r of rows) out[r.type] = r.n;
    return out;
  }

  function purgeOlderThan(ts) {
    return db.prepare(`DELETE FROM events WHERE ts < ?`).run(ts);
  }
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
  return { add, recent, countSince, countByTypeBetween, purgeOlderThan };
}
