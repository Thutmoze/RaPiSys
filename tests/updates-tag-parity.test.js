/**
 * RaPiSys — the agent (Available Updates) and the server (Update History)
 * tag packages with separate copies of the same rules. They must agree on
 * every case, or the same upgrade is tagged differently on the two pages.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { tagging } from '../server/repositories/updates.js';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const agent = require('../agent/rapisys-agent.cjs');

// The agent's pipeline for one Available Updates entry (rapisys-agent.cjs,
// apt list parsing): kernel and firmware flags, then rpiTag with the origin.
const AGENT_FIRMWARE_RE = /^(rpi-eeprom|rpieeprom|rpifw|librpieeprom|librpifw|raspi-firmware|raspberrypi-bootloader|firmware-)/;
function agentTags({ name, description = '', origin = null, version = '' }) {
  const kernel = agent.isKernelPkg(name);
  const firmware = AGENT_FIRMWARE_RE.test(name) || /firmware/i.test(description);
  const rpi = agent.rpiTag({
    name, description, kernel, firmware,
    fromRpiArchive: agent.isRpiArchiveHost(origin) && !agent.isRptRebuild(version),
    rpiArchive: origin ? agent.isRpiArchiveHost(origin) : null,
  });
  return { kernel, firmware, rpi };
}
function serverTags({ name, description = '', origin = null, version = '' }) {
  const kernel = tagging.isKernelPkg(name);
  const firmware = tagging.isFirmwarePkg(name, description);
  const rpi = tagging.isRpiPkg(name, kernel, firmware, description, origin, version);
  return { kernel, firmware, rpi };
}

const RPI = 'archive.raspberrypi.com';
const DEB = 'deb.debian.org';
const CASES = [
  // kernels: by origin when known, by name otherwise
  { name: 'linux-image-rpi-2712', version: '1:6.12.47-1+rpt1', origin: RPI },
  { name: 'linux-image-rpi-2712', version: '1:6.12.47-1+rpt1' },
  { name: 'linux-headers-6.12.47+rpt-rpi-2712', version: '1:6.12.47-1+rpt1', origin: RPI },
  { name: 'linux-image-amd64', version: '6.12.48-1', origin: DEB },
  { name: 'linux-libc-dev', version: '6.12.48-1', origin: DEB },
  { name: 'linux-kbuild-6.12.47+rpt', version: '1:6.12.47-1+rpt1' },
  { name: 'raspberrypi-kernel', version: '1:1.20250430-1' },
  // Raspberry Pi firmware: both tags
  { name: 'rpi-eeprom', description: 'Raspberry Pi 4/5 boot EEPROM updater', version: '28.2-1', origin: RPI },
  { name: 'raspi-firmware', description: 'Raspberry Pi family GPU firmware and bootloaders', version: '1:1.20250430-4', origin: RPI },
  // generic firmware: never Pi by summary
  { name: 'firmware-brcm80211', description: 'Binary firmware for Broadcom/Cypress 802.11 wireless cards (for Raspberry Pi)', version: '1:20240709-2~bpo12+1+rpt3', origin: RPI },
  { name: 'firmware-misc-nonfree', description: 'Binary firmware for various drivers', version: '20250410-2', origin: DEB },
  // Pi tools: by name, by summary, by archive (not for +rptN rebuilds)
  { name: 'raspi-config', description: 'Raspberry Pi configuration tool', version: '20250707', origin: RPI },
  { name: 'rpicam-apps', description: 'rpicam-apps', version: '1.9.0-1', origin: RPI },
  { name: 'rc-gui', description: 'Raspberry Pi configuration tool (GUI)', version: '1.80' },
  { name: 'libpisp1', description: 'PiSP library', version: '1.2.1-1', origin: RPI },
  { name: 'libpisp1', description: 'PiSP library', version: '1.2.1-1' },
  { name: 'libcamera0.5', description: 'complex camera support library', version: '0.5.1+rpt20250722-1', origin: RPI },
  { name: 'mesa-vulkan-drivers', description: 'Mesa Vulkan graphics drivers', version: '25.0.7-2+rpt3', origin: RPI },
  { name: 'chromium', description: 'web browser', version: '1:140.0.7339.80-1~deb12u1+rpt20250910', origin: RPI },
  // plain Debian packages
  { name: 'openssl', description: 'Secure Sockets Layer toolkit', version: '3.5.1-1+deb13u1', origin: DEB },
  { name: 'curl', description: 'command line tool for transferring data with URL syntax', version: '8.14.1-2', origin: DEB },
  { name: 'python3-gpiozero', description: 'Simple API for controlling devices attached to a Pi\'s GPIO pins', version: '2.0.1-0+rpt1' },
];

describe('agent and server package tagging agree', () => {
  for (const c of CASES) {
    it(`${c.name} ${c.version}${c.origin ? ` from ${c.origin}` : ' (no origin)'}`, () => {
      expect(serverTags(c)).toEqual(agentTags(c));
    });
  }

  it('the agent and server rule helpers agree on their own', () => {
    for (const h of ['archive.raspberrypi.com', 'archive.raspberrypi.org', 'deb.debian.org', 'evilraspberrypi.com', null]) {
      expect(tagging.isRpiArchiveHost(h)).toBe(agent.isRpiArchiveHost(h));
    }
    for (const v of ['1:6.12.47-1+rpt1', '0.5.1+rpt20250722-1', '25.0.7-2~rpt3', '3.5.1-1+deb13u1', '']) {
      expect(tagging.isRptRebuild(v)).toBe(agent.isRptRebuild(v));
    }
  });
});
