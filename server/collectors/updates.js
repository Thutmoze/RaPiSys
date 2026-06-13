/**
 * RaPiSys — software update collector (F8)
 * ----------------------------------------
 * Thin wrapper over the host agent's apt/eeprom ops. The agent already does
 * the privileged work (apt-get update / list --upgradable with security +
 * kernel tagging / changelog / upgrade with live streaming / rpi-eeprom).
 */

import { agentCall, agentConfigured } from '../core/agent-client.js';

export function createUpdatesCollector({ updatesRepo } = {}) {
  async function refresh(onProgress) {
    // apt-get update, list upgradable, then deep-scan each candidate
    // changelog for security signals (RPi repo has no -security pocket).
    if (!agentConfigured()) return { available: false };
    onProgress?.({ phase: 'apt-update' });
    await agentCall('apt.update', {}, null, 120000).catch(() => {});
    onProgress?.({ phase: 'listing' });
    const { updates } = await agentCall('apt.listUpgradable', {}, null, 90000);
    // deep security scan with progress
    if (updates.length) {
      onProgress?.({ phase: 'scanning', total: updates.length, done: 0 });
      try {
        const { result } = await agentCall('apt.securityScan',
          { packages: updates.map((u) => u.package) },
          (line) => { try { const p = JSON.parse(line); onProgress?.({ phase: 'scanning', total: p.total, done: p.progress, pkg: p.pkg }); } catch { /* */ } },
          updates.length * 35000 + 30000);
        for (const u of updates) {
          const r = result[u.package];
          if (r) { u.security = u.security || r.security; u.urgency = r.urgency; u.cves = r.cves || 0; }
        }
      } catch { /* keep pocket-based tags only */ }
    }
    updatesRepo?.saveCache(updates);
    return { available: true, updates, checkedAt: Date.now() };
  }

  function cached() {
    if (!updatesRepo) return { available: false, updates: [], checkedAt: null };
    const c = updatesRepo.getCache();
    return { available: c.checkedAt != null, updates: c.updates, checkedAt: c.checkedAt };
  }

  async function list() {
    if (!agentConfigured()) return { available: false, updates: [] };
    try {
      const { updates } = await agentCall('apt.listUpgradable', {}, null, 90000);
      return { available: true, updates };
    } catch (err) { return { available: false, error: err.message, updates: [] }; }
  }

  async function changelog(pkg, candidate = true) {
    if (!agentConfigured()) return { changelog: 'agent unavailable' };
    return agentCall('apt.changelog', { pkg, candidate }, null, 45000);
  }

  async function firmware() {
    if (!agentConfigured()) return { available: false };
    try { const r = await agentCall('eeprom.check', {}, null, 25000); return { available: true, ...r }; }
    catch { return { available: false }; }
  }

  // Streaming upgrade: onLine receives each output line for SSE relay.
  async function upgrade({ packages = null, full = false, simulate = false }, onLine) {
    if (!agentConfigured()) throw new Error('host agent required');
    const params = full ? { full: true, simulate } : { packages, simulate };
    return agentCall('apt.upgrade', params, onLine, 1800000); // up to 30 min
  }

  async function firmwareUpdate(onLine) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('eeprom.update', {}, onLine, 300000);
  }

  return { refresh, cached, list, changelog, firmware, upgrade, firmwareUpdate };
}
