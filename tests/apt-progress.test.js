import { describe, it, expect } from 'vitest';
import { createAptProgress } from '../src/modules/apt-progress.js';

const feed = (p, lines) => { let s; for (const l of lines) s = p.line(l); return s; };

describe('apt upgrade progress', () => {
  it('has no percent before apt prints its plan', () => {
    const p = createAptProgress();
    expect(feed(p, ['Reading package lists...', 'Calculating upgrade...'])).toMatchObject({ pct: null, phase: null });
  });

  it('counts downloads into the first 30%', () => {
    const p = createAptProgress();
    feed(p, ['3 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.']);
    expect(p.state()).toMatchObject({ pct: 0, phase: 'Preparing' });
    expect(p.line('Get:2 http://deb.debian.org/debian trixie/main arm64 foo arm64 1.0 [10 kB]'))
      .toEqual({ pct: 15, phase: 'Downloading', done: 2, of: 4 });
  });

  it('spreads unpack, configure and remove over the remaining 70%', () => {
    const p = createAptProgress();
    feed(p, ['2 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.', 'Get:1 x', 'Get:2 x']);
    expect(p.line('Removing old (1.0) ...')).toEqual({ pct: 44, phase: 'Removing', done: 1, of: 1 });
    expect(p.line('Unpacking a (2.0) over (1.0) ...')).toEqual({ pct: 58, phase: 'Unpacking', done: 1, of: 2 });
    p.line('Unpacking b (2.0) over (1.0) ...');
    expect(p.line('Setting up a (2.0) ...')).toEqual({ pct: 86, phase: 'Configuring', done: 1, of: 2 });
    expect(p.line('Setting up b (2.0) ...').pct).toBe(99);
    expect(p.line('Processing triggers for man-db (2.13) ...')).toMatchObject({ pct: 99, phase: 'Finishing up' });
  });

  it('jumps past the download share when packages were already cached', () => {
    const p = createAptProgress();
    feed(p, ['1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.']);
    expect(p.line('Unpacking a (2.0) over (1.0) ...').pct).toBe(65);
  });

  it('never goes backwards or past 99 on unexpected extra lines', () => {
    const p = createAptProgress();
    feed(p, ['1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', 'Unpacking a ...', 'Setting up a ...']);
    const s = feed(p, ['Setting up extra ...', 'Get:1 late', 'Unpacking extra ...']);
    expect(s.pct).toBe(99);
    expect(s.done).toBe(1);
  });

  it('stays without a percent when there is nothing to do', () => {
    const p = createAptProgress();
    expect(p.line('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.').pct).toBeNull();
  });
});
