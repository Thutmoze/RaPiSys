/**
 * RaPiSys — event-loop delay, as a health signal.
 *
 * Synchronous work on the main thread (execSync in the legacy collector, sync
 * file access, large SQL) delays every request, timer and socket. This keeps
 * a rolling window of loop delay so /api/health/deep shows it, and so a
 * change meant to remove blocking can be measured before and after.
 */
import { monitorEventLoopDelay } from 'perf_hooks';

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
