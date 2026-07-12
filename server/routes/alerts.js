/** RaPiSys — /api/alerts: rule CRUD, active alerts, incident history. */

import express from 'express';
import { describeMetric, GROUP_ORDER } from '../core/metric-catalog.js';

const VALID_OPS = ['>', '<', '>=', '<='];
const VALID_SEV = ['info', 'warning', 'critical'];
const VALID_CHANNELS = ['ui', 'email', 'telegram'];

export function alertsRouter({ alertsRepo, metricsRepo, requireAuth, sampler }) {
  const r = express.Router();

  function validate(body) {
    const e = [];
    if (!body.name || String(body.name).length > 80) e.push('name required (≤80 chars)');
    if (!body.metric || String(body.metric).length > 80) e.push('metric required');
    if (!VALID_OPS.includes(body.op)) e.push(`op must be one of ${VALID_OPS.join(' ')}`);
    if (!Number.isFinite(Number(body.threshold))) e.push('threshold must be a number');
    if (!VALID_SEV.includes(body.severity)) e.push(`severity must be ${VALID_SEV.join('|')}`);
    const sustain = Number(body.sustain_s ?? 60), cooldown = Number(body.cooldown_s ?? 900);
    if (sustain < 0 || sustain > 86400) e.push('sustain_s out of range');
    if (cooldown < 0 || cooldown > 86400 * 7) e.push('cooldown_s out of range');
    const channels = Array.isArray(body.channels) ? body.channels.filter((c) => VALID_CHANNELS.includes(c)) : ['ui'];
    return { errors: e, rule: {
      name: String(body.name), metric: String(body.metric), op: body.op,
      threshold: Number(body.threshold), sustain_s: sustain,
      severity: body.severity, enabled: body.enabled !== false && body.enabled !== 0,
      cooldown_s: cooldown,
      escalate_after_s: body.escalate_after_s ? Number(body.escalate_after_s) : null,
      channels: channels.length ? channels : ['ui'],
    } };
  }

  r.get('/rules', (req, res) => {
    res.json({ rules: alertsRepo.listRules().map((x) => ({ ...x, channels: JSON.parse(x.channels || '["ui"]') })) });
  });
  r.post('/rules', requireAuth, (req, res) => {
    const { errors, rule } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    res.json({ ok: true, id: alertsRepo.createRule(rule) });
  });
  r.put('/rules/:id', requireAuth, (req, res) => {
    if (!alertsRepo.getRule(req.params.id)) return res.status(404).json({ error: 'rule not found' });
    const { errors, rule } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    alertsRepo.updateRule(req.params.id, rule);
    res.json({ ok: true });
  });
  r.delete('/rules/:id', requireAuth, (req, res) => {
    alertsRepo.deleteRule(req.params.id);
    res.json({ ok: true });
  });

  r.get('/active', (req, res) => res.json({ active: alertsRepo.active() }));
  r.get('/history', (req, res) => res.json({ history: alertsRepo.history(Math.min(Number(req.query.limit) || 100, 500)) }));
  r.get('/metrics', (req, res) => {
    const live = sampler ? sampler.getLiveNames() : {};
    const metrics = metricsRepo.listMetrics()
      .map((key) => describeMetric(key, live))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.label.localeCompare(b.label));
    res.json({ metrics });
  });

  return r;
}
