/** RaPiSys — scheduled update check service tests. */
import { describe, it, expect, vi } from 'vitest';

const { createUpdateScheduler } = await import('../server/services/update-scheduler.js');

function fixture({ updatesList = [], smtpTo = 'admin@example.com' } = {}) {
  let settings = { rapisys: {} };
  const sent = [];
  const updates = { refresh: vi.fn(async () => ({ available: true, updates: updatesList, checkedAt: Date.now() })) };
  const mailer = { send: vi.fn(async (m) => { sent.push(m); return { ok: true }; }) };
  const sched = createUpdateScheduler({
    updates, mailer,
    loadSettings: async () => settings,
    saveSettings: async (s) => { settings = s; },
    withFileLock: async (fn) => fn(),
    events: { add: () => {} },
  });
  return { sched, sent, updates, mailer, get settings() { return settings; } };
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

  it('tick fires within the window after the scheduled time, once per occurrence', async () => {
    const { sched, updates } = fixture({ updatesList: [] });
    await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 0 });
    const before = new Date(Date.UTC(2026, 0, 1, 2, 55, 0));  // 02:55 — before target
    const at = new Date(Date.UTC(2026, 0, 1, 3, 5, 0));       // 03:05 — within 11-min window
    const after = new Date(Date.UTC(2026, 0, 1, 3, 8, 0));    // 03:08 — same occurrence
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
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 1, 3, 2, 0)))).toBe(true);    // 03:02 — in window
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 1, 3, 30, 0)))).toBe(false);  // 03:30 — too late
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 1, 2, 58, 0)))).toBe(false);  // 02:58 — too early
  });

  it('isDue respects weekly day-of-week', async () => {
    const { sched } = fixture();
    const cfg = await sched.setConfig({ enabled: true, frequency: 'weekly', time: '03:00', dayOfWeek: 1, tzOffsetMinutes: 0 });
    // 2026-01-05 is a Monday (getUTCDay()===1)
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 5, 3, 2)))).toBe(true);
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 6, 3, 2)))).toBe(false);  // Tuesday
  });

  it('isDue shifts by tzOffsetMinutes so local time matches a UTC container', async () => {
    const { sched } = fixture();
    // user in UTC+3 (Doha) wants 03:00 local → that's 00:00 UTC
    const cfg = await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 180 });
    const utcMatch = new Date(Date.UTC(2026, 0, 5, 0, 5));    // 00:05 UTC = 03:05 local — in window
    const utcLate = new Date(Date.UTC(2026, 0, 5, 3, 5));     // 03:05 UTC = 06:05 local — wrong time
    expect(sched.isDue(cfg, utcMatch)).toBe(true);            // fires at user's 03:00
    expect(sched.isDue(cfg, utcLate)).toBe(false);            // not at user's 06:00
  });
});
