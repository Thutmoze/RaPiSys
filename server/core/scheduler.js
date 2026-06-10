/**
 * RaPiSys — Scheduler
 * -------------------
 * Minimal interval scheduler for background collection jobs.
 *  - overlap guard: a job never runs twice concurrently
 *  - jitter: spreads job start times so collectors don't all fire together
 *  - error backoff: a repeatedly failing job slows down instead of log-spamming
 *  - introspection: job list + last run/err surfaced by /api/health/deep
 */

export function createScheduler() {
  const jobs = new Map();

  function register(name, intervalMs, fn, { jitter = true, runNow = false } = {}) {
    if (jobs.has(name)) throw new Error(`job '${name}' already registered`);
    const job = {
      name, intervalMs, fn,
      running: false, timer: null, failures: 0,
      lastRun: null, lastError: null, lastDurationMs: null,
    };

    const tick = async () => {
      if (job.running) return;        // overlap guard
      job.running = true;
      const t0 = Date.now();
      try {
        await fn();
        job.failures = 0;
        job.lastError = null;
      } catch (err) {
        job.failures++;
        job.lastError = err.message;
        if (job.failures <= 3 || job.failures % 10 === 0) {
          console.error(`[scheduler] job '${name}' failed (${job.failures}x): ${err.message}`);
        }
      } finally {
        job.lastRun = t0;
        job.lastDurationMs = Date.now() - t0;
        job.running = false;
        // Exponential backoff capped at 8x the normal interval.
        const backoff = Math.min(2 ** Math.min(job.failures, 3), 8);
        job.timer = setTimeout(tick, intervalMs * (job.failures ? backoff : 1));
        if (job.timer.unref) job.timer.unref();
      }
    };

    const initialDelay = runNow ? 0 : (jitter ? Math.random() * Math.min(intervalMs, 5000) : 0);
    job.timer = setTimeout(tick, initialDelay);
    if (job.timer.unref) job.timer.unref();
    jobs.set(name, job);
    return job;
  }

  function stop() {
    for (const job of jobs.values()) clearTimeout(job.timer);
    jobs.clear();
  }

  function status() {
    return [...jobs.values()].map(({ name, intervalMs, lastRun, lastError, lastDurationMs, failures }) =>
      ({ name, intervalMs, lastRun, lastError, lastDurationMs, failures }));
  }

  return { register, stop, status };
}
