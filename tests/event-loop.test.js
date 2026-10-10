/** RaPiSys — event-loop delay monitor (health signal for blocking work). */
import { describe, it, expect } from 'vitest';
import { createEventLoopMonitor } from '../server/core/event-loop.js';

describe('event-loop monitor', () => {
  it('sees a synchronous block on the main thread', async () => {
    const mon = createEventLoopMonitor({ resolutionMs: 10, windowMs: 60e3 });
    await new Promise((r) => setTimeout(r, 50));
    const until = Date.now() + 120;
    while (Date.now() < until) { /* block the loop like execSync would */ }
    await new Promise((r) => setTimeout(r, 30));
    const s = mon.status();
    mon.stop();
    expect(s.current.maxMs).toBeGreaterThanOrEqual(80);
    expect(s.last).toBeNull();
    expect(s.resolutionMs).toBe(10);
  });
});
