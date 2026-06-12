-- RaPiSys migration 003 — MFA becomes optional per admin choice
ALTER TABLE admin_user ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 1;
