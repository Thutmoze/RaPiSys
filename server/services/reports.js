/**
 * RaPiSys — reporting & trend analysis
 * ------------------------------------
 * Nightly job materializes a per-day summary (min/avg/max/p95 per metric,
 * peak windows, event counts, a health score) into report_daily. Weekly
 * and monthly views aggregate dailies on demand. Health score is a
 * weighted rubric over thermal headroom, throttle/undervoltage events,
 * storage runway, service failures and alert activity.
 */

const KEY_METRICS = ['cpu.usage', 'mem.percent', 'temp.cpu', 'fan.rpm', 'power.watts', 'load.avg1'];

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    min: sorted[0], max: sorted[sorted.length - 1],
    avg: sum / sorted.length, p95: p(0.95), p50: p(0.5), n: sorted.length,
  };
}

export function createReports({ metricsRepo, eventsRepo, reportsRepo, getStorageInfo }) {

  /** Build (and persist) the summary for a given day (default: yesterday). */
  function materializeDay(ts = Date.now() - 86400e3) {
    const dayStart = startOfDay(ts);
    const dayEnd = dayStart + 86400e3;
    const day = ymd(dayStart);
    const metrics = {};
    for (const m of KEY_METRICS) {
      const { points } = metricsRepo.query(m, dayStart, dayEnd);
      const s = stats(points.map((p) => p.value));
      if (s) {
        // peak window: hour with the highest average
        const byHour = {};
        for (const pt of points) {
          const h = new Date(pt.ts).getHours();
          (byHour[h] ||= []).push(pt.value);
        }
        let peakHour = null, peakAvg = -Infinity;
        for (const [h, vs] of Object.entries(byHour)) {
          const a = vs.reduce((x, y) => x + y, 0) / vs.length;
          if (a > peakAvg) { peakAvg = a; peakHour = Number(h); }
        }
        metrics[m] = { ...s, peakHour };
      }
    }

    const events = eventsRepo.countByTypeBetween
      ? eventsRepo.countByTypeBetween(dayStart, dayEnd)
      : {};
    const isToday = day === ymd(Date.now());
    const summary = {
      day, generatedAt: Date.now(), metrics, events, partial: isToday,
      health: healthScore({ metrics, events, storage: getStorageInfo?.() }),
    };
    reportsRepo.upsertDaily(day, summary);
    return summary;
  }

  /** Backfill any missing days within the last `n` days, plus today (partial). */
  function backfill(n = 14) {
    const out = [];
    // Always (re)materialize today so the dashboard shows live data without
    // waiting for the nightly job — even on a fresh install collecting since
    // this morning.
    out.push(materializeDay(startOfDay(Date.now())));
    for (let i = 1; i <= n; i++) {
      const dayStart = startOfDay(Date.now() - i * 86400e3);
      if (!reportsRepo.getDaily(ymd(dayStart))) out.push(materializeDay(dayStart));
    }
    return out;
  }

  /** 0–100 weighted health score with a per-factor breakdown. */
  function healthScore({ metrics, events, storage }) {
    const factors = [];
    const tempMax = metrics['temp.cpu']?.max;
    if (tempMax != null) {
      // Pi 5 throttles ~85°C; full marks under 60, zero by 85.
      const score = clamp(100 - Math.max(0, (tempMax - 60) / 25 * 100), 0, 100);
      factors.push({ name: 'Thermal headroom', score, weight: 0.25, detail: `peak ${tempMax.toFixed(1)}°C` });
    }
    const throttle = (events['throttle.active'] || 0) + (events['undervoltage'] || 0);
    factors.push({ name: 'Throttle / undervoltage', score: throttle === 0 ? 100 : clamp(100 - throttle * 20, 0, 100),
      weight: 0.2, detail: throttle === 0 ? 'none' : `${throttle} event(s)` });

    const cpuAvg = metrics['cpu.usage']?.avg;
    if (cpuAvg != null) factors.push({ name: 'CPU load', score: clamp(100 - cpuAvg, 0, 100), weight: 0.15, detail: `avg ${cpuAvg.toFixed(0)}%` });
    const memAvg = metrics['mem.percent']?.avg;
    if (memAvg != null) factors.push({ name: 'Memory', score: clamp(100 - memAvg, 0, 100), weight: 0.15, detail: `avg ${memAvg.toFixed(0)}%` });

    if (storage?.percentUsed != null) {
      factors.push({ name: 'Storage runway', score: clamp(100 - storage.percentUsed, 0, 100), weight: 0.15, detail: `${storage.percentUsed.toFixed(0)}% used` });
    }
    const alerts = (events['alert.fired'] || 0);
    factors.push({ name: 'Alert activity', score: alerts === 0 ? 100 : clamp(100 - alerts * 10, 0, 100), weight: 0.1, detail: alerts === 0 ? 'quiet' : `${alerts} fired` });

    const totalWeight = factors.reduce((a, f) => a + f.weight, 0) || 1;
    const overall = Math.round(factors.reduce((a, f) => a + f.score * f.weight, 0) / totalWeight);
    return { overall, factors };
  }

  /** Aggregate dailies into a weekly or monthly view. */
  function aggregate(period = 'week') {
    const days = period === 'month' ? 30 : 7;
    const dailies = reportsRepo.recentDays(days);
    if (!dailies.length) return { period, days: [], metrics: {}, health: null };
    const merged = {};
    for (const m of KEY_METRICS) {
      const mins = [], maxs = [], avgs = [];
      for (const d of dailies) {
        const dm = d.metrics?.[m];
        if (dm) { mins.push(dm.min); maxs.push(dm.max); avgs.push(dm.avg); }
      }
      if (avgs.length) merged[m] = {
        min: Math.min(...mins), max: Math.max(...maxs),
        avg: avgs.reduce((a, b) => a + b, 0) / avgs.length,
        trend: avgs.length > 1 ? avgs[avgs.length - 1] - avgs[0] : 0,
      };
    }
    const healthAvg = Math.round(dailies.reduce((a, d) => a + (d.health?.overall || 0), 0) / dailies.length);
    return { period, days: dailies, metrics: merged, health: { overall: healthAvg } };
  }

  return { materializeDay, backfill, aggregate, healthScore };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const ymd = (ts) => new Date(ts).toISOString().slice(0, 10);
