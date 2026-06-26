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
      const ssh = (d.ssh || []).length;
      const vnc = (d.vnc || []).length;
      // tailscale is an object with a peers array (active peers)
      const ts = (d.tailscale?.peers || []).filter((p) => p.active || p.online).length
        || (Array.isArray(d.tailscale) ? d.tailscale.length : 0);
      const total = ssh + vnc + ts;
      setBig(elv, total, total ? 'active now' : 'none active');
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
      let score;
      try {
        const t = await getJSON('/api/reports/today');
        score = t?.health?.overall ?? t?.health?.score;
      } catch { /* fall back to latest daily */ }
      if (score == null) {
        const d = await getJSON('/api/reports/daily?days=1');
        const day = (d.days || [])[0];
        score = day?.payload?.health?.overall ?? day?.payload?.health?.score;
      }
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
      const top = (d.shares || []).slice(0, 3);
      if (!top.length) { setBig(elv, '—', 'no connections'); return; }
      setBig(elv, top[0].service || '—', Math.round(top[0].pct ?? 0) + '%');
      setRow(elv, top.slice(1).map((p) => [p.service, Math.round(p.pct ?? 0) + '%']));
    },
  },
  {
    id: 'sum-domains', title: 'DNS', icon: iconGlobe, nav: '#/network',
    async load(elv) {
      const d = await getJSON('/api/network');
      const dns = d.dns || {};
      const body = elv.querySelector('.sw-body');
      // Pi-hole source: rich mini-view — headline queries, permitted/blocked split
      // bar, and the top domains.
      if (dns.source === 'pihole' && dns.available !== false) {
        const t = dns.totals || {};
        const total = Number(t.total ?? 0);
        const blocked = Number(t.blocked ?? 0);
        const permitted = Math.max(0, total - blocked);
        const pctB = t.percentBlocked != null ? Math.round(t.percentBlocked * 10) / 10
          : (total ? Math.round((blocked / total) * 1000) / 10 : 0);
        const top = (dns.topPermitted || []).slice(0, 3);
        const fmt = (n) => Number(n).toLocaleString();
        const permW = total ? (permitted / total) * 100 : 100;
        const rows = top.length
          ? top.map((x) => {
              const max = Math.max(1, ...top.map((y) => y.count));
              return `<div class="sw-dns-row"><span class="sw-dns-dom" title="${esc(x.domain)}">${esc(x.domain)}</span>
                <span class="sw-dns-bar"><span style="width:${Math.max(4, (x.count / max) * 100)}%"></span></span>
                <span class="sw-dns-n">${fmt(x.count)}</span></div>`;
            }).join('')
          : `<div class="sw-dns-empty">Awaiting queries…</div>`;
        body.innerHTML = `
          <div class="sw-main"><span class="sw-value">${fmt(total)}</span><span class="sw-label">queries today</span></div>
          <div class="sw-dns-split" title="${fmt(permitted)} permitted · ${fmt(blocked)} blocked">
            <span class="sw-dns-perm" style="width:${permW}%"></span>
            <span class="sw-dns-block" style="width:${100 - permW}%"></span>
          </div>
          <div class="sw-dns-legend">
            <span><i class="sw-dot-ok"></i>${fmt(permitted)} permitted</span>
            <span><i class="sw-dot-block"></i>${fmt(blocked)} blocked (${pctB}%)</span>
          </div>
          <div class="sw-dns-list">${rows}</div>`;
        return;
      }
      // Fallbacks (non-Pi-hole) keep the standard template.
      body.innerHTML = `<div class="sw-main"><span class="sw-value" data-sw="value">—</span><span class="sw-label" data-sw="label">loading…</span></div><div class="sw-row" data-sw="row"></div>`;
      const doms = dns.domains || [];
      if (doms.length) {
        setBig(elv, doms.length, 'domains');
        setRow(elv, doms.slice(0, 3).map((x) => [x.domain, x.queries ?? '']));
        return;
      }
      const resolver = shortResolver(dns.resolver);
      setBig(elv, resolver, 'resolver');
      setRow(elv, [['Per-domain', 'not logged']]);
    },
  },
  {
    id: 'sum-case', title: 'Case',
    icon: () => svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h2M8 11h2M8 15h2"/><circle cx="15.5" cy="9" r="1.6"/>'),
    nav: '#/settings?tab=pironman',
    async load(elv) {
      let d = {};
      try { d = await getJSON('/api/pironman/status'); } catch { /* enabled but agent/api hiccup */ }
      // Gated: only show live data when the controller is installed.
      if (!d || d.installed !== true) {
        setBig(elv, 'Off', d && d.installed === false ? 'not installed' : 'not set up');
        setRow(elv, [['Setup', 'Settings → Case']]);
        return;
      }
      const rgb = d.rgb || {}, fan = d.fan || {};
      if (rgb.enable) {
        setBig(elv, 'RGB on', String(rgb.style || 'rainbow').replace('_', ' '));
      } else {
        setBig(elv, 'RGB off', fan.modeLabel || '—');
      }
      setRow(elv, [
        ['Fan', fan.modeLabel || '—'],
        ['LED', fan.led || '—'],
        [rgb.enable ? 'Bright' : 'API', rgb.enable ? (rgb.brightness ?? 0) + '%' : (d.apiReachable ? 'live' : 'file')],
      ]);
    },
  },
];

// --- helpers ---------------------------------------------------------------

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function shortResolver(r) {
  if (!r) return '—';
  return String(r).replace(/^https?:\/\//, '').split('/')[0].slice(0, 18);
}

async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}

function setBig(card, value, label, tone = '') {
  const v = card.querySelector('[data-sw=value]');
  const l = card.querySelector('[data-sw=label]');
  if (v) {
    v.textContent = value;
    v.className = 'sw-value' + (tone ? ' sw-' + tone : '');
    // long text values (e.g. a resolver name) get a smaller font so they fit
    const len = String(value).length;
    v.classList.toggle('sw-value-sm', len > 6);
    v.classList.toggle('sw-value-xs', len > 12);
  }
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
function iconFan() { return svg('<path d="M12 12c0-3 .5-6 3-6s3 3 0 4.5"/><path d="M12 12c3 0 6 .5 6 3s-3 3-4.5 0"/><path d="M12 12c0 3-.5 6-3 6s-3-3 0-4.5"/><path d="M12 12c-3 0-6-.5-6-3s3-3 4.5 0"/><circle cx="12" cy="12" r="1.5"/>'); }
function iconBolt() { return svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'); }
function iconShuffle() { return svg('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'); }
function iconGlobe() { return svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'); }
function iconArrow() { return svg('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>'); }
