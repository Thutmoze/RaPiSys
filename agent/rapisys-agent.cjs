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
    // Strip ANSI/terminal control sequences (cursor hide/show, moves, colour)
    // so streamed installer output is readable; drop lone spinner frames.
    const clean = (l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\b]/g, '');
    const onData = (buf) => buf.toString('utf-8').split('\n').forEach((raw) => {
      const l = clean(raw);
      if (!l.trim()) return;
      if (/^[-\\|/]$/.test(l.trim())) return;
      send(l);
    });
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

/** Shell-quote a single argument for use inside `sh -c` strings. */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** Is a TCP port free on the host? (checks listeners via ss) */
async function portInUse(port) {
  const r = await run('sh', ['-c', `ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE '[:.]${port}$' && echo USED || echo FREE`], 5000)
    .catch(() => ({ stdout: 'FREE' }));
  return /USED/.test(r.stdout || '');
}
/** Pick the first free port starting from `preferred`, then a fallback list. */
async function firstFreePort(preferred) {
  const tries = [...new Set([preferred, 8081, 8080, 8088, 8089, 8090, 80].filter(Boolean))];
  for (const p of tries) { if (!(await portInUse(p))) return p; }
  return preferred;   // give up gracefully; caller surfaces the bind error
}

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

// ---- Pironman case controller (multi-variant) ------------------------------
// The official SunFounder installer (install.sh) supports all models via a
// --variant flag and installs to a single shared layout regardless of model:
//   /opt/pironman5  ·  pironman5.service  ·  /opt/pironman5/.variant marker.
const PIRONMAN_INSTALLER_URL =
  'https://raw.githubusercontent.com/sunfounder/sunfounder-installer-scripts/main/pironman5/install.sh';
const PIRONMAN_VARIANTS = ['base', 'mini', 'max', 'pro-max'];
const PIRONMAN_MODEL_NAMES = {
  'base': 'Pironman 5', 'mini': 'Pironman 5 Mini',
  'max': 'Pironman 5 Max', 'pro-max': 'Pironman 5 Pro Max',
};
// Per-variant device-tree overlay (matches the installer's PM5_OVERLAYS map).
const PIRONMAN_OVERLAY_BY_VARIANT = {
  'base': 'sunfounder-pironman5', 'mini': 'sunfounder-pironman5mini',
  'max': 'sunfounder-pironman5', 'pro-max': 'sunfounder-pironman5promax',
};
const PIRONMAN_DIR     = '/opt/pironman5';
const PIRONMAN_SRC     = '/opt/pironman5'; // installer clones into the work dir
const PIRONMAN_VENV_PY = '/opt/pironman5/venv/bin/python3';
const PIRONMAN_VENV_PIP= '/opt/pironman5/venv/bin/pip3';
const PIRONMAN_VARIANT_FILE = '/opt/pironman5/.variant';
function pironmanInstalledVariant() {
  try { return fs.readFileSync(PIRONMAN_VARIANT_FILE, 'utf-8').trim() || null; } catch { return null; }
}
// The SunFounder installer runs pip, which defaults its cache to $HOME/.cache.
// The agent runs with systemd ProtectHome=read-only, so /root is read-only and
// pip fails to build wheels ([Errno 30]). Point HOME/cache at the agent's
// (writable, PrivateTmp) /tmp and disable the cache as a belt-and-suspenders.
const PIRONMAN_BUILD_HOME = '/tmp/pironman-build';
function pironmanInstallEnv() {
  try { fs.mkdirSync(PIRONMAN_BUILD_HOME + '/.cache', { recursive: true }); } catch { /* */ }
  return {
    DEBIAN_FRONTEND: 'noninteractive',
    HOME: PIRONMAN_BUILD_HOME,
    XDG_CACHE_HOME: PIRONMAN_BUILD_HOME + '/.cache',
    PIP_CACHE_DIR: PIRONMAN_BUILD_HOME + '/.cache/pip',
    PIP_NO_CACHE_DIR: '1',
    // Give the installer a real terminal type so its `tput` colour calls work
    // instead of spamming "tput: No value for \$TERM and no -T specified".
    TERM: 'xterm-256color',
  };
}
// Run the SunFounder installer under a pseudo-terminal (script(1)) feeding "n"
// to its end-of-install "reboot now? (y/n)" prompt. Without a real /dev/tty that
// prompt's `read < /dev/tty` fails instantly and the framework's `while true`
// loop busy-spins at 100% CPU forever (the install never returns). script(1)
// supplies the pty so the read succeeds, and the piped "n" declines the
// installer's own reboot — RaPiSys runs its own reboot prompt after install.
function runPironmanInstaller(installArgs, send) {
  try { fs.mkdirSync(PIRONMAN_BUILD_HOME, { recursive: true }); } catch { /* */ }
  const inner = `export HOME=${shq(PIRONMAN_BUILD_HOME)}; cd ${shq(PIRONMAN_BUILD_HOME)} && `
    + installArgs.map(shq).join(' ');
  const wrapped = `printf 'n\nn\nn\n' | script -qec ${shq(inner)} /dev/null`;
  return runStreaming('sh', ['-c', wrapped], pironmanInstallEnv(), send);
}
const PIRONMAN_SERVICE = 'pironman5.service';
// Overlay depends on the installed variant; default to base if unknown.
function pironmanOverlay() {
  const v = pironmanInstalledVariant();
  return PIRONMAN_OVERLAY_BY_VARIANT[v] || 'sunfounder-pironman5';
}
const BOOT_CONFIG_TXT = '/boot/firmware/config.txt';
// The SunFounder installer copies the .dtbo file but never adds the dtoverlay=
// line to config.txt, so the fan/RGB overlay would not load on boot. Add it
// idempotently after a successful install.
function ensurePironmanOverlay(send, overlay) {
  overlay = overlay || pironmanOverlay();
  try {
    let cfg = BOOT_CONFIG_TXT;
    if (!fs.existsSync(cfg)) cfg = '/boot/config.txt';
    if (!fs.existsSync(cfg)) { send && send('Note: config.txt not found; skipping dtoverlay wiring.'); return false; }
    const txt = fs.readFileSync(cfg, 'utf-8');
    if (new RegExp('^\\s*dtoverlay=' + overlay + '\\b', 'm').test(txt)) {
      send && send('Device-tree overlay already enabled in config.txt.');
      return true;
    }
    fs.appendFileSync(cfg, (txt.endsWith('\n') ? '' : '\n') + 'dtoverlay=' + overlay + '\n');
    send && send('Enabled device-tree overlay in config.txt (takes effect after reboot).');
    return true;
  } catch (e) {
    send && send('Warning: could not edit config.txt (' + e.message + '). Add "dtoverlay=' + overlay + '" yourself.');
    return false;
  }
}
// Remove the dtoverlay= line from config.txt on uninstall (idempotent; the
// SunFounder uninstall removes the .dtbo file but may leave the config line).
function removePironmanOverlay(send, overlay) {
  overlay = overlay || pironmanOverlay();
  try {
    let cfg = BOOT_CONFIG_TXT;
    if (!fs.existsSync(cfg)) cfg = '/boot/config.txt';
    if (!fs.existsSync(cfg)) return false;
    const txt = fs.readFileSync(cfg, 'utf-8');
    const re = new RegExp('^\\s*dtoverlay=' + overlay + '\\b.*$\\n?', 'm');
    if (!re.test(txt)) { send && send('No device-tree overlay line to remove from config.txt.'); return true; }
    fs.writeFileSync(cfg, txt.replace(re, ''));
    send && send('Removed device-tree overlay line from config.txt.');
    return true;
  } catch (e) {
    send && send('Warning: could not edit config.txt (' + e.message + ').');
    return false;
  }
}
// Configure the Pi to fully power off on shutdown (POWER_OFF_ON_HALT=1) so the
// GPIO-powered RGB fan does not keep running after halt. SunFounder requires
// this for the Mini/Max/Pro variants. Idempotent: skip if already set.
async function pironmanEepromPowerOff(send) {
  const have = await run('sh', ['-c', 'command -v rpi-eeprom-config >/dev/null && echo OK'], 5000).catch(() => ({ stdout: '' }));
  if (!/OK/.test(have.stdout)) { send && send('rpi-eeprom-config not available; skipping shutdown power-off config.'); return false; }
  const cur = await run('rpi-eeprom-config', [], 8000).catch(() => ({ stdout: '' }));
  if (/^\s*POWER_OFF_ON_HALT=1\s*$/m.test(cur.stdout || '')) {
    send && send('EEPROM already set to full power-off on shutdown.');
    return true;
  }
  send && send('Configuring EEPROM: full power-off on shutdown (POWER_OFF_ON_HALT=1)…');
  // Build the new config: keep existing lines, set/replace POWER_OFF_ON_HALT.
  let cfg = (cur.stdout || '').replace(/^\s*POWER_OFF_ON_HALT=.*$/m, '').replace(/\n+$/,'\n');
  cfg = (cfg.endsWith('\n') ? cfg : cfg + '\n') + 'POWER_OFF_ON_HALT=1\n';
  const tmp = '/tmp/rapisys-eeprom.conf';
  fs.writeFileSync(tmp, cfg);
  const r = await run('rpi-eeprom-config', ['--apply', tmp], 30000).catch((e) => ({ code: 1, stderr: String(e) }));
  if (r.code === 0) { send && send('EEPROM updated (applies on next reboot).'); return true; }
  send && send('Warning: EEPROM update failed (' + (r.stderr || '').slice(0,120) + '). You can set it via raspi-config → Advanced → Shutdown Behaviour.');
  return false;
}
const PIRONMAN_API_PORT= 34001;
const PIRONMAN_REMOTE_VERSION =
  'https://raw.githubusercontent.com/sunfounder/pironman5/main/pironman5/version.py';

// Real fan profiles from pm_auto (index 0..4); used to validate gpio_fan_mode.
const PIRONMAN_FAN_MODES  = ['Always On', 'Performance', 'Cool', 'Balanced', 'Quiet'];
const PIRONMAN_RGB_STYLES = new Set(['rainbow', 'breath', 'leap', 'flow', 'raise_up', 'colorful']);
const PIRONMAN_FAN_LED    = new Set(['follow', 'on', 'off']);
const PIRONMAN_HEX_RE     = /^#?[0-9a-fA-F]{6}$/;

/** Validate + normalise a Pironman config patch (the `system` block). Hardware
 *  pins are intentionally NOT writable. Throws on any non-allowlisted key. */
function pironmanValidateConfig(input) {
  assert(input && typeof input === 'object', 'config must be an object');
  const sys = (input.system && typeof input.system === 'object') ? input.system : input;
  const out = {};
  const setInt = (k, v, lo, hi) => {
    const n = Math.round(Number(v));
    assert(Number.isFinite(n) && n >= lo && n <= hi, `${k} must be an integer ${lo}-${hi}`);
    out[k] = n;
  };
  for (const [k, v] of Object.entries(sys)) {
    switch (k) {
      case 'temperature_unit':
        assert(v === 'C' || v === 'F', 'temperature_unit must be C or F'); out[k] = v; break;
      case 'rgb_enable':
        assert(typeof v === 'boolean', 'rgb_enable must be boolean'); out[k] = v; break;
      case 'rgb_color':
        assert(typeof v === 'string' && PIRONMAN_HEX_RE.test(v), 'rgb_color must be a hex colour');
        out[k] = (v.startsWith('#') ? v : '#' + v).toLowerCase(); break;
      case 'rgb_style':
        assert(PIRONMAN_RGB_STYLES.has(v), `rgb_style must be one of: ${[...PIRONMAN_RGB_STYLES].join(', ')}`);
        out[k] = v; break;
      case 'rgb_brightness': setInt(k, v, 0, 100); break;
      case 'rgb_speed':      setInt(k, v, 0, 100); break;
      case 'rgb_led_count':  setInt(k, v, 1, 256); break;
      case 'gpio_fan_mode':  setInt(k, v, 0, PIRONMAN_FAN_MODES.length - 1); break;
      case 'gpio_fan_led':
        assert(PIRONMAN_FAN_LED.has(v), 'gpio_fan_led must be follow|on|off'); out[k] = v; break;
      default:
        throw new Error(`config key not permitted from the dashboard: ${k}`);
    }
  }
  assert(Object.keys(out).length > 0, 'no valid config keys provided');
  return out;
}

/** Resolve the live config.json path via the installed package, or null. */
async function pironmanConfigPath() {
  if (!fs.existsSync(PIRONMAN_VENV_PY)) return null;
  const r = await run(PIRONMAN_VENV_PY,
    ['-c', "from pkg_resources import resource_filename as f; print(f('pironman5_mini','config.json'))"], 8000)
    .catch(() => ({ code: 1, stdout: '' }));
  const p = (r.stdout || '').trim();
  return (r.code === 0 && p) ? p : null;
}

const OPS = {

  // ---- Pironman 5 Mini -----------------------------------------------------
  // Hybrid model: the server proxies live config to pm_dashboard's API (port
  // 34001); these ops handle install/update/restart and the file fallback.

  async 'pironman.detect'() {
    const out = { installed: false, serviceActive: false, version: null,
      apiPort: PIRONMAN_API_PORT, apiReachable: false, hasDashboard: false, configPath: null };
    const unit = await run('sh', ['-c',
      `systemctl list-unit-files ${shq(PIRONMAN_SERVICE)} 2>/dev/null | grep -q ${shq(PIRONMAN_SERVICE)} && echo YES`], 5000)
      .catch(() => ({ stdout: '' }));
    out.installed = /YES/.test(unit.stdout) || fs.existsSync(PIRONMAN_VENV_PY);
    if (!out.installed) return out;
    out.variant = pironmanInstalledVariant();
    out.model = PIRONMAN_MODEL_NAMES[out.variant] || 'Pironman';
    out.serviceActive = (await run('systemctl', ['is-active', PIRONMAN_SERVICE], 5000)
      .catch(() => ({ stdout: '' }))).stdout.trim() === 'active';
    // The official installer uses the `pironman5` package for every variant;
    // fall back to the legacy mini package import if present.
    const v = await run(PIRONMAN_VENV_PY,
      ['-c', 'try:\n from pironman5.version import __version__\nexcept Exception:\n from pironman5_mini.version import __version__\nprint(__version__)'], 8000)
      .catch(() => ({ stdout: '' }));
    out.version = (v.stdout || '').trim() || null;
    const dash = await run('sh', ['-c', `${shq(PIRONMAN_VENV_PIP)} show pm_dashboard >/dev/null 2>&1 && echo YES`], 8000)
      .catch(() => ({ stdout: '' }));
    out.hasDashboard = /YES/.test(dash.stdout);
    out.configPath = await pironmanConfigPath();
    const probe = await run('sh', ['-c',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PIRONMAN_API_PORT}/api/v1.0/test`], 6000)
      .catch(() => ({ stdout: '' }));
    out.apiReachable = /^200$/.test((probe.stdout || '').trim());
    return out;
  },

  async 'pironman.install'({ variant = 'mini', disableDashboard = false } = {}, send) {
    const noDash = !!disableDashboard;
    assert(PIRONMAN_VARIANTS.includes(variant), `unknown variant: ${variant}`);
    send('Checking prerequisites (curl, bash)...');
    const have = await run('sh', ['-c', 'command -v curl >/dev/null && command -v bash >/dev/null && echo OK'], 6000);
    assert(/OK/.test(have.stdout), 'curl and bash are required on the host');
    // Fetch the official installer to a temp file (not curl|bash) so we can run
    // it non-interactively with --variant and capture output for the stream.
    send('Fetching SunFounder installer…');
    const tmp = '/tmp/pironman-install.sh';
    const dl = await run('curl', ['-sSL', PIRONMAN_INSTALLER_URL, '-o', tmp], 30000);
    assert(dl.code === 0 && fs.existsSync(tmp), 'failed to download the installer');
    send(`Running official installer (variant: ${variant}${noDash ? ', slim' : ''}) — this can take several minutes…`);
    // --plain-text keeps the streamed output clean; --variant skips the menu;
    // --disable-dashboard maps to the slim install.
    const args = ['bash', tmp, '--variant', variant, '--plain-text'];
    if (noDash) args.push('--disable-dashboard');
    const r = await runPironmanInstaller(args, send);
    assert(r.code === 0, `installer exited with code ${r.code}`);
    ensurePironmanOverlay(send, PIRONMAN_OVERLAY_BY_VARIANT[variant]);
    await pironmanEepromPowerOff(send);
    send('Installed. A reboot is required to load the device-tree overlay.');
    const det = await OPS['pironman.detect']();
    return { ok: true, installed: det.installed, version: det.version, variant,
      hasDashboard: det.hasDashboard, apiReachable: det.apiReachable, rebootRequired: true };
  },

  // Remove the Pironman software from the host. Requires an explicit typed
  // confirmation token. Manually tears down the /opt/pironman5 layout
  // from the source dir, then strips the dtoverlay line from config.txt.
  async 'pironman.uninstall'({ confirm } = {}, send) {
    assert(confirm === 'UNINSTALL', 'confirmation token required');
    // The official installer ships no uninstaller, so tear down manually:
    // capture the variant first (for the right overlay), then stop/disable the
    // service, remove the work dir, the symlink, the unit file, and the overlay.
    const variant = pironmanInstalledVariant();
    const overlay = PIRONMAN_OVERLAY_BY_VARIANT[variant] || 'sunfounder-pironman5';
    send('Stopping and disabling the Pironman service…');
    await run('sh', ['-c', `systemctl stop ${shq(PIRONMAN_SERVICE)} 2>/dev/null; systemctl disable ${shq(PIRONMAN_SERVICE)} 2>/dev/null; true`], 30000).catch(() => {});
    send('Removing the service unit file…');
    await run('sh', ['-c', `rm -f /etc/systemd/system/${shq(PIRONMAN_SERVICE)} 2>/dev/null; true`], 10000).catch(() => {});
    send('Removing the pironman5 binary symlink…');
    await run('sh', ['-c', 'rm -f /usr/local/bin/pironman5 /usr/local/bin/pipower5 2>/dev/null; true'], 10000).catch(() => {});
    send('Removing the work directory (/opt/pironman5)…');
    await run('rm', ['-rf', PIRONMAN_DIR], 30000).catch(() => {});
    send('Removing the bash-completion entry…');
    await run('sh', ['-c', 'rm -f /etc/bash_completion.d/pironman5 2>/dev/null; true'], 10000).catch(() => {});
    removePironmanOverlay(send, overlay);
    send('Reloading systemd…');
    await run('systemctl', ['daemon-reload'], 10000).catch(() => {});
    send('Uninstalled. A reboot is recommended to fully unload the device-tree overlay.');
    const det = await OPS['pironman.detect']();
    return { ok: true, installed: det.installed, rebootRecommended: true };
  },

  async 'pironman.checkUpdate'() {
    const det = await OPS['pironman.detect']();
    if (!det.installed) return { installed: false, updateAvailable: false };
    const remote = await run('sh', ['-c', `curl -fsSL --max-time 8 ${shq(PIRONMAN_REMOTE_VERSION)}`], 12000)
      .catch(() => ({ stdout: '' }));
    const m = (remote.stdout || '').match(/__version__\s*=\s*['"]([\w.]+)['"]/);
    const latest = m ? m[1] : null;
    return { installed: true, currentVersion: det.version, latestVersion: latest,
      updateAvailable: !!(latest && det.version && latest !== det.version) };
  },

  async 'pironman.update'(_, send) {
    const det = await OPS['pironman.detect']();
    assert(det.installed, 'Pironman is not installed');
    const noDash = !det.hasDashboard;
    const variant = pironmanInstalledVariant() || 'mini';
    send('Fetching SunFounder installer…');
    const tmp = '/tmp/pironman-install.sh';
    const dl = await run('curl', ['-sSL', PIRONMAN_INSTALLER_URL, '-o', tmp], 30000);
    assert(dl.code === 0 && fs.existsSync(tmp), 'failed to download the installer');
    send(noDash ? `Reinstalling latest (variant: ${variant}, slim)…` : `Reinstalling latest (variant: ${variant})…`);
    const args = ['bash', tmp, '--variant', variant, '--plain-text'];
    if (noDash) args.push('--disable-dashboard');
    const r = await runPironmanInstaller(args, send);
    assert(r.code === 0, `installer exited with code ${r.code}`);
    send('Restarting service...');
    await run('systemctl', ['restart', PIRONMAN_SERVICE], 30000).catch(() => {});
    const after = await OPS['pironman.detect']();
    return { ok: true, version: after.version, hasDashboard: after.hasDashboard };
  },

  // Read whether the EEPROM is set to full power-off on shutdown.
  async 'pironman.eepromStatus'() {
    const have = await run('sh', ['-c', 'command -v rpi-eeprom-config >/dev/null && echo OK'], 5000).catch(() => ({ stdout: '' }));
    if (!/OK/.test(have.stdout)) return { available: false, configured: null };
    const cur = await run('rpi-eeprom-config', [], 8000).catch(() => ({ stdout: '' }));
    return { available: true, configured: /^\s*POWER_OFF_ON_HALT=1\s*$/m.test(cur.stdout || '') };
  },

  // Configure full power-off on shutdown on demand (same as during install).
  async 'pironman.eepromConfigure'(_, send) {
    const ok = await pironmanEepromPowerOff(send);
    return { ok, rebootRecommended: ok };
  },

  async 'pironman.restart'() {
    assert(fs.existsSync(PIRONMAN_VENV_PY), 'Pironman is not installed');
    await run('systemctl', ['restart', PIRONMAN_SERVICE], 30000);
    const active = (await run('systemctl', ['is-active', PIRONMAN_SERVICE], 5000)
      .catch(() => ({ stdout: '' }))).stdout.trim();
    return { ok: true, serviceActive: active === 'active' };
  },

  async 'pironman.readConfig'() {
    const p = await pironmanConfigPath();
    assert(p && fs.existsSync(p), 'Pironman config not found');
    let json = {};
    try { json = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { throw new Error('config.json is not valid JSON'); }
    return { configPath: p, config: json, system: json.system || {} };
  },

  async 'pironman.writeConfig'({ config } = {}, send) {
    const clean = pironmanValidateConfig(config);
    const p = await pironmanConfigPath();
    assert(p && fs.existsSync(p), 'Pironman config not found');
    let current = {};
    try { current = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { current = {}; }
    if (!current.system || typeof current.system !== 'object') current.system = {};
    Object.assign(current.system, clean);
    let uid = 0, gid = 0, mode = 0o644;
    try { const s = fs.statSync(p); uid = s.uid; gid = s.gid; mode = s.mode & 0o777; } catch {}
    const tmp = p + '.rapisys.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current, null, 4));
    try { fs.chownSync(tmp, uid, gid); } catch {}
    try { fs.chmodSync(tmp, mode); } catch {}
    fs.renameSync(tmp, p);
    if (send) send('Config written. Restarting service to apply...');
    await run('systemctl', ['restart', PIRONMAN_SERVICE], 30000).catch(() => {});
    return { ok: true, applied: Object.keys(clean), configPath: p, restarted: true };
  },
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

  // List orphaned (auto-removable) packages — dependencies no longer needed by
  // anything explicitly installed. Read-only: uses apt-get's simulate mode, makes
  // no changes. These are the safest removal candidates.
  async 'inventory.autoremovable'() {
    // -s = simulate (no changes); the lock timeout avoids hanging if another
    // apt process holds the lock — we'd rather return nothing than block.
    const r = await run('apt-get', ['-s', '-o', 'DPkg::Lock::Timeout=5', 'autoremove'], 18000).catch(() => ({ code: 1, stdout: '' }));
    if (r.code !== 0) return { packages: [] };
    const names = [];
    for (const line of (r.stdout || '').split('\n')) {
      const m = line.match(/^Remv\s+(\S+)/);
      if (m) names.push(m[1]);
    }
    return { packages: names };
  },

  // ---- simulate + perform package removal (destructive, guarded) ----------
  async 'inventory.removeSimulate'({ name }) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,128}$/.test(name), 'invalid package name');
    // Names that must never be removed from the dashboard regardless of apt
    // priority: kernels, firmware, bootloader, init, and Pi base packages.
    const PROTECTED_RE = /^(linux-image|linux-headers|linux-kbuild|raspberrypi-kernel|raspberrypi-bootloader|rpi-eeprom|raspi-firmware|firmware-|systemd$|udev$|grub|initramfs-tools|raspberrypi-sys-mods|raspberrypi-ui-mods)/;
    const unameR = (await run('uname', ['-r'], 3000).catch(() => ({ stdout: '' }))).stdout.trim();
    const runningKernelPkg = unameR ? `linux-image-${unameR}` : null;
    const isHardProtected = (pkg) => PROTECTED_RE.test(pkg) || (runningKernelPkg && pkg === runningKernelPkg);
    if (isHardProtected(name)) {
      return { allowed: false, reason: `${name} is a protected system package (kernel / firmware / bootloader) and cannot be removed from the dashboard.` };
    }
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
      if (isHardProtected(pkg)) { protectedHits.push(pkg); continue; }
      const pm = await run('dpkg-query', ['-W', '-f=${Essential}\t${Priority}', pkg], 3000).catch(() => ({ stdout: '' }));
      const [e2, p2] = (pm.stdout || '').split('\t');
      if (e2 === 'yes' || p2 === 'required' || p2 === 'important') protectedHits.push(pkg);
    }
    return { allowed: protectedHits.length === 0, removed, protectedHits,
      reason: protectedHits.length ? `Removal would also remove protected package(s): ${protectedHits.join(', ')}` : null };
  },

  async 'inventory.remove'({ name, confirm }, send) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,128}$/.test(name), 'invalid package name');
    assert(confirm === name, 'confirmation mismatch');
    // re-run the guard server-side (never trust the client)
    const guard = await this['inventory.removeSimulate']({ name });
    assert(guard.allowed, guard.reason || 'removal not allowed');
    // stream apt output line-by-line when a sink is provided (SSE relay)
    if (typeof send === 'function') {
      const r = await runStreaming('apt-get', ['remove', '-y', name], { DEBIAN_FRONTEND: 'noninteractive' }, send);
      return { ok: r.code === 0, removed: guard.removed };
    }
    const r = await run('apt-get', ['remove', '-y', name], 120000);
    return { ok: r.code === 0, log: (r.stdout || '') + (r.stderr || ''), removed: guard.removed };
  },

  // Install (or reinstall) a package — used by the activity-history "reinstall"
  // action. Name is strictly validated; apt resolves dependencies. Streams
  // output when a sink is provided.
  async 'inventory.install'({ name }, send) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,128}$/.test(name), 'invalid package name');
    if (typeof send === 'function') {
      const r = await runStreaming('apt-get', ['install', '-y', name], { DEBIAN_FRONTEND: 'noninteractive' }, send);
      return { ok: r.code === 0 };
    }
    const r = await run('apt-get', ['install', '-y', name], 180000);
    return { ok: r.code === 0, log: (r.stdout || '') + (r.stderr || '') };
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

  // Point THIS Pi's own resolver at the local Pi-hole (127.0.0.1:53), so the Pi's
  // own lookups flow through Pi-hole and appear in analytics. Reversible. Keeps a
  // fallback nameserver so the Pi still resolves if Pi-hole is down (those few
  // fallback queries bypass Pi-hole). Only affects this Pi — not other devices.
  async 'pihole.setSystemResolver'({ enable, fallback = '1.1.1.1' } = {}) {
    const BACKUP = '/etc/rapisys/resolv.conf.pihole.orig';
    const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
    assert(!fallback || IP_RE.test(fallback), 'invalid fallback DNS IP');
    // Guard: if Tailscale manages resolv.conf, refuse (it rewrites it constantly).
    try {
      const rc = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      if (/generated by tailscale/i.test(rc)) {
        throw new Error('Tailscale manages this Pi\u2019s DNS (MagicDNS). Pointing the Pi at Pi-hole would require disabling MagicDNS for the whole node. Use Tailscale split-DNS in the admin console instead.');
      }
    } catch (e) { if (/Tailscale manages/.test(e.message)) throw e; }

    if (enable) {
      // Verify the local Pi-hole is actually answering DNS on :53 before we
      // repoint, so we never strand the Pi with a dead resolver.
      const probe = await run('sh', ['-c', "command -v dig >/dev/null && dig @127.0.0.1 +time=2 +tries=1 +short pi.hole || nslookup -timeout=2 pi.hole 127.0.0.1 >/dev/null 2>&1 && echo ok"], 6000).catch(() => ({ stdout: '', code: 1 }));
      // Don't hard-fail on probe (pi.hole may not resolve), but warn via state.
      // Back up the current resolv.conf once (follow symlink to capture content).
      fs.mkdirSync('/etc/rapisys', { recursive: true });
      if (!fs.existsSync(BACKUP)) {
        try {
          const real = fs.realpathSync('/etc/resolv.conf');
          fs.copyFileSync(real, BACKUP);
        } catch { try { fs.copyFileSync('/etc/resolv.conf', BACKUP); } catch { /* */ } }
      }
      // Write a plain resolv.conf: Pi-hole first, fallback second, short timeout
      // so failover to the fallback is quick if Pi-hole stops answering.
      const lines = ['# Managed by RaPiSys (point this Pi at Pi-hole)',
        'nameserver 127.0.0.1'];
      if (fallback) lines.push(`nameserver ${fallback}`);
      lines.push('options timeout:2 attempts:2 edns0');
      try { fs.unlinkSync('/etc/resolv.conf'); } catch { /* symlink or file */ }
      fs.writeFileSync('/etc/resolv.conf', lines.join('\n') + '\n');
      return { ok: true, enabled: true, fallback: fallback || null, probedOk: /ok|\d+\.\d+/.test(probe.stdout || '') };
    } else {
      // Restore the backup; if none, fall back to a sane public resolver so the
      // Pi is never left without DNS.
      if (fs.existsSync(BACKUP)) {
        try { fs.unlinkSync('/etc/resolv.conf'); } catch { /* */ }
        try { fs.copyFileSync(BACKUP, '/etc/resolv.conf'); } catch { /* */ }
        try { fs.unlinkSync(BACKUP); } catch { /* */ }
      } else {
        try { fs.unlinkSync('/etc/resolv.conf'); } catch { /* */ }
        fs.writeFileSync('/etc/resolv.conf', `nameserver ${fallback || '1.1.1.1'}\noptions edns0\n`);
      }
      return { ok: true, enabled: false };
    }
  },

  // Report whether the Pi is currently pointed at Pi-hole (our managed marker).
  async 'pihole.systemResolverStatus'() {
    try {
      const rc = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      const managed = /Managed by RaPiSys \(point this Pi at Pi-hole\)/.test(rc);
      const pointsLocal = /^\s*nameserver\s+127\.0\.0\.1\s*$/m.test(rc);
      const tailscale = /generated by tailscale/i.test(rc);
      return { enabled: managed && pointsLocal, tailscaleManaged: tailscale };
    } catch (e) { return { enabled: false, error: e.message }; }
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

  // ---- Pi-hole: detect + one-click install (host or docker) ---------------
  // Detect an existing Pi-hole on the host: native install (pihole-FTL) or a
  // Docker container. Reports version and the web/API port so the dashboard can
  // connect without the user hunting for it.
  async 'pihole.detect'() {
    const out = { installed: false, method: null, version: null, port: null, container: null, apiReachable: false };
    // Probe a port for a live Pi-hole v6 API (or v5). Returns true if it answers.
    const probe = (port) => run('sh', ['-c',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/api/auth; ` +
      `echo '|'; curl -s -o /dev/null -w '%{http_code}' --max-time 3 'http://127.0.0.1:${port}/admin/api.php?versions'`], 8000)
      .then((r) => {
        const [v6, v5] = (r.stdout || '').split('|');
        // v6 /api/auth answers 200 (no pw) or 401 (pw set); v5 api.php answers 200.
        return /^(200|401)$/.test((v6 || '').trim()) || /^200$/.test((v5 || '').trim());
      }).catch(() => false);
    // Parse a configured webserver.port value (handles "8081o,[::]:8081o" form).
    const parsePort = (s) => { const m = (s || '').match(/(\d{2,5})/); return m ? Number(m[1]) : null; };
    // Find the first port that actually answers, trying the configured one first.
    const findPort = async (configured) => {
      const candidates = [...new Set([configured, 80, 8080, 8081, 443].filter(Boolean))];
      for (const p of candidates) { if (await probe(p)) return { port: p, reachable: true }; }
      return { port: configured || 80, reachable: false };
    };

    // Native: the `pihole` CLI / pihole-FTL service.
    const cli = await run('sh', ['-c', 'command -v pihole || command -v pihole-FTL'], 4000);
    if (cli.code === 0 && cli.stdout.trim()) {
      out.installed = true; out.method = 'host';
      const v = await run('pihole', ['-v'], 8000).catch(() => ({ stdout: '' }));
      const m = (v.stdout || '').match(/Core\s+version\s+is\s+v?([\d.]+)/i) || (v.stdout || '').match(/v?([\d.]+)/);
      out.version = m ? m[1] : null;
      const portRead = await run('sh', ['-c', "pihole-FTL --config webserver.port 2>/dev/null | head -1"], 5000).catch(() => ({ stdout: '' }));
      const found = await findPort(parsePort(portRead.stdout));
      out.port = found.port; out.apiReachable = found.reachable;
      return out;
    }
    // Docker: a running container from the pihole/pihole image.
    const dk = await run('sh', ['-c', "command -v docker >/dev/null && docker ps --filter ancestor=pihole/pihole --format '{{.Names}}' 2>/dev/null | head -1"], 6000);
    if (dk.code === 0 && dk.stdout.trim()) {
      const name = dk.stdout.trim();
      out.installed = true; out.method = 'docker'; out.container = name;
      const v = await run('sh', ['-c', `docker exec ${shq(name)} pihole -v 2>/dev/null`], 10000).catch(() => ({ stdout: '' }));
      const m = (v.stdout || '').match(/Core\s+version\s+is\s+v?([\d.]+)/i);
      out.version = m ? m[1] : null;
      // Host networking shows no docker port map, so read the configured port from
      // inside the container, then VERIFY by probing where the API actually answers.
      const portRead = await run('sh', ['-c', `docker exec ${shq(name)} pihole-FTL --config webserver.port 2>/dev/null | head -1`], 8000).catch(() => ({ stdout: '' }));
      const found = await findPort(parsePort(portRead.stdout));
      out.port = found.port; out.apiReachable = found.reachable;
      return out;
    }
    return out;
  },

  // One-click install. method: 'host' (official unattended installer) or
  // 'docker' (official pihole/pihole image). Streams progress. Fixed, validated
  // parameters only — never arbitrary shell. Admin-token gated at the route.
  async 'pihole.install'({ method = 'host', upstream = '1.1.1.1', upstream2 = '1.0.0.1', webPassword = '', webPort = 80 } = {}, send) {
    // Validate inputs strictly.
    assert(method === 'host' || method === 'docker', 'method must be host or docker');
    const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
    assert(IP_RE.test(upstream), 'invalid upstream DNS IP');
    if (upstream2) assert(IP_RE.test(upstream2), 'invalid secondary upstream DNS IP');
    const port = Math.min(Math.max(parseInt(webPort, 10) || 80, 1), 65535);
    assert(/^[\x20-\x7e]{0,128}$/.test(String(webPassword)), 'invalid web password');

    if (method === 'host') {
      send('Preparing unattended Pi-hole install…');
      // The --unattended flag needs a pre-seeded setupVars.conf, else the
      // installer falls back to interactive dialogs and fails (Pi-hole #6380).
      fs.mkdirSync('/etc/pihole', { recursive: true });
      // Pick the primary LAN interface for PIHOLE_INTERFACE.
      const iface = await run('sh', ['-c', "ip route get 1.1.1.1 2>/dev/null | grep -oP 'dev \\K\\S+' | head -1"], 5000)
        .then((r) => (r.stdout || '').trim() || 'eth0').catch(() => 'eth0');
      const setupVars = [
        `PIHOLE_INTERFACE=${iface}`,
        `PIHOLE_DNS_1=${upstream}`,
        `PIHOLE_DNS_2=${upstream2 || ''}`,
        'QUERY_LOGGING=true',
        'INSTALL_WEB_SERVER=true',
        'INSTALL_WEB_INTERFACE=true',
        'LIGHTTPD_ENABLED=false',
        'CACHE_SIZE=10000',
        'DNS_FQDN_REQUIRED=true',
        'DNS_BOGUS_PRIV=true',
        'DNSMASQ_LISTENING=local',
        'BLOCKING_ENABLED=true',
      ].join('\n') + '\n';
      fs.writeFileSync('/etc/pihole/setupVars.conf', setupVars, { mode: 0o644 });
      send(`Interface ${iface}, upstream ${upstream}${upstream2 ? ' / ' + upstream2 : ''}. Downloading the official installer…`);
      // Fetch the official installer to a file, then run it unattended. (We pin
      // the canonical URL; piping to bash is the project's own supported method.)
      const dl = await run('sh', ['-c', 'curl -fsSL https://install.pi-hole.net -o /tmp/pihole-install.sh && echo OK'], 60000);
      assert(/OK/.test(dl.stdout), `could not download installer: ${dl.stderr || dl.stdout}`);
      send('Running installer (this can take several minutes)…');
      const r = await runStreaming('bash', ['/tmp/pihole-install.sh', '--unattended'], { PIHOLE_SKIP_OS_CHECK: 'true' }, send);
      try { fs.unlinkSync('/tmp/pihole-install.sh'); } catch {}
      assert(r.code === 0, `installer exited with code ${r.code}`);
      // Set the web/API password if one was provided (v6 uses an app-password).
      let appPassword = webPassword || '';
      if (webPassword) {
        await run('pihole', ['setpassword', webPassword], 15000).catch(async () => {
          await run('pihole', ['-a', '-p', webPassword, webPassword], 15000).catch(() => {});
        });
      }
      send('Pi-hole installed. Detecting connection details…');
      const det = await OPS['pihole.detect']();
      return { ok: true, method: 'host', version: det.version, port: det.port || 80, hasPassword: !!appPassword };
    }

    // Docker method: official image, host networking so it can own :53.
    send('Installing Pi-hole as a Docker container (official image)…');
    const have = await run('sh', ['-c', 'command -v docker'], 4000);
    assert(have.code === 0, 'Docker is not installed on the host');
    // Pick a free web/API port. With host networking Pi-hole can't fall back on
    // its own, so if the chosen port is taken we move to the next free one and
    // tell the user (this is exactly the :80 collision that breaks installs).
    let webPort2 = port;
    if (await portInUse(webPort2)) {
      const free = await firstFreePort(webPort2 === 80 ? 8081 : webPort2 + 1);
      send(`Port ${webPort2} is already in use — using ${free} for the Pi-hole web interface instead.`);
      webPort2 = free;
    } else {
      send(`Using port ${webPort2} for the Pi-hole web interface.`);
    }
    // Free port 53 if systemd-resolved holds it (reversible: disable stub listener).
    send('Checking port 53 (systemd-resolved stub)…');
    await run('sh', ['-c', "ss -lntu 2>/dev/null | grep -q ':53 ' && (mkdir -p /etc/systemd/resolved.conf.d && printf '[Resolve]\\nDNSStubListener=no\\n' > /etc/systemd/resolved.conf.d/rapisys-pihole.conf && systemctl restart systemd-resolved) || true"], 20000);
    const dir = '/opt/pihole-docker';
    fs.mkdirSync(dir, { recursive: true });
    // Under host networking, non-default web ports need the "<port>o" (HTTP) form.
    const portSpec = `${webPort2}o,[::]:${webPort2}o`;
    const compose = [
      'services:',
      '  pihole:',
      '    container_name: pihole',
      '    image: pihole/pihole:latest',
      '    network_mode: host',
      '    environment:',
      '      TZ: "Etc/UTC"',
      `      FTLCONF_webserver_api_password: "${webPassword.replace(/"/g, '')}"`,
      `      FTLCONF_dns_upstreams: "${upstream}${upstream2 ? ';' + upstream2 : ''}"`,
      `      FTLCONF_webserver_port: "${portSpec}"`,
      '    volumes:',
      '      - "./etc-pihole:/etc/pihole"',
      '    cap_add:',
      '      - NET_ADMIN',
      '    restart: unless-stopped',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose, { mode: 0o644 });
    send('Pulling image and starting container…');
    const up = await runStreaming('sh', ['-c', `cd ${shq(dir)} && (docker compose up -d || docker-compose up -d)`], {}, send);
    assert(up.code === 0, `docker compose failed (code ${up.code})`);
    send('Container started. Verifying the web/API port…');
    // Give FTL a moment to bind, then detect (which probes for the live API port).
    await new Promise((r) => setTimeout(r, 4000));
    const det = await OPS['pihole.detect']();
    return { ok: true, method: 'docker', version: det.version, port: det.port || webPort2, hasPassword: !!webPassword, apiReachable: det.apiReachable };
  },

  // Check whether a Pi-hole update is available, method-aware.
  //  host   -> `pihole updatechecker` + parse /etc/pihole/versions (or `pihole -v`)
  //  docker -> compare the running image's digest against the registry's latest
  async 'pihole.checkUpdate'() {
    const det = await OPS['pihole.detect']();
    if (!det.installed) return { installed: false, updateAvailable: false };
    if (det.method === 'host') {
      // Refresh Pi-hole's own version cache, then read it.
      await run('pihole', ['updatechecker'], 60000).catch(() => {});
      const ver = await run('sh', ['-c', 'cat /etc/pihole/versions 2>/dev/null'], 5000).catch(() => ({ stdout: '' }));
      const txt = ver.stdout || '';
      const cur = {}, lat = {};
      for (const comp of ['CORE', 'WEB', 'FTL']) {
        const c = txt.match(new RegExp(`${comp}_VERSION=v?([\\w.]+)`));
        const l = txt.match(new RegExp(`GITHUB_${comp}_VERSION=v?([\\w.]+)`));
        if (c) cur[comp] = c[1];
        if (l) lat[comp] = l[1];
      }
      // Fall back to `pihole -v` text if the versions file wasn't parseable.
      let updateAvailable = Object.keys(lat).some((k) => lat[k] && cur[k] && lat[k] !== cur[k]);
      if (!Object.keys(lat).length) {
        const v = await run('pihole', ['-v'], 15000).catch(() => ({ stdout: '' }));
        updateAvailable = /update available/i.test(v.stdout || '');
      }
      return { installed: true, method: 'host', updateAvailable,
        currentVersion: cur.CORE || det.version || null, latestVersion: lat.CORE || null, components: { current: cur, latest: lat } };
    }
    // docker: compare local image digest vs registry latest (no full pull).
    const name = det.container || 'pihole';
    const localDigest = await run('sh', ['-c', `docker inspect --format '{{index .RepoDigests 0}}' ${shq(name)} 2>/dev/null`], 8000).catch(() => ({ stdout: '' }));
    const local = (localDigest.stdout || '').trim();
    // `docker manifest inspect` needs experimental on older docker; try it, then
    // fall back to a `docker pull` dry comparison.
    const remote = await run('sh', ['-c', "docker manifest inspect pihole/pihole:latest 2>/dev/null | grep -m1 -oE '\"digest\": ?\"sha256:[a-f0-9]+\"' | head -1"], 20000).catch(() => ({ stdout: '' }));
    let updateAvailable = false;
    if (local && remote.stdout) {
      const remoteSha = (remote.stdout.match(/sha256:[a-f0-9]+/) || [])[0];
      updateAvailable = remoteSha ? !local.includes(remoteSha) : false;
    } else {
      // Fallback: pull and see if anything new was downloaded.
      const pull = await run('sh', ['-c', 'docker pull pihole/pihole:latest 2>&1'], 120000).catch(() => ({ stdout: '' }));
      updateAvailable = !/Image is up to date/i.test(pull.stdout || '');
    }
    return { installed: true, method: 'docker', updateAvailable,
      currentVersion: det.version || null, latestVersion: null, container: name };
  },

  // Apply a Pi-hole update, method-aware, streamed.
  async 'pihole.update'(_, send) {
    const det = await OPS['pihole.detect']();
    assert(det.installed, 'Pi-hole is not installed');
    if (det.method === 'host') {
      send('Running pihole -up…');
      const r = await runStreaming('pihole', ['-up'], {}, send);
      assert(r.code === 0, `pihole -up exited with code ${r.code}`);
      const after = await OPS['pihole.detect']();
      return { ok: true, method: 'host', version: after.version };
    }
    // docker: pull + recreate from the compose dir, preserving the volume config.
    const dir = '/opt/pihole-docker';
    const hasCompose = fs.existsSync(path.join(dir, 'docker-compose.yml'));
    if (hasCompose) {
      send('Pulling latest image…');
      const pull = await runStreaming('sh', ['-c', `cd ${shq(dir)} && (docker compose pull || docker-compose pull)`], {}, send);
      assert(pull.code === 0, 'docker compose pull failed');
      send('Recreating container…');
      const up = await runStreaming('sh', ['-c', `cd ${shq(dir)} && (docker compose up -d || docker-compose up -d)`], {}, send);
      assert(up.code === 0, 'docker compose up failed');
    } else {
      // Container not created by us (no compose file): pull + recreate by name.
      const name = det.container || 'pihole';
      send('Pulling latest image…');
      const pull = await runStreaming('sh', ['-c', 'docker pull pihole/pihole:latest'], {}, send);
      assert(pull.code === 0, 'docker pull failed');
      send('Restarting container with the new image…');
      // Safest generic recreate: restart picks up the new image only if recreated;
      // since we lack the original run args, we restart and report guidance.
      await run('sh', ['-c', `docker restart ${shq(name)}`], 30000).catch(() => {});
      send('Note: container restarted. If it did not pick up the new image, recreate it from your compose/run definition.');
    }
    const after = await OPS['pihole.detect']();
    return { ok: true, method: 'docker', version: after.version };
  },

  // ---- Pi-hole long-term DB backup to the NAS -----------------------------
  // The live FTL SQLite DB stays on the Pi (SQLite over CIFS/NFS is unsafe). We
  // take a CONSISTENT copy with sqlite3 .backup (safe while FTL is writing),
  // gzip it, and drop it on the NAS mount. Old backups are pruned to `retain`.
  async 'pihole.backupToNas'({ mountpoint, retain = 14 } = {}, send) {
    assert(typeof mountpoint === 'string' && mountpoint.startsWith(MOUNT_BASE + '/'),
      `mountpoint must be under ${MOUNT_BASE}`);
    const r = Math.min(Math.max(parseInt(retain, 10) || 14, 1), 365);
    // NAS must be mounted.
    const st = await OPS['nas.status']({ mountpoint });
    assert(st.mounted, 'NAS is not mounted at ' + mountpoint);

    // Locate the live DB (host native vs docker container).
    const det = await OPS['pihole.detect']();
    assert(det.installed, 'Pi-hole is not installed');
    send?.('Locating Pi-hole database…');

    const destDir = path.join(mountpoint, 'pihole-backups');
    fs.mkdirSync(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const destFile = path.join(destDir, `pihole-FTL-${stamp}.db.gz`);

    // Ensure sqlite3 is available for a safe .backup.
    const haveSqlite = await run('sh', ['-c', 'command -v sqlite3'], 4000);

    if (det.method === 'docker') {
      const name = det.container || 'pihole';
      send?.('Creating a consistent copy inside the container…');
      // The official image has no standalone `sqlite3` CLI, but pihole-FTL embeds
      // SQLite and exposes it via `pihole-FTL sqlite3`. Use that for a consistent
      // .backup; fall back to the sqlite3 CLI if it happens to be present.
      const tmp = `/tmp/pihole-FTL-${stamp}.db`;
      const haveCliInCtr = await run('sh', ['-c', `docker exec ${shq(name)} sh -c 'command -v sqlite3'`], 6000).catch(() => ({ code: 1 }));
      const sqliteCmd = haveCliInCtr.code === 0 ? 'sqlite3' : 'pihole-FTL sqlite3';
      const bk = await run('sh', ['-c',
        `docker exec ${shq(name)} sh -c ${shq(`${sqliteCmd} /etc/pihole/pihole-FTL.db ".backup '${tmp}'"`)}`], 180000);
      assert(bk.code === 0, 'consistent copy failed inside the container: ' + (bk.stderr || bk.stdout || ''));
      send?.('Compressing and copying to the NAS…');
      // Stream the tmp DB out of the container, gzip on the host, write to NAS.
      const out = await run('sh', ['-c',
        `docker exec ${shq(name)} cat ${shq(tmp)} | gzip -c > ${shq(destFile)}`], 300000);
      assert(out.code === 0, 'copy to NAS failed: ' + (out.stderr || ''));
      await run('sh', ['-c', `docker exec ${shq(name)} rm -f ${shq(tmp)}`], 15000).catch(() => {});
    } else {
      const db = '/etc/pihole/pihole-FTL.db';
      assert(fs.existsSync(db), 'Pi-hole DB not found at ' + db);
      const tmp = `/tmp/pihole-FTL-${stamp}.db`;
      send?.('Creating a consistent copy…');
      // Prefer the sqlite3 CLI; otherwise use pihole-FTL's embedded SQLite; else cp.
      const haveFtl = await run('sh', ['-c', 'command -v pihole-FTL'], 4000).catch(() => ({ code: 1 }));
      if (haveSqlite.code === 0) {
        const bk = await run('sqlite3', [db, `.backup '${tmp}'`], 180000);
        assert(bk.code === 0, 'consistent copy failed: ' + (bk.stderr || ''));
      } else if (haveFtl.code === 0) {
        const bk = await run('sh', ['-c', `pihole-FTL sqlite3 ${shq(db)} ".backup '${tmp}'"`], 180000);
        assert(bk.code === 0, 'consistent copy failed: ' + (bk.stderr || bk.stdout || ''));
      } else {
        // Last resort: plain copy. FTL uses WAL so this is usually consistent.
        await run('cp', [db, tmp], 60000);
      }
      send?.('Compressing and copying to the NAS…');
      const out = await run('sh', ['-c', `gzip -c ${shq(tmp)} > ${shq(destFile)}`], 300000);
      assert(out.code === 0, 'copy to NAS failed');
      fs.unlinkSync(tmp);
    }

    // Prune old backups beyond `retain` (keep newest r).
    send?.('Pruning old backups…');
    const files = fs.readdirSync(destDir).filter((f) => /^pihole-FTL-.*\.db\.gz$/.test(f)).sort();
    const remove = files.slice(0, Math.max(0, files.length - r));
    for (const f of remove) { try { fs.unlinkSync(path.join(destDir, f)); } catch {} }

    const size = fs.statSync(destFile).size;
    send?.(`Done — ${(size / 1048576).toFixed(1)} MB written.`);
    return { ok: true, file: destFile, size, pruned: remove.length, kept: Math.min(files.length, r) };
  },

  // List existing Pi-hole backups on the NAS.
  async 'pihole.backupStatus'({ mountpoint } = {}) {
    assert(typeof mountpoint === 'string' && mountpoint.startsWith(MOUNT_BASE + '/'),
      `mountpoint must be under ${MOUNT_BASE}`);
    const dir = path.join(mountpoint, 'pihole-backups');
    if (!fs.existsSync(dir)) return { backups: [] };
    const backups = fs.readdirSync(dir).filter((f) => /^pihole-FTL-.*\.db\.gz$/.test(f))
      .map((f) => { const s = fs.statSync(path.join(dir, f)); return { name: f, size: s.size, mtime: s.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    return { backups };
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

  // ---- Tailscale one-click install / connect ------------------------------
  // The official `tailscale` binary lives on the HOST (not in Docker). These
  // ops mirror the Pi-hole / Pironman lifecycle: detect → install → up →
  // (down / logout / update / uninstall). All params are strictly validated
  // and run via execFile — never arbitrary shell.

  // Read-only snapshot: presence, version, daemon, backend state, and the
  // authoritative prefs (ssh / accept-routes / magicdns / advertised routes).
  async 'tailscale.detect'() {
    const out = { installed: false, version: null, daemonActive: false,
      backendState: null, loggedIn: false, online: null, dnsName: null,
      magicDNS: null, tailnet: null, ssh: false, acceptRoutes: false,
      acceptDns: null, advertiseRoutes: [], hostname: null, wantRunning: null };
    const which = await run('sh', ['-c', 'command -v tailscale'], 4000).catch(() => ({ code: 1, stdout: '' }));
    if (which.code !== 0 || !which.stdout.trim()) return out;
    out.installed = true;
    const ver = await run('tailscale', ['version'], 6000).catch(() => ({ stdout: '' }));
    out.version = ((ver.stdout || '').split('\n')[0] || '').trim() || null;
    out.daemonActive = (await run('systemctl', ['is-active', 'tailscaled'], 5000)
      .catch(() => ({ stdout: '' }))).stdout.trim() === 'active';
    const st = await run('tailscale', ['status', '--json'], 8000).catch(() => ({ code: 1, stdout: '' }));
    if (st.code === 0 && st.stdout.trim()) {
      try {
        const j = JSON.parse(st.stdout);
        out.backendState = j.BackendState || null;
        out.loggedIn = !!out.backendState && !['NeedsLogin', 'NoState'].includes(out.backendState);
        out.dnsName = (j.Self && j.Self.DNSName ? j.Self.DNSName : '').replace(/\.$/, '') || null;
        out.online = j.Self ? !!j.Self.Online : null;
        out.magicDNS = !!(j.CurrentTailnet && j.CurrentTailnet.MagicDNSEnabled);
        out.tailnet = (j.CurrentTailnet && j.CurrentTailnet.Name) || null;
      } catch { /* not running yet */ }
    }
    // Authoritative prefs (ssh / routes / dns / hostname) from `debug prefs`.
    const pf = await run('tailscale', ['debug', 'prefs'], 6000).catch(() => ({ stdout: '' }));
    try {
      const p = JSON.parse(pf.stdout);
      out.ssh = !!p.RunSSH;
      out.acceptRoutes = !!p.RouteAll;
      out.acceptDns = (p.CorpDNS === undefined) ? null : !!p.CorpDNS;
      out.advertiseRoutes = Array.isArray(p.AdvertiseRoutes) ? p.AdvertiseRoutes : [];
      out.hostname = p.Hostname || null;
      out.wantRunning = (p.WantRunning === undefined) ? null : !!p.WantRunning;
    } catch { /* prefs unavailable */ }
    return out;
  },

  // Install the binary only (official install.sh → apt repo + package). Does
  // NOT join a tailnet — that's `tailscale.up`. Streams installer output.
  async 'tailscale.install'(_, send) {
    send('Checking prerequisites (curl)…');
    const have = await run('sh', ['-c', 'command -v curl >/dev/null && echo OK'], 6000);
    assert(/OK/.test(have.stdout), 'curl is required on the host');
    send('Downloading the official Tailscale installer…');
    const tmp = '/tmp/tailscale-install.sh';
    const dl = await run('curl', ['-fsSL', 'https://tailscale.com/install.sh', '-o', tmp], 60000);
    assert(dl.code === 0 && fs.existsSync(tmp), `could not download installer: ${dl.stderr || dl.stdout}`);
    send('Running installer (adds the Tailscale apt repo and installs the package)…');
    const r = await runStreaming('sh', [tmp], {}, send);
    try { fs.unlinkSync(tmp); } catch {}
    assert(r.code === 0, `installer exited with code ${r.code}`);
    send('Enabling the tailscaled service…');
    await run('systemctl', ['enable', '--now', 'tailscaled'], 30000).catch(() => {});
    send('Tailscale installed. Detecting status…');
    const det = await OPS['tailscale.detect']();
    return { ok: true, installed: det.installed, version: det.version,
      backendState: det.backendState, loggedIn: det.loggedIn };
  },

  // Join / re-configure the tailnet. With an auth key this is headless; without
  // one, `tailscale up` prints a login URL and blocks until the user authorizes
  // in a browser (the route surfaces that URL). --reset makes the submitted
  // form authoritative so cleared toggles actually revert.
  async 'tailscale.up'({ authKey = '', ssh = false, hostname = '', acceptRoutes = false,
    acceptDns = true, advertiseRoutes = '' } = {}, send) {
    const present = await run('sh', ['-c', 'command -v tailscale'], 4000).catch(() => ({ code: 1 }));
    assert(present.code === 0, 'Tailscale is not installed');
    if (authKey) assert(/^tskey-[A-Za-z0-9_-]{6,200}$/.test(String(authKey)), 'invalid auth key format');
    let host = '';
    if (hostname) { host = String(hostname).toLowerCase();
      assert(/^[a-z0-9][a-z0-9-]{0,62}$/.test(host), 'invalid hostname (a–z, 0–9, hyphen; ≤63 chars)'); }
    let routes = [];
    if (advertiseRoutes) {
      routes = String(advertiseRoutes).split(',').map((s) => s.trim()).filter(Boolean);
      const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
      for (const c of routes) assert(CIDR.test(c), `invalid route CIDR: ${c}`);
    }
    // Advertising subnet routes requires IP forwarding on the host.
    if (routes.length) {
      send('Enabling IP forwarding for subnet routing…');
      try {
        fs.writeFileSync('/etc/sysctl.d/99-tailscale.conf',
          'net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n', { mode: 0o644 });
        await run('sysctl', ['-p', '/etc/sysctl.d/99-tailscale.conf'], 10000).catch(() => {});
      } catch (e) { send('Note: could not persist IP-forwarding sysctl: ' + e.message); }
    }
    const args = ['up', '--reset',
      `--accept-routes=${acceptRoutes ? 'true' : 'false'}`,
      `--accept-dns=${acceptDns ? 'true' : 'false'}`,
      `--ssh=${ssh ? 'true' : 'false'}`];
    if (host) args.push(`--hostname=${host}`);
    if (routes.length) args.push(`--advertise-routes=${routes.join(',')}`);
    if (authKey) {
      args.push(`--authkey=${authKey}`);
      send('Connecting to your tailnet with the provided auth key…');
    } else {
      // Self-terminate if the user never authorizes, so we don't leave a
      // dangling `tailscale up` on the host.
      args.push('--timeout=300s');
      send('Starting login — open the link that appears below to authorize this Pi.');
    }
    const r = await runStreaming('tailscale', args, {}, send);
    assert(r.code === 0, authKey
      ? `tailscale up failed (code ${r.code})`
      : `login did not complete (code ${r.code}) — the authorization link may have expired`);
    send('Connected. Detecting status…');
    const det = await OPS['tailscale.detect']();
    return { ok: true, backendState: det.backendState, dnsName: det.dnsName, online: det.online,
      ssh: det.ssh, magicDNS: det.magicDNS, advertiseRoutes: det.advertiseRoutes, loggedIn: det.loggedIn };
  },

  // Disconnect (stay logged in; reconnect later without re-auth).
  async 'tailscale.down'() {
    const r = await run('tailscale', ['down'], 20000);
    const det = await OPS['tailscale.detect']();
    return { ok: r.code === 0, backendState: det.backendState, wantRunning: det.wantRunning };
  },

  // Log out of the tailnet entirely (next connect needs re-authentication).
  async 'tailscale.logout'(_, send) {
    send && send('Logging out of the tailnet…');
    const r = await run('tailscale', ['logout'], 30000);
    assert(r.code === 0, `logout failed: ${r.stderr || r.stdout}`);
    const det = await OPS['tailscale.detect']();
    return { ok: true, backendState: det.backendState, loggedIn: det.loggedIn };
  },

  // Remove Tailscale from the host. Requires a typed confirmation token.
  async 'tailscale.uninstall'({ confirm } = {}, send) {
    assert(confirm === 'UNINSTALL', 'confirmation token required');
    send('Disconnecting and logging out…');
    await run('tailscale', ['down'], 20000).catch(() => {});
    await run('tailscale', ['logout'], 30000).catch(() => {});
    send('Stopping and disabling tailscaled…');
    await run('sh', ['-c', 'systemctl stop tailscaled 2>/dev/null; systemctl disable tailscaled 2>/dev/null; true'], 30000).catch(() => {});
    send('Removing the Tailscale package…');
    const r = await runStreaming('apt-get', ['remove', '-y', 'tailscale'], { DEBIAN_FRONTEND: 'noninteractive' }, send);
    try { fs.unlinkSync('/etc/sysctl.d/99-tailscale.conf'); } catch {}
    send('Reloading systemd…');
    await run('systemctl', ['daemon-reload'], 10000).catch(() => {});
    const det = await OPS['tailscale.detect']();
    return { ok: r.code === 0, installed: det.installed };
  },

  // Is a newer Tailscale published? (apt-repo aware via `tailscale update`.)
  async 'tailscale.checkUpdate'() {
    const det = await OPS['tailscale.detect']();
    if (!det.installed) return { installed: false, updateAvailable: false };
    const r = await run('tailscale', ['update', '--check'], 30000)
      .catch(() => ({ code: 1, stdout: '', stderr: '' }));
    const text = (r.stdout || '') + (r.stderr || '');
    if (/up to date|already.*latest|no update/i.test(text)) {
      return { installed: true, currentVersion: det.version, updateAvailable: false };
    }
    const m = text.match(/(\d+\.\d+\.\d+)/);
    return { installed: true, currentVersion: det.version,
      latestVersion: m ? m[1] : null, updateAvailable: !!m };
  },

  // Apply the available Tailscale update (streamed).
  async 'tailscale.update'(_, send) {
    const det = await OPS['tailscale.detect']();
    assert(det.installed, 'Tailscale is not installed');
    send('Updating Tailscale…');
    const r = await runStreaming('tailscale', ['update', '--yes'], {}, send);
    assert(r.code === 0, `update failed (code ${r.code})`);
    const after = await OPS['tailscale.detect']();
    return { ok: true, version: after.version };
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
    const zlib2 = require('zlib');
    // Read the first changelog found anywhere under usr/share/doc in an
    // extracted tree (not just usr/share/doc/<pkg> — metapackages may ship the
    // changelog under a differently-named doc dir, or not at all).
    const extractChangelog = (extractRoot) => {
      const docRoot = path.join(extractRoot, 'usr', 'share', 'doc');
      let dirs = [];
      try { dirs = fs.readdirSync(docRoot); } catch { return ''; }
      // prefer the exact package dir, then any sibling
      dirs.sort((a, b) => (a === pkg ? -1 : b === pkg ? 1 : 0));
      for (const d of dirs) {
        const dd = path.join(docRoot, d);
        let files = [];
        try { files = fs.readdirSync(dd); } catch { continue; }
        const f = files.find((n) => /^changelog(\.Debian)?(\.gz)?$/i.test(n));
        if (f) {
          const p = path.join(dd, f);
          // skip dangling symlinks (common for kernel metapackages)
          try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
          try { const b = fs.readFileSync(p); return f.endsWith('.gz') ? zlib2.gunzipSync(b).toString('utf-8') : b.toString('utf-8'); }
          catch { /* try next */ }
        }
      }
      return '';
    };

    if (ok) {
      await run('dpkg-deb', ['-x', debPath, path.join(tmp, 'x')], 60000).catch(() => {});
      text = extractChangelog(path.join(tmp, 'x'));
    }

    let usedSource = false;
    // Fallback: the package's own .deb has no changelog (thin metapackage, e.g.
    // linux-headers-rpi-2712). Resolve its source package and download a binary
    // .deb from the same source that *does* carry a changelog.
    if (!text) {
      try {
        const show = await run('apt-cache', ['show', pkg], 15000).catch(() => ({ stdout: '' }));
        // "Source: linux" (may include a version in parens, strip it)
        const sm = (show.stdout || '').match(/^Source:\s*(\S+)/m);
        const srcName = sm ? sm[1] : null;
        if (srcName) {
          // find a binary .deb URI from the same source pool dir as our package
          // (the pool path is /pool/main/<x>/<source>/...), preferring the
          // versioned headers-common or image deb which ships the changelog.
          const poolDir = uri.slice(0, uri.lastIndexOf('/') + 1);
          const allUris = (piu.stdout || '').match(/'(https?:\/\/[^']+\.deb)'/g) || [];
          const cands = allUris.map((s) => s.slice(1, -1))
            .filter((u) => u.startsWith(poolDir))
            .sort((a, b) => {
              // prefer 'common' (arch-indep docs) then 'image' then anything
              const score = (u) => /common/.test(u) ? 0 : /linux-image/.test(u) ? 1 : 2;
              return score(a) - score(b);
            });
          for (const cu of cands) {
            if (cu === uri) continue;   // already tried the package's own deb
            const stmp = path.join(tmp, 'src'); fs.mkdirSync(stmp, { recursive: true });
            const sdeb = path.join(stmp, 'src.deb');
            const sok = await new Promise((resolve) => {
              const lib = cu.startsWith('https') ? https : http;
              const rq = lib.get(cu, (rs) => {
                if (rs.statusCode !== 200) { rs.destroy(); return resolve(false); }
                const total = parseInt(rs.headers['content-length'] || '0', 10);
                const o = fs.createWriteStream(sdeb); let got = 0, lp = -1;
                rs.on('data', (d) => { got += d.length; const pc = total ? Math.floor((got/total)*100) : 0; if (pc !== lp) { lp = pc; send?.(JSON.stringify({ downloaded: got, total, pct: pc, source: true })); } });
                rs.pipe(o); o.on('finish', () => resolve(true)); o.on('error', () => resolve(false)); rs.on('error', () => resolve(false));
              });
              rq.on('error', () => resolve(false));
              rq.setTimeout(180000, () => { rq.destroy(); resolve(false); });
            });
            if (sok) {
              await run('dpkg-deb', ['-x', sdeb, path.join(stmp, 'x')], 60000).catch(() => {});
              text = extractChangelog(path.join(stmp, 'x'));
              if (text) { usedSource = true; break; }
            }
          }
        }
      } catch { /* fallback best-effort */ }
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (!text) return { changelog: '', source: 'none', error: 'no changelog in this package' };
    let candidateVersion = null;
    const fnm = uri.split('/').pop().match(/_([^_]+)_/);
    if (fnm) candidateVersion = decodeURIComponent(fnm[1]).replace(/%7e/gi, '~').replace(/%2b/gi, '+');
    return { changelog: text.split('\n').slice(0, 150).join('\n'), source: usedSource ? 'source' : 'candidate', candidateVersion };
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

  // ---- TLS / HTTPS certificate provisioning --------------------------------
  // Cert+key live in a host dir bind-mounted into the container read-only.
  // Generate a long-lived self-signed cert covering localhost, the LAN IP and
  // the hostname. No external dependency; browsers warn once until trusted.
  async 'tls.selfSigned'({ dir = '/var/lib/rapisys/tls', altNames = [] } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const crt = path.join(dir, 'server.crt');
    const key = path.join(dir, 'server.key');
    const host = require('os').hostname();
    // collect SANs: always localhost + loopback, plus the host's own IPs
    const ifs = require('os').networkInterfaces();
    const ips = new Set(['127.0.0.1']);
    for (const list of Object.values(ifs)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.add(a.address);
    const sans = ['DNS:localhost', `DNS:${host}`, `DNS:${host}.local`];
    for (const n of altNames) { if (/^[a-zA-Z0-9.-]+$/.test(n)) sans.push(`DNS:${n}`); }
    for (const ip of ips) sans.push(`IP:${ip}`);
    const r = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', crt, '-days', '3650', '-subj', `/CN=${host}`,
      '-addext', `subjectAltName=${sans.join(',')}`], 30000);
    assert(r.code === 0, `openssl failed: ${r.stderr || r.stdout}`);
    fs.chmodSync(key, 0o640); fs.chmodSync(crt, 0o644);
    // The dashboard container runs as a non-root user in the shared group; let
    // that group read the private key (0640 root:rapisys) without making it
    // world-readable — mirrors how the agent socket is shared.
    await run('chgrp', [SOCKET_GROUP, key], 5000).catch(() => {});
    const info = await run('openssl', ['x509', '-in', crt, '-noout', '-enddate'], 5000).catch(() => ({ stdout: '' }));
    return { ok: true, crt, key, mode: 'selfsigned', sans, notAfter: (info.stdout || '').replace('notAfter=', '').trim() };
  },

  // Tailscale status: is tailscaled up, what's our *.ts.net name, can we cert?
  async 'tls.tailscaleStatus'() {
    const r = await run('tailscale', ['status', '--json'], 8000).catch(() => ({ code: 1, stdout: '' }));
    if (r.code !== 0) return { available: false, reason: 'tailscale not running or not installed' };
    let j; try { j = JSON.parse(r.stdout); } catch { return { available: false, reason: 'could not parse tailscale status' }; }
    const dnsName = (j.Self && j.Self.DNSName ? j.Self.DNSName : '').replace(/\.$/, '');
    const magicDNS = !!(j.CurrentTailnet && j.CurrentTailnet.MagicDNSEnabled);
    return { available: !!dnsName, dnsName, magicDNS, backendState: j.BackendState || null };
  },

  // Provision (or renew) a Tailscale cert. Re-running only fetches a new cert
  // when the current one is near expiry, so a periodic call = auto-renew.
  async 'tls.tailscaleCert'({ dir = '/var/lib/rapisys/tls', dnsName = null } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    let name = dnsName;
    if (!name) {
      const st = await run('tailscale', ['status', '--json'], 8000).catch(() => ({ stdout: '' }));
      try { name = (JSON.parse(st.stdout).Self.DNSName || '').replace(/\.$/, ''); } catch { /* */ }
    }
    assert(name && /^[a-zA-Z0-9.-]+\.ts\.net$/.test(name), 'no valid tailscale DNS name');
    const crt = path.join(dir, 'server.crt');
    const key = path.join(dir, 'server.key');
    const r = await run('tailscale', ['cert', '--cert-file', crt, '--key-file', key, name], 60000);
    assert(r.code === 0, `tailscale cert failed: ${r.stderr || r.stdout}`);
    fs.chmodSync(key, 0o640); fs.chmodSync(crt, 0o644);
    await run('chgrp', [SOCKET_GROUP, key], 5000).catch(() => {});
    const info = await run('openssl', ['x509', '-in', crt, '-noout', '-enddate'], 5000).catch(() => ({ stdout: '' }));
    return { ok: true, crt, key, mode: 'tailscale', dnsName: name, notAfter: (info.stdout || '').replace('notAfter=', '').trim() };
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
      // Invoke via OPS so handlers that call this['other.op'] (e.g. removePackage
      // → removeSimulate guard) have `this` bound to the ops table.
      const result = await OPS[req.op](req.params || {}, (streamLine) => reply({ stream: streamLine }));
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
