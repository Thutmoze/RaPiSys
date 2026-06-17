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

  it('tick fires only at the scheduled hour and once per hour', async () => {
    const { sched, updates } = fixture({ updatesList: [] });
    await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 0 });
    const at3 = new Date(Date.UTC(2026, 0, 1, 3, 5, 0));   // 03:05 — matches hour 3
    const at4 = new Date(Date.UTC(2026, 0, 1, 4, 5, 0));   // 04:05 — wrong hour
    await sched.tick(at4);
    expect(updates.refresh).toHaveBeenCalledTimes(0);   // not the scheduled hour
    await sched.tick(at3);
    expect(updates.refresh).toHaveBeenCalledTimes(1);   // fires
    await sched.tick(at3);
    expect(updates.refresh).toHaveBeenCalledTimes(1);   // same hour, gated
  });

  it('isDue respects weekly day-of-week', async () => {
    const { sched } = fixture();
    const cfg = await sched.setConfig({ enabled: true, frequency: 'weekly', time: '03:00', dayOfWeek: 1, tzOffsetMinutes: 0 });
    // 2026-01-05 is a Monday (getUTCDay()===1)
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 5, 3, 0)))).toBe(true);
    expect(sched.isDue(cfg, new Date(Date.UTC(2026, 0, 6, 3, 0)))).toBe(false);  // Tuesday
  });

  it('isDue shifts by tzOffsetMinutes so local time matches a UTC container', async () => {
    const { sched } = fixture();
    // user in UTC+3 (Doha) wants 03:00 local → that's 00:00 UTC
    const cfg = await sched.setConfig({ enabled: true, frequency: 'daily', time: '03:00', tzOffsetMinutes: 180 });
    const utcMidnight = new Date(Date.UTC(2026, 0, 5, 0, 30));   // 00:30 UTC = 03:30 local
    const utcThree = new Date(Date.UTC(2026, 0, 5, 3, 30));      // 03:30 UTC = 06:30 local
    expect(sched.isDue(cfg, utcMidnight)).toBe(true);            // fires at user's 03:00
    expect(sched.isDue(cfg, utcThree)).toBe(false);             // not at user's 06:00
  });
});
