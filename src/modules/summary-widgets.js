/** RaPiSys — Overview summary widgets (F6).
 *
 * Compact, glanceable cards that surface headline numbers from the feature
 * pages (Sessions, Updates, Alerts, Health, Hardware, Network). Each builds its
 * own DOM block (matching the existing .card design language), fetches from the
 * same API the full page uses, and links to that page. They are registered as
 * layout widgets so the user can add them to the dashboard in edit mode.
 *
 * They are created lazily and parked (hidden) until placed via the layout
 * editor — so they never alter the default dashboard.
 */

const NAV = (hash) => () => { window.location.hash = hash; };

// Each summary widget: id, title, the card element factory, and a refresh fn.
export const SUMMARY_WIDGETS = [
  {
    id: 'sum-sessions', title: 'Active Sessions', icon: iconUsers, nav: '#/sessions',
    async load(elv) {
      const d = await getJSON('/api/sessions');
      const active = (d.active || d.sessions || []).filter((s) => !s.ended_at && !s.endedAt);
      const ssh = active.filter((s) => (s.kind || '').toLowerCase() === 'ssh').length;
      const vnc = active.filter((s) => (s.kind || '').toLowerCase() === 'vnc').length;
      const ts = active.filter((s) => (s.kind || '').toLowerCase() === 'tailscale').length;
      setBig(elv, active.length, 'active now');
      setRow(elv, [['SSH', ssh], ['VNC', vnc], ['Tailscale', ts]]);
    },
  },
  {
    id: 'sum-updates', title: 'Updates', icon: iconDownload, nav: '#/updates',
    async load(elv) {
      const d = await getJSON('/api/updates');
      const ups = d.updates || [];
      const sec = ups.filter((u) => u.security).length;
      setBig(elv, ups.length, 'pending');
      setRow(elv, [['Security', sec, sec > 0 ? 'warn' : '']]);
    },
  },
  {
    id: 'sum-alerts', title: 'Active Alerts', icon: iconBell, nav: '#/alerts',
    async load(elv) {
      const d = await getJSON('/api/alerts/active');
      const active = d.active || [];
      const crit = active.filter((a) => (a.severity || '') === 'critical').length;
      const warn = active.filter((a) => (a.severity || '') === 'warning').length;
      setBig(elv, active.length, active.length ? 'firing' : 'all clear', active.length ? (crit ? 'crit' : 'warn') : 'ok');
      setRow(elv, [['Critical', crit, crit ? 'crit' : ''], ['Warning', warn, warn ? 'warn' : '']]);
    },
  },
  {
    id: 'sum-health', title: 'Health Score', icon: iconHeart, nav: '#/reports',
    async load(elv) {
      const d = await getJSON('/api/reports/daily');
      const score = d?.payload?.health?.score ?? d?.health?.score ?? d?.score;
      if (score == null) { setBig(elv, '—', 'no data yet'); return; }
      const tone = score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'crit';
      setBig(elv, Math.round(score), 'out of 100', tone);
    },
  },
  {
    id: 'sum-cooling', title: 'Active Cooling', icon: iconFan, nav: '#/hardware',
    async load(elv) {
      const d = await getJSON('/api/hardware');
      const fan = d.fan || {};
      if (!fan.rpm && fan.present === false) { setBig(elv, 'N/A', 'no fan detected'); return; }
      setBig(elv, fan.rpm ?? 0, 'RPM');
      setRow(elv, [['Duty', (fan.dutyPercent ?? 0) + '%'], ['Mode', fan.mode || '—']]);
    },
  },
  {
    id: 'sum-power', title: 'Power', icon: iconBolt, nav: '#/hardware',
    async load(elv) {
      const d = await getJSON('/api/hardware');
      const p = d.power || {};
      const watts = p.watts != null ? Number(p.watts).toFixed(1) : '—';
      setBig(elv, watts, 'watts', p.undervoltageNow ? 'crit' : '');
      const core = (p.rails || []).find((r) => /core/i.test(r.rail));
      setRow(elv, [['Core', core ? core.volts.toFixed(2) + ' V' : '—'],
        ['Undervolt', p.undervoltageNow ? 'YES' : 'no', p.undervoltageNow ? 'crit' : 'ok']]);
    },
  },
  {
    id: 'sum-protocols', title: 'Protocols', icon: iconShuffle, nav: '#/network',
    async load(elv) {
      const d = await getJSON('/api/network/protocols');
      const list = (d.protocols || d.share || d || []).slice ? (d.protocols || d.share || []) : [];
      const top = (Array.isArray(list) ? list : []).slice(0, 3);
      if (!top.length) { setBig(elv, '—', 'no data'); return; }
      setBig(elv, top[0].proto || top[0].name || '—', (top[0].percent ?? top[0].pct ?? '') + (top[0].percent != null ? '%' : ''));
      setRow(elv, top.slice(1).map((p) => [p.proto || p.name, (p.percent ?? p.pct ?? '') + '%']));
    },
  },
  {
    id: 'sum-domains', title: 'Top Domains', icon: iconGlobe, nav: '#/network',
    async load(elv) {
      const d = await getJSON('/api/network/dns').catch(() => getJSON('/api/network/connections'));
      const doms = d.domains || d.top || [];
      if (!doms.length) { setBig(elv, '—', 'no DNS data'); return; }
      setBig(elv, doms.length, 'domains seen');
      setRow(elv, doms.slice(0, 3).map((x) => [x.domain || x.name || x.host, x.queries ?? x.count ?? '']));
    },
  },
];

// --- helpers ---------------------------------------------------------------

async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}

function setBig(card, value, label, tone = '') {
  const v = card.querySelector('[data-sw=value]');
  const l = card.querySelector('[data-sw=label]');
  if (v) { v.textContent = value; v.className = 'sw-value' + (tone ? ' sw-' + tone : ''); }
  if (l) l.textContent = label;
}
function setRow(card, pairs) {
  const row = card.querySelector('[data-sw=row]');
  if (!row) return;
  row.innerHTML = pairs.map(([k, val, tone]) =>
    `<div class="sw-stat"><span class="sw-stat-label">${k}</span><span class="sw-stat-val${tone ? ' sw-' + tone : ''}">${val}</span></div>`).join('');
}

/** Build the card element for a summary widget (matches .card design). */
export function buildSummaryCard(def) {
  const card = document.createElement('div');
  card.className = 'card sw-card';
  card.dataset.swId = def.id;
  card.innerHTML = `
    <div class="card-header">
      <div class="card-icon sw-icon">${def.icon()}</div>
      <span class="card-title">${def.title}</span>
      <button class="sw-open" title="Open ${def.title}">${iconArrow()}</button>
    </div>
    <div class="card-body sw-body">
      <div class="sw-main"><span class="sw-value" data-sw="value">—</span><span class="sw-label" data-sw="label">loading…</span></div>
      <div class="sw-row" data-sw="row"></div>
    </div>`;
  card.querySelector('.sw-open').addEventListener('click', NAV(def.nav));
  // initial + periodic refresh while present
  const refresh = () => def.load(card).catch(() => setBig(card, '—', 'unavailable'));
  refresh();
  card._swTimer = setInterval(refresh, 15000);
  return card;
}

// inline icons (Lucide-style, matching the app)
function svg(p) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`; }
function iconUsers() { return svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'); }
function iconDownload() { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'); }
function iconBell() { return svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'); }
function iconHeart() { return svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>'); }
function iconFan() { return svg('<path d="M12 12m0 0a4 4 0 0 0 4-4c0-2-1-4-4-4s-4 4-4 4a4 4 0 0 0 4 4z"/><circle cx="12" cy="12" r="1.5"/>'); }
function iconBolt() { return svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'); }
function iconShuffle() { return svg('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'); }
function iconGlobe() { return svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'); }
function iconArrow() { return svg('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>'); }
