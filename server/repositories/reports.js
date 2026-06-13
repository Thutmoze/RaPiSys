/** RaPiSys — report_daily repository. */

export function createReportsRepo(db) {
  function upsertDaily(day, payload) {
    db.prepare(`INSERT INTO report_daily (day, payload) VALUES (?, ?)
                ON CONFLICT(day) DO UPDATE SET payload = excluded.payload`)
      .run(day, JSON.stringify(payload));
  }
  function getDaily(day) {
    const row = db.prepare(`SELECT payload FROM report_daily WHERE day = ?`).get(day);
    return row ? JSON.parse(row.payload) : null;
  }
  function range(fromDay, toDay) {
    return db.prepare(`SELECT day, payload FROM report_daily WHERE day BETWEEN ? AND ? ORDER BY day`)
      .all(fromDay, toDay).map((r) => ({ day: r.day, ...JSON.parse(r.payload) }));
  }
  function recentDays(n = 30) {
    return db.prepare(`SELECT day, payload FROM report_daily ORDER BY day DESC LIMIT ?`)
      .all(n).map((r) => ({ day: r.day, ...JSON.parse(r.payload) })).reverse();
  }
  return { upsertDaily, getDaily, range, recentDays };
}
