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
const http = require('http');
const https = require('https');
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

function run(cmd, args, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: opts.cwd }, (err, stdout, stderr) => {
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
  // ---- software inventory (read-only host inspection) ---------------------
  async 'inventory.packages'() {
    // dpkg-query: name, version, status, size, priority, essential, summary.
    const fmt = '${Package}\t${Version}\t${Status}\t${Installed-Size}\t${Priority}\t${Essential}\t${Section}\t${binary:Summary}\n';
    const r = await run('dpkg-query', ['-W', `-f=${fmt}`], 15000).catch(() => ({ code: 1, stdout: '' }));
    if (r.code !== 0) return { packages: [] };
    const packages = [];
    for (const line of r.stdout.split('\n')) {
      const [name, version, status, size, priority, essential, section, summary] = line.split('\t');
      if (!name || !/installed/.test(status || '')) continue;
      let installedAt = null;
      try { installedAt = Math.floor(fs.statSync(`/var/lib/dpkg/info/${name}.list`).mtimeMs); } catch { /* */ }
      packages.push({ name, version: version || '', installedAt, sizeKB: Number(size) || 0,
        priority: priority || '', essential: essential === 'yes', section: section || '', description: summary || '' });
    }
    return { packages };
  },

  // ---- simulate + perform package removal (destructive, guarded) ----------
  async 'inventory.removeSimulate'({ name }) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,128}$/.test(name), 'invalid package name');
    // refuse essential/required outright
    const meta = await run('dpkg-query', ['-W', '-f=${Essential}\t${Priority}', name], 5000).catch(() => ({ stdout: '' }));
    const [essential, priority] = (meta.stdout || '').split('\t');
    if (essential === 'yes' || priority === 'required') {
      return { allowed: false, reason: `${name} is ${essential === 'yes' ? 'an essential' : 'a required'} package and cannot be removed from here.` };
    }
    // simulate to capture the full cascade
    const sim = await run('apt-get', ['-s', 'remove', name], 20000).catch((e) => ({ code: 1, stdout: '', stderr: String(e) }));
    const removed = [];
    for (const line of (sim.stdout || '').split('\n')) {
      const m = line.match(/^Remv\s+(\S+)/);
      if (m) removed.push(m[1]);
    }
    // guard: if the cascade would pull in protected packages, flag them
    const protectedHits = [];
    for (const pkg of removed) {
      const pm = await run('dpkg-query', ['-W', '-f=${Essential}\t${Priority}', pkg], 3000).catch(() => ({ stdout: '' }));
      const [e2, p2] = (pm.stdout || '').split('\t');
      if (e2 === 'yes' || p2 === 'required' || p2 === 'important') protectedHits.push(pkg);
    }
    return { allowed: protectedHits.length === 0, removed, protectedHits,
      reason: protectedHits.length ? `Removal would also remove protected package(s): ${protectedHits.join(', ')}` : null };
  },

  async 'inventory.remove'({ name, confirm }) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,128}$/.test(name), 'invalid package name');
    assert(confirm === name, 'confirmation mismatch');
    // re-run the guard server-side (never trust the client)
    const guard = await this['inventory.removeSimulate']({ name });
    assert(guard.allowed, guard.reason || 'removal not allowed');
    const r = await run('apt-get', ['remove', '-y', name], 120000);
    return { ok: r.code === 0, log: (r.stdout || '') + (r.stderr || ''), removed: guard.removed };
  },

  async 'inventory.serviceControl'({ name, action }) {
    assert(/^[a-zA-Z0-9@._\\-]{1,128}$/.test(name), 'invalid service');
    assert(['stop', 'start', 'restart', 'disable', 'enable'].includes(action), 'invalid action');
    const r = await run('systemctl', [action, `${name}.service`], 15000);
    return { ok: r.code === 0, log: (r.stderr || r.stdout || '') };
  },
  async 'inventory.services'() {
    // systemd units: load/active/sub state + since-timestamp.
    const r = await run('systemctl',
      ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'], 10000)
      .catch(() => ({ code: 1, stdout: '' }));
    if (r.code !== 0) return { services: [] };
    const services = [];
    for (const line of r.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [unit, load, active, sub] = cols;
      services.push({ name: unit.replace(/\.service$/, ''), load, active, sub,
        description: cols.slice(4).join(' ') });
    }
    return { services };
  },
  async 'inventory.serviceDetail'({ name }) {
    assert(/^[a-zA-Z0-9@._\\-]{1,128}$/.test(name), 'invalid service name');
    const r = await run('systemctl',
      ['show', `${name}.service`, '-p', 'ActiveEnterTimestamp,MainPID,MemoryCurrent,ExecMainStartTimestamp,UnitFileState'], 6000)
      .catch(() => ({ code: 1, stdout: '' }));
    const out = {};
    for (const line of (r.stdout || '').split('\n')) {
      const i = line.indexOf('='); if (i < 0) continue;
      out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  },

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

  // ---- DNS query logging via dnsmasq (opt-in) -----------------------------
  // The Pi's own recent DNS lookups, no logging config needed: parse
  // systemd-resolved's journal (it records 'Looking up' / cache) when
  // present; otherwise sample current :53 peers via ss.
  // ---- DNS logging forwarder in front of Tailscale MagicDNS (opt-in) ------
  // Installs dnsmasq as a LOCAL forwarder: listens on 127.0.0.1#5353, logs
  // every query, forwards upstream to MagicDNS (100.100.100.100). We point
  // /etc/resolv.conf at it and back up the original. Fully reversible.
  async 'dns.forwarder'({ enable }) {
    const BACKUP = '/etc/rapisys/resolv.conf.orig';
    const DROPIN = '/etc/dnsmasq.d/rapisys-forwarder.conf';
    const LOG = '/var/log/dnsmasq-rapisys.log';
    if (enable) {
      // Tailscale owns /etc/resolv.conf and rewrites it instantly; a local
      // forwarder can't hold the resolver slot without disabling MagicDNS
      // (tailscale set --accept-dns=false), which degrades tailnet DNS for
      // the whole node. Refuse cleanly rather than leave a broken half-state.
      try {
        const rc = fs.readFileSync('/etc/resolv.conf', 'utf-8');
        if (/generated by tailscale/i.test(rc)) {
          throw new Error('Tailscale manages this Pi\'s DNS (MagicDNS). A local logging forwarder would require disabling MagicDNS for the whole node. Use Tailscale split-DNS in the admin console to point a domain at a logging resolver instead.');
        }
      } catch (e) { if (/Tailscale manages/.test(e.message)) throw e; }
      const have = await run('sh', ['-c', 'command -v dnsmasq'], 3000);
      if (have.code !== 0) {
        const inst = await run('apt-get', ['install', '-y', 'dnsmasq'], 120000);
        assert(inst.code === 0, 'dnsmasq install failed');
      }
      // dnsmasq as a non-default-port forwarder so it never clashes with
      // whatever else binds :53; resolv.conf points at it directly.
      fs.mkdirSync('/etc/dnsmasq.d', { recursive: true });
      fs.writeFileSync(DROPIN,
        ['port=5353', 'listen-address=127.0.0.1', 'bind-interfaces',
         'no-resolv', 'server=100.100.100.100', 'log-queries',
         `log-facility=${LOG}`, 'cache-size=1000'].join('\n') + '\n');
      // back up resolv.conf once, then repoint it
      fs.mkdirSync('/etc/rapisys', { recursive: true });
      if (!fs.existsSync(BACKUP)) {
        try { fs.copyFileSync('/etc/resolv.conf', BACKUP); } catch { /* may be symlink */ }
      }
      // dnsmasq on 5353 — resolv.conf can't carry a port, so we run a tiny
      // :53 listener too by adding a second drop-in binding 53 on loopback.
      fs.writeFileSync('/etc/dnsmasq.d/rapisys-forwarder.conf',
        ['listen-address=127.0.0.53', 'bind-interfaces', 'no-resolv',
         'server=100.100.100.100', 'log-queries', `log-facility=${LOG}`,
         'cache-size=1000'].join('\n') + '\n');
      const sysd = await run('systemctl', ['list-unit-files', 'dnsmasq.service'], 4000).catch(() => ({ stdout: '' }));
      if (sysd.stdout.includes('dnsmasq.service')) {
        await run('systemctl', ['enable', '--now', 'dnsmasq'], 8000);
        await run('systemctl', ['restart', 'dnsmasq'], 8000);
      } else {
        return { ok: false, error: 'no dnsmasq.service unit; manual start required' };
      }
      // repoint resolver
      try { fs.unlinkSync('/etc/resolv.conf'); } catch { /* */ }
      fs.writeFileSync('/etc/resolv.conf', 'nameserver 127.0.0.53\noptions edns0\n');
      return { ok: true, enabled: true, log: LOG };
    } else {
      try { fs.unlinkSync(DROPIN); } catch { /* */ }
      await run('systemctl', ['restart', 'dnsmasq'], 8000).catch(() => {});
      // restore original resolv.conf
      if (fs.existsSync(BACKUP)) {
        try { fs.unlinkSync('/etc/resolv.conf'); } catch { /* */ }
        try { fs.copyFileSync(BACKUP, '/etc/resolv.conf'); } catch { /* */ }
      } else {
        fs.writeFileSync('/etc/resolv.conf', 'nameserver 100.100.100.100\n');
      }
      return { ok: true, enabled: false };
    }
  },

    async 'dns.recent'({ limit = 20 }) {
    // journal route (systemd-resolved with at least default logging)
    const j = await run('sh', ['-c',
      "journalctl -u systemd-resolved --no-pager -n 400 -o cat 2>/dev/null | grep -oiE 'question: [^ ]+|Looking up [^ ]+' | awk '{print $NF}'"], 5000)
      .catch(() => ({ stdout: '' }));
    const counts = {};
    for (const d of (j.stdout || '').split('\n')) {
      const dom = d.trim().toLowerCase().replace(/\.$/, '');
      if (dom && dom.includes('.')) counts[dom] = (counts[dom] || 0) + 1;
    }
    if (Object.keys(counts).length) {
      const domains = Object.entries(counts).map(([domain, queries]) => ({ domain, queries }))
        .sort((a, b) => b.queries - a.queries).slice(0, Number(limit) || 20);
      return { source: 'resolved-journal', domains };
    }
    // Identify the active resolver (Tailscale MagicDNS shows as 100.100.100.100).
    let resolver = null;
    try {
      const rc = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      const ns = (rc.match(/^nameserver\s+(\S+)/m) || [])[1];
      if (ns === '100.100.100.100') resolver = 'Tailscale MagicDNS';
      else if (ns) resolver = ns;
    } catch { /* none */ }

    // fallback: live DNS peers the Pi is talking to right now
    const ss = await run('sh', ['-c', "ss -tunp 'dport = :53' 2>/dev/null"], 4000).catch(() => ({ stdout: '' }));
    const peers = {};
    for (const line of (ss.stdout || '').split('\n').slice(1)) {
      const m = line.match(/\s(\S+):53\s/);
      if (m) peers[m[1]] = (peers[m[1]] || 0) + 1;
    }
    return { source: 'live-peers', resolver,
      domains: Object.entries(peers).map(([domain, queries]) => ({ domain, queries })).slice(0, Number(limit) || 20) };
  },

    async 'dns.enableLogging'() {
    // Only safe with a STANDALONE dnsmasq: a real service unit + a config
    // directory or file we may edit. NetworkManager/libvirt embed their own
    // dnsmasq with no editable config and no service — never touch those.
    const hasService = (await run('systemctl', ['list-unit-files', 'dnsmasq.service'], 4000)
      .catch(() => ({ stdout: '' }))).stdout.includes('dnsmasq.service');
    const hasConfD = fs.existsSync('/etc/dnsmasq.d');
    const hasConf = fs.existsSync('/etc/dnsmasq.conf');
    if (!hasService || !(hasConfD || hasConf)) {
      throw new Error('per-domain logging needs a standalone dnsmasq (none found — your dnsmasq is embedded in NetworkManager/libvirt). Pi-hole is also supported when present.');
    }
    if (hasConfD) {
      fs.writeFileSync('/etc/dnsmasq.d/rapisys-logging.conf',
        'log-queries\nlog-facility=/var/log/dnsmasq-rapisys.log\n');
    } else {
      let conf = fs.readFileSync('/etc/dnsmasq.conf', 'utf-8');
      if (!conf.includes('# RAPISYS-LOGGING')) {
        conf += '\n# RAPISYS-LOGGING\nlog-queries\nlog-facility=/var/log/dnsmasq-rapisys.log\n';
        fs.writeFileSync('/etc/dnsmasq.conf', conf);
      }
    }
    const r = await run('systemctl', ['restart', 'dnsmasq'], 8000);
    assert(r.code === 0, `dnsmasq restart failed: ${r.stderr || r.stdout}`);
    return { ok: true, log: '/var/log/dnsmasq-rapisys.log' };
  },
  async 'dns.disableLogging'() {
    try { fs.unlinkSync('/etc/dnsmasq.d/rapisys-logging.conf'); } catch { /* none */ }
    try {
      const conf = fs.readFileSync('/etc/dnsmasq.conf', 'utf-8');
      if (conf.includes('# RAPISYS-LOGGING')) {
        fs.writeFileSync('/etc/dnsmasq.conf',
          conf.replace(/\n# RAPISYS-LOGGING\nlog-queries\nlog-facility=[^\n]*\n/, '\n'));
      }
    } catch { /* none */ }
    await run('systemctl', ['restart', 'dnsmasq'], 8000).catch(() => {});
    return { ok: true };
  },
  async 'dns.topDomains'({ limit = 15 }) {
    const log = '/var/log/dnsmasq-rapisys.log';
    let text = '';
    try { text = fs.readFileSync(log, 'utf-8'); } catch { return { enabled: false, domains: [] }; }
    // keep memory bounded: only the tail
    if (text.length > 2_000_000) text = text.slice(-2_000_000);
    const counts = {};
    for (const line of text.split('\n')) {
      // "... query[A] github.com from 192.168.10.9"
      const m = line.match(/query\[[A-Z]+\]\s+(\S+)\s+from/);
      if (m) { const d = m[1].toLowerCase(); counts[d] = (counts[d] || 0) + 1; }
    }
    const domains = Object.entries(counts)
      .map(([domain, queries]) => ({ domain, queries }))
      .sort((a, b) => b.queries - a.queries)
      .slice(0, Math.min(Number(limit) || 15, 50));
    return { enabled: true, domains, totalQueries: Object.values(counts).reduce((a, b) => a + b, 0) };
  },

  // ---- per-process bandwidth via nethogs (opt-in, installs on first use) ---
  async 'nethogs.sample'({ seconds = 5 }) {
    // Ensure nethogs is present (tiny package).
    const have = await run('sh', ['-c', 'command -v nethogs'], 3000);
    if (have.code !== 0) {
      const inst = await run('apt-get', ['install', '-y', 'nethogs'], 120000);
      assert(inst.code === 0, 'nethogs install failed (apt)');
    }
    const dur = Math.min(Math.max(Number(seconds) || 5, 2), 15);
    // -t trace mode, -c count cycles (~1s each), -d delay
    const r = await run('nethogs', ['-t', '-c', String(dur), '-d', '1'], (dur + 5) * 1000)
      .catch((e) => ({ code: 1, stdout: '', stderr: String(e) }));
    // trace output: "program/pid/uid\tsent_KB/s\trecv_KB/s"
    const procs = {};
    for (const line of (r.stdout || '').split('\n')) {
      const m = line.match(/^(.+?)\/(\d+)\/\d+\s+([\d.]+)\s+([\d.]+)/);
      if (!m) continue;
      const name = m[1].split('/').pop();
      const key = `${name}:${m[2]}`;
      const sent = parseFloat(m[3]), recv = parseFloat(m[4]);
      if (!procs[key]) procs[key] = { comm: name, pid: Number(m[2]), sentKB: 0, recvKB: 0, n: 0 };
      procs[key].sentKB += sent; procs[key].recvKB += recv; procs[key].n += 1;
    }
    const list = Object.values(procs)
      .map((p) => ({ comm: p.comm, pid: p.pid, sentKBs: p.sentKB / p.n, recvKBs: p.recvKB / p.n }))
      .filter((p) => p.sentKBs + p.recvKBs > 0.01)
      .sort((a, b) => (b.sentKBs + b.recvKBs) - (a.sentKBs + a.recvKBs))
      .slice(0, 10);
    return { processes: list };
  },

    async 'vnstat.json'({ iface }) {
    const args = ['--json'];
    if (iface && /^[a-zA-Z0-9._-]{1,32}$/.test(iface)) args.push('-i', iface);
    const r = await run('vnstat', args, 8000).catch(() => ({ code: 127, stdout: '' }));
    if (r.code !== 0 || !r.stdout.trim()) throw new Error('vnstat not available or no data');
    return { output: r.stdout };
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
  async 'nas.unmount'({ mountpoint }) {
    assert(mountpoint === path.posix.normalize(mountpoint) && mountpoint.startsWith(MOUNT_BASE + '/'),
      `mountpoint must be under ${MOUNT_BASE}`);
    const unit = unitNameFor(mountpoint);
    await run('systemctl', ['disable', '--now', `${unit}.mount`]).catch(() => {});
    await run('umount', [mountpoint]).catch(async () => {
      await run('umount', ['-l', mountpoint]).catch(() => {});
    });
    try { fs.unlinkSync(`/etc/systemd/system/${unit}.mount`); } catch { /* gone */ }
    await run('systemctl', ['daemon-reload']);
    return { ok: true, unmounted: mountpoint };
  },

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
    const names = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([^/]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s+([^\]]+)\])?/);
      if (!m) continue;
      names.push(m[1]);
      updates.push({
        package: m[1], pocket: m[2], candidate: m[3], installed: m[4] || null,
        security: securityPkgs.has(m[1]),
        kernel: /^linux-image|^linux-headers|^raspberrypi-kernel/.test(m[1]),
      });
    }
    // Descriptions (one dpkg-query call for all upgradable packages) and the
    // install date of the currently-installed version (.list mtime).
    const desc = {};
    if (names.length) {
      const dq = await run('dpkg-query', ['-W', '-f=${Package}\t${binary:Summary}\n', ...names], 30000).catch(() => ({ stdout: '' }));
      for (const line of (dq.stdout || '').split('\n')) {
        const i = line.indexOf('\t');
        if (i > 0) desc[line.slice(0, i)] = line.slice(i + 1);
      }
    }
    // Candidate download size: parse `apt-cache show` Size: fields (bytes of the
    // .deb). One call for all upgradable packages; take the first (candidate) Size.
    const sizeMap = {};
    if (names.length) {
      const sc = await run('apt-cache', ['show', ...names], 30000).catch(() => ({ stdout: '' }));
      let curPkg = null;
      for (const line of (sc.stdout || '').split('\n')) {
        const pm = line.match(/^Package:\s*(\S+)/);
        if (pm) { curPkg = pm[1]; continue; }
        const zm = line.match(/^Size:\s*(\d+)/);
        if (zm && curPkg && sizeMap[curPkg] == null) sizeMap[curPkg] = parseInt(zm[1], 10);
      }
    }
    for (const u of updates) {
      u.description = desc[u.package] || '';
      u.sizeBytes = sizeMap[u.package] || null;
      try { u.installedAt = Math.floor(fs.statSync(`/var/lib/dpkg/info/${u.package}.list`).mtimeMs); }
      catch { u.installedAt = null; }
    }
    return { updates };
  },
  // -- Partial changelog fetch over HTTP range requests -----------------------
  // A .deb is an `ar` archive: [magic][debian-binary][control.tar.*][data.tar.*].
  // The changelog lives in data.tar under ./usr/share/doc/<pkg>/. The RPi
  // archive supports range requests, so we (1) probe the ar headers, (2) range-
  // fetch just the data.tar member, (3) stream it through tar and stop as soon
  // as the changelog is extracted — pulling a few MB instead of 100+ MB.
  async 'apt.changelogRange'({ pkg }) {
    assert(PKG_RE.test(pkg), 'invalid package name');

    // 1) resolve the candidate .deb URL for THIS exact package (no download).
    //    `apt-get download --print-uris` is empty on this archive, so use
    //    install --reinstall --print-uris and pick the line whose filename
    //    starts with "<pkg>_".
    const piu = await run('apt-get', ['install', '--reinstall', '--print-uris', '-y', pkg], 20000).catch(() => ({ stdout: '' }));
    let uri = null;
    const re = new RegExp("'(https?://[^']+/(" + pkg.replace(/[.+]/g, '\\$&') + "_[^']+\\.deb))'");
    const m = (piu.stdout || '').match(re);
    if (m) uri = m[1];
    if (!uri) return { changelog: '', source: 'none', error: 'could not resolve package URL' };

    // Byte budget: stream at most this much of data.tar looking for the
    // changelog. Cheap packages (docs early) finish in a few hundred KB;
    // giants (chromium) whose docs sit late will hit the budget and bail.
    const BYTE_BUDGET = 8 * 1024 * 1024;

    const httpGet = (url, headers) => new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { headers }, (res) => resolve(res));
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(new Error('http timeout')); });
    });

    // 2) probe first 2KB to read ar member headers
    const head = await new Promise((resolve, reject) => {
      httpGet(uri, { Range: 'bytes=0-2047' }).then((res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).catch(reject);
    }).catch(() => null);
    if (!head || head.slice(0, 8).toString('ascii') !== '!<arch>\n') {
      return { changelog: '', source: 'none', error: 'unexpected archive format' };
    }
    // parse members
    let off = 8, dataMember = null;
    while (off + 60 <= head.length) {
      const name = head.slice(off, off + 16).toString('ascii').trim();
      const size = parseInt(head.slice(off + 48, off + 58).toString('ascii').trim(), 10);
      if (!Number.isFinite(size)) break;
      const dataOff = off + 60;
      if (name.startsWith('data.tar')) { dataMember = { name, size, dataOff }; break; }
      off = dataOff + size + (size % 2);
    }
    if (!dataMember) return { changelog: '', source: 'none', error: 'data member not found' };

    // 3) range-fetch the data.tar.* member, pipe through tar, extract only the
    //    changelog, abort the moment it's written.
    const comp = dataMember.name.split('.').pop(); // gz | xz | zst
    const tmp = `/tmp/rapisys-clr-${pkg}-${Date.now()}`;
    fs.mkdirSync(tmp, { recursive: true });
    const docGlob = `./usr/share/doc/${pkg}/changelog*`;
    const tarArgs = ['-x', '--ignore-command-error', '--warning=no-unknown-keyword',
      '-C', tmp, '--wildcards', '--no-anchored', `usr/share/doc/${pkg}/changelog*`];
    // choose tar decompress flag
    if (comp === 'gz') tarArgs.unshift('-z');
    else if (comp === 'xz') tarArgs.unshift('-J');
    else if (comp === 'zst') tarArgs.unshift('--zstd');

    const rangeEnd = dataMember.dataOff + dataMember.size - 1;
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      httpGet(uri, { Range: `bytes=${dataMember.dataOff}-${rangeEnd}` }).then((res) => {
        const tar = spawn('tar', tarArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
        let streamed = 0;
        res.on('data', (d) => { streamed += d.length; if (streamed > BYTE_BUDGET) { try { res.destroy(); tar.kill('SIGTERM'); } catch {} } });
        res.pipe(tar.stdin);
        res.on('error', () => {});
        tar.stdin.on('error', () => {});
        // poll for the changelog file; once present, kill the stream early
        const poll = setInterval(() => {
          try {
            const docDir = `${tmp}/usr/share/doc/${pkg}`;
            if (fs.existsSync(docDir)) {
              const f = fs.readdirSync(docDir).find((n) => n.startsWith('changelog'));
              if (f) {
                clearInterval(poll);
                res.destroy(); try { tar.kill('SIGTERM'); } catch {}
                finish(`${docDir}/${f}`);
              }
            }
          } catch {}
        }, 150);
        tar.on('close', () => { clearInterval(poll);
          // tar finished (whole member read) — check one last time
          try {
            const docDir = `${tmp}/usr/share/doc/${pkg}`;
            const f = fs.existsSync(docDir) ? fs.readdirSync(docDir).find((n) => n.startsWith('changelog')) : null;
            finish(f ? `${docDir}/${f}` : null);
          } catch { finish(null); }
        });
        // hard cap so a pathological package can't hang the op
        setTimeout(() => { try { res.destroy(); tar.kill('SIGKILL'); } catch {}; finish(null); }, 45000);
      }).catch(() => finish(null));
    });

    let text = '';
    if (result) {
      try { const b = fs.readFileSync(result); text = result.endsWith('.gz') ? require('zlib').gunzipSync(b).toString('utf-8') : b.toString('utf-8'); } catch {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (!text) return { changelog: '', source: 'none', error: 'changelog not found in stream' };
    // candidate version from the URL filename (epoch dropped, ~ and + encoded)
    let candidateVersion = null;
    const fnm = uri.split('/').pop().match(/_([^_]+)_/);
    if (fnm) candidateVersion = decodeURIComponent(fnm[1]).replace(/%7e/gi, '~').replace(/%2b/gi, '+');
    return { changelog: text.split('\n').slice(0, 150).join('\n'), source: 'candidate', candidateVersion, partial: true };
  },

    // Full-download changelog fetch WITH progress (for packages whose docs sit
  // past the range-fetch budget, e.g. chromium @ 114MB). Streams the .deb,
  // emitting {downloaded,total,pct} lines, then extracts the changelog.
  async 'apt.changelogFull'({ pkg }, send) {
    assert(PKG_RE.test(pkg), 'invalid package name');
    const piu = await run('apt-get', ['install', '--reinstall', '--print-uris', '-y', pkg], 20000).catch(() => ({ stdout: '' }));
    const re = new RegExp("'(https?://[^']+/(" + pkg.replace(/[.+]/g, '\\$&') + "_[^']+\\.deb))'");
    const m = (piu.stdout || '').match(re);
    if (!m) return { changelog: '', source: 'none', error: 'could not resolve package URL' };
    const uri = m[1];

    const tmp = `/tmp/rapisys-clf-${pkg}-${Date.now()}`;
    fs.mkdirSync(tmp, { recursive: true });
    const debPath = path.join(tmp, 'pkg.deb');

    const ok = await new Promise((resolve) => {
      const lib = uri.startsWith('https') ? https : http;
      const req = lib.get(uri, (res) => {
        if (res.statusCode !== 200) { res.destroy(); return resolve(false); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const out = fs.createWriteStream(debPath);
        let got = 0, lastPct = -1;
        res.on('data', (d) => {
          got += d.length;
          const pct = total ? Math.floor((got / total) * 100) : 0;
          if (pct !== lastPct) { lastPct = pct; send?.(JSON.stringify({ downloaded: got, total, pct })); }
        });
        res.pipe(out);
        out.on('finish', () => resolve(true));
        out.on('error', () => resolve(false));
        res.on('error', () => resolve(false));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(180000, () => { req.destroy(); resolve(false); });
    });

    let text = '';
    if (ok) {
      // extract just the changelog from the downloaded .deb
      await run('dpkg-deb', ['-x', debPath, path.join(tmp, 'x')], 60000).catch(() => {});
      const docDir = path.join(tmp, 'x', 'usr', 'share', 'doc', pkg);
      if (fs.existsSync(docDir)) {
        for (const f of ['changelog.Debian.gz', 'changelog.gz', 'changelog.Debian', 'changelog']) {
          const p = path.join(docDir, f);
          if (fs.existsSync(p)) { const b = fs.readFileSync(p); text = f.endsWith('.gz') ? require('zlib').gunzipSync(b).toString('utf-8') : b.toString('utf-8'); break; }
        }
      }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (!text) return { changelog: '', source: 'none', error: 'changelog not found' };
    let candidateVersion = null;
    const fnm = uri.split('/').pop().match(/_([^_]+)_/);
    if (fnm) candidateVersion = decodeURIComponent(fnm[1]).replace(/%7e/gi, '~').replace(/%2b/gi, '+');
    return { changelog: text.split('\n').slice(0, 150).join('\n'), source: 'candidate', candidateVersion };
  },

    async 'apt.changelog'({ pkg, candidate = false }) {
    assert(PKG_RE.test(pkg), 'invalid package name');
    const zlib = require('zlib');
    const readGz = (p) => { try { const b = fs.readFileSync(p); return p.endsWith('.gz') ? zlib.gunzipSync(b).toString('utf-8') : b.toString('utf-8'); } catch { return ''; } };
    const localChangelog = () => {
      for (const f of ['changelog.Debian.gz', 'changelog.gz', 'changelog.Debian', 'changelog']) {
        const p = `/usr/share/doc/${pkg}/${f}`;
        if (fs.existsSync(p)) return readGz(p);
      }
      return '';
    };

    // For upgradable packages we want the CANDIDATE version's notes (what's
    // NEW), which the installed local changelog can't contain. `apt changelog`
    // fails on Trixie/rpt1, so download the candidate .deb and extract its
    // bundled changelog instead.
    let candidateText = '';
    let candidateVersion = null;
    if (candidate) {
      const tmp = `/tmp/rapisys-changelog-${pkg}-${Date.now()}`;
      try {
        fs.mkdirSync(tmp, { recursive: true });
        const dl = await run('apt-get', ['download', pkg], 30000, { cwd: tmp }).catch(() => ({ code: 1 }));
        if (dl.code === 0) {
          const deb = fs.readdirSync(tmp).find((f) => f.endsWith('.deb'));
          if (deb) {
            const m = deb.match(/_([^_]+)_/); candidateVersion = m ? m[1] : null;
            // extract the doc tree from the .deb, then read its changelog
            await run('dpkg-deb', ['-x', path.join(tmp, deb), path.join(tmp, 'x')], 15000).catch(() => {});
            const docDir = path.join(tmp, 'x', 'usr', 'share', 'doc', pkg);
            if (fs.existsSync(docDir)) {
              for (const f of ['changelog.Debian.gz', 'changelog.gz', 'changelog.Debian', 'changelog']) {
                const p = path.join(docDir, f);
                if (fs.existsSync(p)) { candidateText = readGz(p); break; }
              }
            }
          }
        }
      } catch { /* fall through to local */ }
      finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
    }

    const text = candidateText || localChangelog();
    if (!text) {
      const r = await run('apt', ['changelog', pkg], 12000).catch(() => ({ stdout: '' }));
      if (r.stdout) return { changelog: r.stdout.split('\n').slice(0, 120).join('\n'), source: 'network' };
      return { changelog: 'No changelog available.', source: 'none' };
    }
    return {
      changelog: text.split('\n').slice(0, 150).join('\n'),
      source: candidateText ? 'candidate' : 'installed',
      candidateVersion,
    };
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
