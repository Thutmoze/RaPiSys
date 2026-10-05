/**
 * RaPiSys — alerting engine
 * -------------------------
 * Evaluated every 30 s against the latest sampled metrics. Per-rule state
 * machine prevents flapping:
 *
 *    ok ──breach──► pending ──sustained──► firing ──clear──► ok (resolved)
 *
 *  - pending → firing only after the breach lasts `sustain_s`
 *  - notifications respect `cooldown_s` (no re-notify storms)
 *  - optional escalation: re-notify if still firing after `escalate_after_s`
 *  - channels: "ui" (event log → toast/banner), "email" (mailer), "telegram"
 */

import { describeMetric, isStatusMetric, flagWording, containerSlugOf, CONTAINER_HEALTH_METRIC } from '../core/metric-catalog.js';
import { normalizeHealthConfig } from './container-health.js';

// Escape values interpolated into Telegram HTML-parse-mode messages.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const OPS = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
};

export function createAlertEngine({ alertsRepo, metricsRepo, eventsRepo, mailer, telegram, getSettings, sampler }) {

  async function notify(rule, kind, value) {
    // Same catalog + live name cache the Alerts UI dropdown uses, so a
    // notification says "DNS" / "pihole" rather than "service.dns.up".
    const live = sampler ? sampler.getLiveNames() : {};
    const label = describeMetric(rule.metric, live).label;
    const statusMetric = isStatusMetric(rule.metric);
    const title = kind === 'fired'
      ? `[${rule.severity.toUpperCase()}] ${rule.name}`
      : `[RESOLVED] ${rule.name}`;
    // Service/container metrics are 1 (up) or 0 (down) — say so in words
    // instead of showing the raw number, which is what was happening before.
    const flag = flagWording(rule.metric, value);
    const body = flag
      ? flag
      : statusMetric
      ? (kind === 'fired'
          ? `${label} is ${value >= 1 ? 'up' : 'down'}.`
          : `${label} is ${value >= 1 ? 'up' : 'down'} again.`)
      : (kind === 'fired'
          ? `${label} is ${fmt(value)} (threshold: ${rule.op} ${rule.threshold}).`
          : `${label} is back to ${fmt(value)}.`);

    return deliver(rule, kind, title, body,
      { ruleId: rule.id, name: rule.name, metric: rule.metric, value, threshold: rule.threshold, op: rule.op });
  }

  /** Send one alert notification on every channel of the rule. */
  async function deliver(rule, kind, title, body, eventData) {
    const channels = safeChannels(rule.channels);
    // UI channel: persisted event drives the toast/banner/badge.
    eventsRepo.add(`alert.${kind}`, kind === 'fired' ? rule.severity : 'info', eventData);

    if (channels.includes('email')) {
      try {
        const smtp = await getSettings().then((s) => s.rapisys?.smtp);
        if (smtp?.host) {
          await mailer.send({
            // No brand prefix here: mailer.send() composes
            // "RaPiSys · <node> — <subject>" for every sender.
            subject: title,
            text: body,
            html: `<div style="font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;padding:24px;border-radius:16px">
              <h2 style="margin:0 0 8px"><span style="color:#00d4ff">Ra</span><span style="color:#a855f7">Pi</span>Sys</h2>
              <h3 style="margin:0 0 12px;color:${kind === 'fired' ? (rule.severity === 'critical' ? '#ef4444' : '#f97316') : '#10b981'}">${title}</h3>
              <p style="margin:0;white-space:pre-wrap">${esc(body)}</p></div>`,
          });
        } else {
          // Previously silent: a rule with "email" checked but no SMTP host
          // configured just did nothing, with no way to tell why an email
          // never showed up. Now it's a visible event on the Alerts/Events
          // feed pointing at Settings → Email.
          eventsRepo.add('alert.email_skipped', 'warning',
            { ruleId: rule.id, name: rule.name, reason: 'SMTP not configured — set it up in Settings → Email' });
        }
      } catch (err) {
        eventsRepo.add('alert.email_failed', 'warning', { ruleId: rule.id, error: err.message });
      }
    }

    if (channels.includes('telegram')) {
      try {
        const tg = await getSettings().then((s) => s.rapisys?.telegram);
        if (tg?.chatId) {
          const icon = kind === 'fired' ? (rule.severity === 'critical' ? '🔴' : '🟠') : '🟢';
          await telegram.send({
            text: `${icon} <b>${esc(title)}</b>\n${esc(body)}`,
          });
        }
      } catch (err) {
        eventsRepo.add('alert.telegram_failed', 'warning', { ruleId: rule.id, error: err.message });
      }
    }
    return channels;
  }

  /** One evaluation pass. Exposed for tests; scheduled every 30 s. */
  async function evaluateOnce(now = Date.now()) {
    const values = metricsRepo.latestValues();
    for (const rule of alertsRepo.listRules()) {
      if (!rule.enabled) continue;
      if (rule.metric === CONTAINER_HEALTH_METRIC) {
        await evaluateContainerRule(rule, values, now);
        continue;
      }
      const sample = values[rule.metric];
      if (!sample) continue;                       // metric not collected (yet)
      const breach = (OPS[rule.op] || OPS['>'])(sample.value, rule.threshold);
      const st = alertsRepo.getState(rule.id);

      if (st.state === 'ok' && breach) {
        alertsRepo.setState(rule.id, 'pending', now, st.last_notified);
      } else if (st.state === 'pending') {
        if (!breach) {
          alertsRepo.setState(rule.id, 'ok', null, st.last_notified);
        } else if (now - st.since >= rule.sustain_s * 1000) {
          alertsRepo.setState(rule.id, 'firing', now, now);
          alertsRepo.openIncident(rule.id, now, sample.value);
          const channels = await notify(rule, 'fired', sample.value);
          alertsRepo.markNotified(rule.id, channels);
        }
      } else if (st.state === 'firing') {
        if (!breach) {
          alertsRepo.setState(rule.id, 'ok', null, st.last_notified);
          alertsRepo.resolveIncident(rule.id, now);
          await notify(rule, 'resolved', sample.value);
        } else {
          alertsRepo.updateIncidentPeak(rule.id, sample.value);
          // Escalation / re-notify after cooldown.
          const esc = rule.escalate_after_s ? rule.escalate_after_s * 1000 : null;
          const cooled = now - (st.last_notified || 0) >= rule.cooldown_s * 1000;
          if (esc && now - st.since >= esc && cooled) {
            alertsRepo.setState(rule.id, 'firing', st.since, now);
            await notify(rule, 'fired', sample.value);
          }
        }
      }
    }
  }

  // ---- container health rules ---------------------------------------------
  // One rule watches several containers and runs the same ok -> pending ->
  // firing machine per container (alert_target_state), so each container
  // fires, notifies and resolves on its own.

  function containerDetails() {
    const map = new Map();
    for (const c of sampler?.getContainers?.() || []) map.set(c.slug, c);
    return map;
  }

  /** Restarts counted over the window: the sum of increases in Docker's
   * RestartCount (a recreated container starts again at 0, which is ignored). */
  function restartsInWindow(slug, windowMin, now) {
    const pts = metricsRepo.query(`docker.${slug}.restarts`, now - windowMin * 60000, now, '10s').points || [];
    let n = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].value - pts[i - 1].value;
      if (d > 0) n += d;
    }
    return n;
  }

  /** Which containers a rule covers right now (slugs with a fresh running
   * metric). "All containers" leaves out removed ones, so a throwaway
   * `docker run --rm` container does not alert; a container picked by name
   * still counts as down when it is removed. It also skips containers the
   * sampler does not know: right after a restart, the last samples of a
   * container removed before it are still fresh but say nothing current. */
  function ruleTargets(cfg, values, info) {
    const live = Object.keys(values).map(containerSlugOf).filter(Boolean);
    if (cfg.scope === 'all') {
      return live.filter((s) => {
        if (cfg.exclude.includes(s)) return false;
        const d = info.get(s);
        return d ? d.state !== 'removed' : !sampler?.getContainers;
      });
    }
    const liveSet = new Set(live);
    return cfg.containers.filter((s) => liveSet.has(s));
  }

  /** Breach reasons for one container: [{ code, text }]. */
  function containerReasons(cfg, slug, values, now, info) {
    const out = [];
    const exit = info?.exitCode != null && info.exitCode !== 0
      ? ` (last exit code ${info.exitCode}${info.oomKilled ? ', out of memory' : ''})` : (info?.oomKilled ? ' (out of memory)' : '');
    if (cfg.conditions.includes('down') && values[`docker.${slug}.up`]?.value === 0) {
      const how = info?.state === 'removed' ? 'was removed' : info?.state === 'restarting' ? 'is restarting'
        : info?.state === 'exited' ? 'has stopped' : 'is not running';
      out.push({ code: 'down', text: `${how}${exit}` });
    }
    if (cfg.conditions.includes('unhealthy') && values[`docker.${slug}.health`]?.value === 0) {
      const streak = info?.failingStreak > 0 ? `: healthcheck failed ${info.failingStreak} time${info.failingStreak === 1 ? '' : 's'} in a row` : '';
      out.push({ code: 'unhealthy', text: `is unhealthy${streak}` });
    }
    if (cfg.conditions.includes('restarts')) {
      const n = restartsInWindow(slug, cfg.restarts.window_min, now);
      if (n >= cfg.restarts.count) {
        out.push({ code: 'restarts', text: `keeps restarting: ${n} restarts in the last ${cfg.restarts.window_min} min${exit}` });
      }
    }
    return out;
  }

  async function notifyContainer(rule, slug, kind, reasons, info, since, now) {
    const name = info?.name || slug;
    const title = kind === 'fired'
      ? `[${rule.severity.toUpperCase()}] ${rule.name}: ${name}`
      : `[RESOLVED] ${rule.name}: ${name}`;
    let body;
    if (kind === 'fired') {
      body = `Container ${name} ${reasons.map((r) => r.text).join(', and ')}.`;
      if (reasons.some((r) => r.code === 'unhealthy') && info?.healthOutput) {
        body += `\nLast check output: ${info.healthOutput}`;
      }
    } else {
      const mins = since ? Math.max(1, Math.round((now - since) / 60000)) : null;
      body = `Container ${name} is running normally again${mins ? ` after ${mins} min` : ''}.`;
    }
    return deliver(rule, kind, title, body, {
      ruleId: rule.id, name: rule.name, metric: rule.metric, target: slug, container: name,
      reason: reasons.map((r) => r.text).join('; ') || null,
    });
  }

  async function evaluateContainerRule(rule, values, now) {
    const cfg = normalizeHealthConfig(rule.config);
    const info = containerDetails();
    const targets = ruleTargets(cfg, values, info);
    const targetSet = new Set(targets);

    for (const slug of targets) {
      const reasons = containerReasons(cfg, slug, values, now, info.get(slug));
      const breach = reasons.length > 0;
      const reasonText = reasons.map((r) => r.text).join('; ') || null;
      const st = alertsRepo.getTargetState(rule.id, slug);

      if (st.state === 'ok' && breach) {
        alertsRepo.setTargetState(rule.id, slug, 'pending', now, st.last_notified, reasonText);
      } else if (st.state === 'pending') {
        if (!breach) {
          alertsRepo.setTargetState(rule.id, slug, 'ok', null, st.last_notified, null);
        } else if (now - st.since >= rule.sustain_s * 1000) {
          alertsRepo.setTargetState(rule.id, slug, 'firing', now, now, reasonText);
          const channels = await notifyContainer(rule, slug, 'fired', reasons, info.get(slug), null, now);
          alertsRepo.openTargetIncident(rule.id, slug, now, reasonText, channels);
        } else {
          alertsRepo.setTargetState(rule.id, slug, 'pending', st.since, st.last_notified, reasonText);
        }
      } else if (st.state === 'firing') {
        if (!breach) {
          alertsRepo.setTargetState(rule.id, slug, 'ok', null, st.last_notified, null);
          alertsRepo.resolveTargetIncident(rule.id, slug, now);
          await notifyContainer(rule, slug, 'resolved', [], info.get(slug), st.since, now);
        } else {
          let notified = st.last_notified;
          const escMs = rule.escalate_after_s ? rule.escalate_after_s * 1000 : null;
          const cooled = now - (st.last_notified || 0) >= rule.cooldown_s * 1000;
          if (escMs && now - st.since >= escMs && cooled) {
            notified = now;
            await notifyContainer(rule, slug, 'fired', reasons, info.get(slug), null, now);
          }
          alertsRepo.setTargetState(rule.id, slug, 'firing', st.since, notified, reasonText);
        }
      }
    }

    // A container that left the rule's scope (unwatched, or gone for good
    // after the removal grace window) can no longer be evaluated: close it
    // quietly rather than leaving an alert firing forever.
    for (const st of alertsRepo.listTargetStates(rule.id)) {
      if (targetSet.has(st.target)) continue;
      if (st.state === 'firing') alertsRepo.resolveTargetIncident(rule.id, st.target, now);
      alertsRepo.deleteTargetState(rule.id, st.target);
    }
  }

  /** Sensible starter rules, created once on an empty table. */
  function seedDefaults() {
    if (alertsRepo.countRules() > 0) return;
    const defaults = [
      { name: 'High CPU temperature', metric: 'temp.cpu', op: '>', threshold: 80, sustain_s: 120, severity: 'critical', cooldown_s: 900, channels: ['ui', 'email'] },
      { name: 'High CPU usage', metric: 'cpu.usage', op: '>', threshold: 90, sustain_s: 300, severity: 'warning', cooldown_s: 1800, channels: ['ui'] },
      { name: 'High memory usage', metric: 'mem.percent', op: '>', threshold: 90, sustain_s: 300, severity: 'warning', cooldown_s: 1800, channels: ['ui'] },
    ];
    for (const d of defaults) alertsRepo.createRule({ enabled: 1, escalate_after_s: null, ...d });
  }

  const fmt = (v) => (Math.round(v * 10) / 10).toLocaleString();
  const safeChannels = (c) => { try { const x = JSON.parse(c); return Array.isArray(x) ? x : ['ui']; } catch { return ['ui']; } };

  return { evaluateOnce, seedDefaults };
}
