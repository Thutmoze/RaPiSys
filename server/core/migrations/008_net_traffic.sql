-- RaPiSys — built-in bandwidth history (replaces the host vnStat daemon).
--
-- Byte totals per interface, accumulated from /proc/net/dev counter deltas
-- into local-time hour / day / month buckets, the same granularity vnStat
-- keeps. vnStat's existing history is imported once on first run.

CREATE TABLE IF NOT EXISTS net_traffic (
  iface  TEXT    NOT NULL,
  period TEXT    NOT NULL,            -- hour | day | month
  ts     INTEGER NOT NULL,            -- bucket start (local time), epoch ms
  rx     INTEGER NOT NULL DEFAULT 0,  -- bytes
  tx     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (iface, period, ts)
) WITHOUT ROWID;

-- Last counters seen per interface. With the kernel boot id this lets a
-- restart of the container count the traffic that passed while it was down.
CREATE TABLE IF NOT EXISTS net_counter_state (
  iface   TEXT    PRIMARY KEY,
  boot_id TEXT    NOT NULL,
  rx      INTEGER NOT NULL,
  tx      INTEGER NOT NULL,
  ts      INTEGER NOT NULL
);
