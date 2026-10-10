/**
 * RaPiSys — recent HTTP requests, for stall attribution.
 *
 * Keeps the last few hundred requests (method, path, start, end) in memory so
 * an event-loop stall can be matched to the request that was being served.
 * Paths only: no query strings, headers or bodies.
 */
const MAX = 300;
const recent = [];
const inFlight = new Set();

export function trackRequests(req, res, next) {
  const entry = { method: req.method, path: req.path, start: Date.now(), end: null };
  inFlight.add(entry);
  res.on('close', () => {
    entry.end = Date.now();
    inFlight.delete(entry);
    recent.push(entry);
    if (recent.length > MAX) recent.shift();
  });
  next();
}

/** "METHOD /path" of requests in flight at any point in [fromTs, toTs]. */
export function requestsBetween(fromTs, toTs) {
  const hit = (e) => e.start <= toTs && (e.end == null || e.end >= fromTs);
  const out = new Set();
  for (const e of [...inFlight, ...recent]) if (hit(e)) out.add(`${e.method} ${e.path}`);
  return [...out];
}
