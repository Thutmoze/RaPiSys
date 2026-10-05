/** RaPiSys — /api/alerts: rule CRUD, active alerts, incident history. */

import express from 'express';
import { describeMetric, GROUP_ORDER, CONTAINER_HEALTH_METRIC, containerSlugOf, isContainerHealthInput, slugify } from '../core/metric-catalog.js';
import { normalizeHealthConfig, validateHealthConfig, coversContainer, setContainerWatched, isHealthRule } from '../services/container-health.js';

const VALID_OPS = ['>', '<', '>=', '<='];
const VALID_SEV = ['info', 'warning', 'critical'];
const VALID_CHANNELS = ['ui', 'email', 'telegram'];

export function alertsRouter({ alertsRepo, metricsRepo, requireAuth, sampler, getSettings }) {
  const r = express.Router();

  function validate(body) {
    const e = [];
    // A container health rule has no op/threshold of its own; its scope and
    // conditions live in `config`.
    const health = body.metric === CONTAINER_HEALTH_METRIC;
    if (health) { body = { ...body, op: '<', threshold: 1 }; e.push(...validateHealthConfig(body.config)); }
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
      config: health ? normalizeHealthConfig(body.config) : null,
    } };
  }

  const parseRule = (x) => ({ ...x, channels: JSON.parse(x.channels || '["ui"]'),
    config: x.config ? normalizeHealthConfig(x.config) : null });

  r.get('/rules', (req, res) => {
    res.json({ rules: alertsRepo.listRules().map(parseRule) });
  });
  r.post('/rules', requireAuth, (req, res) => {
    const { errors, rule } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    res.json({ ok: true, id: alertsRepo.createRule(rule) });
  });
  r.put('/rules/:id', requireAuth, (req, res) => {
    const existing = alertsRepo.getRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'rule not found' });
    // Keep the bells' rule recognisable across edits made in the form.
    const prev = existing.config ? normalizeHealthConfig(existing.config) : null;
    const body = { ...(req.body || {}) };
    if (prev?.managed && body.config && typeof body.config === 'object') body.config = { ...body.config, managed: true };
    const { errors, rule } = validate(body);
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
    // Containers are picked through the "Container health" entry. Single
    // container "running" metrics stay listed only where an existing rule
    // still uses one, so those older rules remain editable.
    const used = new Set(alertsRepo.listRules().map((x) => x.metric));
    const keys = metricsRepo.listMetrics();
    const hasContainers = keys.some((k) => containerSlugOf(k)) || (sampler?.getContainers?.() || []).length > 0;
    const metrics = keys
      .filter((k) => !isContainerHealthInput(k) && (!containerSlugOf(k) || used.has(k)))
      .concat(hasContainers || used.has(CONTAINER_HEALTH_METRIC) ? [CONTAINER_HEALTH_METRIC] : [])
      .map((key) => describeMetric(key, live))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
        || (a.key === CONTAINER_HEALTH_METRIC ? -1 : b.key === CONTAINER_HEALTH_METRIC ? 1 : 0)
        || a.label.localeCompare(b.label));
    res.json({ metrics });
  });

  // ---- container health: picker data + Containers card bells -------------

  const healthRules = () => alertsRepo.listRules().filter(isHealthRule)
    .map((x) => ({ ...x, cfg: normalizeHealthConfig(x.config) }));
  const managedRule = () => healthRules().find((x) => x.cfg.managed) || null;

  /** Live containers with health, and which ones the enabled health rules watch. */
  r.get('/containers', (req, res) => {
    const rules = healthRules().filter((x) => x.enabled);
    const managed = managedRule();
    const containers = (sampler?.getContainers?.() || []).map((c) => ({
      slug: c.slug, name: c.name, image: c.image, state: c.state, health: c.health,
      restartCount: c.restartCount ?? null,
      watchedBy: rules.filter((x) => coversContainer(x.cfg, c.slug)).map((x) => ({ id: x.id, name: x.name })),
      bell: !!(managed && managed.enabled && coversContainer(managed.cfg, c.slug)),
    }));
    res.json({ containers, managedRuleId: managed?.id ?? null });
  });

  /** Bell toggle: add/remove one container from the bell-managed rule,
   * creating it with defaults on first use. */
  r.post('/containers/:slug/watch', requireAuth, async (req, res) => {
    const slug = slugify(req.params.slug);
    const watch = req.body?.watch !== false;
    let managed = managedRule();
    if (!managed) {
      if (!watch) return res.json({ ok: true, ruleId: null });
      // Notify on every channel that is already set up.
      let channels = ['ui'];
      try {
        const st = (await getSettings?.())?.rapisys || {};
        if (st.smtp?.host) channels.push('email');
        if (st.telegram?.chatId) channels.push('telegram');
      } catch { /* settings unreadable: dashboard only */ }
      const id = alertsRepo.createRule({
        name: 'Container health', metric: CONTAINER_HEALTH_METRIC, op: '<', threshold: 1,
        sustain_s: 60, severity: 'critical', enabled: 1, cooldown_s: 900, escalate_after_s: null, channels,
        config: { ...normalizeHealthConfig({ scope: 'some', containers: [slug] }), managed: true },
      });
      return res.json({ ok: true, ruleId: id, created: true });
    }
    const cfg = setContainerWatched(managed.cfg, slug, watch);
    alertsRepo.updateRule(managed.id, {
      ...managed, channels: JSON.parse(managed.channels || '["ui"]'), config: cfg,
      // Turning a bell on means "alert me": wake the rule up if it was disabled.
      enabled: watch ? 1 : managed.enabled,
    });
    res.json({ ok: true, ruleId: managed.id });
  });

  return r;
}
