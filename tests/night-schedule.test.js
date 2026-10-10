/** RaPiSys — Pironman night-light schedule transitions, including restarts. */
import { describe, it, expect } from 'vitest';
import { nightAction } from '../server/services/night-schedule.js';

describe('night-light schedule', () => {
  it('switches off entering the window and restores leaving it', () => {
    expect(nightAction(false, true, false)).toBe('off');
    expect(nightAction(true, false, true)).toBe('restore');
  });

  it('does nothing without a transition', () => {
    expect(nightAction(false, false, false)).toBe('none');
    expect(nightAction(true, true, true)).toBe('none');
  });

  it('a restart outside the window leaves the lights as the user set them', () => {
    expect(nightAction(null, false, false)).toBe('none');
  });

  it('a restart outside the window after a mid-window shutdown restores', () => {
    expect(nightAction(null, false, true)).toBe('restore');
  });

  it('a restart inside the window does not snapshot the already-off lights', () => {
    expect(nightAction(null, true, true)).toBe('none');
    expect(nightAction(null, true, false)).toBe('off');
  });
});
