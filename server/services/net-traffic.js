/**
 * RaPiSys — built-in bandwidth history (replaces the host vnStat daemon)
 * ----------------------------------------------------------------------
 * Every minute, the /proc/net/dev byte counters are diffed against the last
 * values seen and the difference is added to the interface's local-time
 * hour / day / month buckets. The last counters are stored with the kernel
 * boot id, so a container restart (deploy) still counts the traffic that
 * passed while it was down; only the final minute before a reboot is lost.
 *
 * On first run, vnStat's existing history (if the host has it) is imported
 * through the agent so the chart keeps its past.
 */

import fs from 'fs';

const HOST_PROC = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';

// Loopback, container veths and per-compose bridges churn and carry nothing
// worth a history; docker0, VPN and physical interfaces are kept.
export const TRAFFIC_SKIP_IF = /^(lo|veth|cni|flannel|br-|virbr)/;

/** Byte counters per interface from /proc/net/dev text. */
export function parseNetDev(text) {
  const out = {};
  for (const line of String(text || '').split('\n').slice(2)) {
    const [namePart, rest] = line.split(':');
    if (!rest) continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    out[namePart.trim()] = { rx: cols[0], tx: cols[8] };
  }
  return out;
}

/** Local-time bucket starts (epoch ms) containing `ts`. */
export function trafficBuckets(ts) {
  const d = new Date(ts);
  return {
    hour: new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime(),
    day: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
  };
}

/**
 * Bytes to count since the last sample. Same boot and a counter that moved
 * forward: the difference. Same boot but a smaller counter: the interface was
 * recreated, so everything on it is new. New boot: everything since boot.
 * Never seen before: nothing (this sample becomes the baseline).
 */
export function counterDelta(prev, cur, bootId) {
  if (!prev) return 0;
  if (prev.bootId !== bootId) return cur;
  return cur >= prev.value ? cur - prev.value : cur;
}

/** vnStat --json (v2) to import rows, using vnStat's own local bucket starts. */
export function vnstatImportRows(json) {
  const rows = [];
  for (const i of json?.interfaces || []) {
    if (TRAFFIC_SKIP_IF.test(i.name)) continue;
    for (const [src, period] of [['hour', 'hour'], ['day', 'day'], ['month', 'month']]) {
      for (const b of i.traffic?.[src] || []) {
        if (!Number.isFinite(b.timestamp)) continue;
        rows.push({ iface: i.name, period, ts: b.timestamp * 1000, rx: b.rx || 0, tx: b.tx || 0 });
      }
    }
  }
  return rows;
}

export function createNetTraffic({
  repo,
  readNetDev = () => fs.readFileSync(`${HOST_PROC}/net/dev`, 'utf-8'),
  readBootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
  importVnstat = null,          // async () => vnstat --json object, or null
  now = () => Date.now(),
} = {}) {
  let importTried = false;
  let lastPrune = 0;

  async function tick() {
    // Import before the first accounting write, while the table is still empty.
    if (!importTried) {
      importTried = true;
      if (importVnstat && repo.isEmpty()) {
        try {
          const rows = vnstatImportRows(await importVnstat());
          if (rows.length) { repo.importRows(rows); console.log(`[net-traffic] imported ${rows.length} vnStat buckets`); }
        } catch (e) { console.log(`[net-traffic] no vnStat history to import (${e.message})`); }
      }
    }

    const ts = now();
    const bootId = readBootId();
    const counters = parseNetDev(readNetDev());
    const state = repo.counterState();
    const buckets = trafficBuckets(ts);
    const deltas = [];
    const nextState = [];
    for (const [iface, c] of Object.entries(counters)) {
      if (TRAFFIC_SKIP_IF.test(iface)) continue;
      const p = state[iface];
      deltas.push({
        iface, buckets,
        rx: counterDelta(p && { bootId: p.bootId, value: p.rx }, c.rx, bootId),
        tx: counterDelta(p && { bootId: p.bootId, value: p.tx }, c.tx, bootId),
      });
      nextState.push({ iface, bootId, rx: c.rx, tx: c.tx, ts });
    }
    repo.record(deltas, nextState);

    if (ts - lastPrune > 3600e3) { lastPrune = ts; repo.prune(ts); }
  }

  /**
   * The bandwidth-history payload, in the vnStat JSON shape the Network page
   * already reads: { available, interfaces: [{ name, today, hours, days, months, total }] }.
   */
  function history() {
    const series = repo.series();
    const totals = repo.totals();
    const today = trafficBuckets(now()).day;
    const dateOf = (ms, withDay = true) => {
      const d = new Date(ms);
      return withDay ? { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
        : { year: d.getFullYear(), month: d.getMonth() + 1 };
    };
    const interfaces = Object.entries(series).map(([name, s]) => ({
      name,
      today: (() => { const t = s.day.find((b) => b.ts === today); return t ? { date: dateOf(t.ts), rx: t.rx, tx: t.tx } : null; })(),
      hours: s.hour.map((b) => ({ date: dateOf(b.ts), time: { hour: new Date(b.ts).getHours(), minute: 0 }, timestamp: b.ts / 1000, rx: b.rx, tx: b.tx })),
      days: s.day.map((b) => ({ date: dateOf(b.ts), timestamp: b.ts / 1000, rx: b.rx, tx: b.tx })),
      months: s.month.map((b) => ({ date: dateOf(b.ts, false), timestamp: b.ts / 1000, rx: b.rx, tx: b.tx })),
      total: totals[name] || null,
    }));
    return { available: true, source: 'rapisys', interfaces };
  }

  return { tick, history };
}
