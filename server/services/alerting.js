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

const METRIC_LABELS = {
  'cpu.usage': 'CPU usage', 'mem.percent': 'Memory usage', 'temp.cpu': 'CPU temperature',
  'fan.rpm': 'Fan speed', 'power.watts': 'Board power', 'load.avg1': 'Load (1m)',
};

export function createAlertEngine({ alertsRepo, metricsRepo, eventsRepo, mailer, telegram, getSettings }) {

  async function notify(rule, kind, value) {
    const channels = safeChannels(rule.channels);
    const label = METRIC_LABELS[rule.metric] || rule.metric;
    const title = kind === 'fired'
      ? `[${rule.severity.toUpperCase()}] ${rule.name}`
      : `[RESOLVED] ${rule.name}`;
    const body = kind === 'fired'
      ? `${label} is ${fmt(value)} (threshold: ${rule.op} ${rule.threshold}).`
      : `${label} is back to ${fmt(value)}.`;

    // UI channel: persisted event drives the toast/banner/badge.
    eventsRepo.add(`alert.${kind}`, kind === 'fired' ? rule.severity : 'info',
      { ruleId: rule.id, name: rule.name, metric: rule.metric, value, threshold: rule.threshold, op: rule.op });

    if (channels.includes('email')) {
      try {
        const smtp = await getSettings().then((s) => s.rapisys?.smtp);
        if (smtp?.host) {
          await mailer.send({
            subject: `RaPiSys ${title}`,
            text: body,
            html: `<div style="font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;padding:24px;border-radius:16px">
              <h2 style="margin:0 0 8px"><span style="color:#00d4ff">Ra</span><span style="color:#a855f7">Pi</span>Sys</h2>
              <h3 style="margin:0 0 12px;color:${kind === 'fired' ? (rule.severity === 'critical' ? '#ef4444' : '#f97316') : '#10b981'}">${title}</h3>
              <p style="margin:0">${body}</p></div>`,
          });
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
