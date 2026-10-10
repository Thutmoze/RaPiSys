/**
 * RaPiSys — event-loop delay, as a health signal.
 *
 * Synchronous work on the main thread (execSync in the legacy collector, sync
 * file access, large SQL) delays every request, timer and socket. This keeps
 * a rolling window of loop delay so /api/health/deep shows it, and so a
 * change meant to remove blocking can be measured before and after.
 */
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'perf_hooks';

const WINDOW_MS = 5 * 60e3;
const ms = (ns) => Math.round((ns / 1e6) * 10) / 10;

export function createEventLoopMonitor({ resolutionMs = 20, windowMs = WINDOW_MS } = {}) {
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  let windowStart = Date.now();
  let last = null;   // the last complete window

  function snapshot(start, end) {
    return {
      windowMs: end - start,
      meanMs: ms(h.mean), p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max),
    };
  }
  const timer = setInterval(() => {
    const now = Date.now();
    last = snapshot(windowStart, now);
    h.reset();
    windowStart = now;
  }, windowMs);
  timer.unref?.();

  /** { current, last }: the window in progress and the last complete one (null at first). */
  function status() {
    return { resolutionMs, current: snapshot(windowStart, Date.now()), last };
  }
  function stop() { clearInterval(timer); h.disable(); }
  return { status, stop };
}

/**
 * Stall detector: a short timer that notices when it fired late by more than
 * `thresholdMs`, then asks `attribute(from, to)` what was running in that
 * span. Garbage-collection pauses in the span are added too (`gcMs`), since
 * they block the thread without belonging to any job or request. Keeps the
 * last few stalls for /api/health/deep and logs each one.
 */
const GC_KINDS = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weak' };

export function createStallDetector({ thresholdMs = 200, intervalMs = 50, keep = 20, attribute = () => ({}), log = console.warn } = {}) {
  const stalls = [];
  let last = Date.now();
  const gcs = [];   // recent GC pauses: { start, end (epoch ms), kind }
  let gcObserver = null;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const start = performance.timeOrigin + e.startTime;
        gcs.push({ start, end: start + e.duration, kind: GC_KINDS[e.detail?.kind] || 'gc' });
      }
      while (gcs.length > 200) gcs.shift();
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { /* no GC timing: stalls are still recorded */ }
  const gcIn = (from, to) => {
    const hit = gcs.filter((g) => g.start <= to && g.end >= from);
    if (!hit.length) return {};
    const byKind = {};
    for (const g of hit) byKind[g.kind] = Math.round(((byKind[g.kind] || 0) + g.end - g.start) * 10) / 10;
    return { gcMs: byKind };
  };
  const timer = setInterval(() => {
    const now = Date.now();
    const blockedMs = now - last - intervalMs;
    if (blockedMs > thresholdMs) {
      const from = last + intervalMs;
      // GC entries reach the observer asynchronously: record a moment later.
      setTimeout(() => {
        let who = {};
        try { who = { ...(attribute(from, now) || {}), ...gcIn(from, now) }; } catch { /* attribution is best-effort */ }
        stalls.push({ at: new Date(from).toISOString(), blockedMs, ...who });
        if (stalls.length > keep) stalls.shift();
        log(`[event-loop] blocked ${blockedMs} ms; ${JSON.stringify(who)}`);
      }, 250).unref?.();
    }
    last = now;
  }, intervalMs);
  timer.unref?.();
  return { stalls: () => [...stalls], stop: () => { clearInterval(timer); gcObserver?.disconnect(); } };
}
