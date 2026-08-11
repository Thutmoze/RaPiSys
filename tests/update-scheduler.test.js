/** RaPiSys — scheduled update check service tests. */
import { describe, it, expect, vi } from 'vitest';

const { createUpdateScheduler } = await import('../server/services/update-scheduler.js');

function fixture({ updatesList = [], unscanned = [], changelogs = {} } = {}) {
  let settings = { rapisys: {} };
  const sent = [];
  const tgSent = [];
  const updates = {
    refresh: vi.fn(async () => ({ available: true, updates: updatesList, checkedAt: Date.now(), unscanned })),
    cached: vi.fn(() => ({ available: true, updates: updatesList, checkedAt: Date.now() })),
    changelogFull: vi.fn(async (pkg) => ({ changelog: changelogs[pkg] || '' })),
    tagSecurityFromChangelog: vi.fn((pkg, cand, text) => {
      const cves = new Set((text.match(/CVE-\d{4}-\d+/g) || [])).size;
      const security = /-security;/.test(text) || cves > 0;
      return { security, cves, urgency: security ? 'high' : 'low' };
    }),
  };
  const mailer = { send: vi.fn(async (m) => { sent.push(m); return { ok: true }; }) };
  const telegram = { send: vi.fn(async (m) => { tgSent.push(m); return { ok: true }; }) };
  const sched = createUpdateScheduler({
    updates, mailer, telegram,
    loadSettings: async () => settings,
    saveSettings: async (s) => { settings = s; },
    withFileLock: async (fn) => fn(),
    events: { add: () => {} },
  });
  return { sched, sent, tgSent, updates, mailer, telegram, get settings() { return settings; } };
}

describe('update scheduler', () => {
  it('defaults to disabled and validates frequency/time on save', async () => {
    const { sched } = fixture();
    expect((await sched.getConfig()).enabled).toBe(false);
    expect((await sched.getConfig()).frequency).toBe('daily');
    const saved = await sched.setConfig({ enabled: true, frequency: 'weekly', time: '09:30', dayOfWeek: 3 });
    expect(saved.enabled).toBe(true);
    expect(saved.frequency).toBe('weekly');
    expect(saved.time).toBe('09:30');
    expect(saved.dayOfWeek).toBe(3);
    // invalid values are rejected, keeping the current ones
    const saved2 = await sched.setConfig({ frequency: 'hourly', time: '99:99' });
    expect(saved2.frequency).toBe('weekly');   // unchanged
    expect(saved2.time).toBe('09:30');         // unchanged
  });

  it('does nothing when disabled', async () => {
    const { sched, mailer } = fixture({ updatesList: [{ package: 'x', security: true, candidate: '2' }] });
    const r = await sched.runOnce();
    expect(r.skipped).toBe('disabled');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('emails security updates when enabled and present', async () => {
    const list = [
      { package: 'openssl', installed: '1.0', candidate: '1.1', security: true, cves: 2 },
      { package: 'nano', installed: '5', candidate: '6', security: false },
    ];
    const { sched, sent } = fixture({ updatesList: list });
    await sched.setConfig({ enabled: true });
    const r = await sched.runOnce();
    expect(r.security).toBe(1);
    expect(r.checked).toBe(2);
    expect(r.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/1 security update/);
    expect(sent[0].text).toMatch(/openssl/);
    expect(sent[0].text).not.toMatch(/nano/);   // only-security body lists openssl
  });

  it('does not email when only-security is on and there are none', async () => {
    const { sched, mailer } = fixture({ updatesList: [{ package: 'nano', candidate: '6', security: false }] });
    await sched.setConfig({ enabled: true, onlySecurity: true });
    const r = await sched.runOnce();
    expect(r.security).toBe(0);
    expect(r.emailed).toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('deep-scans unscanned packages and upgrades them to security when CVEs found', async () => {
    // chromium starts untagged (security:false) and is in the unscanned list;
    // its full changelog contains a CVE, so the deep-scan must flip it.
    const { sched, updates } = fixture({
      updatesList: [{ package: 'chromium', installed: '1', candidate: '2', security: false }],
      unscanned: ['chromium'],
      changelogs: { chromium: 'chromium (2) bookworm; urgency=high\n  * Fix CVE-2026-1234\n' },
    });
    await sched.setConfig({ enabled: true, onlySecurity: true });
    const r = await sched.runOnce();
    expect(updates.changelogFull).toHaveBeenCalledWith('chromium');
    expect(r.security).toBe(1);          // upgraded by the deep scan
  });

  it('sends Telegram when telegramEnabled and security updates exist', async () => {
    const { sched, telegram, tgSent } = fixture({
      updatesList: [{ package: 'openssl', installed: '1', candidate: '2', security: true, cves: 1 }],
    });
    await sched.setConfig({ enabled: true, emailEnabled: false, telegramEnabled: true });
    const r = await sched.runOnce();
    expect(r.telegrammed).toBe(true);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(tgSent[0].text).toMatch(/openssl/);
  });

  it('tick fires within the window after the scheduled time, once per occurrence', async () => {
    const { sched, updates } = fixture({ updatesList: [] });
    await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 0 });
    const before = new Date(Date.UTC(2026, 0, 1, 2, 55, 0));  // 02:55 — before target
    const at = new Date(Date.UTC(2026, 0, 1, 3, 1, 0));       // 03:01 — within 2-min window
    const after = new Date(Date.UTC(2026, 0, 1, 3, 1, 30));   // 03:01:30 — same occurrence
    await sched.tick(before);
    expect(updates.refresh).toHaveBeenCalledTimes(0);   // not yet due
    await sched.tick(at);
    expect(updates.refresh).toHaveBeenCalledTimes(1);   // fires once
    await sched.tick(after);
    expect(updates.refresh).toHaveBeenCalledTimes(1);   // same occurrence, gated
  });

  it('does not fire well past the scheduled time (missed window)', async () => {
    const { sched } = fixture();
    const cfg = await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 0 });
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 1, 3, 1, 0)))).toBe(true);    // 03:01 — in window
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 1, 3, 30, 0)))).toBe(false);  // 03:30 — too late
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 1, 2, 58, 0)))).toBe(false);  // 02:58 — too early
  });

  it('isDue respects weekly day-of-week', async () => {
    const { sched } = fixture();
    const cfg = await sched.setConfig({ enabled: true, frequency: 'weekly', time: '03:00', dayOfWeek: 1, tzOffsetMinutes: 0 });
    // 2026-01-05 is a Monday (getUTCDay()===1)
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 5, 3, 1)))).toBe(true);
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 6, 3, 1)))).toBe(false);  // Tuesday
  });

  it('records a failed check distinctly instead of a false zero, and does not email', async () => {
    const { sched, mailer, telegram, settings } = fixture();
    // override refresh to simulate apt.listUpgradable throwing (dpkg lock, etc.)
    const updates = {
      refresh: vi.fn(async () => ({ available: true, ok: false, error: 'apt list --upgradable exited 100: could not get lock', checkedAt: Date.now() })),
      cached: vi.fn(() => ({ available: true, updates: [], checkedAt: Date.now() })),
      changelogFull: vi.fn(),
      tagSecurityFromChangelog: vi.fn(),
    };
    let s = { rapisys: {} };
    const events = { add: vi.fn() };
    const sched2 = createUpdateScheduler({
      updates, mailer, telegram,
      loadSettings: async () => s,
      saveSettings: async (v) => { s = v; },
      withFileLock: async (fn) => fn(),
      events,
    });
    await sched2.setConfig({ enabled: true });
    const r = await sched2.runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not get lock/);
    expect(r.checked).toBeNull();
    expect(mailer.send).not.toHaveBeenCalled();
    expect(telegram.send).not.toHaveBeenCalled();
    expect(events.add).toHaveBeenCalledWith('update.check.fail', 'warning', expect.objectContaining({ error: expect.stringMatching(/lock/) }));
    // persisted so the UI can show it, not silently dropped
    expect(s.rapisys.updateSchedule.lastRun.ok).toBe(false);
    expect(s.rapisys.updateSchedule.runHistory[0].ok).toBe(false);
  });

  it('flags a suspicious drop from a large known-good count to zero, but still records it', async () => {
    const { sched, mailer } = fixture({ updatesList: [] });
    let s = { rapisys: { updateSchedule: { enabled: true, lastRun: { ts: Date.now() - 86400000, checked: 95, security: 35, ok: true }, runHistory: [] } } };
    const events = { add: vi.fn() };
    const sched2 = createUpdateScheduler({
      updates: { refresh: vi.fn(async () => ({ available: true, ok: true, updates: [], checkedAt: Date.now(), unscanned: [] })),
        cached: vi.fn(() => ({ available: true, updates: [], checkedAt: Date.now() })),
        changelogFull: vi.fn(), tagSecurityFromChangelog: vi.fn() },
      mailer, telegram: { send: vi.fn() },
      loadSettings: async () => s,
      saveSettings: async (v) => { s = v; },
      withFileLock: async (fn) => fn(),
      events,
    });
    const r = await sched2.runOnce();
    expect(r.flagged).toBe(true);
    expect(r.flagReason).toMatch(/95 to 0/);
    expect(r.checked).toBe(0);   // still recorded, not hidden
    expect(events.add).toHaveBeenCalledWith('update.check.flagged', 'warning', expect.objectContaining({ checked: 0 }));
  });

  it('does not flag a genuinely small/normal update count', async () => {
    const { sched } = fixture({ updatesList: [{ package: 'nano', candidate: '2', security: false }] });
    let s = { rapisys: { updateSchedule: { enabled: true, lastRun: { ts: Date.now() - 86400000, checked: 2, security: 0, ok: true }, runHistory: [] } } };
    const sched2 = createUpdateScheduler({
      updates: { refresh: vi.fn(async () => ({ available: true, ok: true, updates: [{ package: 'nano', candidate: '2', security: false }], checkedAt: Date.now(), unscanned: [] })),
        cached: vi.fn(() => ({ available: true, updates: [{ package: 'nano', candidate: '2', security: false }], checkedAt: Date.now() })),
        changelogFull: vi.fn(), tagSecurityFromChangelog: vi.fn() },
      mailer: { send: vi.fn() }, telegram: { send: vi.fn() },
      loadSettings: async () => s,
      saveSettings: async (v) => { s = v; },
      withFileLock: async (fn) => fn(),
      events: { add: vi.fn() },
    });
    const r = await sched2.runOnce();
    expect(r.flagged).toBe(false);
  });

  it('isDue shifts by tzOffsetMinutes so local time matches a UTC container', async () => {
    const { sched } = fixture();
    // user in UTC+3 (Doha) wants 03:00 local → that's 00:00 UTC
    const cfg = await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 180 });
    const utcMatch = new Date(Date.UTC(2026, 0, 5, 0, 1));    // 00:01 UTC = 03:01 local — in window
    const utcLate = new Date(Date.UTC(2026, 0, 5, 3, 5));     // 03:05 UTC = 06:05 local — wrong time
    expect(sched.isDue(cfg, utcMatch)).toBe(true);            // fires at user's 03:00
    expect(sched.isDue(cfg, utcLate)).toBe(false);            // not at user's 06:00
  });
});
