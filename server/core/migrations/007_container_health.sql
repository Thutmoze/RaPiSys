-- RaPiSys — container health alerts.
--
-- A "Container health" rule (metric 'docker.health') watches several
-- containers at once and fires one alert per container, so it needs:
--  - alert_rules.config: JSON scope/conditions for rule types that need more
--    than metric/op/threshold (NULL for ordinary threshold rules)
--  - alert_target_state: the per-container state machine (alert_state stays
--    the per-rule one for every other rule)
--  - alert_history.target/detail: which container an incident was about, and why

ALTER TABLE alert_rules ADD COLUMN config TEXT;
ALTER TABLE alert_history ADD COLUMN target TEXT;
ALTER TABLE alert_history ADD COLUMN detail TEXT;

CREATE TABLE IF NOT EXISTS alert_target_state (
  rule_id       INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  target        TEXT NOT NULL,                       -- container slug
  state         TEXT NOT NULL DEFAULT 'ok',          -- ok|pending|firing
  since         INTEGER,
  last_notified INTEGER,
  reason        TEXT,                                -- human text of the current breach
  PRIMARY KEY (rule_id, target)
);
