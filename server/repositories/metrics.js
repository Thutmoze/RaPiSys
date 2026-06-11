/**
 * RaPiSys — metrics repository
 * All time-series SQL lives here. Writes are batched per collector cycle.
 */

export function createMetricsRepo(db) {
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO metrics (ts, res, metric, value, vmin, vmax)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  /** Write a batch of {metric, value} at one timestamp (raw 10s resolution). */
  const writeBatch = db.transaction((ts, samples) => {
    for (const s of samples) {
      if (s.value === null || s.value === undefined || Number.isNaN(s.value)) continue;
      insertStmt.run(ts, '10s', s.metric, s.value, null, null);
    }
  });

  /** Query a series; resolution picked automatically from the time range. */
  function query(metric, fromTs, toTs, res = null) {
    const span = toTs - fromTs;
    const auto = span <= 6 * 3600e3 ? '10s'
      : span <= 48 * 3600e3 ? '1m'
      : span <= 30 * 86400e3 ? '10m' : '1h';
    let useRes = res || auto;
    let rows = db.prepare(
      `SELECT ts, value, vmin, vmax FROM metrics
       WHERE metric = ? AND res = ? AND ts BETWEEN ? AND ? ORDER BY ts`
    ).all(metric, useRes, fromTs, toTs);
    // Downsampled tiers may not exist yet early in the app's life —
    // fall back to raw data (capped) so charts are never empty.
    if (rows.length === 0 && useRes !== '10s') {
      rows = db.prepare(
        `SELECT ts, value, vmin, vmax FROM metrics
         WHERE metric = ? AND res = '10s' AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 5000`
      ).all(metric, fromTs, toTs);
      useRes = '10s';
    }
    return { res: useRes, points: rows };
  }

  function listMetrics() {
    return db.prepare(`SELECT DISTINCT metric FROM metrics ORDER BY metric`).all().map((r) => r.metric);
  }

  /**
   * Downsample one tier into the next: e.g. raw '10s' rows older than
   * `olderThanTs` are aggregated into '1m' buckets (avg/min/max), then the
   * raw rows are deleted. Called by the retention job for each tier.
   */
  function downsample(fromRes, toRes, bucketMs, olderThanTs) {
    const agg = db.prepare(
      `SELECT metric, (ts / ${bucketMs}) * ${bucketMs} AS bts,
              AVG(value) AS v, MIN(COALESCE(vmin, value)) AS mn, MAX(COALESCE(vmax, value)) AS mx
       FROM metrics WHERE res = ? AND ts < ?
       GROUP BY metric, bts`
    ).all(fromRes, olderThanTs);
    const apply = db.transaction(() => {
      for (const r of agg) insertStmt.run(r.bts, toRes, r.metric, r.v, r.mn, r.mx);
      db.prepare(`DELETE FROM metrics WHERE res = ? AND ts < ?`).run(fromRes, olderThanTs);
    });
    apply();
    return agg.length;
  }

  /** Latest raw value per metric (used by the alert engine). */
  function latestValues(maxAgeMs = 120000) {
    const rows = db.prepare(
      `SELECT metric, value, MAX(ts) AS ts FROM metrics
       WHERE res = '10s' AND ts > ? GROUP BY metric`
    ).all(Date.now() - maxAgeMs);
    const out = {};
    for (const r of rows) out[r.metric] = { value: r.value, ts: r.ts };
    return out;
  }

  function purgeOlderThan(ts) {
    return db.prepare(`DELETE FROM metrics WHERE ts < ?`).run(ts);
  }

  return { writeBatch, query, listMetrics, downsample, purgeOlderThan, latestValues };
}
