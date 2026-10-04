/**
 * RaPiSys — reboot-required status
 * --------------------------------
 * Turns the agent's raw 'sys.rebootStatus' facts into one of three levels:
 *
 *   reboot   kernel newer than the running one, GPU firmware reinstalled
 *            since boot, bootloader EEPROM staged, or /run/reboot-required
 *   restart  only host programs still running libraries an upgrade replaced
 *   none     nothing waiting
 *
 * The result is cached (the agent call walks /proc/<pid>/maps) and exposed
 * as the ordinary metric `updates.reboot_required` (1/0), so reminders use
 * the normal alert engine (sustain / escalate) instead of a special rule type.
 */

import { agentCall, agentConfigured } from '../core/agent-client.js';

const TTL_MS = 5 * 60 * 1000;

/**
 * @param {object} raw          agent 'sys.rebootStatus' result
 * @param {object[]} history    update_history rows, newest first
 */
export function summarizeRebootStatus(raw, history = []) {
  if (!raw) return { level: 'none', reasons: [], libs: { count: 0, packages: [], procs: [] }, since: null, installed: 0, bootTime: null, kernel: null };
  const reasons = [];
  const k = raw.kernel || {};
  if (k.running && k.latest && k.latest !== k.running) reasons.push({ kind: 'kernel', running: k.running, latest: k.latest });
  if (raw.firmware) reasons.push({ kind: 'firmware', version: raw.firmware.version || null, at: raw.firmware.changedAt || null });
  if (raw.eeprom) reasons.push({ kind: 'bootloader', at: raw.eeprom.stagedAt || null });
  // Debian's flag names packages; skip the ones a reason above already covers.
  const flagged = (raw.rebootRequiredFile?.pkgs || []).filter((p) => !/^linux-image|^raspi-firmware$/.test(p));
  if (raw.rebootRequiredFile && (flagged.length || !reasons.length)) reasons.push({ kind: 'packages', pkgs: flagged });

  const procs = (raw.procs || []).map((p) => ({
    name: p.name, unit: p.unit || null, kind: p.kind || 'process', description: p.description || null,
    pids: p.pids || [], files: p.files || [], packages: p.packages || [],
  }));
  const libs = { count: procs.length, packages: [...new Set(procs.flatMap((p) => p.packages))], procs };

  const level = reasons.length ? 'reboot' : (procs.length ? 'restart' : 'none');

  // "Pending since": the first successful install after this boot, which is
  // what put the system in this state. Falls back to the staged timestamps.
  const boot = raw.bootTime || 0;
  const sinceBoot = history.filter((h) => h.ts > boot && h.result === 'success');
  const stamps = [...sinceBoot.map((h) => h.ts), ...reasons.map((r) => r.at).filter(Boolean)];
  return {
    level,
    reasons,
    libs,
    since: level === 'none' || !stamps.length ? null : Math.min(...stamps),
    installed: level === 'none' ? 0 : sinceBoot.length,
    bootTime: raw.bootTime || null,
    kernel: k.running || null,
  };
}

export function createRebootStatus({ updatesRepo, agent = agentCall, configured = agentConfigured } = {}) {
  let cache = null, cachedAt = 0, inflight = null;

  async function refresh() {
    if (!configured()) { cachedAt = Date.now(); return (cache = summarizeRebootStatus(null)); }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const raw = await agent('sys.rebootStatus', {}, null, 20000);
        let history = [];
        try { history = updatesRepo?.recent({ limit: 200 })?.rows || []; } catch { /* no history */ }
        cache = { ...summarizeRebootStatus(raw, history), checkedAt: Date.now() };
        cachedAt = Date.now();
        return cache;
      } finally { inflight = null; }
    })();
    return inflight;
  }

  /** Cached status; `force` re-reads the host (after an upgrade, on demand). */
  async function get({ force = false } = {}) {
    if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
    return refresh();
  }

  /**
   * Synchronous 1/0 for the sampler. Never blocks a sample: a stale cache
   * kicks off a background refresh and the next sample picks it up.
   */
  function metricValue() {
    if (Date.now() - cachedAt >= TTL_MS) refresh().catch(() => {});
    if (!cache) return null;
    return cache.level === 'reboot' ? 1 : 0;
  }

  /** Reboot the host through the agent's confirmed op. */
  function reboot() {
    return agent('sys.reboot', { confirm: 'REBOOT' }, null, 10000);
  }

  return { get, metricValue, reboot };
}
