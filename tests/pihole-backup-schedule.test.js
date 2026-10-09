/** RaPiSys — Pi-hole NAS backup schedule: restarts must not add backups. */
import { describe, it, expect } from 'vitest';

const { piholeBackupDue, createPiholeBackupJob } = await import('../server/services/pihole-backup.js');

const H = 3600e3, DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 9, 12);

describe('piholeBackupDue', () => {
  it('is due with no backup on the NAS yet', () => {
    expect(piholeBackupDue({ now: NOW, intervalMs: DAY, newestMtime: null })).toBe(true);
  });
  it('is not due while the newest backup is younger than the interval', () => {
    expect(piholeBackupDue({ now: NOW, intervalMs: DAY, newestMtime: NOW - 2 * H })).toBe(false);
  });
  it('is due once the interval (less 1 h slack) has passed', () => {
    expect(piholeBackupDue({ now: NOW, intervalMs: DAY, newestMtime: NOW - 23 * H })).toBe(true);
  });
  it('waits 6 h after a failed attempt', () => {
    expect(piholeBackupDue({ now: NOW, intervalMs: DAY, newestMtime: null, lastFailAt: NOW - H })).toBe(false);
    expect(piholeBackupDue({ now: NOW, intervalMs: DAY, newestMtime: null, lastFailAt: NOW - 7 * H })).toBe(true);
  });
});

describe('pihole backup job', () => {
  function setup({ backups = [], status = null } = {}) {
    const calls = [];
    const events = [];
    const job = (now = NOW) => createPiholeBackupJob({
      loadSettings: async () => ({ rapisys: { piholeBackup: { enabled: true, frequency: 'daily', retain: 14 }, nas: { mountpoint: '/mnt/rapisys/mybook' } } }),
      network: {
        piholeBackupStatus: async () => status || { agent: true, backups },
        piholeBackupToNas: async (p) => { calls.push(p); backups.unshift({ name: 'new', mtime: now }); return { file: 'new', size: 1 }; },
      },
      events: { add: (...a) => events.push(a) },
      now: () => now,
    });
    return { job, calls, events, backups };
  }

  it('does not back up again after a restart when today\'s backup exists', async () => {
    const { job, calls } = setup({ backups: [{ name: 'today', mtime: NOW - 3 * H }] });
    await job().tick();          // fresh process, as after every deploy
    await job().tick();
    expect(calls).toEqual([]);
  });

  it('backs up once when due, then not again on the next restart', async () => {
    const { job, calls } = setup({ backups: [{ name: 'yesterday', mtime: NOW - 25 * H }] });
    await job().tick();
    await job(NOW + 10 * 60e3).tick();
    expect(calls).toEqual([{ mountpoint: '/mnt/rapisys/mybook', retain: 14 }]);
  });

  it('skips when the NAS cannot be listed instead of treating it as empty', async () => {
    const { job, calls } = setup({ status: { agent: true, backups: [], error: 'mount not reachable' } });
    await job().tick();
    expect(calls).toEqual([]);
  });
});
