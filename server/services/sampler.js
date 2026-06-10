/**
 * RaPiSys — metrics sampler
 * -------------------------
 * The background job that records metrics into SQLite every N seconds
 * regardless of whether a browser is open. Reuses the existing stats
 * collector (legacy, untouched) plus the new hardware collector.
 */

import { getSystemStats } from '../stats.js';

export function createSampler({ metricsRepo, eventsRepo, hardware }) {
  async function sampleOnce() {
    const ts = Date.now();
    const samples = [];

    const [stats, hw] = await Promise.all([
      getSystemStats().catch(() => null),
      hardware.snapshot().catch(() => null),
    ]);

    if (stats) {
      samples.push(
        { metric: 'cpu.usage', value: stats.cpu?.usage },
        { metric: 'cpu.freq', value: stats.cpu?.speed ? stats.cpu.speed * 1000 : null },
        { metric: 'mem.percent', value: stats.memory?.percent },
        { metric: 'load.avg1', value: stats.load?.avgLoad },
        { metric: 'temp.cpu', value: stats.temperature?.main },
      );
      // network is { interfaces, stats } from the legacy collector;
      // stats entries carry per-second rates computed from /proc/net/dev deltas.
      for (const iface of stats.network?.stats || []) {
        if (!iface.iface) continue;
        samples.push(
          { metric: `net.${iface.iface}.rx`, value: iface.rxSec ?? iface.rx_sec ?? null },
          { metric: `net.${iface.iface}.tx`, value: iface.txSec ?? iface.tx_sec ?? null },
        );
      }
    }

    if (hw) {
      samples.push(
        { metric: 'fan.rpm', value: hw.fan.present ? hw.fan.rpm : null },
        { metric: 'fan.duty', value: hw.fan.present ? hw.fan.dutyPercent : null },
        { metric: 'power.core_v', value: hw.power.coreVolts },
        { metric: 'power.5v', value: hw.power.supply5v },
        { metric: 'power.watts', value: hw.power.watts },
      );
      for (const ev of hardware.throttleTransitions(hw)) {
        eventsRepo.add(ev.type, ev.severity, { ts });
      }
    }

    metricsRepo.writeBatch(ts, samples.filter((s) => s.value !== null && s.value !== undefined));
  }

  return { sampleOnce };
}
