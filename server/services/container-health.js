/**
 * RaPiSys — container health rule config
 * --------------------------------------
 * A "Container health" alert rule (metric 'docker.health') stores its scope
 * and conditions as JSON in alert_rules.config:
 *
 *   { scope: 'one' | 'some' | 'all',
 *     containers: [slug, ...],          // one/some: the watched containers
 *     exclude: [slug, ...],             // all: containers left out
 *     conditions: ['down', 'unhealthy', 'restarts'],
 *     restarts: { count: 3, window_min: 10 },
 *     managed: true }                   // the rule the Containers card bells edit
 *
 * Shared by the alerts route (validation, bells) and the alert engine.
 */

import { slugify, CONTAINER_HEALTH_CONDITIONS, CONTAINER_HEALTH_METRIC } from '../core/metric-catalog.js';

const SCOPES = ['one', 'some', 'all'];
const MAX_CONTAINERS = 200;

export const DEFAULT_HEALTH_CONFIG = Object.freeze({
  scope: 'some', containers: [], exclude: [],
  conditions: ['down', 'unhealthy'], restarts: { count: 3, window_min: 10 },
});

const slugList = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => slugify(s)).filter(Boolean))].slice(0, MAX_CONTAINERS);
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Parse (string or object) and fill defaults; never throws. */
export function normalizeHealthConfig(raw) {
  let c = raw;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  if (!c || typeof c !== 'object') c = {};
  const conditions = (Array.isArray(c.conditions) ? c.conditions : DEFAULT_HEALTH_CONFIG.conditions)
    .filter((x) => CONTAINER_HEALTH_CONDITIONS.includes(x));
  return {
    scope: SCOPES.includes(c.scope) ? c.scope : DEFAULT_HEALTH_CONFIG.scope,
    containers: slugList(c.containers),
    exclude: slugList(c.exclude),
    conditions: [...new Set(conditions)],
    restarts: {
      count: clampInt(c.restarts?.count, 1, 100, 3),
      window_min: clampInt(c.restarts?.window_min, 1, 1440, 10),
    },
    ...(c.managed ? { managed: true } : {}),
  };
}

/** Validation errors for a submitted config (empty array when valid). */
export function validateHealthConfig(raw) {
  const e = [];
  const c = raw && typeof raw === 'object' ? raw : {};
  const cfg = normalizeHealthConfig(c);
  if (!SCOPES.includes(c.scope)) e.push(`config.scope must be one of ${SCOPES.join('|')}`);
  if (!cfg.conditions.length) e.push('choose at least one condition (stops running, unhealthy, restarting)');
  if (cfg.scope === 'one' && cfg.containers.length !== 1) e.push('choose a container');
  // The bell-managed rule may legitimately be empty (every bell turned off).
  if (cfg.scope === 'some' && !cfg.containers.length && !c.managed) e.push('choose at least one container');
  return e;
}

/** Does this (normalized) config watch the container? */
export function coversContainer(cfg, slug) {
  return cfg.scope === 'all' ? !cfg.exclude.includes(slug) : cfg.containers.includes(slug);
}

/** Toggle one container in a config (used by the Containers card bells). */
export function setContainerWatched(cfg, slug, watch) {
  const next = { ...cfg, containers: [...cfg.containers], exclude: [...cfg.exclude] };
  if (next.scope === 'all') {
    next.exclude = watch ? next.exclude.filter((s) => s !== slug) : [...new Set([...next.exclude, slug])];
  } else {
    next.containers = watch ? [...new Set([...next.containers, slug])] : next.containers.filter((s) => s !== slug);
    if (next.scope === 'one' && next.containers.length !== 1) next.scope = 'some';
  }
  return next;
}

export const isHealthRule = (rule) => rule?.metric === CONTAINER_HEALTH_METRIC;
