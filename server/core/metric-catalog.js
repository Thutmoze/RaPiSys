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
};

const NET_RE = /^net\.(.+)\.(rx|tx)$/;
const SVC_RE = /^service\.(.+)\.up$/;
const DOCK_RE = /^docker\.(.+)\.up$/;
const PEER_RE = /^peer\.(.+)\.up$/;

export const GROUP_ORDER = ['System', 'Thermal & power', 'Network', 'Services', 'Containers', 'Nodes', 'Other'];

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
