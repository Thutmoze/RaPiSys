-- RaPiSys — last Disk cleanup scan.
--
-- One row: the most recent disk.scan result, so the Disk page can show it
-- instantly while a fresh scan runs instead of starting from a blank card.

CREATE TABLE IF NOT EXISTS disk_scan (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  scanned_at INTEGER NOT NULL,        -- epoch ms
  payload    TEXT    NOT NULL         -- JSON: { categories, totalDefaultBytes, scannedAt }
);
