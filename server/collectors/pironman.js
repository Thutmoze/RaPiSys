/**
 * RaPiSys — Pironman 5 Mini collector / pm_dashboard proxy
 * --------------------------------------------------------
 * Talks to SunFounder's pm_dashboard REST API (default
 * http://127.0.0.1:34001/api/v1.0/*) for live device info and config, and
 * writes config through its granular setters — which apply live AND persist
 * (pm_dashboard fires its on-config-changed callback into pm_auto).
 *
 * Hybrid model: proxy first, host-agent fallback. When the API is unreachable
 * (dashboard installed slim, or the service is down) we fall back to the
 * agent's pironman.readConfig / pironman.writeConfig ops (validated file
 * write + service restart). detect/install/update/restart are agent-owned
 * (see agent/rapisys-agent.cjs); this collector never shells out itself.
 */

import http from 'http';
import { agentCall, agentConfigured } from '../core/agent-client.js';

const DEFAULT_TIMEOUT = 5000;
const API_PREFIX = '/api/v1.0';

// Real GPIO fan profiles from pm_auto (index 0..4).
const FAN_MODES = ['Always On', 'Performance', 'Cool', 'Balanced', 'Quiet'];

// Writable `system` key -> { ep: pm_dashboard setter, key: JSON body field }.
// Hardware pins are intentionally absent (not settable from the dashboard).
const SETTER_MAP = {
  temperature_unit: { ep: 'set-temperature-unit', key: 'unit' },
  gpio_fan_mode:    { ep: 'set-fan-mode',         key: 'fan_mode' },
  gpio_fan_led:     { ep: 'set-fan-led',          key: 'led' },
  rgb_enable:       { ep: 'set-rgb-enable',       key: 'enable' },
  rgb_color:        { ep: 'set-rgb-color',        key: 'color' },
  rgb_style:        { ep: 'set-rgb-style',        key: 'style' },
  rgb_speed:        { ep: 'set-rgb-speed',        key: 'speed' },
  rgb_brightness:   { ep: 'set-rgb-brightness',   key: 'brightness' },
  rgb_led_count:    { ep: 'set-rgb-led-count',    key: 'led_count' },
};

/** Minimal HTTP fetch with timeout; pm_dashboard is plain http on the Pi. */
function request(urlStr, { method = 'GET', body = null, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { return reject(new Error('bad URL')); }
    const payload = body == null ? null : JSON.stringify(body);
    const opts = { method, headers: { Accept: 'application/json' }, timeout };
    if (payload != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/**
 * Create a Pironman client bound to a config provider.
 *  getConfig() -> { enabled, host, port } | null   (host/port of pm_dashboard)
 */
export function createPironmanClient({ getConfig }) {
  function base() {
    const c = getConfig() || {};
    const host = c.host || '127.0.0.1';
    const port = c.port || 34001;
    return { url: `http://${host}:${port}${API_PREFIX}`, host, port };
  }

  async function apiGet(path, timeout = DEFAULT_TIMEOUT) {
    const { url } = base();
    const r = await request(`${url}/${path}`, { timeout });
    if (r.status !== 200 || !r.json || r.json.status !== true) {
      throw new Error(r.json?.error || `pironman API ${path} failed (${r.status})`);
    }
    return r.json.data;
  }

  async function apiPost(ep, body, timeout = DEFAULT_TIMEOUT) {
    const { url } = base();
    const r = await request(`${url}/${ep}`, { method: 'POST', body, timeout });
    if (r.status !== 200 || !r.json || r.json.status !== true) {
      throw new Error(r.json?.error || `pironman API ${ep} failed (${r.status})`);
    }
    return true;
  }

  /** Is the local pm_dashboard API answering? (GET /test -> {data:"OK"}) */
  async function apiReachable() {
    try {
      const { url } = base();
      const r = await request(`${url}/test`, { timeout: 3000 });
      return r.status === 200 && r.json?.status === true;
    } catch { return false; }
  }

  /** Install/service/version facts come from the agent (authoritative). */
  async function detect() {
    if (!agentConfigured()) return null;
    return agentCall('pironman.detect', {}, null, 8000).catch(() => null);
  }

  /** Read the live config — API first, agent file fallback. */
  async function readConfig() {
    try {
      const data = await apiGet('get-config', 4000); // { system: {...}, ... }
      return { source: 'api', config: data, system: data?.system || {} };
    } catch {
      if (agentConfigured()) {
        const r = await agentCall('pironman.readConfig', {}, null, 8000);
        return { source: 'agent', config: r.config, system: r.system || {} };
      }
      throw new Error('Pironman config unavailable (API down, agent not configured)');
    }
  }

  /** Normalised snapshot for the UI: presence, version, fan, rgb, display. */
  async function snapshot({ withDetect = true } = {}) {
    const det = withDetect ? await detect() : null;
    const reachable = await apiReachable();

    let system = {};
    let peripherals = null;
    let deviceInfo = null;
    if (reachable) {
      const cfg = await apiGet('get-config', 4000).catch(() => null);
      system = cfg?.system || {};
      deviceInfo = await apiGet('get-device-info', 4000).catch(() => null);
      peripherals = deviceInfo?.peripherals || null;
    } else if (det?.installed && agentConfigured()) {
      const r = await agentCall('pironman.readConfig', {}, null, 8000).catch(() => null);
      system = r?.system || {};
    }

    const modeIdx = Number(system.gpio_fan_mode);
    return {
      present: !!(det?.installed) || reachable,
      installed: det?.installed ?? reachable,
      serviceActive: det?.serviceActive ?? null,
      version: det?.version ?? null,
      variant: det?.variant ?? null,
      model: det?.model || deviceInfo?.name || null,
      apiReachable: reachable,
      apiPort: det?.apiPort ?? (getConfig()?.port || 34001),
      hasDashboard: det?.hasDashboard ?? reachable,
      peripherals,
      fan: {
        mode: Number.isFinite(modeIdx) ? modeIdx : null,
        modeLabel: FAN_MODES[modeIdx] ?? null,
        led: system.gpio_fan_led ?? null,
        modes: FAN_MODES,
      },
      rgb: {
        enable: system.rgb_enable ?? null,
        color: system.rgb_color ?? null,
        style: system.rgb_style ?? null,
        speed: system.rgb_speed ?? null,
        brightness: system.rgb_brightness ?? null,
        ledCount: system.rgb_led_count ?? null,
      },
      display: { temperatureUnit: system.temperature_unit ?? null },
    };
  }

  /**
   * Apply a config patch (keys from SETTER_MAP). API setters (live) first;
   * agent file write + restart as the fallback.
   */
  async function setConfig(patch) {
    const entries = Object.entries(patch || {}).filter(([k]) => k in SETTER_MAP);
    if (!entries.length) throw new Error('no writable Pironman config keys');

    if (await apiReachable()) {
      const applied = [];
      for (const [k, v] of entries) {
        const { ep, key } = SETTER_MAP[k];
        await apiPost(ep, { [key]: v });
        applied.push(k);
      }
      return { ok: true, source: 'api', applied };
    }

    if (!agentConfigured()) throw new Error('Pironman API down and host agent not configured');
    const system = Object.fromEntries(entries);
    const r = await agentCall('pironman.writeConfig', { config: { system } }, null, 40000);
    return { ok: true, source: 'agent', applied: r.applied || Object.keys(system) };
  }

  /** Connectivity test for the Settings "Test" button. */
  async function test() {
    try {
      if (await apiReachable()) {
        const di = await apiGet('get-device-info', 4000).catch(() => null);
        return { ok: true, source: 'api', name: di?.name || 'Pironman',
          version: di?.version || null, peripherals: di?.peripherals || null };
      }
      const det = await detect();
      if (det?.installed) {
        return { ok: true, source: 'agent', installed: true,
          serviceActive: det.serviceActive, version: det.version, apiReachable: false };
      }
      return { ok: false, error: `Pironman API not reachable on :${getConfig()?.port || 34001}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { detect, snapshot, readConfig, setConfig, test, apiReachable, FAN_MODES };
}
