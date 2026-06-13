/**
 * RaPiSys — software update collector (F8)
 * ----------------------------------------
 * Thin wrapper over the host agent's apt/eeprom ops. The agent already does
 * the privileged work (apt-get update / list --upgradable with security +
 * kernel tagging / changelog / upgrade with live streaming / rpi-eeprom).
 */

import { agentCall, agentConfigured } from '../core/agent-client.js';

export function createUpdatesCollector() {
  async function refresh() {
    // apt-get update (no stream needed here) then list.
    if (!agentConfigured()) return { available: false };
    await agentCall('apt.update', {}, null, 120000).catch(() => {});
    const { updates } = await agentCall('apt.listUpgradable', {}, null, 90000);
    return { available: true, updates };
  }

  async function list() {
    if (!agentConfigured()) return { available: false, updates: [] };
    try {
      const { updates } = await agentCall('apt.listUpgradable', {}, null, 90000);
      return { available: true, updates };
    } catch (err) { return { available: false, error: err.message, updates: [] }; }
  }

  async function changelog(pkg) {
    if (!agentConfigured()) return { changelog: 'agent unavailable' };
    return agentCall('apt.changelog', { pkg }, null, 25000);
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

  return { refresh, list, changelog, firmware, upgrade, firmwareUpdate };
}
