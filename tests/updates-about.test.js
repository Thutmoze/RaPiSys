/** RaPiSys — Updates "About" panel facts.
 *
 * The agent returns raw `apt-cache show`, `apt-cache rdepends --installed`,
 * `apt-mark showmanual` and the candidate's archive host; the server turns
 * them into the panel payload.
 */
import { describe, it, expect } from 'vitest';
import { parsePackageAbout, parseLongDescription } from '../server/collectors/updates.js';

const SHOW = `Package: libgnutls30t64
Version: 3.8.9-3
Installed-Size: 2953
Maintainer: Debian GnuTLS Maintainers <pkg-gnutls-maint@lists.alioth.debian.org>
Architecture: arm64
Source: gnutls28 (3.8.9-3)
Depends: libc6 (>= 2.38), libgmp10 (>= 2:6.3.0+dfsg)
Description: GNU TLS library - main runtime library
 GnuTLS is a portable library which implements the Transport Layer
 Security (TLS 1.0, 1.1, 1.2, 1.3) protocols.
 .
 GnuTLS features support for:
  - certificate path validation, as well as DANE and trust on first use.
  - public key methods, including RSA and Elliptic curves, as well as
    password and key authentication methods.
 .
 This package contains the main runtime library.
Homepage: https://www.gnutls.org/
Description-md5: 0ebc6e9f4e5f1b2a3c4d5e6f7a8b9c0d
Section: libs
Priority: optional

Package: libgnutls30t64
Version: 3.8.9-2
Description: older stanza must be ignored
`;

const RDEP = `libgnutls30t64
Reverse Depends:
  wget
 |libcurl3t64-gnutls
  wget
  libgnutls30t64:armhf
  network-manager
`;

describe('parseLongDescription', () => {
  it('splits paragraphs on " ." and joins wrapped lines', () => {
    expect(parseLongDescription(['One line', 'wrapped.', '.', 'Second.'])).toEqual(['One line wrapped.', 'Second.']);
  });
  it('collects bullets and continues them on deeper-indented lines', () => {
    expect(parseLongDescription(['Intro:', ' * first', '   still first', ' * second', 'After.']))
      .toEqual(['Intro:', ['first still first', 'second'], 'After.']);
  });
  it('returns nothing for an empty description', () => {
    expect(parseLongDescription([])).toEqual([]);
  });
});

describe('parsePackageAbout', () => {
  const d = parsePackageAbout('libgnutls30t64', {
    show: SHOW, rdepends: RDEP, manual: 'curl\nnetwork-manager\nwget:arm64\n', origin: 'deb.debian.org',
  });

  it('reads the candidate stanza only', () => {
    expect(d.version).toBe('3.8.9-3');
    expect(d.summary).toBe('GNU TLS library - main runtime library');
  });
  it('parses the long description into paragraphs and bullets', () => {
    expect(d.description).toEqual([
      'GnuTLS is a portable library which implements the Transport Layer Security (TLS 1.0, 1.1, 1.2, 1.3) protocols.',
      'GnuTLS features support for:',
      ['certificate path validation, as well as DANE and trust on first use.',
        'public key methods, including RSA and Elliptic curves, as well as password and key authentication methods.'],
      'This package contains the main runtime library.',
    ]);
  });
  it('extracts facts', () => {
    expect(d).toMatchObject({
      source: 'gnutls28', section: 'libs', priority: 'optional', essential: false,
      maintainer: 'Debian GnuTLS Maintainers', installedSize: 2953 * 1024,
      homepage: 'https://www.gnutls.org/', origin: 'debian', manual: false,
    });
  });
  it('dedupes reverse deps, strips "|" and arch, and drops itself', () => {
    expect(d.requiredBy).toEqual(['wget', 'libcurl3t64-gnutls', 'network-manager']);
    expect(d.requiredByCount).toBe(3);
  });
  it('names the manually installed packages that need it', () => {
    expect(d.manualDependents).toEqual(['wget', 'network-manager']);
  });

  it('marks manual and essential packages, and the Raspberry Pi archive', () => {
    const e = parsePackageAbout('libc6', {
      show: 'Package: libc6\nVersion: 2.41-12\nEssential: yes\nPriority: required\nDescription: GNU C Library\n',
      manual: 'libc6\n', origin: 'archive.raspberrypi.com',
    });
    expect(e).toMatchObject({ essential: true, manual: true, origin: 'raspberrypi', source: 'libc6', requiredByCount: 0 });
  });
  it('drops a non-http homepage', () => {
    const e = parsePackageAbout('x', { show: 'Package: x\nHomepage: javascript:alert(1)\nDescription: x\n' });
    expect(e.homepage).toBeNull();
  });
  it('reads translated Description-en records', () => {
    const e = parsePackageAbout('x', { show: 'Package: x\nDescription-en: short\n long text\n' });
    expect(e.summary).toBe('short');
    expect(e.description).toEqual(['long text']);
  });
  it('returns null when apt has no record', () => {
    expect(parsePackageAbout('nope', { show: '' })).toBeNull();
  });
  it('labels other archives by host', () => {
    expect(parsePackageAbout('docker-ce', { show: 'Package: docker-ce\nDescription: Docker\n', origin: 'download.docker.com' }))
      .toMatchObject({ origin: 'other', originHost: 'download.docker.com' });
  });
});
