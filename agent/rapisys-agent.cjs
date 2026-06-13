#!/usr/bin/env node
/**
 * rapisys-agent — RaPiSys host agent
 * ==================================
 * A small privileged helper that runs DIRECTLY ON THE PI (not in Docker) as
 * a systemd service. The dashboard container talks to it over a Unix socket
 * and can only invoke the FIXED ALLOWLIST of operations below — never
 * arbitrary shell. This is what lets the web container itself stay
 * unprivileged while still offering fan control, NAS mounts, apt updates
 * and firmware checks.
 *
 * Security model
 * --------------
 *  - Socket: /run/rapisys/agent.sock, mode 0660 root:rapisys
 *  - Every request must carry a valid HMAC-SHA256 over (id, op, params, ts)
 *    using the shared AGENT_SECRET from /etc/rapisys/agent.env (0600 root).
 *  - Requests older than 30 s are rejected (replay window).
 *  - All parameters are validated against strict patterns; commands run via
 *    execFile (no shell interpolation, ever).
 *  - Every operation is logged to journald.
 *
 * Zero npm dependencies — uses only Node built-ins, so it runs on the host's
 * Node (installed by deploy.sh) without a node_modules directory.
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const SOCKET_DIR = process.env.AGENT_SOCKET_DIR || '/run/rapisys';
const SOCKET_PATH = path.join(SOCKET_DIR, 'agent.sock');
const SECRET = process.env.AGENT_SECRET || '';
const SOCKET_GROUP = process.env.AGENT_SOCKET_GROUP || 'rapisys';
const REPLAY_WINDOW_MS = 30000;

if (SECRET.length < 32) {
  console.error('FATAL: AGENT_SECRET missing/too short (set in /etc/rapisys/agent.env)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) return reject(new Error(`${cmd} timed out`));
      // Many tools (apt, rpi-eeprom-update) use nonzero codes informatively;
      // callers inspect output, so resolve with everything.
      resolve({ code: err ? err.code ?? 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Stream a long-running command line by line to the client. */
function runStreaming(cmd, args, env, send) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    const onData = (buf) => buf.toString('utf-8').split('\n').forEach((l) => l && send(l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code }));
  });
}

const PKG_RE = /^[a-z0-9][a-z0-9+.:~-]*$/;           // Debian package name policy
const LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9._-]{1,253}$/;
const SHARE_RE = /^[A-Za-z0-9 _./-]{1,128}$/;
const MOUNT_BASE = '/mnt/rapisys';
const ALLOWED_CIFS_OPTS = new Set(['vers=1.0', 'vers=2.0', 'vers=2.1', 'vers=3.0', 'vers=3.1.1',
  'ro', 'rw', 'noperm', 'iocharset=utf8', 'file_mode=0664', 'dir_mode=0775',
  'nofail', '_netdev', 'soft', 'noserverino', 'nounix', 'nobrl',
  'sec=ntlm', 'sec=ntlmssp', 'sec=ntlmv2']);
// uid=/gid= carry dynamic numeric ids — validated by pattern, not enumeration.
const UIDGID_RE = /^(uid|gid)=\d{1,6}$/;
const ALLOWED_NFS_OPTS = new Set(['ro', 'rw', 'vers=3', 'vers=4', 'vers=4.1', 'vers=4.2',
  'nofail', '_netdev', 'soft', 'timeo=100', 'retrans=2', 'noatime']);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** systemd unit name for a mountpoint: /mnt/rapisys/nas1 -> mnt-rapisys-nas1.mount */
function unitNameFor(mountpoint) {
  return mountpoint.replace(/^\//, '').replace(/-/g, '\\x2d').replace(/\//g, '-');
}

function findFanSysfs() {
  // Pi 5 official cooler: /sys/devices/platform/cooling_fan/hwmon/hwmonN/{fan1_input,pwm1,pwm1_enable}
  const base = '/sys/devices/platform/cooling_fan/hwmon';
  try {
    const entries = fs.readdirSync(base).filter((d) => d.startsWith('hwmon'));
    for (const e of entries) {
      const dir = path.join(base, e);
      if (fs.existsSync(path.join(dir, 'pwm1'))) return dir;
    }
  } catch { /* no cooler */ }
  return null;
}

// vcgencmd subcommands the dashboard may read (read-only telemetry).
const VC_ALLOWED = new Set([
  'get_throttled', 'measure_temp', 'measure_volts core', 'measure_clock arm',
  'pmic_read_adc', 'get_config arm_freq', 'measure_volts sdram_c',
]);

// ---------------------------------------------------------------------------
// Operation allowlist — THE ONLY THINGS THIS AGENT WILL EVER DO
// ---------------------------------------------------------------------------

/** CPU thermal zone directory (governs the Pi 5 fan curve), or null. */
function findCpuThermalZone() {
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      const dir = `/sys/class/thermal/${z}`;
      try {
        const type = fs.readFileSync(path.join(dir, 'type'), 'utf-8').trim();
        if (/cpu|soc/i.test(type)) return dir;
      } catch { /* next */ }
    }
  } catch { /* no thermal */ }
  return null;
}

const OPS = {
  async 'ping'() {
    return { pong: true, version: '1.0.0', pid: process.pid };
  },

  // ---- vcgencmd telemetry (read-only) -------------------------------------
  async 'vc.read'({ cmd }) {
    assert(VC_ALLOWED.has(cmd), `vcgencmd subcommand not allowed: ${cmd}`);
    const { stdout } = await run('vcgencmd', cmd.split(' '), 3000);
    return { output: stdout.trim() };
  },

  // ---- Fan control ---------------------------------------------------------
  async 'fan.get'() {
    const dir = findFanSysfs();
    if (!dir) return { present: false };
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf-8').trim(); } catch { return null; } };
    // Truthful mode: the thermal zone decides auto vs manual on Pi 5.
    let mode = read('pwm1_enable');
    const zone = findCpuThermalZone();
    if (zone) {
      try {
        mode = fs.readFileSync(path.join(zone, 'mode'), 'utf-8').trim() === 'enabled' ? '2' : '1';
      } catch { /* keep pwm1_enable value */ }
    }
    return {
      present: true,
      rpm: parseInt(read('fan1_input') || '0', 10),
      pwm: parseInt(read('pwm1') || '0', 10),          // 0–255
      mode,                                            // '2'=auto '1'=manual
    };
  },
  async 'fan.setMode'({ mode }) {
    assert(['auto', 'manual'].includes(mode), 'mode must be auto|manual');
    const dir = findFanSysfs();
    assert(dir, 'no active cooler detected');
    // Pi 5 reality: the pwm-fan driver has NO automatic mode — the fan
    // curve is the THERMAL SUBSYSTEM's job. Auto/manual is controlled by
    // the thermal zone's mode file: 'enabled' = governor drives the fan
    // (auto), 'disabled' = governor hands off (manual). pwm1_enable is
    // only touched as a best-effort for other coolers.
    const zone = findCpuThermalZone();
    if (mode === 'auto') {
      if (zone) fs.writeFileSync(path.join(zone, 'mode'), 'enabled');
      try { fs.writeFileSync(path.join(dir, 'pwm1_enable'), '2'); } catch { /* pwm-fan: no auto */ }
    } else {
      if (zone) fs.writeFileSync(path.join(zone, 'mode'), 'disabled');
      try { fs.writeFileSync(path.join(dir, 'pwm1_enable'), '1'); } catch { /* tolerated */ }
    }
    return { ok: true, mode };
  },
  async 'fan.setDuty'({ percent }) {
    const p = Number(percent);
    assert(Number.isFinite(p) && p >= 0 && p <= 100, 'percent must be 0–100');
    const dir = findFanSysfs();
    assert(dir, 'no active cooler detected');
    // Manual duty: take the governor off the fan first, or it overrides
    // our pwm on the next trip-point change.
    const zone = findCpuThermalZone();
    if (zone) fs.writeFileSync(path.join(zone, 'mode'), 'disabled');
    try { fs.writeFileSync(path.join(dir, 'pwm1_enable'), '1'); } catch { /* tolerated */ }
    fs.writeFileSync(path.join(dir, 'pwm1'), String(Math.round((p / 100) * 255)));
    return { ok: true, percent: p };
  },

  // ---- Login sessions via systemd-logind (Trixie dropped utmp) ------------
  async 'sessions.list'() {
    // --no-legend table is stable across systemd versions; `-o json` is not
    // supported for list-sessions on all builds (silently prints the table).
    const ls = await run('loginctl', ['list-sessions', '--no-legend'], 5000);
    const ids = ls.stdout.split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((x) => /^\d+$/.test(x));
    const sessions = [];
    for (const id of ids.slice(0, 50)) {
      const det = await run('loginctl', ['show-session', id,
        '-p', 'Name', '-p', 'RemoteHost', '-p', 'Remote', '-p', 'TTY',
        '-p', 'Timestamp', '-p', 'Class', '-p', 'Type', '-p', 'Leader'], 3000);
      const p = Object.fromEntries(det.stdout.trim().split('\n')
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
      if (p.Class !== 'user') continue;
      // Timestamp: "Thu 2026-06-11 16:34:41 +03" -> ISO-ish for Date.parse
      let startedAt = null;
      const m = (p.Timestamp || '').match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2,4}|\w+)$/);
      if (m) {
        const tz = /^[+-]/.test(m[3]) ? (m[3].length === 3 ? m[3] + ':00' : m[3].slice(0, 3) + ':' + m[3].slice(3)) : 'Z';
        const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
        if (!Number.isNaN(t)) startedAt = t;
      }
      sessions.push({
        id, user: p.Name || '', remote: p.Remote === 'yes',
        host: p.RemoteHost || '', tty: p.TTY || '', type: p.Type || '',
        startedAt, pid: Number(p.Leader) || null,
      });
    }
    return { sessions };
  },

  async 'sessions.terminate'({ id }) {
    assert(/^\d{1,8}$/.test(String(id)), 'invalid session id');
    const r = await run('loginctl', ['terminate-session', String(id)], 5000);
    assert(r.code === 0, `terminate failed: ${r.stderr || r.stdout || 'unknown'}`);
    return { ok: true, id: String(id) };
  },

  // ---- Tailscale (read-only status; binary lives on the host) -------------
  async 'ts.status'() {
    const r = await run('tailscale', ['status', '--json'], 8000)
      .catch(() => ({ code: 127, stdout: '' }));
    if (r.code !== 0 || !r.stdout.trim()) throw new Error('tailscale not installed or not running');
    return { output: r.stdout };
  },

  // ---- NAS mounts (systemd .mount/.automount units, never fstab) ----------
  async 'nas.status'({ mountpoint }) {
    assert(mountpoint.startsWith(MOUNT_BASE), `mountpoint must be under ${MOUNT_BASE}`);
    const { stdout } = await run('findmnt', ['-J', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS', mountpoint], 5000)
      .catch(() => ({ stdout: '' }));
    let info = null;
    try { info = JSON.parse(stdout).filesystems?.[0] || null; } catch { /* not mounted */ }
    let df = null;
    if (info) {
      const r = await run('df', ['-B1', '--output=size,used,avail', mountpoint], 5000);
      const lines = r.stdout.trim().split('\n');
      if (lines.length >= 2) {
        const [size, used, avail] = lines[1].trim().split(/\s+/).map(Number);
        df = { size, used, avail };
      }
    }
    return { mounted: !!info, info, df };
  },

  async 'nas.mount'({ label, proto, host, share, mountpoint, options = [], username, password }) {
    assert(LABEL_RE.test(label), 'invalid label');
    assert(['cifs', 'nfs'].includes(proto), 'proto must be cifs|nfs');
    assert(HOST_RE.test(host), 'invalid host');
    assert(SHARE_RE.test(share), 'invalid share');
    assert(mountpoint === path.posix.normalize(mountpoint) && mountpoint.startsWith(MOUNT_BASE + '/'),
      `mountpoint must be under ${MOUNT_BASE}`);
    const allowed = proto === 'cifs' ? ALLOWED_CIFS_OPTS : ALLOWED_NFS_OPTS;
    for (const o of options) {
      assert(allowed.has(o) || (proto === 'cifs' && UIDGID_RE.test(o)), `mount option not allowed: ${o}`);
    }

    // A stale .automount from a previous install leaves a dead autofs trap
    // at the mountpoint (ENODEV/ENOTCONN on any access). Clear it first.
    try {
      fs.mkdirSync(mountpoint, { recursive: true });
    } catch (err) {
      if (!['ENODEV', 'ENOTCONN', 'EEXIST'].includes(err.code)) throw err;
      const unit = unitNameFor(mountpoint);
      await run('systemctl', ['disable', '--now', `${unit}.automount`]).catch(() => {});
      await run('systemctl', ['stop', `${unit}.mount`]).catch(() => {});
      await run('umount', ['-l', mountpoint]).catch(() => {});
      fs.mkdirSync(mountpoint, { recursive: true });
    }
    const what = proto === 'cifs'
      ? `//${host}/${share.replace(/^\//, '')}`
      : `${host}:${share.startsWith('/') ? share : '/' + share}`;

    let optList = [...options, 'nofail', '_netdev'];
    if (proto === 'cifs') {
      // Credentials file readable by root only — never on the mount cmdline.
      assert(typeof username === 'string' && username.length <= 64, 'invalid username');
      const credDir = '/etc/rapisys/creds';
      fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
      const credFile = path.join(credDir, `${label}.cred`);
      fs.writeFileSync(credFile, `username=${username}\npassword=${password || ''}\n`, { mode: 0o600 });
      optList.push(`credentials=${credFile}`);
    }

    const unit = unitNameFor(mountpoint);
    const mountUnit = `[Unit]
Description=RaPiSys NAS mount ${label}
After=network-online.target
Wants=network-online.target

[Mount]
What=${what}
Where=${mountpoint}
Type=${proto}
Options=${[...new Set(optList)].join(',')}
TimeoutSec=30

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(`/etc/systemd/system/${unit}.mount`, mountUnit);
    // No .automount indirection anymore: autofs traps cannot trigger
    // across mount namespaces — the container saw ELOOP instead of the
    // share until something host-side touched the path. A DB directory
    // is hot anyway, so we enable the .mount directly (boots via its
    // own [Install] section) and remove any automount from older code.
    try { fs.unlinkSync(`/etc/systemd/system/${unit}.automount`); } catch { /* none */ }
    await run('systemctl', ['disable', '--now', `${unit}.automount`]).catch(() => {});
    await run('systemctl', ['daemon-reload']);
    await run('systemctl', ['reset-failed', `${unit}.mount`]).catch(() => {});
    await run('systemctl', ['enable', `${unit}.mount`]).catch(() => {});
    // RESTART (not start): if the share is already mounted with stale
    // options, plain start is a no-op and new options never apply.
    const started = await run('systemctl', ['restart', `${unit}.mount`], 45000);
    if (started.code !== 0) {
      const st = await run('journalctl', ['-u', `${unit}.mount`, '-n', '10', '--no-pager', '-o', 'cat']);
      const detail = (st.stdout.match(/mount error[^\n]*|mount\.cifs[^\n]*|mount\.nfs[^\n]*|Server[^\n]*/g) || [])
        .slice(-2).join(' — ');
      await run('systemctl', ['disable', '--now', `${unit}.mount`]).catch(() => {});
      throw new Error(`mount failed: ${detail || 'see journalctl -u ' + unit + '.mount'}`);
    }
    return OPS['nas.status']({ mountpoint });
  },

  async 'nas.unmount'({ mountpoint, removeUnit = false }) {
    assert(mountpoint.startsWith(MOUNT_BASE + '/'), `mountpoint must be under ${MOUNT_BASE}`);
    const unit = unitNameFor(mountpoint);
    await run('systemctl', ['disable', '--now', `${unit}.automount`]).catch(() => {});
    await run('systemctl', ['stop', `${unit}.mount`]).catch(() => {});
    if (removeUnit) {
      for (const ext of ['.mount', '.automount']) {
        try { fs.unlinkSync(`/etc/systemd/system/${unit}${ext}`); } catch { /* gone */ }
      }
      await run('systemctl', ['daemon-reload']);
    }
    return { ok: true };
  },

  // ---- APT / firmware updates ----------------------------------------------
  async 'apt.update'(_, send) {
    const r = await runStreaming('apt-get', ['update'], { DEBIAN_FRONTEND: 'noninteractive' }, send);
    return { code: r.code };
  },
  async 'apt.listUpgradable'() {
    const { stdout } = await run('apt', ['list', '--upgradable'], 60000);
    // Security tagging via simulated dist-upgrade against -security pockets.
    const sim = await run('apt-get', ['-s', 'dist-upgrade'], 60000);
    const securityPkgs = new Set(
      [...sim.stdout.matchAll(/^Inst (\S+) .*-security/gm)].map((m) => m[1])
    );
    const updates = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([^/]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s+([^\]]+)\])?/);
      if (!m) continue;
      updates.push({
        package: m[1], pocket: m[2], candidate: m[3], installed: m[4] || null,
        security: securityPkgs.has(m[1]),
        kernel: /^linux-image|^linux-headers|^raspberrypi-kernel/.test(m[1]),
      });
    }
    return { updates };
  },
  async 'apt.changelog'({ pkg }) {
    assert(PKG_RE.test(pkg), 'invalid package name');
    const { stdout } = await run('apt-get', ['changelog', '--print-uris', pkg], 15000).catch(() => ({ stdout: '' }));
    const r = await run('apt', ['changelog', pkg], 20000).catch(() => ({ stdout: '' }));
    const text = (r.stdout || stdout || '').split('\n').slice(0, 60).join('\n');
    return { changelog: text || 'No changelog available.' };
  },
  async 'apt.upgrade'({ packages, simulate = false, full = false }, send) {
    let args;
    const env = { DEBIAN_FRONTEND: 'noninteractive' };
    if (full) {
      // Full upgrade — UI requires an explicit typed confirmation before
      // this op is ever invoked (user decision: user chooses).
      args = ['dist-upgrade', '-y', ...(simulate ? ['-s'] : [])];
    } else {
      assert(Array.isArray(packages) && packages.length >= 1 && packages.length <= 100, 'packages required');
      for (const p of packages) assert(PKG_RE.test(p), `invalid package name: ${p}`);
      args = ['install', '--only-upgrade', '-y', ...(simulate ? ['-s'] : []), ...packages];
    }
    const r = await runStreaming('apt-get', args, env, send);
    return { code: r.code, simulated: simulate };
  },
  async 'eeprom.check'() {
    const r = await run('rpi-eeprom-update', [], 20000).catch((e) => ({ code: 1, stdout: '', stderr: e.message }));
    return { output: (r.stdout + r.stderr).trim(), updateAvailable: /UPDATE AVAILABLE/i.test(r.stdout) };
  },
  async 'eeprom.update'(_, send) {
    const r = await runStreaming('rpi-eeprom-update', ['-a'], {}, send);
    return { code: r.code, note: 'firmware staged; takes effect on next reboot' };
  },

  // ---- System --------------------------------------------------------------
  async 'sys.reboot'({ confirm }) {
    assert(confirm === 'REBOOT', 'confirmation token required');
    setTimeout(() => run('systemctl', ['reboot']), 1500);
    return { ok: true, rebootingIn: '1.5s' };
  },
};

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

function verify({ id, op, params, ts, hmac }) {
  if (!id || !op || typeof ts !== 'number') return false;
  if (Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) return false;
  const expect = crypto.createHmac('sha256', SECRET)
    .update(`${id}.${op}.${JSON.stringify(params || {})}.${ts}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(hmac || '')));
  } catch { return false; }
}

fs.mkdirSync(SOCKET_DIR, { recursive: true });
try { fs.unlinkSync(SOCKET_PATH); } catch { /* fresh */ }

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', async (chunk) => {
    buf += chunk.toString('utf-8');
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    let req;
    try { req = JSON.parse(line); } catch { sock.end(); return; }

    const reply = (obj) => sock.write(JSON.stringify({ id: req.id, ...obj }) + '\n');
    if (!verify(req)) {
      console.warn(`[agent] DENIED unauthenticated request op=${req.op}`);
      reply({ ok: false, error: 'authentication failed' });
      return sock.end();
    }
    const handler = OPS[req.op];
    if (!handler) {
      console.warn(`[agent] DENIED non-allowlisted op=${req.op}`);
      reply({ ok: false, error: `operation not allowed: ${req.op}` });
      return sock.end();
    }
    console.log(`[agent] op=${req.op} params=${JSON.stringify(req.params || {})}`);
    try {
      const result = await handler(req.params || {}, (streamLine) => reply({ stream: streamLine }));
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
    sock.end();
  });
  sock.on('error', () => {});
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o660);
  // Best effort: give the docker-side group access to the socket.
  run('chgrp', [SOCKET_GROUP, SOCKET_PATH]).catch(() => {});
  console.log(`[agent] rapisys-agent listening on ${SOCKET_PATH}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
