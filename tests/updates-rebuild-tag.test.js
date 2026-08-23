/** RaPiSys — binNMU rebuild detection (the "rebuild" tag). */
import { describe, it, expect } from 'vitest';
import { isBinNmuRebuild } from '../server/collectors/updates.js';

describe('isBinNmuRebuild', () => {
  it('flags a bumped binNMU counter', () => {
    // The real dirmngr/GnuPG case: whole set rebuilt against a new soname.
    expect(isBinNmuRebuild('2.4.7-21+deb13u1+b3', '2.4.7-21+deb13u1+b4')).toBe(true);
  });

  it('flags a first rebuild of a package that had no suffix', () => {
    expect(isBinNmuRebuild('1.0-1', '1.0-1+b1')).toBe(true);
  });

  it('does not flag a real version change', () => {
    expect(isBinNmuRebuild('2.4.7-20', '2.4.7-21+deb13u1')).toBe(false);
    expect(isBinNmuRebuild('1.6.0-1', '1.7.0-1')).toBe(false);
  });

  it('does not flag a version change that merely also carries a suffix', () => {
    // Upstream moved AND it was rebuilt — that is not a pure rebuild.
    expect(isBinNmuRebuild('2.4.7-21+deb13u1+b3', '2.4.8-1+b1')).toBe(false);
  });

  it('does not treat Raspberry Pi rpt rebuilds as binNMUs', () => {
    // +rptN carries real source patches, so it is a different animal.
    expect(isBinNmuRebuild('153.0-1+rpt1', '153.0.4-1+rpt1')).toBe(false);
    expect(isBinNmuRebuild('25.0.7-2+rpt4+deb13u1', '26.2.0-1~bpo13+0~rpt3')).toBe(false);
  });

  it('handles missing, equal or malformed input', () => {
    expect(isBinNmuRebuild(null, '1.0-1+b1')).toBe(false);
    expect(isBinNmuRebuild('1.0-1+b1', null)).toBe(false);
    expect(isBinNmuRebuild('1.0-1+b1', '1.0-1+b1')).toBe(false);
    expect(isBinNmuRebuild('', '')).toBe(false);
  });

  it('does not flag a downgrade-shaped pair as a rebuild it should act on', () => {
    // +b4 -> +b3 still differs only by the counter; the tag describes the
    // KIND of change, and apt would never offer this as an upgrade anyway.
    expect(isBinNmuRebuild('2.4.7-21+deb13u1+b4', '2.4.7-21+deb13u1+b3')).toBe(true);
  });
});
