-- RaPiSys migration 002 — local admin account + browser sessions

-- Single local admin (id constrained to 1). Password: scrypt. TOTP secret
-- encrypted at rest with SECRET_KEY (AES-256-GCM, JSON {ct,iv,tag} base64).
CREATE TABLE IF NOT EXISTS admin_user (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  username        TEXT    NOT NULL,
  pass_salt       BLOB    NOT NULL,
  pass_hash       BLOB    NOT NULL,
  totp_secret_enc TEXT,
  mfa_confirmed   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Browser sessions: only the SHA-256 of the cookie value is stored.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_expires ON auth_sessions (expires_at);
