/**
 * RaPiSys — software update collector (F8)
 * ----------------------------------------
 * Thin wrapper over the host agent's apt/eeprom ops. The agent already does
 * the privileged work (apt-get update / list --upgradable with security +
 * kernel tagging / changelog / upgrade with live streaming / rpi-eeprom).
 */

import { agentCall, agentConfigured } from '../core/agent-client.js';

// Security signals can live in a LATER sub-entry — e.g. the upstream
// "trixie-security; urgency=high" block that follows the benign rpt1 repackage
// block. The fetched changelog is already trimmed to the candidate's recent
// notes (~150 lines), so scan the whole fetched text rather than only the
// first version block.
function firstEntry(text) {
  return String(text || '');
}

export function createUpdatesCollector({ updatesRepo } = {}) {
  async function refresh(onProgress) {
    // Fast refresh: apt-get update + list. Security is detected lazily when a
    // changelog is viewed (the RPi repo offers no -security pocket and no
    // standalone changelog URL — the only source is the 100MB+ package, so we
    // never bulk-download). Known security tags are re-applied from cache.
    if (!agentConfigured()) return { available: false };
    onProgress?.({ phase: 'apt-update' });
    await agentCall('apt.update', {}, null, 120000).catch(() => {});
    onProgress?.({ phase: 'listing' });
    const { updates } = await agentCall('apt.listUpgradable', {}, null, 90000);
    // carry forward known tags (skip re-scan when candidate unchanged)
    const known = updatesRepo?.getSecurityTags?.() || {};
    const toScan = [];
    for (const u of updates) {
      const k = known[u.package];
      if (k && k.candidate === u.candidate) { u.security = u.security || k.security; u.cves = k.cves; u.urgency = k.urgency; }
      else toScan.push(u.package);
    }
    // deep security scan via partial range-fetch (cheap now)
    if (toScan.length) {
      onProgress?.({ phase: 'scanning', total: toScan.length, done: 0 });
      const res = await securityScan(toScan, (p) => onProgress?.({ phase: 'scanning', total: p.total, done: p.done, pkg: p.pkg }));
      for (const u of updates) { const r = res[u.package]; if (r) { u.security = u.security || r.security; u.cves = r.cves; u.urgency = r.urgency; } }
    }
    updatesRepo?.saveCache(updates);
    return { available: true, updates, checkedAt: Date.now() };
  }

  // Inspect a single candidate changelog's security signals (called lazily
  // from the changelog endpoint). Returns and persists the tag.
  function tagSecurityFromChangelog(pkg, candidate, changelogText) {
    const head = firstEntry(changelogText);
    const cves = new Set((head.match(/CVE-\d{4}-\d+/g) || [])).size;
    const um = head.match(/urgency=(\w+)/i);
    const urgency = um ? um[1].toLowerCase() : null;
    const security = /-security;/.test(head) || cves > 0 || urgency === 'high' || urgency === 'critical' || urgency === 'emergency';
    updatesRepo?.saveSecurityTag?.(pkg, { candidate, security, cves, urgency });
    return { security, cves, urgency };
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
    if (candidate) {
      // Try the partial range-fetch first (a few hundred KB for most packages).
      try {
        const r = await agentCall('apt.changelogRange', { pkg }, null, 50000);
        if (r && r.changelog) return r;
      } catch { /* fall through */ }
    }
    // local installed changelog (no new-version notes, but instant)
    return agentCall('apt.changelog', { pkg, candidate: false }, null, 30000);
  }

  // Full download with progress (for big packages whose docs are past budget).
  async function changelogFull(pkg, onProgress) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('apt.changelogFull', { pkg },
      (line) => { try { onProgress?.(JSON.parse(line)); } catch { /* */ } }, 200000);
  }

  // Bulk security scan, now cheap thanks to range-fetched changelogs.
  async function securityScan(packages, onProgress) {
    if (!agentConfigured()) return {};
    const out = {};
    let done = 0;
    for (const pkg of packages) {
      try {
        // range-fetch only — cheap. Giants whose docs are past budget return
        // empty and are simply left untagged (user can download individually).
        const r = await agentCall('apt.changelogRange', { pkg }, null, 50000);
        if (r && r.changelog) {
          const head = firstEntry(r.changelog);
          const cves = new Set((head.match(/CVE-\d{4}-\d+/g) || [])).size;
          const um = head.match(/urgency=(\w+)/i);
          const urgency = um ? um[1].toLowerCase() : null;
          const security = /-security;/.test(head) || cves > 0 || urgency === 'high' || urgency === 'critical' || urgency === 'emergency';
          out[pkg] = { security, cves, urgency };
          updatesRepo?.saveSecurityTag?.(pkg, { candidate: r.candidateVersion, security, cves, urgency });
        }
      } catch { /* skip */ }
      done++;
      onProgress?.({ done, total: packages.length, pkg });
    }
    return out;
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

  return { refresh, cached, list, changelog, changelogFull, securityScan, tagSecurityFromChangelog, firmware, upgrade, firmwareUpdate };
}
