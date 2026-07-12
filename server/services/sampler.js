/**
 * RaPiSys — metrics sampler
 * -------------------------
 * The background job that records metrics into SQLite every N seconds
 * regardless of whether a browser is open. Reuses the existing stats
 * collector (legacy, untouched) plus the new hardware collector.
 */

import { getSystemStats } from '../stats.js';
import { slugify } from '../core/metric-catalog.js';

// A container that's fully removed (not just stopped) would otherwise go
// stale rather than read 0 — nothing keeps writing its metric. We keep
// reporting it "down" for this long after its last sighting so a normal
// `docker compose up -d --build` redeploy (which briefly removes and
// recreates a container) doesn't false-fire a "not running" alert. After
// the window, if it's still gone, we stop emitting it entirely.
const CONTAINER_GRACE_MS = 30 * 60 * 1000;

export function createSampler({ metricsRepo, eventsRepo, hardware, servicesApi }) {
  // slug -> { label, lastSeenTs } — used both for the grace window and to
  // resolve friendly names in the Alerts metric picker.
  const knownContainers = new Map();
  const knownServices = new Map();

  async function sampleOnce() {
    const ts = Date.now();
    const samples = [];

    const [stats, hw, serviceResults] = await Promise.all([
      getSystemStats().catch(() => null),
      hardware.snapshot().catch(() => null),
      servicesApi
        ? servicesApi.loadServices()
          .then((list) => Promise.all(list.map((s) => servicesApi.checkService(s))))
          .catch(() => [])
        : Promise.resolve([]),
    ]);

    if (stats) {
      samples.push(
        { metric: 'cpu.usage', value: stats.cpu?.usage },
        { metric: 'cpu.freq', value: stats.cpu?.speed ? stats.cpu.speed * 1000 : null },
        { metric: 'mem.percent', value: stats.memory?.percent },
        { metric: 'load.avg1', value: stats.load?.avgLoad },
      );
      // temp: prefer the Pi 5 hardware collector (sysfs/PMIC) — the legacy
      // collector reports 0 when no sensor is visible, which would pollute
      // the series. Fall back to it only when it has a real value.
      const legacyTemp = stats.temperature?.main || null;
      const hwTemp = hw?.thermal?.cpuTemp ?? null;
      samples.push({ metric: 'temp.cpu', value: hwTemp ?? legacyTemp });
      // network is { interfaces, stats } from the legacy collector;
      // stats entries carry per-second rates computed from /proc/net/dev deltas.
      for (const iface of stats.network?.stats || []) {
        if (!iface.iface) continue;
        samples.push(
          { metric: `net.${iface.iface}.rx`, value: iface.rxSec ?? iface.rx_sec ?? null },
          { metric: `net.${iface.iface}.tx`, value: iface.txSec ?? iface.tx_sec ?? null },
        );
      }

      // container status: 1 = running, 0 = present but not running.
      const seenSlugs = new Set();
      for (const c of stats.containers || []) {
        if (!c?.name) continue;
        const slug = slugify(c.name);
        seenSlugs.add(slug);
        knownContainers.set(slug, { label: c.name, lastSeenTs: ts });
        samples.push({ metric: `docker.${slug}.up`, value: c.state === 'running' ? 1 : 0 });
      }
      // grace window: a container that vanished entirely (removed, not just
      // stopped) keeps reading 0 until the window elapses, then is retired.
      for (const [slug, info] of knownContainers) {
        if (seenSlugs.has(slug)) continue;
        if (ts - info.lastSeenTs <= CONTAINER_GRACE_MS) {
          samples.push({ metric: `docker.${slug}.up`, value: 0 });
        } else {
          knownContainers.delete(slug);
        }
      }
    }

    // service checks: 1 = online, 0 = offline. These probe the configured
    // port directly, so — unlike a container metric — they keep working even
    // if the underlying container is fully removed (e.g. Pi-hole on :53).
    knownServices.clear();
    for (const s of serviceResults) {
      if (!s?.name) continue;
      const slug = slugify(s.name);
      knownServices.set(slug, s.name);
      samples.push({ metric: `service.${slug}.up`, value: s.status === 'online' ? 1 : 0 });
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

  /** Slug -> display-name maps for the currently-known services/containers,
   * used by the Alerts metric picker to show real names instead of slugs. */
  function getLiveNames() {
    const containers = new Map();
    for (const [slug, info] of knownContainers) containers.set(slug, info.label);
    return { services: knownServices, containers };
  }

  return { sampleOnce, getLiveNames };
}
