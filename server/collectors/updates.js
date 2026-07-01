/**
 * RaPiSys — software update collector (F8)
 * ----------------------------------------
 * Thin wrapper over the host agent's apt/eeprom ops. The agent already does
 * the privileged work (apt-get update / list --upgradable with security +
 * kernel tagging / changelog / upgrade with live streaming / rpi-eeprom).
 */

import { agentCall, agentConfigured } from '../core/agent-client.js';

// --- Debian version comparison (dpkg algorithm, sufficient subset) ----------
function parseVer(v) {
  v = String(v || '').trim();
  let epoch = null; const ci = v.indexOf(':');   // null = epoch omitted in this string
  if (ci >= 0) { epoch = parseInt(v.slice(0, ci), 10) || 0; v = v.slice(ci + 1); }
  let upstream = v, revision = '';
  const di = v.lastIndexOf('-');
  if (di >= 0) { upstream = v.slice(0, di); revision = v.slice(di + 1); }
  return { epoch, upstream, revision };
}
function cmpPart(a, b) {
  a = a || ''; b = b || ''; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let nd = '', md = '';
    while (i < a.length && !/\d/.test(a[i])) nd += a[i++];
    while (j < b.length && !/\d/.test(b[j])) md += b[j++];
    if (nd !== md) {
      for (let k = 0; k < Math.max(nd.length, md.length); k++) {
        const ca = nd[k] || '', cb = md[k] || '';
        if (ca === cb) continue;
        if (ca === '~') return -1;
        if (cb === '~') return 1;
        const oa = ca === '' ? 0 : (/[a-zA-Z]/.test(ca) ? ca.charCodeAt(0) : ca.charCodeAt(0) + 256);
        const ob = cb === '' ? 0 : (/[a-zA-Z]/.test(cb) ? cb.charCodeAt(0) : cb.charCodeAt(0) + 256);
        return oa < ob ? -1 : 1;
      }
    }
    let na = '', ma = '';
    while (i < a.length && /\d/.test(a[i])) na += a[i++];
    while (j < b.length && /\d/.test(b[j])) ma += b[j++];
    const ia = parseInt(na || '0', 10), ib = parseInt(ma || '0', 10);
    if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}
// Pick the highest-severity urgency mentioned in a changelog window (a single
// version's notes can hold several urgency= markers; the security one wins).
const URGENCY_RANK = { emergency: 4, critical: 3, high: 2, medium: 1, low: 0 };
function highestUrgency(text) {
  const all = [...String(text || '').matchAll(/urgency=(\w+)/gi)].map((m) => m[1].toLowerCase());
  if (!all.length) return null;
  return all.sort((a, b) => (URGENCY_RANK[b] ?? -1) - (URGENCY_RANK[a] ?? -1))[0];
}

// The candidate's release date is the trailer date of the TOP (newest) entry in
// its changelog: a line like " -- Maintainer <email>  Thu, 26 Jun 2026 …". We
// take the first such line and parse it to epoch ms; null if unparseable.
function parseChangelogReleaseDate(text) {
  const m = String(text || '').match(/^ -- .+?<[^>]*>\s{2,}(.+?)\s*$/m);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

function vercmp(x, y, defaultEpoch = 0) {
  const a = parseVer(x), b = parseVer(y);
  // Changelog entry headers often omit the epoch; inherit the candidate's so
  // an epoch-less security sub-block isn't mistaken for an older release.
  const ea = a.epoch == null ? defaultEpoch : a.epoch;
  const eb = b.epoch == null ? defaultEpoch : b.epoch;
  if (ea !== eb) return ea < eb ? -1 : 1;
  const u = cmpPart(a.upstream, b.upstream); if (u) return u;
  return cmpPart(a.revision, b.revision);
}

// Return only the changelog entries that are NEWER than the installed version.
// This is the correct, uniform rule: a CVE/security marker only matters if it
// belongs to a version you don't yet have. Entries at or below the installed
// version describe fixes you already received (or never needed).
function newerThanInstalledWindow(text, installedVersion, candidateVersion) {
  const body = String(text || '');
  if (!installedVersion) return body;            // unknown — fall back to full
  // Default epoch for epoch-less changelog headers: take it from whichever of
  // the candidate/installed versions actually carries an epoch (the .deb
  // filename that candidateVersion is derived from DROPS the epoch, so the
  // installed version is the reliable source).
  const candE = parseVer(candidateVersion).epoch;
  const instE = parseVer(installedVersion).epoch;
  const defaultEpoch = (candE != null ? candE : (instE != null ? instE : 0));
  const lines = body.split('\n');
  const headerRe = /^\S+\s+\(([^)]+)\)/;
  const keep = [];
  let include = true;
  for (const line of lines) {
    const m = line.match(headerRe);
    // entries that omit the epoch inherit defaultEpoch; the installed version
    // we compare against also uses it if IT is epoch-less.
    if (m) { include = vercmp(m[1], installedVersion, defaultEpoch) > 0; }
    if (include) keep.push(line);
  }
  return keep.join('\n');
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
      if (k && k.candidate === u.candidate) { u.security = u.security || k.security; u.cves = k.cves; u.urgency = k.urgency; u.releaseDate = k.releaseDate; }
      else toScan.push(u.package);
    }
    // deep security scan via partial range-fetch (cheap now)
    if (toScan.length) {
      onProgress?.({ phase: 'scanning', total: toScan.length, done: 0 });
      const installedMap = {};
      for (const u of updates) installedMap[u.package] = u.installed;
      const res = await securityScan(toScan, installedMap, (p) => onProgress?.({ phase: 'scanning', total: p.total, done: p.done, pkg: p.pkg }));
      for (const u of updates) { const r = res[u.package]; if (r && r.scanned) { u.security = r.security; u.cves = r.cves; u.urgency = r.urgency; u.releaseDate = r.releaseDate; } }
    }
    updatesRepo?.saveCache(updates);
    // report packages whose changelog still isn't cached (large pkgs whose
    // range-fetch couldn't reach the changelog). getChangelog handles the
    // epoch-mismatch between apt's candidate and the stored one.
    const unscanned = updates
      .filter((u) => !updatesRepo?.getChangelog?.(u.package, u.candidate))
      .map((u) => u.package);
    return { available: true, updates, checkedAt: Date.now(), unscanned };
  }

  // Inspect a single candidate changelog's security signals (called lazily
  // from the changelog endpoint). Returns and persists the tag.
  function tagSecurityFromChangelog(pkg, candidate, changelogText, installed) {
    const head = newerThanInstalledWindow(changelogText, installed, candidate);
    const cves = new Set((head.match(/CVE-\d{4}-\d+/g) || [])).size;
    const urgency = highestUrgency(head);
    const security = /-security;/.test(head) || cves > 0 || urgency === 'high' || urgency === 'critical' || urgency === 'emergency';
    const releaseDate = parseChangelogReleaseDate(changelogText);
    updatesRepo?.saveSecurityTag?.(pkg, { candidate, security, cves, urgency, releaseDate });
    return { security, cves, urgency, releaseDate };
  }

  function cached() {
    if (!updatesRepo) return { available: false, updates: [], checkedAt: null };
    const c = updatesRepo.getCache();
    // Always merge the latest tags from update_sectags so the table reflects
    // them even if they were computed/updated after the list was cached.
    const tags = updatesRepo.getSecurityTags?.() || {};
    const strip = (v) => String(v || '').replace(/^\d+:/, '');
    const updates = (c.updates || []).map((u) => {
      const t = tags[u.package];
      if (t && (!t.candidate || strip(t.candidate) === strip(u.candidate))) {
        return { ...u, security: !!t.security, cves: t.cves || 0, urgency: t.urgency || u.urgency, releaseDate: t.releaseDate || u.releaseDate || null };
      }
      return u;
    });
    return { available: c.checkedAt != null, updates, checkedAt: c.checkedAt };
  }

  async function list() {
    if (!agentConfigured()) return { available: false, updates: [] };
    try {
      const { updates } = await agentCall('apt.listUpgradable', {}, null, 90000);
      return { available: true, updates };
    } catch (err) { return { available: false, error: err.message, updates: [] }; }
  }

  function candidateOf(pkg) {
    try { const c = updatesRepo?.getCache?.(); const u = (c?.updates || []).find((x) => x.package === pkg); return u ? u.candidate : null; }
    catch { return null; }
  }

  async function changelog(pkg, candidate = true) {
    if (!agentConfigured()) return { changelog: 'agent unavailable' };
    if (candidate) {
      const cand = candidateOf(pkg);
      // 1) DB cache first — any prior successful fetch (range or full download).
      const stored = updatesRepo?.getChangelog?.(pkg, cand);
      if (stored && stored.none) return { changelog: '', candidateVersion: cand, source: 'none', none: true };
      if (stored && stored.changelog) return { changelog: stored.changelog, candidateVersion: stored.candidateVersion || cand, source: 'candidate' };
      // 2) range-fetch (cheap); store on success.
      try {
        const r = await agentCall('apt.changelogRange', { pkg }, null, 50000);
        if (r && r.changelog) { updatesRepo?.saveChangelog?.(pkg, r.candidateVersion || cand, r.changelog); updatesRepo?.saveReleaseDate?.(pkg, r.candidateVersion || cand, parseChangelogReleaseDate(r.changelog)); return r; }
      } catch { /* fall through */ }
    }
    // local installed changelog (instant fallback; NOT stored as candidate)
    return agentCall('apt.changelog', { pkg, candidate: false }, null, 30000);
  }

  // Full download with progress (for big packages whose docs are past budget).
  async function changelogFull(pkg, onProgress) {
    if (!agentConfigured()) throw new Error('host agent required');
    const r = await agentCall('apt.changelogFull', { pkg },
      (line) => { try { onProgress?.(JSON.parse(line)); } catch { /* */ } }, 200000);
    // persist so future views reuse it instantly with the proper format
    if (r && r.changelog) { updatesRepo?.saveChangelog?.(pkg, r.candidateVersion || candidateOf(pkg), r.changelog); updatesRepo?.saveReleaseDate?.(pkg, r.candidateVersion || candidateOf(pkg), parseChangelogReleaseDate(r.changelog)); }
    // record a sentinel when the package genuinely has no changelog (even after
    // the source-package fallback) so we don't re-download it every view.
    else if (r && r.source === 'none') updatesRepo?.markNoChangelog?.(pkg, candidateOf(pkg));
    return r;
  }

  // Bulk security scan, now cheap thanks to range-fetched changelogs.
  async function securityScan(packages, installedMap, onProgress) {
    if (!agentConfigured()) return {};
    const out = {};
    let done = 0;
    for (const pkg of packages) {
      try {
        // range-fetch only — cheap. Giants whose docs are past budget return
        // empty and are simply left untagged (user can download individually).
        const r = await agentCall('apt.changelogRange', { pkg }, null, 50000);
        if (r && r.changelog) {
          const head = newerThanInstalledWindow(r.changelog, installedMap?.[pkg], r.candidateVersion);
          const cves = new Set((head.match(/CVE-\d{4}-\d+/g) || [])).size;
          const urgency = highestUrgency(head);
          const security = /-security;/.test(head) || cves > 0 || urgency === 'high' || urgency === 'critical' || urgency === 'emergency';
          const releaseDate = parseChangelogReleaseDate(r.changelog);
          out[pkg] = { security, cves, urgency, releaseDate, scanned: true };
          updatesRepo?.saveSecurityTag?.(pkg, { candidate: r.candidateVersion, security, cves, urgency, changelog: r.changelog, releaseDate });
          updatesRepo?.saveChangelog?.(pkg, r.candidateVersion, r.changelog);
        } else {
          // range-fetch couldn't reach the changelog (docs past budget = large pkg)
          out[pkg] = { scanned: false };
        }
      } catch { out[pkg] = { scanned: false }; }
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
