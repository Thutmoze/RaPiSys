/**
 * RaPiSys — setInterval for data polls.
 *
 * Every tick is a request to the Pi (or a peer through it). A plain interval
 * keeps firing while the tab is hidden, and stacks requests when the Pi is
 * slower than the interval (the 1 s Network poll on a busy node). This skips
 * ticks while the page is hidden and never starts a tick while the previous
 * one is still running; the next tick after the page is shown again refreshes.
 *
 * Returns a normal interval id: stop it with clearInterval as before. `fn`
 * should return its promise (or nothing, if it is synchronous) so the overlap
 * guard can see when it finishes.
 */
export function poll(fn, ms) {
  let busy = false;
  return setInterval(async () => {
    if (busy || document.hidden) return;
    busy = true;
    try { await fn(); } catch { /* the poll's own code reports errors */ } finally { busy = false; }
  }, ms);
}
