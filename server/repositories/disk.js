/** RaPiSys — disk repository: the last cleanup scan, shown while a new one runs. */

export function createDiskRepo(db) {
  const put = db.prepare(`INSERT INTO disk_scan (id, scanned_at, payload) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET scanned_at=excluded.scanned_at, payload=excluded.payload`);
  const get = db.prepare(`SELECT scanned_at AS scannedAt, payload FROM disk_scan WHERE id=1`);

  function saveScan(scan) {
    const at = scan?.scannedAt || Date.now();
    put.run(at, JSON.stringify({ ...scan, scannedAt: at }));
  }

  /** The last scan, or null when none was ever saved (or the row is unreadable). */
  function lastScan() {
    const row = get.get();
    if (!row) return null;
    try { return { ...JSON.parse(row.payload), scannedAt: row.scannedAt }; } catch { return null; }
  }

  return { saveScan, lastScan };
}
