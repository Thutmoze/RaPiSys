/** RaPiSys — frontend poll helper: no ticks while hidden, no overlapping ticks. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { poll } from '../src/modules/poll.js';

beforeEach(() => { vi.useFakeTimers(); globalThis.document = { hidden: false }; });
afterEach(() => { vi.useRealTimers(); delete globalThis.document; });

describe('poll', () => {
  it('skips ticks while the page is hidden', async () => {
    const fn = vi.fn(async () => {});
    const id = poll(fn, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    document.hidden = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    document.hidden = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    clearInterval(id);
  });

  it('never starts a tick while the previous one is still running', async () => {
    let release;
    const fn = vi.fn(() => new Promise((r) => { release = r; }));
    const id = poll(fn, 1000);
    await vi.advanceTimersByTimeAsync(5000);          // slow Pi: first call still pending
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    clearInterval(id);
  });

  it('keeps polling after a tick throws', async () => {
    const fn = vi.fn(async () => { throw new Error('offline'); });
    const id = poll(fn, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    clearInterval(id);
  });
});
