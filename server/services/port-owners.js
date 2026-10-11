// Names a listening port after the application that owns it.
//
// Port numbers only say what usually runs there: :8080 is "HTTP Proxy" by
// convention, but on a Pi-hole host it is Pi-hole's admin page, and a Docker
// app publishing :9443 has no conventional name at all. The host agent reports
// which process owns each port, and which container that process runs in; the
// Docker API reports which container publishes a port through docker-proxy.
// Those owners name the service. A port with no identifiable owner returns
// nothing and keeps the port-based guess.

import { KNOWN_SERVICES, KNOWN_PROCESSES } from '../services-config.js';

// Process names that say nothing about the application.
const GENERIC_PROCESSES = new Set([
  'node', 'python', 'python3', 'java', 'docker-proxy', 'sh', 'bash', 'ruby', 'php',
  'php-fpm', 'uvicorn', 'gunicorn', 'dotnet', 'deno', 'bun',
]);

// Applications recognised by image name or process name, with per-port roles
// so an app that listens on several ports gets distinct, meaningful names.
const APPS = {
  pihole: {
    name: 'Pi-hole', icon: 'shield',
    ports: {
      53: { role: 'DNS', checkType: 'dns' },
      80: { role: 'Admin', path: '/admin/' },
      443: { role: 'Admin', checkType: 'https', path: '/admin/' },
      8080: { role: 'Admin', path: '/admin/' },
    },
  },
  rapisys: {
    name: 'RaPiSys', icon: 'activity',
    ports: {
      3001: { checkType: 'http', path: '/api/health' },
      3443: { role: 'HTTPS', checkType: 'https', path: '/api/health', icon: 'lock' },
    },
  },
  syncthing: { name: 'Syncthing', icon: 'refresh-cw', ports: {} },
  grafana: { name: 'Grafana', icon: 'bar-chart', ports: {} },
  jellyfin: { name: 'Jellyfin', icon: 'film', ports: {} },
  plex: { name: 'Plex', icon: 'play-circle', ports: {} },
  portainer: { name: 'Portainer', icon: 'box', ports: {} },
  'home-assistant': { name: 'Home Assistant', icon: 'home', ports: {} },
  influxdb: { name: 'InfluxDB', icon: 'database', ports: {} },
  postgres: { name: 'PostgreSQL', icon: 'database', ports: {} },
  mariadb: { name: 'MariaDB', icon: 'database', ports: {} },
  redis: { name: 'Redis', icon: 'database', ports: {} },
};
const PROCESS_APPS = { 'pihole-FTL': 'pihole' };

/** 'ghcr.io/home-assistant/home-assistant:stable' -> 'home-assistant' */
export function imageBase(image) {
  const noDigest = String(image || '').split('@')[0];
  const last = noDigest.split('/').pop() || '';
  return last.split(':')[0].toLowerCase();
}

const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const containerName = (c) => String((c.Names && c.Names[0]) || c.Id || '').replace(/^\//, '');

function appForContainer(c) {
  const base = imageBase(c.Image);
  if (APPS[base]) return { key: base, ...APPS[base] };
  return null;
}

/**
 * @param {object} input
 * @param {Array<{port:number,address:string,process:string|null,pid:number|null,containerId:string|null}>} input.listeners
 *        from the agent's ports.owners op (may be empty when the agent is absent)
 * @param {Array<object>} input.containers  Docker /containers/json entries (may be empty)
 * @returns {Map<number,{name:string,icon:string,checkType:string,path:string,owner:string,process:string|null}>}
 */
export function identifyPorts({ listeners = [], containers = [] } = {}) {
  const byId = new Map(containers.map((c) => [c.Id, c]));
  const published = new Map();   // host port -> { container, privatePort }
  for (const c of containers) {
    for (const p of c.Ports || []) {
      if (p.Type === 'tcp' && p.PublicPort && !published.has(p.PublicPort)) {
        published.set(p.PublicPort, { container: c, privatePort: p.PrivatePort });
      }
    }
  }

  // One entry per port: who owns it.
  const owners = new Map();
  const ports = new Set([...listeners.map((l) => l.port), ...published.keys()]);
  for (const port of ports) {
    const l = listeners.find((x) => x.port === port) || {};
    const proc = l.process || null;
    const pub = published.get(port);
    const container = pub ? pub.container : (l.containerId ? byId.get(l.containerId) : null);
    if (container) {
      owners.set(port, { kind: 'container', container, privatePort: pub ? pub.privatePort : port, process: proc });
    } else if (proc && PROCESS_APPS[proc]) {
      owners.set(port, { kind: 'app', app: { key: PROCESS_APPS[proc], ...APPS[PROCESS_APPS[proc]] }, process: proc });
    } else if (proc && !GENERIC_PROCESSES.has(proc) && KNOWN_PROCESSES[proc]) {
      owners.set(port, { kind: 'process', process: proc });
    }
  }

  // The main container of a Compose project is the one with the lowest port;
  // the project is named after it, other containers after their service.
  const projectMain = new Map();
  for (const [port, o] of [...owners].sort((a, b) => a[0] - b[0])) {
    if (o.kind !== 'container') continue;
    const project = o.container.Labels?.['com.docker.compose.project'];
    if (project && !projectMain.has(project)) projectMain.set(project, o.container.Id);
  }

  const result = new Map();
  for (const [port, o] of owners) {
    let app = null;
    let base;
    let icon;
    let owner;
    const procNote = o.process && o.process !== 'docker-proxy' ? `process ${o.process}` : null;
    if (o.kind === 'container') {
      const c = o.container;
      app = appForContainer(c);
      const project = c.Labels?.['com.docker.compose.project'];
      const service = c.Labels?.['com.docker.compose.service'];
      if (app) base = app.name;
      else if (project && projectMain.get(project) === c.Id) base = capitalise(project);
      else if (service) base = capitalise(service);
      else base = capitalise(containerName(c));
      icon = app ? app.icon : 'box';
      owner = [procNote, `container ${containerName(c)}`, `image ${imageBase(c.Image)}`].filter(Boolean).join(' · ');
    } else if (o.kind === 'app') {
      app = o.app;
      base = app.name;
      icon = app.icon;
      owner = procNote;
    } else {
      const known = KNOWN_PROCESSES[o.process];
      base = known.name;
      icon = known.icon || 'server';
      owner = procNote;
    }

    const role = app?.ports?.[port] || {};
    const privatePort = o.privatePort || port;
    const conventional = KNOWN_SERVICES[port] || KNOWN_SERVICES[privatePort] || null;
    const checkType = role.checkType
      || (conventional && conventional.checkType !== 'interface' ? conventional.checkType : null)
      || (o.kind === 'process' ? KNOWN_PROCESSES[o.process].checkType : null)
      || (o.kind === 'container' ? 'tcp' : 'http');
    const path = role.path || conventional?.path || (o.kind === 'process' ? KNOWN_PROCESSES[o.process].path : null) || '/';
    result.set(port, {
      name: base, icon: role.icon || icon, checkType, path, owner,
      process: o.process || null,
      group: o.kind === 'container' ? o.container.Id : `app:${base}`,
      role: role.role || null,
    });
  }

  // An application on several ports: tell its ports apart.
  const groups = new Map();
  for (const [port, r] of result) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(port);
  }
  for (const ports of groups.values()) {
    if (ports.length < 2) continue;
    for (const port of ports) {
      const r = result.get(port);
      const suffix = r.role || (r.checkType === 'https' ? 'HTTPS' : null);
      if (suffix) {
        r.name = `${r.name} ${suffix}`;
        if (suffix === 'HTTPS' && r.icon === 'box') r.icon = 'lock';
      }
    }
  }
  // Still the same name twice (two plain-HTTP ports of one app): add the port.
  const seen = new Map();
  for (const [port, r] of [...result].sort((a, b) => a[0] - b[0])) {
    if (seen.has(r.name)) r.name = `${r.name} :${port}`;
    else seen.set(r.name, port);
  }

  for (const r of result.values()) { delete r.group; delete r.role; }
  return result;
}
