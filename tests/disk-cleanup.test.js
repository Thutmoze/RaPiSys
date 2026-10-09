/** RaPiSys — disk cleanup guards and estimates.
 *
 * Fixtures are captured from XRPi (Docker 29, kernel 6.18.50+rpt-rpi-2712)
 * on 2026-10-09: `apt-get -s autoremove` wanted the old 6.18.34 kernel plus
 * five superseded libraries, and the blanket linux-image guard made the whole
 * category fail on every run.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { autoremoveProtected, parseDockerSize, dockerDangling, staleTmpArgs } = require('../agent/rapisys-agent.cjs');

// apt-get -s autoremove | grep ^Remv (package names only)
const XRPI_REMV = [
  'chromium-sandbox', 'libneatvnc0', 'libaml0t64', 'libfuse2t64', 'libwlroots-0.19',
  'linux-headers-6.18.34+rpt-rpi-2712', 'linux-image-6.18.34+rpt-rpi-2712', 'linux-base-6.18.34+rpt-rpi-2712',
  'linux-headers-6.18.34+rpt-rpi-v8', 'linux-image-6.18.34+rpt-rpi-v8', 'linux-base-6.18.34+rpt-rpi-v8',
  'linux-headers-6.18.34+rpt-common-rpi', 'linux-kbuild-6.18.34+rpt',
];

describe('autoremoveProtected', () => {
  it('lets an old, non-running kernel go', () => {
    expect(autoremoveProtected(XRPI_REMV, '6.18.50+rpt-rpi-2712\n')).toEqual([]);
  });

  it('protects every flavour of the running kernel version', () => {
    const remv = ['linux-image-6.18.50+rpt-rpi-2712', 'linux-image-6.18.50+rpt-rpi-v8',
      'linux-headers-6.18.50+rpt-common-rpi', 'linux-kbuild-6.18.50+rpt', 'libfoo1'];
    expect(autoremoveProtected(remv, '6.18.50+rpt-rpi-2712')).toEqual(remv.slice(0, 4));
  });

  it('does not confuse 6.18.5 with 6.18.50', () => {
    expect(autoremoveProtected(['linux-image-6.18.5+rpt-rpi-2712'], '6.18.50+rpt-rpi-2712')).toEqual([]);
  });

  it('always protects meta packages, firmware and boot', () => {
    const remv = ['linux-image-rpi-2712', 'linux-headers-rpi-v8', 'rpi-eeprom', 'raspi-firmware',
      'firmware-brcm80211', 'initramfs-tools', 'systemd', 'udev', 'raspberrypi-sys-mods'];
    expect(autoremoveProtected(remv, '6.18.50+rpt-rpi-2712')).toEqual(remv);
    expect(autoremoveProtected(['systemd-timesyncd', 'libudev1'], '6.18.50+rpt-rpi-2712')).toEqual([]);
  });

  it('fails closed on every kernel package when the release is unknown', () => {
    expect(autoremoveProtected(XRPI_REMV, '')).toEqual([
      'linux-headers-6.18.34+rpt-rpi-2712', 'linux-image-6.18.34+rpt-rpi-2712',
      'linux-headers-6.18.34+rpt-rpi-v8', 'linux-image-6.18.34+rpt-rpi-v8',
      'linux-headers-6.18.34+rpt-common-rpi', 'linux-kbuild-6.18.34+rpt',
    ]);
  });
});

describe('docker prune estimate', () => {
  it('parses docker sizes', () => {
    expect(parseDockerSize('632.6MB')).toBe(632600000);
    expect(parseDockerSize('399.7kB')).toBe(399700);
    expect(parseDockerSize('10.67GB')).toBe(10670000000);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('')).toBe(0);
  });

  // docker system df -v --format '{{json .Images}}' (trimmed to the fields used)
  const XRPI_IMAGES = JSON.stringify([
    { Containers: '1', Repository: 'papyrusiq', Tag: 'latest', UniqueSize: '894.8MB' },
    { Containers: '0', Repository: '<none>', Tag: '<none>', UniqueSize: '152.1MB' },
    { Containers: '0', Repository: '<none>', Tag: '<none>', UniqueSize: '265MB' },
    { Containers: '0', Repository: '<none>', Tag: '<none>', UniqueSize: '632.6MB' },
    { Containers: '0', Repository: 'node', Tag: '22-alpine', UniqueSize: '399.7kB' },
    { Containers: '1', Repository: '<none>', Tag: '<none>', UniqueSize: '300MB' },
    { Containers: '0', Repository: 'rapisys', Tag: 'snap-20260823-175716', UniqueSize: '120MB' },
  ]);

  it('counts only unused untagged images, unique layers only', () => {
    expect(dockerDangling(XRPI_IMAGES)).toEqual({ bytes: 152100000 + 265000000 + 632600000, count: 3 });
  });

  it('survives junk output', () => {
    expect(dockerDangling('')).toEqual({ bytes: 0, count: 0 });
    expect(dockerDangling('Error: daemon not running')).toEqual({ bytes: 0, count: 0 });
  });
});

describe('staleTmpArgs', () => {
  it('requires both atime and mtime age and excludes open inodes on that filesystem', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-tmp-'));
    const dev = String(fs.statSync(dir).dev);
    const args = staleTmpArgs(dir, new Map([[dev, new Set(['11', '22'])], ['999', new Set(['33'])]]));
    expect(args).toEqual([dir, '-xdev', '-type', 'f', '-atime', '+7', '-mtime', '+7', '!', '-inum', '11', '!', '-inum', '22']);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns null for a missing directory', () => {
    expect(staleTmpArgs('/definitely/not/here', new Map())).toBeNull();
  });
});
