/** RaPiSys — alert rules / state / history repository. */

export function createAlertsRepo(db) {
  function listRules() {
    return db.prepare(`SELECT * FROM alert_rules ORDER BY id`).all();
  }
  function getRule(id) {
    return db.prepare(`SELECT * FROM alert_rules WHERE id = ?`).get(id);
  }
  // config: rule-type specific JSON (container health scope/conditions), null otherwise.
  const configJson = (c) => (c == null ? null : JSON.stringify(c));
  function createRule(r) {
    const res = db.prepare(
      `INSERT INTO alert_rules (name, metric, op, threshold, sustain_s, severity,
         enabled, cooldown_s, escalate_after_s, channels, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(r.name, r.metric, r.op, r.threshold, r.sustain_s, r.severity,
      r.enabled ? 1 : 0, r.cooldown_s, r.escalate_after_s ?? null, JSON.stringify(r.channels), configJson(r.config));
    return res.lastInsertRowid;
  }
  function updateRule(id, r) {
    db.prepare(
      `UPDATE alert_rules SET name=?, metric=?, op=?, threshold=?, sustain_s=?,
         severity=?, enabled=?, cooldown_s=?, escalate_after_s=?, channels=?, config=? WHERE id=?`
    ).run(r.name, r.metric, r.op, r.threshold, r.sustain_s, r.severity,
      r.enabled ? 1 : 0, r.cooldown_s, r.escalate_after_s ?? null, JSON.stringify(r.channels), configJson(r.config), id);
  }
  function deleteRule(id) {
    db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM alert_state WHERE rule_id = ?`).run(id);
    db.prepare(`DELETE FROM alert_target_state WHERE rule_id = ?`).run(id);
  }
  function countRules() {
    return db.prepare(`SELECT COUNT(*) c FROM alert_rules`).get().c;
  }

  // ---- state machine persistence ----
  function getState(ruleId) {
    return db.prepare(`SELECT * FROM alert_state WHERE rule_id = ?`).get(ruleId)
      || { rule_id: ruleId, state: 'ok', since: null, last_notified: null };
  }
  function setState(ruleId, state, since, lastNotified) {
    db.prepare(
      `INSERT INTO alert_state (rule_id, state, since, last_notified) VALUES (?, ?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET state=excluded.state, since=excluded.since,
         last_notified=excluded.last_notified`
    ).run(ruleId, state, since, lastNotified);
  }

  // ---- history ----
  function openIncident(ruleId, firedAt, peak) {
    return db.prepare(
      `INSERT INTO alert_history (rule_id, fired_at, peak_value, notified) VALUES (?, ?, ?, '[]')`
    ).run(ruleId, firedAt, peak).lastInsertRowid;
  }
  function updateIncidentPeak(ruleId, value) {
    db.prepare(
      `UPDATE alert_history SET peak_value = MAX(COALESCE(peak_value, 0), ?)
       WHERE rule_id = ? AND target IS NULL AND resolved_at IS NULL`
    ).run(value, ruleId);
  }
  function markNotified(ruleId, channels) {
    db.prepare(
      `UPDATE alert_history SET notified = ? WHERE rule_id = ? AND target IS NULL AND resolved_at IS NULL`
    ).run(JSON.stringify(channels), ruleId);
  }
  function resolveIncident(ruleId, resolvedAt) {
    db.prepare(
      `UPDATE alert_history SET resolved_at = ? WHERE rule_id = ? AND target IS NULL AND resolved_at IS NULL`
    ).run(resolvedAt, ruleId);
  }

  // ---- per-target (container health) state + incidents ----
  function getTargetState(ruleId, target) {
    return db.prepare(`SELECT * FROM alert_target_state WHERE rule_id = ? AND target = ?`).get(ruleId, target)
      || { rule_id: ruleId, target, state: 'ok', since: null, last_notified: null, reason: null };
  }
  function listTargetStates(ruleId) {
    return db.prepare(`SELECT * FROM alert_target_state WHERE rule_id = ?`).all(ruleId);
  }
  function setTargetState(ruleId, target, state, since, lastNotified, reason = null) {
    db.prepare(
      `INSERT INTO alert_target_state (rule_id, target, state, since, last_notified, reason) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id, target) DO UPDATE SET state=excluded.state, since=excluded.since,
         last_notified=excluded.last_notified, reason=excluded.reason`
    ).run(ruleId, target, state, since, lastNotified, reason);
  }
  function deleteTargetState(ruleId, target) {
    db.prepare(`DELETE FROM alert_target_state WHERE rule_id = ? AND target = ?`).run(ruleId, target);
  }
  function openTargetIncident(ruleId, target, firedAt, detail, channels) {
    return db.prepare(
      `INSERT INTO alert_history (rule_id, target, fired_at, peak_value, detail, notified) VALUES (?, ?, ?, 0, ?, ?)`
    ).run(ruleId, target, firedAt, detail, JSON.stringify(channels || [])).lastInsertRowid;
  }
  function resolveTargetIncident(ruleId, target, resolvedAt) {
    db.prepare(
      `UPDATE alert_history SET resolved_at = ? WHERE rule_id = ? AND target = ? AND resolved_at IS NULL`
    ).run(resolvedAt, ruleId, target);
  }
  function history(limit = 100) {
    return db.prepare(
      `SELECT h.*, r.name, r.metric, r.severity FROM alert_history h
       LEFT JOIN alert_rules r ON r.id = h.rule_id
       ORDER BY h.fired_at DESC LIMIT ?`
    ).all(limit);
  }
  /** Firing alerts: one row per firing rule, plus one per firing container
   * of a container health rule (carrying `target` and `reason`). */
  function active() {
    const rules = db.prepare(
      `SELECT r.*, s.state, s.since FROM alert_rules r
       JOIN alert_state s ON s.rule_id = r.id
       WHERE s.state = 'firing'`
    ).all();
    const targets = db.prepare(
      `SELECT r.*, t.state, t.since, t.target, t.reason FROM alert_rules r
       JOIN alert_target_state t ON t.rule_id = r.id
       WHERE t.state = 'firing' AND r.enabled = 1
       ORDER BY t.since`
    ).all();
    return [...rules, ...targets];
  }

  return { listRules, getRule, createRule, updateRule, deleteRule, countRules,
    getState, setState, openIncident, updateIncidentPeak, markNotified,
    resolveIncident, history, active,
    getTargetState, listTargetStates, setTargetState, deleteTargetState,
    openTargetIncident, resolveTargetIncident };
}
