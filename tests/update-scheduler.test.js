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
  it('defaults to disabled and clamps interval on save', async () => {
    const { sched } = fixture();
    expect((await sched.getConfig()).enabled).toBe(false);
    const saved = await sched.setConfig({ enabled: true, intervalHours: 9999 });
    expect(saved.enabled).toBe(true);
    expect(saved.intervalHours).toBe(720);   // clamped to max
    const saved2 = await sched.setConfig({ intervalHours: 1 });
    expect(saved2.intervalHours).toBe(1);     // explicit minimum accepted
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

  it('tick respects the configured interval', async () => {
    const { sched, updates } = fixture({ updatesList: [] });
    await sched.setConfig({ enabled: true, intervalHours: 24 });
    await sched.tick();                       // first tick runs
    expect(updates.refresh).toHaveBeenCalledTimes(1);
    await sched.tick();                       // immediate second tick is gated
    expect(updates.refresh).toHaveBeenCalledTimes(1);
  });
});
