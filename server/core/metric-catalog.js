/**
 * RaPiSys — metric catalog
 * -------------------------
 * Single source of truth for turning a raw metric key ('temp.cpu',
 * 'service.dns.up', 'docker.pihole.up', ...) into a friendly label and a
 * group for the Alerts rule-form dropdown. Also owns `slugify`, used by the
 * sampler to build the dynamic service.<name>.up / docker.<name>.up metric
 * keys so both sides stay in sync.
 */

const STATIC = {
  'cpu.usage': { label: 'CPU usage (%)', group: 'System' },
  'cpu.freq': { label: 'CPU frequency (MHz)', group: 'System' },
  'mem.percent': { label: 'Memory usage (%)', group: 'System' },
  'load.avg1': { label: 'Load average (1 min)', group: 'System' },
  'temp.cpu': { label: 'CPU temperature (°C)', group: 'Thermal & power' },
  'fan.rpm': { label: 'Fan speed (RPM)', group: 'Thermal & power' },
  'fan.duty': { label: 'Fan duty cycle (%)', group: 'Thermal & power' },
  'power.core_v': { label: 'Core voltage (V)', group: 'Thermal & power' },
  'power.5v': { label: '5V rail (V)', group: 'Thermal & power' },
  'power.watts': { label: 'Board power (W)', group: 'Thermal & power' },
  'updates.reboot_required': { label: 'Reboot required to finish updates (1 = yes)', group: 'System' },
  'storage.backup_failed': { label: 'Database backup to NAS failed (1 = yes)', group: 'System' },
};

// 1/0 flags that read better as a sentence than as "is 1 (threshold >= 1)".
const FLAGS = {
  'updates.reboot_required': {
    on: 'A reboot is required to finish installing updates. Open Updates in RaPiSys to see what is waiting.',
    off: 'No reboot is pending any more.',
  },
  'storage.backup_failed': {
    on: 'The last database backup to the NAS failed. Open Settings → Storage in RaPiSys to see why.',
    off: 'Database backups to the NAS are working again.',
  },
};

/** Sentence for a 1/0 flag metric in an alert, or null for ordinary metrics. */
export function flagWording(key, value) {
  const f = FLAGS[key];
  return f ? (value >= 1 ? f.on : f.off) : null;
}

const NET_RE = /^net\.(.+)\.(rx|tx)$/;
const SVC_RE = /^service\.(.+)\.up$/;
const DOCK_RE = /^docker\.(.+)\.up$/;
// Raw inputs to the container health rule: 1 healthy / 0 unhealthy (only for
// images with a HEALTHCHECK, never while "starting"), and Docker's restart count.
const DOCK_HEALTH_RE = /^docker\.(.+)\.health$/;
const DOCK_RESTARTS_RE = /^docker\.(.+)\.restarts$/;
const PEER_RE = /^peer\.(.+)\.up$/;

export const GROUP_ORDER = ['System', 'Thermal & power', 'Network', 'Services', 'Containers', 'Nodes', 'Other'];

/** Virtual metric key of a "Container health" rule. Not sampled itself: the
 * engine reads docker.<slug>.up/.health/.restarts for each watched container. */
export const CONTAINER_HEALTH_METRIC = 'docker.health';
export const CONTAINER_HEALTH_CONDITIONS = ['down', 'unhealthy', 'restarts'];

/** Turn a display name ('Pi-hole Admin', 'my_container.1') into a stable metric-key segment. */
export function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function titleize(slug) {
  return slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Describe a metric key for display. `live` optionally supplies slug -> real
 * display name maps for services/containers (from the sampler's live cache),
 * so a rule for a currently-configured service/container shows its actual
 * name rather than a prettified slug.
 */
export function describeMetric(key, live = {}) {
  if (STATIC[key]) return { key, ...STATIC[key] };
  if (key === CONTAINER_HEALTH_METRIC) {
    return { key, label: 'Container health (running, healthcheck, restarts)', group: 'Containers' };
  }

  let m;
  if ((m = key.match(NET_RE))) {
    const dir = m[2] === 'rx' ? 'download' : 'upload';
    return { key, label: `${m[1]} — ${dir} (bytes/s)`, group: 'Network' };
  }
  if ((m = key.match(SVC_RE))) {
    const name = live.services?.get(m[1]) || titleize(m[1]);
    return { key, label: name, group: 'Services' };
  }
  if ((m = key.match(DOCK_RE))) {
    const name = live.containers?.get(m[1]) || titleize(m[1]);
    return { key, label: name, group: 'Containers' };
  }
  if ((m = key.match(DOCK_HEALTH_RE))) {
    const name = live.containers?.get(m[1]) || titleize(m[1]);
    return { key, label: `${name} healthcheck (1 = healthy)`, group: 'Containers' };
  }
  if ((m = key.match(DOCK_RESTARTS_RE))) {
    const name = live.containers?.get(m[1]) || titleize(m[1]);
    return { key, label: `${name} restart count`, group: 'Containers' };
  }
  if ((m = key.match(PEER_RE))) {
    // Peer names come straight from the operator, so the slug is the name.
    const name = live.peers?.get(m[1]) || m[1];
    return { key, label: `Node ${name} reachable`, group: 'Nodes' };
  }
  return { key, label: key, group: 'Other' };
}

export function isStatusMetric(key) {
  return SVC_RE.test(key) || DOCK_RE.test(key) || PEER_RE.test(key);
}

/** Slug of a per-container "running" metric, or null. */
export function containerSlugOf(key) {
  const m = key.match(DOCK_RE);
  return m ? m[1] : null;
}

/** Raw container inputs that only feed the container health rule; the Alerts
 * picker hides them (a numeric "restart count > N" rule would be misleading). */
export function isContainerHealthInput(key) {
  return DOCK_HEALTH_RE.test(key) || DOCK_RESTARTS_RE.test(key);
}
