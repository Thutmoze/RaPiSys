/** RaPiSys — built-in bandwidth history (replaces vnStat).
 *
 * /proc/net/dev and vnStat JSON shapes follow XRPi (vnStat 2.13, jsonversion 2)
 * on 2026-10-09.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createNetTrafficRepo } = await import('../server/repositories/net-traffic.js');
const { createNetTraffic, parseNetDev, trafficBuckets, counterDelta, vnstatImportRows } = await import('../server/services/net-traffic.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-nt-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  return createNetTrafficRepo(db);
}

const netDev = (c) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
${Object.entries(c).map(([i, v]) => `${i.padStart(6)}: ${v.rx} 10 0 0 0 0 0 0 ${v.tx} 10 0 0 0 0 0 0`).join('\n')}
`;

describe('parseNetDev', () => {
  it('reads rx/tx bytes per interface', () => {
    expect(parseNetDev(netDev({ eth0: { rx: 1000, tx: 200 }, lo: { rx: 5, tx: 5 } })))
      .toEqual({ eth0: { rx: 1000, tx: 200 }, lo: { rx: 5, tx: 5 } });
  });
});

describe('counterDelta', () => {
  it('counts the difference within a boot', () => { expect(counterDelta({ bootId: 'a', value: 100 }, 150, 'a')).toBe(50); });
  it('counts everything since boot after a reboot', () => { expect(counterDelta({ bootId: 'a', value: 900 }, 40, 'b')).toBe(40); });
  it('counts everything when an interface was recreated', () => { expect(counterDelta({ bootId: 'a', value: 900 }, 40, 'a')).toBe(40); });
  it('only sets a baseline the first time', () => { expect(counterDelta(null, 5000, 'a')).toBe(0); });
});

describe('trafficBuckets', () => {
  it('uses local hour, day and month starts', () => {
    const t = new Date(2026, 9, 9, 18, 42, 7).getTime();
    expect(trafficBuckets(t)).toEqual({
      hour: new Date(2026, 9, 9, 18).getTime(), day: new Date(2026, 9, 9).getTime(), month: new Date(2026, 9, 1).getTime(),
    });
  });
});

// vnStat stamps buckets with their local start time; build them the same way.
const sec = (...a) => new Date(...a).getTime() / 1000;
const VNSTAT = {
  jsonversion: '2',
  interfaces: [
    { name: 'eth0', traffic: {
      total: { rx: 300, tx: 30 },
      hour: [{ id: 1, date: { year: 2026, month: 10, day: 9 }, time: { hour: 18, minute: 0 }, timestamp: sec(2026, 9, 9, 18), rx: 10, tx: 1 }],
      day: [{ id: 2, date: { year: 2026, month: 10, day: 9 }, timestamp: sec(2026, 9, 9), rx: 100, tx: 10 }],
      month: [{ id: 3, date: { year: 2026, month: 9 }, timestamp: sec(2026, 8, 1), rx: 200, tx: 20 },
        { id: 4, date: { year: 2026, month: 10 }, timestamp: sec(2026, 9, 1), rx: 100, tx: 10 }],
      fiveminute: [{ id: 5, timestamp: sec(2026, 9, 9, 18, 40), rx: 1, tx: 1 }],
    } },
    { name: 'br-3263731d90ef', traffic: { day: [{ timestamp: sec(2026, 9, 9), rx: 9, tx: 9 }] } },
  ],
};

describe('vnstatImportRows', () => {
  it('imports hours, days and months, skipping 5-minute data and bridges', () => {
    const rows = vnstatImportRows(VNSTAT);
    expect(rows.map((r) => `${r.iface}/${r.period}`)).toEqual(['eth0/hour', 'eth0/day', 'eth0/month', 'eth0/month']);
    expect(rows[1]).toEqual({ iface: 'eth0', period: 'day', ts: new Date(2026, 9, 9).getTime(), rx: 100, tx: 10 });
  });
});

describe('net-traffic service', () => {
  const T0 = new Date(2026, 9, 9, 18, 10).getTime();
  function setup({ vnstat = null } = {}) {
    const r = repo();
    const env = { counters: { eth0: { rx: 1000, tx: 100 } }, boot: 'boot-1', now: T0 };
    const svc = () => createNetTraffic({
      repo: r, readNetDev: () => netDev(env.counters), readBootId: () => env.boot,
      importVnstat: vnstat ? async () => vnstat : null, now: () => env.now,
    });
    return { r, env, svc };
  }

  it('accumulates counter deltas into hour, day and month buckets', async () => {
    const { r, env, svc } = setup();
    const s = svc();
    await s.tick();                                            // baseline only
    env.counters.eth0 = { rx: 1500, tx: 160 }; env.now += 60e3;
    await s.tick();
    env.counters.eth0 = { rx: 1700, tx: 200 }; env.now += 60e3;
    await s.tick();
    const h = s.history().interfaces.find((i) => i.name === 'eth0');
    expect(h.hours.at(-1)).toMatchObject({ time: { hour: 18, minute: 0 }, rx: 700, tx: 100 });
    expect(h.today).toMatchObject({ date: { year: 2026, month: 10, day: 9 }, rx: 700, tx: 100 });
    expect(h.months.at(-1)).toMatchObject({ date: { year: 2026, month: 10 }, rx: 700, tx: 100 });
    expect(h.total).toEqual({ rx: 700, tx: 100 });
    expect(r.counterState().eth0).toMatchObject({ bootId: 'boot-1', rx: 1700, tx: 200 });
  });

  it('counts traffic that passed while the container was restarting', async () => {
    const { env, svc } = setup();
    await svc().tick();
    env.counters.eth0 = { rx: 5000, tx: 100 }; env.now += 300e3;
    const restarted = svc();
    await restarted.tick();
    expect(restarted.history().interfaces[0].today).toMatchObject({ rx: 4000, tx: 0 });
  });

  it('counts everything since boot after a reboot', async () => {
    const { env, svc } = setup();
    const s = svc();
    await s.tick();
    env.boot = 'boot-2'; env.counters.eth0 = { rx: 300, tx: 30 }; env.now += 120e3;
    await s.tick();
    expect(s.history().interfaces[0].today).toMatchObject({ rx: 300, tx: 30 });
  });

  it('skips loopback, veths and per-compose bridges', async () => {
    const { env, svc } = setup();
    const s = svc();
    env.counters = { eth0: { rx: 1, tx: 1 }, lo: { rx: 1, tx: 1 }, veth1064616: { rx: 1, tx: 1 }, 'br-3263731d90ef': { rx: 1, tx: 1 }, docker0: { rx: 1, tx: 1 } };
    await s.tick();
    env.counters = { eth0: { rx: 9, tx: 9 }, lo: { rx: 9, tx: 9 }, veth1064616: { rx: 9, tx: 9 }, 'br-3263731d90ef': { rx: 9, tx: 9 }, docker0: { rx: 9, tx: 9 } };
    env.now += 60e3;
    await s.tick();
    expect(s.history().interfaces.map((i) => i.name).sort()).toEqual(['docker0', 'eth0']);
  });

  it('imports vnStat history once, then adds new traffic on top', async () => {
    const { env, svc } = setup({ vnstat: VNSTAT });
    const s = svc();
    await s.tick();
    env.counters.eth0 = { rx: 1050, tx: 105 }; env.now += 60e3;
    await s.tick();
    const eth0 = s.history().interfaces.find((i) => i.name === 'eth0');
    expect(eth0.total).toEqual({ rx: 350, tx: 35 });           // 300/30 imported + 50/5 new
    expect(eth0.months.map((m) => m.date.month)).toEqual([9, 10]);
    // A second service start (e.g. after a deploy) must not import again.
    await svc().tick();
    expect(s.history().interfaces.find((i) => i.name === 'eth0').total).toEqual({ rx: 350, tx: 35 });
  });

  it('starts empty without vnStat and without traffic', async () => {
    const { svc } = setup();
    const s = svc();
    await s.tick();
    expect(s.history()).toEqual({ available: true, source: 'rapisys', interfaces: [] });
  });
});
