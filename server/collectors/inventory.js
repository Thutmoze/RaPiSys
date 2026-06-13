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
        meta: { sizeKB: p.sizeKB },
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

  /** Full inventory across all kinds. */
  async function collectAll() {
    const [pkgs, svcs, ctrs] = await Promise.all([packages(), services(), containers()]);
    return [...pkgs, ...svcs, ...ctrs];
  }

  return { packages, services, containers, serviceDetail, collectAll };
}
