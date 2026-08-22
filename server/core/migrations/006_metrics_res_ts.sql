-- RaPiSys — index metrics by (res, ts).
--
-- `metrics` is WITHOUT ROWID with PRIMARY KEY (metric, res, ts), so that
-- B-tree is ordered by metric first. Every retention and alerting query
-- filters on res and ts *without* naming a metric, so none of them could use
-- the primary key and each one scanned the whole table.
--
-- With the database on a network mount and better-sqlite3 being synchronous,
-- a cold full scan is a multi-second blocking pread64 on the main thread and
-- the entire event loop stops until it finishes. This index turns those
-- scans into range seeks.
--
-- Note: on a WITHOUT ROWID table the index entries carry the full primary key,
-- so this costs meaningful disk space on a large metrics table. That is a
-- deliberate trade: space is cheap on the share, blocking reads are not.

CREATE INDEX IF NOT EXISTS idx_metrics_res_ts ON metrics(res, ts);
