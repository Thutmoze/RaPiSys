/** RaPiSys — alert rules / state / history repository. */

export function createAlertsRepo(db) {
  function listRules() {
    return db.prepare(`SELECT * FROM alert_rules ORDER BY id`).all();
  }
  function getRule(id) {
    return db.prepare(`SELECT * FROM alert_rules WHERE id = ?`).get(id);
  }
  function createRule(r) {
    const res = db.prepare(
      `INSERT INTO alert_rules (name, metric, op, threshold, sustain_s, severity,
         enabled, cooldown_s, escalate_after_s, channels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(r.name, r.metric, r.op, r.threshold, r.sustain_s, r.severity,
      r.enabled ? 1 : 0, r.cooldown_s, r.escalate_after_s ?? null, JSON.stringify(r.channels));
    return res.lastInsertRowid;
  }
  function updateRule(id, r) {
    db.prepare(
      `UPDATE alert_rules SET name=?, metric=?, op=?, threshold=?, sustain_s=?,
         severity=?, enabled=?, cooldown_s=?, escalate_after_s=?, channels=? WHERE id=?`
    ).run(r.name, r.metric, r.op, r.threshold, r.sustain_s, r.severity,
      r.enabled ? 1 : 0, r.cooldown_s, r.escalate_after_s ?? null, JSON.stringify(r.channels), id);
  }
  function deleteRule(id) {
    db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM alert_state WHERE rule_id = ?`).run(id);
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
       WHERE rule_id = ? AND resolved_at IS NULL`
    ).run(value, ruleId);
  }
  function markNotified(ruleId, channels) {
    db.prepare(
      `UPDATE alert_history SET notified = ? WHERE rule_id = ? AND resolved_at IS NULL`
    ).run(JSON.stringify(channels), ruleId);
  }
  function resolveIncident(ruleId, resolvedAt) {
    db.prepare(
      `UPDATE alert_history SET resolved_at = ? WHERE rule_id = ? AND resolved_at IS NULL`
    ).run(resolvedAt, ruleId);
  }
  function history(limit = 100) {
    return db.prepare(
      `SELECT h.*, r.name, r.metric, r.severity FROM alert_history h
       LEFT JOIN alert_rules r ON r.id = h.rule_id
       ORDER BY h.fired_at DESC LIMIT ?`
    ).all(limit);
  }
  function active() {
    return db.prepare(
      `SELECT r.*, s.state, s.since FROM alert_rules r
       JOIN alert_state s ON s.rule_id = r.id
       WHERE s.state = 'firing'`
    ).all();
  }

  return { listRules, getRule, createRule, updateRule, deleteRule, countRules,
    getState, setState, openIncident, updateIncidentPeak, markNotified,
    resolveIncident, history, active };
}
