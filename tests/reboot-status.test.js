/** RaPiSys — reboot-required detection (agent helpers + server summary).
 *
 * Fixtures are shapes captured from a Pi 5 on Trixie: kernel names from
 * /boot, a /proc/<pid>/maps excerpt, and cgroup v2 lines for a system
 * service, the desktop session and a container.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { summarizeRebootStatus, createRebootStatus } from '../server/services/reboot-status.js';
import { needsReboot, describePlan } from '../server/collectors/updates.js';
import { flagWording } from '../server/core/metric-catalog.js';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { newestKernel, parseDeletedLibs, classifyCgroup, libOwnerPattern, libOwner, parseDpkgSearch, parseSystemctlShow } = require('../agent/rapisys-agent.cjs');

describe('newestKernel', () => {
  const boot = ['vmlinuz-6.18.34+rpt-rpi-2712', 'vmlinuz-6.18.34+rpt-rpi-v8',
    'vmlinuz-6.18.39+rpt-rpi-2712', 'vmlinuz-6.18.39+rpt-rpi-v8'];

  it('reports the running kernel when it is the newest installed', () => {
    expect(newestKernel('6.18.39+rpt-rpi-2712', boot)).toBe('6.18.39+rpt-rpi-2712');
  });

  it('finds a newer kernel of the same flavour', () => {
    expect(newestKernel('6.18.39+rpt-rpi-2712', [...boot, 'vmlinuz-6.18.50+rpt-rpi-2712']))
      .toBe('6.18.50+rpt-rpi-2712');
  });

  it('ignores the other flavour installed alongside (Pi 5 never boots -v8)', () => {
    expect(newestKernel('6.18.39+rpt-rpi-2712', [...boot, 'vmlinuz-6.18.50+rpt-rpi-v8']))
      .toBe('6.18.39+rpt-rpi-2712');
  });

  it('compares numerically, not as text', () => {
    expect(newestKernel('6.9.1+rpt-rpi-2712', ['vmlinuz-6.10.0+rpt-rpi-2712'])).toBe('6.10.0+rpt-rpi-2712');
  });

  it('ignores non-kernel names and copes with an empty /boot', () => {
    expect(newestKernel('6.18.39+rpt-rpi-2712', ['config-6.18.50+rpt-rpi-2712', 'initrd.img'])).toBe('6.18.39+rpt-rpi-2712');
    expect(newestKernel('6.18.39+rpt-rpi-2712', [])).toBe('6.18.39+rpt-rpi-2712');
  });
});

describe('parseDeletedLibs', () => {
  const maps = [
    '7f8a000000-7f8a1c0000 r-xp 00000000 103:02 1311 /usr/lib/aarch64-linux-gnu/libssl.so.3 (deleted)',
    '7f8a1c0000-7f8a1d0000 r--p 001c0000 103:02 1311 /usr/lib/aarch64-linux-gnu/libssl.so.3 (deleted)',
    '7f8b000000-7f8b010000 r-xp 00000000 103:02 2210 /usr/lib/aarch64-linux-gnu/wf-panel-pi/libbatt.so (deleted)',
    '7f8c000000-7f8c010000 r-xp 00000000 103:02 4001 /usr/lib/aarch64-linux-gnu/libc.so.6',
    '7f8d000000-7f8d100000 rw-s 00000000 00:01 9001 /memfd:pipewire-memfd (deleted)',
    '7f8e000000-7f8e100000 rw-s 00000000 00:1a 9002 /dev/shm/wayland.mozilla.ipc.0 (deleted)',
    '7f8f000000-7f8f100000 r--p 00000000 103:02 9003 /usr/share/icons/hicolor/icon-theme.cache (deleted)',
  ].join('\n');

  it('returns replaced shared libraries once each', () => {
    expect(parseDeletedLibs(maps)).toEqual([
      '/usr/lib/aarch64-linux-gnu/libssl.so.3',
      '/usr/lib/aarch64-linux-gnu/wf-panel-pi/libbatt.so',
    ]);
  });

  it('ignores memfd, shared memory and non-library files', () => {
    expect(parseDeletedLibs(maps).some((p) => /memfd|shm|icon/.test(p))).toBe(false);
  });

  it('returns nothing for clean or empty maps', () => {
    expect(parseDeletedLibs('7f8c000000-7f8c010000 r-xp 00000000 103:02 4001 /usr/lib/aarch64-linux-gnu/libc.so.6')).toEqual([]);
    expect(parseDeletedLibs('')).toEqual([]);
  });
});

describe('libOwnerPattern / libOwner', () => {
  // Real `dpkg -S` output for these globs on the Pi, after libxkbcommon0
  // went 1.7.0 -> 1.13.1 and renamed libxkbcommon.so.0.0.0 to .so.0.13.1.
  const dpkgOut = [
    'libxkbcommon0:arm64: /usr/lib/aarch64-linux-gnu/libxkbcommon.so.0.13.1',
    'libxkbcommon0:arm64: /usr/lib/aarch64-linux-gnu/libxkbcommon.so.0',
    'wfplug-batt: /usr/lib/aarch64-linux-gnu/wf-panel-pi/libbatt.so',
    'libssl3t64:arm64: /usr/lib/aarch64-linux-gnu/libssl.so.3',
    'libssl-dev:arm64: /usr/lib/aarch64-linux-gnu/libssl.so',
  ].join('\n');

  it('builds a soname glob that survives a renamed file', () => {
    expect(libOwnerPattern('/usr/lib/aarch64-linux-gnu/libxkbcommon.so.0.0.0')).toBe('*/libxkbcommon.so.0*');
    expect(libOwnerPattern('/usr/lib/aarch64-linux-gnu/libssl.so.3')).toBe('*/libssl.so.3*');
    expect(libOwnerPattern('/usr/lib/aarch64-linux-gnu/wf-panel-pi/libbatt.so')).toBe('*/libbatt.so*');
  });

  it('finds the owner of a library whose old filename no longer exists', () => {
    expect(libOwner('/usr/lib/aarch64-linux-gnu/libxkbcommon.so.0.0.0', dpkgOut)).toBe('libxkbcommon0');
  });

  it('finds unversioned plugins and exact matches, never the -dev package', () => {
    expect(libOwner('/usr/lib/aarch64-linux-gnu/wf-panel-pi/libbatt.so', dpkgOut)).toBe('wfplug-batt');
    expect(libOwner('/usr/lib/aarch64-linux-gnu/libssl.so.3', dpkgOut)).toBe('libssl3t64');
  });

  it('does not confuse similarly named libraries', () => {
    expect(libOwner('/usr/lib/aarch64-linux-gnu/libxkbcommon-x11.so.0.0.0', dpkgOut)).toBeNull();
    expect(libOwner('/usr/lib/aarch64-linux-gnu/libfoo.so.1', '')).toBeNull();
  });
});

describe('program descriptions', () => {
  it('maps binaries to packages from dpkg -S', () => {
    expect(parseDpkgSearch([
      'labwc: /usr/bin/labwc',
      'openssh-server: /usr/sbin/sshd',
      'mate-polkit:arm64: /usr/libexec/polkit-mate-authentication-agent-1',
      'dpkg-query: no path found matching pattern /opt/thing/bin/x',
    ].join('\n'))).toEqual({
      '/usr/bin/labwc': 'labwc',
      '/usr/sbin/sshd': 'openssh-server',
      '/usr/libexec/polkit-mate-authentication-agent-1': 'mate-polkit',
    });
  });

  it('reads unit descriptions from systemctl show blocks', () => {
    const out = 'Id=ssh.service\nDescription=OpenBSD Secure Shell server\n\nId=docker.service\nDescription=Docker Application Container Engine\n';
    expect(parseSystemctlShow(out)).toEqual({
      'ssh.service': 'OpenBSD Secure Shell server',
      'docker.service': 'Docker Application Container Engine',
    });
    expect(parseSystemctlShow('')).toEqual({});
  });

  it('passes the description through to the page', () => {
    const s = summarizeRebootStatus({ bootTime: 1, kernel: {}, procs: [
      { name: 'labwc', kind: 'desktop', files: ['/usr/lib/aarch64-linux-gnu/libxkbcommon.so.0.0.0'], packages: ['libxkbcommon0'], description: 'window-stacking Wayland compositor' },
      { name: 'mystery', kind: 'process', files: [], packages: [] },
    ] });
    expect(s.libs.procs.map((p) => p.description)).toEqual(['window-stacking Wayland compositor', null]);
  });
});

describe('classifyCgroup', () => {
  it('names the systemd unit of a service', () => {
    expect(classifyCgroup('0::/system.slice/ssh.service\n')).toEqual({ kind: 'service', unit: 'ssh.service' });
  });
  it('treats the user session as desktop', () => {
    expect(classifyCgroup('0::/user.slice/user-1000.slice/session-1.scope')).toEqual({ kind: 'desktop', unit: null });
  });
  it('recognises containers so they can be skipped', () => {
    expect(classifyCgroup('0::/system.slice/docker-b90a550c8a402d6a8cb99ecc674701b4669c5b21874c3d183a78de23acc9c7e5.scope').kind).toBe('container');
  });
  it('falls back to a plain process', () => {
    expect(classifyCgroup('0::/init.scope')).toEqual({ kind: 'process', unit: null });
    expect(classifyCgroup('')).toEqual({ kind: 'process', unit: null });
  });
});

describe('summarizeRebootStatus', () => {
  const boot = Date.parse('2026-10-03T20:26:16+03:00');
  const clean = { bootTime: boot, kernel: { running: '6.18.39+rpt-rpi-2712', latest: '6.18.39+rpt-rpi-2712' },
    firmware: null, eeprom: null, rebootRequiredFile: null, procs: [] };

  it('is "none" when nothing is waiting', () => {
    const s = summarizeRebootStatus(clean);
    expect(s.level).toBe('none');
    expect(s.reasons).toEqual([]);
    expect(s.since).toBeNull();
    expect(s.kernel).toBe('6.18.39+rpt-rpi-2712');
  });

  it('is "reboot" for a newer installed kernel, with the history-based start time', () => {
    const history = [
      { ts: boot + 7200e3, result: 'success', package: 'linux-image-rpi-2712' },
      { ts: boot + 7200e3, result: 'success', package: 'openssl' },
      { ts: boot + 3600e3, result: 'failed', package: 'labwc' },
      { ts: boot - 3600e3, result: 'success', package: 'before-this-boot' },
    ];
    const s = summarizeRebootStatus({ ...clean, kernel: { running: '6.18.39+rpt-rpi-2712', latest: '6.18.50+rpt-rpi-2712' } }, history);
    expect(s.level).toBe('reboot');
    expect(s.reasons).toEqual([{ kind: 'kernel', running: '6.18.39+rpt-rpi-2712', latest: '6.18.50+rpt-rpi-2712' }]);
    expect(s.since).toBe(boot + 7200e3);
    expect(s.installed).toBe(2);   // successful installs since boot only
  });

  it('is "reboot" for firmware or a staged bootloader', () => {
    expect(summarizeRebootStatus({ ...clean, firmware: { version: '1:1.20260915-1', changedAt: boot + 60e3 } }).reasons[0])
      .toEqual({ kind: 'firmware', version: '1:1.20260915-1', at: boot + 60e3 });
    const s = summarizeRebootStatus({ ...clean, eeprom: { stagedAt: boot + 90e3 } });
    expect(s.level).toBe('reboot');
    expect(s.since).toBe(boot + 90e3);
  });

  it('keeps /run/reboot-required packages that no other reason covers', () => {
    const s = summarizeRebootStatus({ ...clean,
      kernel: { running: '6.18.39+rpt-rpi-2712', latest: '6.18.50+rpt-rpi-2712' },
      rebootRequiredFile: { pkgs: ['linux-image-6.18.50+rpt-rpi-2712', 'libc6'] } });
    expect(s.reasons.map((r) => r.kind)).toEqual(['kernel', 'packages']);
    expect(s.reasons[1].pkgs).toEqual(['libc6']);
    // A bare flag with no package list still counts.
    expect(summarizeRebootStatus({ ...clean, rebootRequiredFile: { pkgs: [] } }).level).toBe('reboot');
  });

  it('is "restart" when only programs hold replaced libraries', () => {
    const s = summarizeRebootStatus({ ...clean, procs: [
      { name: 'sshd', unit: 'ssh.service', kind: 'service', pids: [1319], files: ['/usr/lib/aarch64-linux-gnu/libssl.so.3'], packages: ['libssl3t64'] },
      { name: 'wf-panel-pi', unit: null, kind: 'desktop', pids: [1601], files: ['/usr/lib/aarch64-linux-gnu/wf-panel-pi/libbatt.so'], packages: ['wfplug-batt'] },
    ] });
    expect(s.level).toBe('restart');
    expect(s.libs.count).toBe(2);
    expect(s.libs.packages).toEqual(['libssl3t64', 'wfplug-batt']);
  });

  it('is "reboot" when PID 1 runs a replaced library (libc6 upgraded)', () => {
    const s = summarizeRebootStatus({ ...clean, procsTotal: 74, procs: [
      { name: 'systemd', kind: 'process', pids: [1], files: ['/usr/lib/aarch64-linux-gnu/libc.so.6'], packages: ['libc6'] },
      { name: 'sshd', unit: 'ssh.service', kind: 'service', pids: [1319], files: ['/usr/lib/aarch64-linux-gnu/libc.so.6'], packages: ['libc6'] },
    ] });
    expect(s.level).toBe('reboot');
    expect(s.reasons).toEqual([{ kind: 'system', packages: ['libc6'] }]);
  });

  it('reports the real program count when the agent capped the list', () => {
    const procs = Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, pids: [100 + i], files: [], packages: ['libc6'] }));
    const s = summarizeRebootStatus({ ...clean, procs, procsTotal: 74 });
    expect(s.libs.count).toBe(74);
    expect(s.libs.shown).toBe(60);
    // Older agents send no total: fall back to what was listed.
    expect(summarizeRebootStatus({ ...clean, procs: procs.slice(0, 3) }).libs.count).toBe(3);
  });

  it('handles a missing agent result', () => {
    expect(summarizeRebootStatus(null).level).toBe('none');
  });
});

describe('createRebootStatus', () => {
  const raw = { bootTime: 1, kernel: { running: '6.18.39+rpt-rpi-2712', latest: '6.18.50+rpt-rpi-2712' }, procs: [] };

  it('caches the host scan and re-reads on force', async () => {
    const agent = vi.fn().mockResolvedValue(raw);
    const rs = createRebootStatus({ updatesRepo: { recent: () => ({ rows: [] }) }, agent, configured: () => true });
    expect((await rs.get()).level).toBe('reboot');
    await rs.get();
    expect(agent).toHaveBeenCalledTimes(1);
    await rs.get({ force: true });
    expect(agent).toHaveBeenCalledTimes(2);
    expect(agent.mock.calls[0][0]).toBe('sys.rebootStatus');
  });

  it('feeds the sampler 1/0 without blocking', async () => {
    const agent = vi.fn().mockResolvedValue(raw);
    const rs = createRebootStatus({ updatesRepo: null, agent, configured: () => true });
    expect(rs.metricValue()).toBeNull();          // first sample: scan starts in background
    await rs.get();
    expect(rs.metricValue()).toBe(1);
  });

  it('reports nothing pending without an agent', async () => {
    const agent = vi.fn();
    const rs = createRebootStatus({ agent, configured: () => false });
    expect((await rs.get()).level).toBe('none');
    expect(agent).not.toHaveBeenCalled();
  });

  it('reboots through the confirmed agent op', async () => {
    const agent = vi.fn().mockResolvedValue({ ok: true });
    await createRebootStatus({ agent, configured: () => true }).reboot();
    expect(agent).toHaveBeenCalledWith('sys.reboot', { confirm: 'REBOOT' }, null, 10000);
  });
});

describe('needsReboot (pre-install tag)', () => {
  it('tags kernel, GPU firmware and bootloader', () => {
    for (const p of ['linux-image-rpi-2712', 'linux-image-6.18.50+rpt-rpi-2712', 'raspi-firmware', 'rpi-eeprom'])
      expect(needsReboot(p)).toBe(true);
  });
  it('does not tag libraries PID 1 re-executes onto, ordinary packages or look-alikes', () => {
    // libc6/systemd/dbus postinst re-exec PID 1; what remains is "restart recommended".
    for (const p of ['libc6', 'systemd', 'dbus', 'linux-headers-rpi-2712', 'linux-libc-dev', 'wf-panel-pi', 'libssl3t64', 'systemd-timesyncd', 'rpi-eeprom-tools', 'libc6-dev', '', null])
      expect(needsReboot(p)).toBe(false);
  });
  it('is carried on upgrade-plan rows', () => {
    const rows = describePlan([{ name: 'linux-image-rpi-2712', action: 'upgrade' }, { name: 'openssl', action: 'upgrade' }], {}, ['openssl']);
    expect(rows.map((r) => r.reboot)).toEqual([true, false]);
  });
});

describe('flagWording', () => {
  it('words the reboot metric as a sentence', () => {
    expect(flagWording('updates.reboot_required', 1)).toMatch(/reboot is required/i);
    expect(flagWording('updates.reboot_required', 0)).toMatch(/no reboot is pending/i);
  });
  it('leaves ordinary metrics alone', () => {
    expect(flagWording('temp.cpu', 80)).toBeNull();
  });
});
