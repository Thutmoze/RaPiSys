/** RaPiSys — binNMU (+bN) upgrades carry no new changelog entries.
 *
 * Debian's build daemons produce binary-only rebuilds versioned +b1, +b2, …
 * with no source change, so they get no source-changelog entry. The newest
 * entry in such a changelog is the version ALREADY INSTALLED, and its CVEs
 * and urgency must not be attributed to the pending upgrade.
 *
 * Fixture is the real dirmngr case: installed 2.4.7-21+deb13u1+b3, candidate
 * 2.4.7-21+deb13u1+b4, newest changelog entry 2.4.7-21+deb13u1 (urgency=high,
 * CVE-2025-68973) — a fix that is already on the machine.
 */
import { describe, it, expect } from 'vitest';
import { newerThanInstalledWindow } from '../server/collectors/updates.js';

const DIRMNGR = `gnupg2 (2.4.7-21+deb13u1) trixie; urgency=high

  * gpg: Fix possible memory corruption in the armor parser (CVE-2025-68973).
  * gpg: Do not use a default when asking for another output filename.

 -- Andreas Metzler <ametzler@debian.org>  Thu, 01 Jan 2026 06:46:01 +0100

gnupg2 (2.4.7-21) unstable; urgency=medium

  * Bump standards version.

 -- Andreas Metzler <ametzler@debian.org>  Sat, 15 Nov 2025 10:00:00 +0100
`;

describe('binNMU upgrades', () => {
  it('yields an empty window when the newest entry is already installed', () => {
    const head = newerThanInstalledWindow(DIRMNGR, '2.4.7-21+deb13u1+b3', '2.4.7-21+deb13u1+b4');
    expect(head.trim()).toBe('');
  });

  it('does not attribute the installed entry is CVEs or urgency to the rebuild', () => {
    const head = newerThanInstalledWindow(DIRMNGR, '2.4.7-21+deb13u1+b3', '2.4.7-21+deb13u1+b4');
    expect(head.match(/CVE-\d{4}-\d+/g)).toBeNull();
    expect(/urgency=high/.test(head)).toBe(false);
  });

  it('still surfaces a genuinely newer entry', () => {
    // Same changelog, but the box is a release behind: +deb13u1 IS the upgrade.
    const head = newerThanInstalledWindow(DIRMNGR, '2.4.7-21', '2.4.7-21+deb13u1');
    expect(head).toContain('CVE-2025-68973');
    expect(head).toContain('urgency=high');
    // …and the older entry the machine already has is excluded.
    expect(head).not.toContain('Bump standards version');
  });

  it('falls back to the whole changelog when the installed version is unknown', () => {
    expect(newerThanInstalledWindow(DIRMNGR, null, '2.4.7-21+deb13u1')).toBe(DIRMNGR);
  });
});
