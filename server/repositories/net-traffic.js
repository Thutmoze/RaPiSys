/** RaPiSys — net_traffic / net_counter_state repository (bandwidth history). */

export const TRAFFIC_PERIODS = ['hour', 'day', 'month'];

// How long each granularity is kept (the card shows 24 hours, 30 days, 12 months).
const KEEP_MS = { hour: 7 * 86400e3, day: 400 * 86400e3, month: 5 * 366 * 86400e3 };

export function createNetTrafficRepo(db) {
  const upsert = db.prepare(`INSERT INTO net_traffic (iface, period, ts, rx, tx) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(iface, period, ts) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx`);
  const insertIgnore = db.prepare(`INSERT OR IGNORE INTO net_traffic (iface, period, ts, rx, tx) VALUES (?, ?, ?, ?, ?)`);

  /** Add byte deltas: `rows` = [{ iface, rx, tx, buckets: { hour, day, month } }]. */
  const add = db.transaction((rows) => {
    for (const r of rows) {
      if (!r.rx && !r.tx) continue;
      for (const p of TRAFFIC_PERIODS) upsert.run(r.iface, p, r.buckets[p], r.rx, r.tx);
    }
  });

  /** One-time history import: [{ iface, period, ts, rx, tx }]; existing buckets win. */
  const importRows = db.transaction((rows) => {
    for (const r of rows) insertIgnore.run(r.iface, r.period, r.ts, r.rx, r.tx);
  });

  function isEmpty() {
    return !db.prepare('SELECT 1 FROM net_traffic LIMIT 1').get();
  }

  /** Buckets newest-last: { iface: { hour: [...], day: [...], month: [...] } }. */
  function series({ hours = 24, days = 30, months = 12 } = {}) {
    const limits = { hour: hours, day: days, month: months };
    const out = {};
    for (const p of TRAFFIC_PERIODS) {
      const rows = db.prepare(`SELECT iface, ts, rx, tx FROM (
          SELECT iface, ts, rx, tx, ROW_NUMBER() OVER (PARTITION BY iface ORDER BY ts DESC) AS n
          FROM net_traffic WHERE period = ?) WHERE n <= ? ORDER BY iface, ts`).all(p, limits[p]);
      for (const r of rows) ((out[r.iface] ||= { hour: [], day: [], month: [] })[p]).push({ ts: r.ts, rx: r.rx, tx: r.tx });
    }
    return out;
  }

  /** All-time totals per interface (months cover the whole history). */
  function totals() {
    return Object.fromEntries(db.prepare(`SELECT iface, SUM(rx) AS rx, SUM(tx) AS tx
      FROM net_traffic WHERE period = 'month' GROUP BY iface`).all().map((r) => [r.iface, { rx: r.rx, tx: r.tx }]));
  }

  function counterState() {
    return Object.fromEntries(db.prepare('SELECT iface, boot_id, rx, tx, ts FROM net_counter_state').all()
      .map((r) => [r.iface, { bootId: r.boot_id, rx: r.rx, tx: r.tx, ts: r.ts }]));
  }

  const saveCounterState = db.transaction((rows) => {
    const st = db.prepare(`INSERT INTO net_counter_state (iface, boot_id, rx, tx, ts) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(iface) DO UPDATE SET boot_id = excluded.boot_id, rx = excluded.rx, tx = excluded.tx, ts = excluded.ts`);
    for (const r of rows) st.run(r.iface, r.bootId, r.rx, r.tx, r.ts);
  });

  function prune(now = Date.now()) {
    const del = db.prepare('DELETE FROM net_traffic WHERE period = ? AND ts < ?');
    let n = 0;
    for (const p of TRAFFIC_PERIODS) n += del.run(p, now - KEEP_MS[p]).changes;
    return n;
  }

  return { add, importRows, isEmpty, series, totals, counterState, saveCounterState, prune };
}
