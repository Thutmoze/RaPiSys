-- Multi-node federation (§14).
--
-- A "peer" is another RaPiSys node this node polls read-only over HTTPS. Each
-- node owns its own database and writes only to it, which is why NO existing
-- table gains a node_id column here: a database only ever contains its own
-- node's metrics, events, sessions and inventory.
--
-- Peer API keys are deliberately NOT columns on `peers`. They go through the
-- existing encrypted `secrets` table (core/crypto.js, AES-256-GCM) under the
-- key `peer.<id>.apikey`, the same path SMTP and NAS credentials already use.

CREATE TABLE IF NOT EXISTS peers (
  id               INTEGER PRIMARY KEY,
  name             TEXT UNIQUE NOT NULL,
  base_url         TEXT NOT NULL,          -- normalized, always https://host:port
  cert_fingerprint TEXT,                   -- sha256, pinned on first success (TOFU)
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);

-- Rolling cache of poll results. This is the only cross-node data stored, and
-- it is a snapshot cache rather than history: pruned by age, never downsampled.
CREATE TABLE IF NOT EXISTS peer_health (
  peer_id    INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  reachable  INTEGER NOT NULL,             -- 0|1
  state      TEXT,                         -- ok | unreachable | auth-failed | cert-changed
  latency_ms INTEGER,
  snapshot   TEXT,                         -- JSON body of GET /api/v1/node-summary
  PRIMARY KEY (peer_id, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_peer_health_ts ON peer_health(ts);
