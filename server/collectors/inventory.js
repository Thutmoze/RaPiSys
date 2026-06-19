/**
 * RaPiSys — software inventory collector
 * --------------------------------------
 * Read-only host inspection via the agent (dpkg, systemctl) plus Docker via
 * the API socket. Results are synced into the `inventory` table so the UI
 * can search/filter/paginate server-side (a Pi can have 1,500+ packages —
 * we never ship them all to the browser at once).
 */

import http from 'http';
import { agentCall, agentConfigured } from '../core/agent-client.js';

const DOCKER_SOCK = '/var/run/docker.sock';

function dockerApiGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path, method: 'GET', timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

export function createInventoryCollector() {
  async function packages() {
    if (!agentConfigured()) return [];
    try {
      const { packages } = await agentCall('inventory.packages', {}, null, 20000);
      return (packages || []).map((p) => ({
        kind: 'package', name: p.name, version: p.version,
        installedAt: p.installedAt, source: 'apt', status: 'installed',
        // Simple 3-bucket category derived from dpkg facets:
        //  system  = essential or priority required/important
        //  library = libs section or lib* name (and not system)
        //  user    = everything else (optional/standard apps)
        category: (p.essential || p.priority === 'required' || p.priority === 'important') ? 'system'
          : (p.section === 'libs' || p.section === 'oldlibs' || /^lib/.test(p.name)) ? 'library'
          : 'user',
        meta: { sizeKB: p.sizeKB, description: p.description, priority: p.priority,
          essential: p.essential, section: p.section },
      }));
    } catch { return []; }
  }

  async function services() {
    if (!agentConfigured()) return [];
    try {
      const { services } = await agentCall('inventory.services', {}, null, 12000);
      return (services || []).map((s) => ({
        kind: 'service', name: s.name, version: null, installedAt: null,
        source: 'systemd', status: `${s.active}/${s.sub}`,
        meta: { load: s.load, active: s.active, sub: s.sub, description: s.description },
      }));
    } catch { return []; }
  }

  async function containers() {
    const list = await dockerApiGet('/containers/json?all=1');
    if (!Array.isArray(list)) return [];
    return list.map((c) => ({
      kind: 'container',
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      version: (c.Image || '').split(':')[1] || 'latest',
      installedAt: c.Created ? c.Created * 1000 : null,
      source: (c.Image || '').split(':')[0],
      status: c.State,
      meta: { image: c.Image, statusText: c.Status, ports: c.Ports?.length || 0 },
    }));
  }

  async function serviceDetail(name) {
    if (!agentConfigured()) return {};
    try { return await agentCall('inventory.serviceDetail', { name }, null, 6000); }
    catch { return {}; }
  }

  async function removeSimulate(name) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('inventory.removeSimulate', { name }, null, 30000);
  }
  async function removePackage(name, confirm) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('inventory.remove', { name, confirm }, null, 130000);
  }
  async function serviceControl(name, action) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('inventory.serviceControl', { name, action }, null, 18000);
  }
  async function removeContainer(name) {
    // stop + remove via Docker API
    await new Promise((resolve) => {
      const req = http.request({ socketPath: DOCKER_SOCK, path: `/containers/${name}/stop`, method: 'POST', timeout: 12000 }, () => resolve());
      req.on('error', () => resolve()); req.on('timeout', () => { req.destroy(); resolve(); }); req.end();
    });
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: DOCKER_SOCK, path: `/containers/${name}`, method: 'DELETE', timeout: 12000 }, (res) => {
        resolve({ ok: res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('docker timeout')); }); req.end();
    });
  }

  /** Full inventory across all kinds. */
  async function collectAll() {
    const [pkgs, svcs, ctrs] = await Promise.all([packages(), services(), containers()]);
    return [...pkgs, ...svcs, ...ctrs];
  }

  async function autoremovable() {
    if (!agentConfigured()) return [];
    try { const { packages } = await agentCall('inventory.autoremovable', {}, null, 25000); return packages || []; }
    catch { return []; }
  }

  /**
   * "Recommended to remove" analysis. Combines several conservative signals,
   * each tagged with a reason + severity so the UI can explain *why* (we never
   * claim something is malware — only observable facts: orphaned, failed,
   * inactive, stopped, oversized-and-old).
   */
  async function recommendations() {
    const [pkgs, svcs, ctrs, orphans] = await Promise.all([packages(), services(), containers(), autoremovable()]);
    const orphanSet = new Set(orphans);
    const recs = [];
    const now = Date.now();
    const DAY = 86400e3;

    // 1) Orphaned (auto-removable) packages — safest, highest-confidence signal.
    for (const name of orphans) {
      const p = pkgs.find((x) => x.name === name);
      recs.push({
        kind: 'package', name, version: p?.version || '',
        reason: 'orphaned', severity: 'safe',
        detail: 'No longer required by any installed package (apt autoremove candidate).',
        sizeKB: p?.meta?.sizeKB || 0,
      });
    }

    // 2) Failed services — something is wrong; review/remove.
    for (const s of svcs) {
      const active = s.meta?.active, sub = s.meta?.sub;
      if (active === 'failed' || sub === 'failed') {
        recs.push({ kind: 'service', name: s.name, reason: 'failed', severity: 'review',
          detail: `Service is in a failed state (${s.status}).`, description: s.meta?.description || '' });
      }
    }

    // 3) Dead/inactive + not-loaded services (loaded but inactive for a while,
    //    or unit no longer found). Lower confidence → 'review'.
    for (const s of svcs) {
      const active = s.meta?.active, sub = s.meta?.sub, load = s.meta?.load;
      if (load === 'not-found') {
        recs.push({ kind: 'service', name: s.name, reason: 'orphaned', severity: 'review',
          detail: 'Unit file no longer present (leftover from a removed package).', description: s.meta?.description || '' });
      } else if (active === 'inactive' && sub === 'dead') {
        recs.push({ kind: 'service', name: s.name, reason: 'inactive', severity: 'review',
          detail: 'Loaded but inactive/dead — not currently doing anything.', description: s.meta?.description || '' });
      }
    }

    // 4) Stopped / exited / dead containers — taking up space, not running.
    for (const c of ctrs) {
      if (['exited', 'dead', 'created'].includes(c.status)) {
        const ageD = c.installedAt ? Math.floor((now - c.installedAt) / DAY) : null;
        recs.push({ kind: 'container', name: c.name, reason: 'stopped', severity: 'safe',
          detail: `Container is ${c.status}${ageD != null ? `, created ${ageD}d ago` : ''} (${c.meta?.statusText || ''}).`,
          description: c.meta?.image || '' });
      }
    }

    // 5) Large + old user packages (low confidence informational nudge). Only
    //    user-category, > 50 MB, installed > 180d ago, and NOT system/library.
    //    Framed as "review" — we can't prove it's unused, just a candidate.
    for (const p of pkgs) {
      const isUser = !(p.meta?.essential || p.meta?.priority === 'required' || p.meta?.priority === 'important'
        || p.meta?.section === 'libs' || p.meta?.section === 'oldlibs' || /^lib/.test(p.name));
      const big = (p.meta?.sizeKB || 0) > 50000;
      const old = p.installedAt && (now - p.installedAt) > 180 * DAY;
      if (isUser && big && old && !orphanSet.has(p.name)) {
        recs.push({ kind: 'package', name: p.name, version: p.version, reason: 'large-old', severity: 'review',
          detail: `Large (${Math.round((p.meta.sizeKB) / 1024)} MB) and installed over 6 months ago — review if still needed.`,
          description: p.meta?.description || '', sizeKB: p.meta?.sizeKB || 0 });
      }
    }

    // de-dup (a service could match failed + inactive); keep highest severity
    const order = { review: 1, safe: 0 };
    const byKey = new Map();
    for (const r of recs) {
      const k = `${r.kind}:${r.name}`;
      const prev = byKey.get(k);
      if (!prev || (order[r.severity] ?? 0) > (order[prev.severity] ?? 0)) byKey.set(k, r);
    }
    const out = [...byKey.values()];
    const counts = { total: out.length,
      safe: out.filter((r) => r.severity === 'safe').length,
      review: out.filter((r) => r.severity === 'review').length };
    return { recommendations: out, counts, generatedAt: now };
  }

  return { packages, services, containers, serviceDetail, removeSimulate, removePackage, serviceControl, removeContainer, collectAll, recommendations };
}
