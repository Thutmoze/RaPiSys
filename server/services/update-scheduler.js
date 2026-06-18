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

export function createUpdateScheduler({ updates, mailer, telegram, loadSettings, saveSettings, withFileLock, events }) {
  const DEFAULTS = {
    enabled: false, frequency: 'daily', time: '03:00', dayOfWeek: 1, dayOfMonth: 1,
    tzOffsetMinutes: 0, emailEnabled: true, emailTo: '', onlySecurity: true,
    telegramEnabled: false, lastRun: null, runHistory: [],
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
        tzOffsetMinutes: patch.tzOffsetMinutes != null ? Number(patch.tzOffsetMinutes) : cur.tzOffsetMinutes,
        emailEnabled: patch.emailEnabled != null ? !!patch.emailEnabled : cur.emailEnabled,
        emailTo: patch.emailTo != null ? String(patch.emailTo).slice(0, 254) : cur.emailTo,
        onlySecurity: patch.onlySecurity != null ? !!patch.onlySecurity : cur.onlySecurity,
        telegramEnabled: patch.telegramEnabled != null ? !!patch.telegramEnabled : cur.telegramEnabled,
        lastRun: cur.lastRun || null,   // preserve the last-run summary across edits
        runHistory: cur.runHistory || [],
      };
      s.rapisys.updateSchedule = saved;
      await saveSettings(s);
    });
    return saved;
  }

  // HTML-escape for Telegram HTML parse mode.
  function tgEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Build the Telegram message listing security (and optionally all) updates.
  function buildTelegram(list) {
    const security = list.filter((u) => u.security);
    const shown = (security.length ? security : list).slice(0, 20);
    const header = security.length
      ? `🔒 <b>RaPiSys: ${security.length} security update${security.length === 1 ? '' : 's'}</b>`
      : `📦 <b>RaPiSys: ${list.length} update${list.length === 1 ? '' : 's'} available</b>`;
    const lines = shown.map((u) =>
      `• <b>${tgEsc(u.package)}</b> <code>${tgEsc(u.installed || '?')} → ${tgEsc(u.candidate)}</code>`
      + (u.cves ? ` (${u.cves} CVE${u.cves > 1 ? 's' : ''})` : ''));
    const more = shown.length < (security.length || list.length)
      ? `\n…and ${(security.length || list.length) - shown.length} more.` : '';
    return `${header}\n${list.length} package update${list.length === 1 ? '' : 's'} on your Raspberry Pi.\n\n`
      + `${lines.join('\n')}${more}\n\nApply them from the Updates page in RaPiSys.`;
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
  let running = false;
  let runningSince = null;
  async function runOnce() {
    const cfg = await getConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };
    running = true; runningSince = Date.now();
    try {
      return await doRun(cfg);
    } finally {
      running = false; runningSince = null;
    }
  }

  async function doRun(cfg) {
    const out = await updates.refresh();
    if (!out.available) return { skipped: 'no-agent' };
    const list = out.updates || [];

    // Deep scan (#3): the interactive UI tags security/CVEs lazily — a user
    // clicks "view changelog" and large packages get their full changelog
    // downloaded on demand. A scheduled check has no one to click, so for any
    // package the cheap range-fetch couldn't reach (out.unscanned), download the
    // full package changelog here so the security/CVE picture is complete before
    // we decide what to notify. Bounded so a pathological run can't take forever.
    let deepScanned = 0;
    const unscanned = (out.unscanned || []).slice(0, 40);
    if (unscanned.length && updates.changelogFull && updates.tagSecurityFromChangelog) {
      const byPkg = Object.fromEntries(list.map((u) => [u.package, u]));
      for (const pkg of unscanned) {
        try {
          const r = await updates.changelogFull(pkg);
          const u = byPkg[pkg];
          if (r && r.changelog && u) {
            const tag = updates.tagSecurityFromChangelog(pkg, u.candidate, r.changelog, u.installed);
            if (tag) { u.security = tag.security; u.cves = tag.cves; u.urgency = tag.urgency; }
            deepScanned++;
          }
        } catch (err) {
          events?.add?.('update.deepscan.fail', 'info', { pkg, error: err.message });
        }
      }
    }

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

    let telegrammed = false;
    if (cfg.telegramEnabled && telegram && (security.length > 0 || (!cfg.onlySecurity && list.length > 0))) {
      try {
        await telegram.send({ text: buildTelegram(list) });
        telegrammed = true;
        events?.add?.('update.telegram', 'info', { security: security.length, total: list.length });
      } catch (err) {
        events?.add?.('update.telegram.fail', 'warning', { error: err.message });
      }
    }
    const result = { ts: Date.now(), checked: list.length, security: security.length, emailed, telegrammed, checkedAt: out.checkedAt };
    // persist the last-run summary + a short history so the UI can show both
    await withFileLock(async () => {
      const s = await loadSettings();
      s.rapisys = s.rapisys || {};
      const cur = s.rapisys.updateSchedule || {};
      const history = [result, ...(cur.runHistory || [])].slice(0, 10);
      s.rapisys.updateSchedule = { ...cur, lastRun: result, runHistory: history };
      await saveSettings(s);
    });
    return { skipped: null, ...result };
  }

  // The scheduler ticks every ~10 min; this fires the check once when the
  // current local time has reached the scheduled HH:MM (within a tick window)
  // on a matching day, and not already fired for that occurrence. The container
  // clock is UTC, so we shift `now` by tzOffsetMinutes (minutes to ADD to UTC
  // to get the user's local time) captured by the browser when saved.
  const TICK_WINDOW_MS = 11 * 60000;   // a bit more than the 10-min tick cadence
  let lastFiredKey = null;
  function localNow(cfg, now = new Date()) {
    const offsetMin = Number(cfg.tzOffsetMinutes) || 0;
    return new Date(now.getTime() + offsetMin * 60000);
  }
  // The scheduled local Date for the day `local` falls on.
  function scheduledTimeOn(cfg, local) {
    const [h, m] = String(cfg.time || '03:00').split(':').map(Number);
    const t = new Date(local.getTime());
    t.setUTCHours(h, m, 0, 0);   // local is a UTC-shifted clock, so use UTC setters
    return t;
  }
  function dayMatches(cfg, local) {
    if (cfg.frequency === 'weekly') return local.getUTCDay() === cfg.dayOfWeek;
    if (cfg.frequency === 'monthly') return local.getUTCDate() === cfg.dayOfMonth;
    return true;   // daily
  }
  function isDue(cfg, now = new Date()) {
    const local = localNow(cfg, now);
    if (!dayMatches(cfg, local)) return false;
    const target = scheduledTimeOn(cfg, local);
    const delta = local.getTime() - target.getTime();
    // due if we're at or just past the scheduled time, within one tick window
    return delta >= 0 && delta < TICK_WINDOW_MS;
  }
  async function tick(now = new Date()) {
    const cfg = await getConfig();
    if (!cfg.enabled) return;
    if (!isDue(cfg, now)) return;
    const local = localNow(cfg, now);
    // one fire per scheduled day+time occurrence
    const key = `${local.getUTCFullYear()}-${local.getUTCMonth()}-${local.getUTCDate()}-${cfg.time}`;
    if (key === lastFiredKey) return;                  // already fired this occurrence
    lastFiredKey = key;
    try { await runOnce(); } catch (err) { events?.add?.('update.check.fail', 'warning', { error: err.message }); }
  }

  return { getConfig, setConfig, runOnce, tick, isDue, isRunning: () => ({ running, since: runningSince }) };
}
