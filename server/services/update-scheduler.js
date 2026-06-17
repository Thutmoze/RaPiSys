/**
 * RaPiSys — scheduled automatic update check (F8).
 * ------------------------------------------------
 * On a configurable cadence, runs the updates collector and — when security
 * updates are found — emails a summary to the configured recipient. The config
 * lives in settings.rapisys.updateSchedule and is editable from the Updates UI.
 *
 *   updateSchedule = {
 *     enabled:      boolean,   // run the periodic check at all
 *     frequency:    'daily'|'weekly'|'monthly',
 *     time:         'HH:MM',   // local time of day to run
 *     dayOfWeek:    0-6,       // for weekly (0 = Sunday)
 *     dayOfMonth:   1-28,      // for monthly
 *     emailEnabled: boolean,   // email security updates when found
 *     emailTo:      string,    // recipient (falls back to SMTP "to")
 *     onlySecurity: boolean,   // only email when there ARE security updates
 *   }
 */

export function createUpdateScheduler({ updates, mailer, loadSettings, saveSettings, withFileLock, events }) {
  const DEFAULTS = {
    enabled: false, frequency: 'daily', time: '03:00', dayOfWeek: 1, dayOfMonth: 1,
    emailEnabled: true, emailTo: '', onlySecurity: true,
  };

  async function getConfig() {
    const s = await loadSettings();
    return { ...DEFAULTS, ...(s.rapisys?.updateSchedule || {}) };
  }

  async function setConfig(patch) {
    let saved;
    await withFileLock(async () => {
      const s = await loadSettings();
      s.rapisys = s.rapisys || {};
      const cur = { ...DEFAULTS, ...(s.rapisys.updateSchedule || {}) };
      const freq = ['daily', 'weekly', 'monthly'].includes(patch.frequency) ? patch.frequency : cur.frequency;
      const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(patch.time || '') ? patch.time : cur.time;
      saved = {
        enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
        frequency: freq,
        time,
        dayOfWeek: patch.dayOfWeek != null ? Math.max(0, Math.min(6, Number(patch.dayOfWeek))) : cur.dayOfWeek,
        dayOfMonth: patch.dayOfMonth != null ? Math.max(1, Math.min(28, Number(patch.dayOfMonth))) : cur.dayOfMonth,
        emailEnabled: patch.emailEnabled != null ? !!patch.emailEnabled : cur.emailEnabled,
        emailTo: patch.emailTo != null ? String(patch.emailTo).slice(0, 254) : cur.emailTo,
        onlySecurity: patch.onlySecurity != null ? !!patch.onlySecurity : cur.onlySecurity,
      };
      s.rapisys.updateSchedule = saved;
      await saveSettings(s);
    });
    return saved;
  }

  // Build the email body listing security (and optionally all) updates.
  function buildEmail(list) {
    const security = list.filter((u) => u.security);
    const subject = security.length
      ? `RaPiSys: ${security.length} security update${security.length === 1 ? '' : 's'} available`
      : `RaPiSys: ${list.length} update${list.length === 1 ? '' : 's'} available`;
    const line = (u) => `  • ${u.package}  ${u.installed || '?'} → ${u.candidate}` +
      (u.cves ? `  [${u.cves} CVE${u.cves > 1 ? 's' : ''}]` : '') +
      (u.urgency ? `  urgency=${u.urgency}` : '');
    const secText = security.length
      ? `Security updates (${security.length}):\n${security.map(line).join('\n')}\n\n`
      : 'No security updates flagged.\n\n';
    const text = `RaPiSys detected ${list.length} available package update${list.length === 1 ? '' : 's'} `
      + `on your Raspberry Pi.\n\n${secText}`
      + `Review and apply them from the Updates page in RaPiSys.\n`;
    const rows = (security.length ? security : list).map((u) =>
      `<tr><td style="padding:4px 10px"><b>${u.package}</b></td>`
      + `<td style="padding:4px 10px;color:#888">${u.installed || '?'} → ${u.candidate}</td>`
      + `<td style="padding:4px 10px">${u.cves ? `${u.cves} CVE${u.cves > 1 ? 's' : ''}` : ''}</td></tr>`).join('');
    const html = `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif">`
      + `<h2 style="color:#00a3cc">RaPiSys — ${security.length} security update${security.length === 1 ? '' : 's'}</h2>`
      + `<p>${list.length} package update${list.length === 1 ? '' : 's'} available on your Raspberry Pi.</p>`
      + `<table style="border-collapse:collapse;font-size:13px">${rows}</table>`
      + `<p style="color:#888;font-size:12px">Apply them from the Updates page in RaPiSys.</p></div>`;
    return { subject, text, html };
  }

  /** Run one scheduled check; email if configured and warranted. */
  async function runOnce() {
    const cfg = await getConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };
    const out = await updates.refresh();
    if (!out.available) return { skipped: 'no-agent' };
    const list = out.updates || [];
    const security = list.filter((u) => u.security);

    let emailed = false;
    if (cfg.emailEnabled && (security.length > 0 || (!cfg.onlySecurity && list.length > 0))) {
      const to = cfg.emailTo || undefined;   // mailer falls back to SMTP "to"
      const { subject, text, html } = buildEmail(list);
      try {
        await mailer.send({ to, subject, text, html });
        emailed = true;
        events?.add?.('update.email', 'info', { security: security.length, total: list.length });
      } catch (err) {
        events?.add?.('update.email.fail', 'warning', { error: err.message });
      }
    }
    return { checked: list.length, security: security.length, emailed, checkedAt: out.checkedAt };
  }

  // The scheduler ticks hourly; this decides whether the current wall-clock
  // moment matches the configured schedule and the run hasn't fired yet today.
  let lastFiredKey = null;   // 'YYYY-MM-DD-HH' of the last run, to fire once
  function isDue(cfg, now = new Date()) {
    const [h] = cfg.time.split(':').map(Number);
    if (now.getHours() !== h) return false;            // only at the chosen hour
    if (cfg.frequency === 'weekly' && now.getDay() !== cfg.dayOfWeek) return false;
    if (cfg.frequency === 'monthly' && now.getDate() !== cfg.dayOfMonth) return false;
    return true;
  }
  async function tick(now = new Date()) {
    const cfg = await getConfig();
    if (!cfg.enabled) return;
    if (!isDue(cfg, now)) return;
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (key === lastFiredKey) return;                  // already fired this hour
    lastFiredKey = key;
    try { await runOnce(); } catch (err) { events?.add?.('update.check.fail', 'warning', { error: err.message }); }
  }

  return { getConfig, setConfig, runOnce, tick, isDue };
}
