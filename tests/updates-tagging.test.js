/** RaPiSys — Raspberry Pi package classification (archive origin + rpt shape).
 *
 * Fixtures are real `apt-cache policy` output shapes and real candidate
 * versions captured from a Pi 5 running Trixie with both archives enabled.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// The agent refuses to load without a usable AGENT_SECRET — that guard is a
// real safety property, so we satisfy it here rather than relax it. Requiring
// the file does not bind the socket: listen() sits behind `require.main`.
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';

const { parsePolicyOrigins, isRptRebuild, isRpiArchiveHost, rpiTag } =
  require('../agent/rapisys-agent.cjs');

describe('isRptRebuild', () => {
  it('treats a small rpt counter as a Debian rebuild', () => {
    // Packages RPi merely recompiled — still Debian software.
    expect(isRptRebuild('153.0.4-1+rpt1')).toBe(true);          // firefox
    expect(isRptRebuild('5.82-1.1+rpt2')).toBe(true);           // bluez
    expect(isRptRebuild('26.2.0-1~bpo13+0~rpt3')).toBe(true);   // mesa
    expect(isRptRebuild('0.19.1-1+rpt5')).toBe(true);           // libwlroots
    expect(isRptRebuild('2.4.10-3+rpt2+deb13u2')).toBe(true);   // cups
    expect(isRptRebuild('2:21.1.16-1.3+rpt1+deb13u3')).toBe(true); // xserver
  });

  it('treats a dated rpt snapshot as Raspberry Pi is own fork', () => {
    // libcamera is maintained by RPi but rides Debian packaging.
    expect(isRptRebuild('0.7.2+rpt20260817-1')).toBe(false);
  });

  it('leaves plain upstream versions alone', () => {
    expect(isRptRebuild('1.7.0-1')).toBe(false);        // libpisp1
    expect(isRptRebuild('20260626-1')).toBe(false);      // raspi-utils
    expect(isRptRebuild('2.12.2')).toBe(false);          // rpi-connect
    expect(isRptRebuild('')).toBe(false);
    expect(isRptRebuild(null)).toBe(false);
  });
});

describe('isRpiArchiveHost', () => {
  it('matches the Raspberry Pi archives only', () => {
    expect(isRpiArchiveHost('archive.raspberrypi.com')).toBe(true);
    expect(isRpiArchiveHost('archive.raspberrypi.org')).toBe(true);
    expect(isRpiArchiveHost('deb.debian.org')).toBe(false);
    expect(isRpiArchiveHost('raspberrypi.com.evil.example')).toBe(false);
    expect(isRpiArchiveHost(undefined)).toBe(false);
  });
});

describe('parsePolicyOrigins', () => {
  const FIXTURE = `libpisp1:
  Installed: 1.6.0-1
  Candidate: 1.7.0-1
  Version table:
     1.7.0-1 500
        500 http://archive.raspberrypi.com/debian trixie/main arm64 Packages
 *** 1.6.0-1 500
        500 http://archive.raspberrypi.com/debian trixie/main arm64 Packages
        100 /var/lib/dpkg/status
libtiff6:
  Installed: 4.7.0-3+deb13u2
  Candidate: 4.7.0-3+deb13u3
  Version table:
     4.7.0-3+deb13u3 500
        500 http://deb.debian.org/debian-security trixie-security/main arm64 Packages
 *** 4.7.0-3+deb13u2 100
        100 /var/lib/dpkg/status
`;

  it('maps each package to the host serving its candidate', () => {
    const o = parsePolicyOrigins(FIXTURE);
    expect(o.libpisp1).toBe('archive.raspberrypi.com');
    expect(o.libtiff6).toBe('deb.debian.org');
  });

  it('ignores the installed entry when it differs from the candidate', () => {
    // libtiff6's installed version is dpkg-local; the candidate is Debian.
    // A naive parser that took the first source line would return undefined.
    expect(parsePolicyOrigins(FIXTURE).libtiff6).not.toBeUndefined();
  });

  it('yields no host for a package with only a local version', () => {
    const o = parsePolicyOrigins(`somepkg:
  Installed: 1.0
  Candidate: 1.0
  Version table:
 *** 1.0 100
        100 /var/lib/dpkg/status
`);
    expect(o.somepkg).toBeUndefined();
  });

  it('survives empty or malformed input', () => {
    expect(parsePolicyOrigins('')).toEqual({});
    expect(parsePolicyOrigins(null)).toEqual({});
    expect(parsePolicyOrigins('N: Unable to locate package foo')).toEqual({});
  });
});

describe('combined rule against real upgrade data', () => {
  // The decision the agent makes: archive origin AND not a rebuild.
  const rpiPkg = (host, version) => isRpiArchiveHost(host) && !isRptRebuild(version);

  it('tags Raspberry Pi is own packages', () => {
    expect(rpiPkg('archive.raspberrypi.com', '1.7.0-1')).toBe(true);       // libpisp1
    expect(rpiPkg('archive.raspberrypi.com', '20260626-1')).toBe(true);    // libgpiolib0
    expect(rpiPkg('archive.raspberrypi.com', '0.39')).toBe(true);          // pishutdown
    expect(rpiPkg('archive.raspberrypi.com', '0.7.2+rpt20260817-1')).toBe(true); // python3-libcamera
  });

  it('does not tag Debian software rebuilt for the Pi', () => {
    expect(rpiPkg('archive.raspberrypi.com', '153.0.4-1+rpt1')).toBe(false);      // firefox
    expect(rpiPkg('archive.raspberrypi.com', '26.2.0-1~bpo13+0~rpt3')).toBe(false); // mesa
  });

  it('does not tag anything from Debian', () => {
    expect(rpiPkg('deb.debian.org', '25.03.0-5+deb13u4')).toBe(false);     // poppler
  });
});

describe('rpiTag: firmware from Raspberry Pi carries the Pi tag too', () => {
  // Real packages on a Pi 5 (Trixie), 2026-10-09.
  const pi = (host, version) => isRpiArchiveHost(host) && !isRptRebuild(version);

  it('tags rpi-eeprom (Raspberry Pi archive, its own package) as well as firmware', () => {
    expect(rpiTag({ name: 'rpi-eeprom', description: 'Raspberry Pi 4/5 boot EEPROM updater', firmware: true,
      fromRpiArchive: pi('archive.raspberrypi.com', '28.33-1') })).toBe(true);
    expect(rpiTag({ name: 'raspi-firmware', description: 'Raspberry Pi family GPU firmware and bootloaders', firmware: true,
      fromRpiArchive: pi('archive.raspberrypi.com', '1:1.20260915-1') })).toBe(true);
  });

  it('still tags rpi-eeprom by name when the archive origin is unknown', () => {
    expect(rpiTag({ name: 'rpi-eeprom', firmware: true, fromRpiArchive: false })).toBe(true);
  });

  it('keeps Debian firmware rebuilt for the Pi firmware-only', () => {
    expect(rpiTag({ name: 'firmware-brcm80211', description: 'Binary firmware for Broadcom/Cypress 802.11 wireless cards (Raspberry Pi)',
      firmware: true, fromRpiArchive: pi('archive.raspberrypi.com', '1:20260519-1~bpo13+1+rpt1') })).toBe(false);
  });

  it('never tags kernels, even from the Raspberry Pi archive', () => {
    expect(rpiTag({ name: 'linux-image-rpi-2712', kernel: true, fromRpiArchive: true })).toBe(false);
  });

  it('keeps tagging Pi tooling by name or summary', () => {
    expect(rpiTag({ name: 'raspi-config' })).toBe(true);
    expect(rpiTag({ name: 'rc-gui', description: 'raspi-config GUI' })).toBe(true);
    expect(rpiTag({ name: 'nano', description: 'small editor' })).toBe(false);
  });
});
