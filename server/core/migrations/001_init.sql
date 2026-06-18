-- RaPiSys migration 001 — initial schema
-- Unified time-series + events + sessions + alerting + reports + inventory.

-- Time-series metrics with tiered resolution.
-- res: '10s' raw, '1m', '10m', '1h' downsampled (vmin/vmax populated there).
CREATE TABLE IF NOT EXISTS metrics (
  ts     INTEGER NOT NULL,            -- unix ms
  res    TEXT    NOT NULL DEFAULT '10s',
  metric TEXT    NOT NULL,            -- e.g. 'temp.cpu', 'fan.rpm', 'net.eth0.rx'
  value  REAL    NOT NULL,
  vmin   REAL,
  vmax   REAL,
  PRIMARY KEY (metric, res, ts)
) WITHOUT ROWID;

-- Discrete events: throttle/undervoltage transitions, service up/down,
-- alert fire/resolve, agent operations (audit), storage degradation.
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,
  type     TEXT    NOT NULL,
  severity TEXT,
  payload  TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, ts);

-- User session log (ssh | vnc | tailscale). One row per session lifetime.
CREATE TABLE IF NOT EXISTS session_log (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL,
  username    TEXT,
  source      TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  last_active INTEGER,
  meta        TEXT                    -- JSON (tty, client, node name, ...)
);
CREATE INDEX IF NOT EXISTS idx_session_started ON session_log (started_at);

-- Network analytics samples.
CREATE TABLE IF NOT EXISTS net_proto_samples (
  ts INTEGER NOT NULL, proto TEXT NOT NULL, conns INTEGER, bytes INTEGER,
  PRIMARY KEY (ts, proto)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS net_proc_samples (
  ts INTEGER NOT NULL, comm TEXT NOT NULL, pid INTEGER, rx INTEGER, tx INTEGER,
  PRIMARY KEY (ts, comm)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dns_stats (
  ts INTEGER NOT NULL, domain TEXT NOT NULL, queries INTEGER,
  PRIMARY KEY (ts, domain)
) WITHOUT ROWID;

-- Alerting.
CREATE TABLE IF NOT EXISTS alert_rules (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  metric           TEXT NOT NULL,
  op               TEXT NOT NULL DEFAULT '>',    -- > < >= <=
  threshold        REAL NOT NULL,
  sustain_s        INTEGER NOT NULL DEFAULT 60,
  severity         TEXT NOT NULL DEFAULT 'warning', -- info|warning|critical
  enabled          INTEGER NOT NULL DEFAULT 1,
  cooldown_s       INTEGER NOT NULL DEFAULT 900,
  escalate_after_s INTEGER,
  channels         TEXT NOT NULL DEFAULT '["ui"]'   -- JSON ["ui","email"]
);
CREATE TABLE IF NOT EXISTS alert_state (
  rule_id       INTEGER PRIMARY KEY REFERENCES alert_rules(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'ok',          -- ok|pending|firing
  since         INTEGER,
  last_notified INTEGER
);
CREATE TABLE IF NOT EXISTS alert_history (
  id          INTEGER PRIMARY KEY,
  rule_id     INTEGER,
  fired_at    INTEGER NOT NULL,
  resolved_at INTEGER,
  peak_value  REAL,
  notified    TEXT                   -- JSON of channels notified
);

-- Materialised daily report (weekly/monthly computed from these).
CREATE TABLE IF NOT EXISTS report_daily (
  day     TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  payload TEXT NOT NULL              -- JSON
);

-- Dashboard layouts (single-user model; key by page).
CREATE TABLE IF NOT EXISTS layouts (
  page   TEXT PRIMARY KEY,
  layout TEXT NOT NULL               -- JSON: [{id,x,y,w,h,visible}]
);

-- Software inventory.
CREATE TABLE IF NOT EXISTS inventory (
  kind         TEXT NOT NULL,        -- package|service|container|userapp
  name         TEXT NOT NULL,
  version      TEXT,
  installed_at INTEGER,
  source       TEXT,
  status       TEXT,
  last_used    INTEGER,
  meta         TEXT,
  PRIMARY KEY (kind, name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS update_history (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  package TEXT,
  from_v  TEXT,
  to_v    TEXT,
  result  TEXT,                      -- success|failed|simulated
  log     TEXT,
  security INTEGER,                  -- 1 if the package carried a security tag at upgrade time
  cves     INTEGER,                  -- count of CVEs known at upgrade time
  kernel   INTEGER,                  -- 1 if a kernel/linux-image package
  description TEXT                   -- package summary captured at upgrade time
);

-- NAS mount registry (units themselves are written by the host agent).
CREATE TABLE IF NOT EXISTS nas_mounts (
  id         INTEGER PRIMARY KEY,
  label      TEXT NOT NULL,
  proto      TEXT NOT NULL,          -- cifs|nfs
  host       TEXT NOT NULL,
  share      TEXT NOT NULL,
  mountpoint TEXT NOT NULL,
  options    TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1
);

-- Encrypted secrets (AES-256-GCM via core/crypto.js). SMTP password etc.
CREATE TABLE IF NOT EXISTS secrets (
  key        TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL
);
