/**
 * RaPiSys — frontend modules entry
 * --------------------------------
 * Additive layer on top of the legacy main.js (untouched):
 *   - hash router + left navigation rail (Overview = the original dashboard)
 *   - first-run setup wizard (storage / retention / SMTP)
 *   - Hardware page: fan, thermal history, power (Pi 5)
 *
 * Everything reuses the existing design tokens (.card, --accent-*, glass).
 */

import { initOverviewLayout, setToast as setLayoutToast } from './layout.js';

const API = window.location.port === '5173' ? 'http://localhost:3001/api' : '/api';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

// ---- date / time formatting preference --------------------------------------
// Stored in localStorage (mirrored from Settings → Preferences). Affects all
// timestamp rendering across the app via rapisysFmtTime / rapisysFmtDate.
const RAPISYS_DATEFMT_KEY = 'rapisys.dateFormat';   // 'auto'|'iso'|'us'|'eu'|'long'
const RAPISYS_TIMEFMT_KEY = 'rapisys.timeFormat';   // 'auto'|'24'|'12'
function rapisysDateFmtPref() {
  return {
    date: localStorage.getItem(RAPISYS_DATEFMT_KEY) || 'auto',
    time: localStorage.getItem(RAPISYS_TIMEFMT_KEY) || 'auto',
  };
}
function rapisysHour12() {
  const t = rapisysDateFmtPref().time;
  if (t === '12') return true;
  if (t === '24') return false;
  return undefined;   // 'auto' → locale default
}
// Date+time (used for log timestamps). dateOnly omits the time part.
function rapisysFmtTime(ts, { dateOnly = false } = {}) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pref = rapisysDateFmtPref();
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getFullYear(), M = pad(d.getMonth() + 1), D = pad(d.getDate());
  const h12 = rapisysHour12();
  const timeStr = h12 === undefined
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: h12 });
  let dateStr;
  switch (pref.date) {
    case 'iso': dateStr = `${Y}-${M}-${D}`; break;
    case 'us': dateStr = `${M}/${D}/${Y}`; break;
    case 'eu': dateStr = `${D}/${M}/${Y}`; break;
    case 'long': dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); break;
    default: dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' }); break;   // 'auto'
  }
  return dateOnly ? dateStr : `${dateStr} ${timeStr}`;
}
const rapisysFmtDate = (ts) => rapisysFmtTime(ts, { dateOnly: true });

async function api(path, opts = {}, retried = false) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(`${API}${path}`, { ...opts, headers, credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401 && !retried) {
    // Admin action from an unauthenticated browser: show the login modal,
    // then retry the original call once.
    const ok = await showLogin();
    if (ok) return api(path, opts, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// App-native confirm dialog (replaces window.confirm's browser chrome)
// ---------------------------------------------------------------------------

function rapisysConfirm(message, { danger = false, confirmLabel = 'Confirm', html = false } = {}) {
  return new Promise((resolve) => {
    const ov = el('div', 'wizard-overlay rconfirm-overlay');
    ov.innerHTML = `
      <div class="wizard card rconfirm">
        <p class="rconfirm-msg"></p>
        <div class="wz-row rconfirm-row">
          <button class="action-btn ${danger ? 'rconfirm-danger' : 'wz-primary'}" data-rc="ok"></button>
          <button class="action-btn set-btn-cancel" data-rc="cancel">Cancel</button>
        </div>
      </div>`;
    // html:true is only ever passed our own escaped strings (names run
    // through esc()); never raw user input.
    if (html) ov.querySelector('.rconfirm-msg').innerHTML = message;
    else ov.querySelector('.rconfirm-msg').textContent = message;
    ov.querySelector('[data-rc=ok]').textContent = confirmLabel;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('[data-rc=ok]').onclick = () => done(true);
    ov.querySelector('[data-rc=cancel]').onclick = () => done(false);
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
    setTimeout(() => ov.querySelector('[data-rc=cancel]').focus(), 40);
  });
}

// ---------------------------------------------------------------------------
// Custom dropdowns: native <select> popups are OS/browser-rendered and
// refuse dark theming in several browsers (white flash). We render our
// own popup and keep the hidden native select as the source of truth so
// existing form code (select.value, change events) works unchanged.
// ---------------------------------------------------------------------------

function enhanceSelects(root) {
  // Portaled dropdown lists live on <body> and outlive their <select> when a
  // page re-renders. Prune any whose owning wrap has left the DOM, so they
  // don't pile up and intercept clicks (the stale, absolutely-positioned list
  // sits over the live one and swallows the mouse event).
  document.querySelectorAll('body > .rsel-list').forEach((l) => {
    if (!l._owner || !l._owner.isConnected) l.remove();
  });

  root.querySelectorAll('select:not([data-rsel])').forEach((sel) => {
    sel.dataset.rsel = '1';
    const wrap = el('div', 'rsel');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);                    // stays in DOM, hidden by CSS

    const btn = el('button', 'rsel-btn');
    btn.type = 'button';
    const labelOf = () => sel.options[sel.selectedIndex]?.text ?? '';
    btn.innerHTML = `<span class="rsel-label"></span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>`;
    const labEl = btn.querySelector('.rsel-label');
    labEl.textContent = labelOf();
    wrap.appendChild(btn);

    // The list is PORTALED to <body>: glass cards each create a stacking
    // context, so an absolutely-positioned list inside one card paints
    // BELOW the next card no matter its z-index.
    const list = el('div', 'rsel-list');
    list.hidden = true;
    const filter = el('input', 'rsel-filter');
    filter.placeholder = 'Type to filter…';
    const items = el('div', 'rsel-items');
    list.appendChild(filter); list.appendChild(items);
    list._owner = wrap;                       // back-reference for orphan pruning
    document.body.appendChild(list);

    function renderItems(q = '') {
      items.innerHTML = '';
      const needle = q.trim().toLowerCase();
      [...sel.options].forEach((o, i) => {
        if (needle && !o.text.toLowerCase().includes(needle)) return;
        const item = el('button', 'rsel-item' + (i === sel.selectedIndex ? ' sel' : ''));
        item.type = 'button';
        item.textContent = o.text;
        item.onclick = (ev) => {
          ev.stopPropagation();
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          labEl.textContent = labelOf();
          close();
        };
        items.appendChild(item);
      });
      if (!items.children.length) items.innerHTML = '<div class="rsel-none">No matches</div>';
    }
    function position() {
      const r = btn.getBoundingClientRect();
      // Let the list grow wider than the button to fit long option text, but
      // never overflow the viewport. min-width keeps it at least button-width.
      list.style.left = `${r.left}px`;
      list.style.minWidth = `${r.width}px`;
      list.style.width = 'max-content';
      list.style.maxWidth = `${Math.max(r.width, window.innerWidth - r.left - 16)}px`;
      const below = window.innerHeight - r.bottom;
      // NB: reset the unused edge to 'auto' (not ''), else the stylesheet's
      // top: calc(100% + 4px) stays in force and, combined with an explicit
      // bottom, stretches/crushes the list to a sliver.
      if (below < 260 && r.top > 260) { list.style.top = 'auto'; list.style.bottom = `${window.innerHeight - r.top + 4}px`; }
      else { list.style.bottom = 'auto'; list.style.top = `${r.bottom + 4}px`; }
    }
    const close = () => { list.hidden = true; btn.classList.remove('open'); filter.value = ''; };
    btn.onclick = () => {
      if (list.hidden) {
        renderItems(); position(); list.hidden = false; btn.classList.add('open');
        filter.style.display = sel.options.length > 8 ? '' : 'none';
        if (sel.options.length > 8) setTimeout(() => filter.focus(), 30);
      } else close();
    };
    filter.addEventListener('input', () => renderItems(filter.value));
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target) && !list.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('scroll', () => { if (!list.hidden) position(); }, true);
    window.addEventListener('resize', () => { if (!list.hidden) position(); });
    sel.addEventListener('change', () => { labEl.textContent = labelOf(); });
  });
}

// ---------------------------------------------------------------------------
// Login modal (full-control mode): username + password + authenticator code
// ---------------------------------------------------------------------------

let loginPromise = null;
function showLogin() {
  if (loginPromise) return loginPromise;       // one modal at a time
  loginPromise = new Promise((resolve) => {
    const ov = el('div', 'wizard-overlay');
    ov.innerHTML = `
      <div class="wizard card login-card">
        <h2><span class="wz-cyan">Ra</span><span class="wz-purple">Pi</span>Sys admin</h2>
        <p class="wz-lead">This action requires the administrator account.</p>
        <div class="wz-form">
          <label>Username <input data-lg="user" autocomplete="username"></label>
          <label>Password <input data-lg="pass" type="password" autocomplete="current-password"></label>
          <label data-lg="codewrap">Authenticator code <input data-lg="code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></label>
          <div class="wz-row">
            <button class="action-btn wz-primary" data-lg="go">Sign in</button>
            <button class="action-btn set-btn-cancel" data-lg="cancel">Cancel</button>
            <span data-lg="status"></span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    // MFA is per-admin choice: hide the code field when it's disabled.
    api('/auth/me').then((me) => {
      if (me.mfaEnabled === false) $('[data-lg=codewrap]', ov).hidden = true;
    }).catch(() => {});
    const done = (ok) => { ov.remove(); loginPromise = null; resolve(ok); };
    $('[data-lg=cancel]', ov).onclick = () => done(false);
    const submit = async () => {
      const stat = $('[data-lg=status]', ov);
      stat.classList.remove('wz-status-ok', 'wz-status-err');
      stat.textContent = 'Signing in…';
      try {
        const res = await fetch(`${API}/auth/login`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: $('[data-lg=user]', ov).value.trim(),
            password: $('[data-lg=pass]', ov).value,
            code: $('[data-lg=code]', ov).value.trim(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'login failed');
        setStatus(stat, true, '✓');
        refreshAuthBadge();
        done(true);
      } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
    };
    $('[data-lg=go]', ov).onclick = submit;
    ov.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') done(false); });
    setTimeout(() => $('[data-lg=user]', ov).focus(), 50);
  });
  return loginPromise;
}

// auth badge in the nav rail (lock icon: state + login/logout)
async function refreshAuthBadge() {
  let me = { mode: 'monitor', authenticated: false };
  try { me = await api('/auth/me'); } catch { /* server older */ }
  const btn = $('.nav-auth');
  if (!btn) return;
  btn.dataset.mode = me.mode;
  btn.dataset.authed = me.authenticated ? '1' : '0';
  btn.title = me.mode === 'monitor'
    ? 'Monitor-only mode'
    : (me.authenticated ? `Signed in as ${me.username} — click to sign out` : 'Read-only — click to sign in');
  btn.classList.toggle('authed', me.authenticated);
  btn.classList.toggle('monitor', me.mode === 'monitor');
}

/** Style an inline status span: bold green on success, bold red on error. */
function setStatus(el, ok, msg) {
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('wz-status-ok', 'wz-status-err');
  el.classList.add(ok ? 'wz-status-ok' : 'wz-status-err');
}

function toast(type, title, message) {
  // Reuse the legacy toast system if present.
  if (window.showToast) return window.showToast(type, title, message);
  console.log(`[${type}] ${title}: ${message}`);
}

// ---------------------------------------------------------------------------
// Minimal canvas line chart for historical series (Smoothie is streaming-only)
// ---------------------------------------------------------------------------

function drawSeries(canvas, points, { color = '#00d4ff', unit = '' } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('Collecting data…', 12, h / 2);
    return;
  }
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.value);
  const lows = points.map((p) => p.vmin ?? p.value);
  const highs = points.map((p) => p.vmax ?? p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...lows), y1 = Math.max(...highs);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.15; y0 -= pad; y1 += pad;
  const X = (t) => ((t - x0) / (x1 - x0 || 1)) * (w - 44) + 36;
  const Y = (v) => h - 18 - ((v - y0) / (y1 - y0)) * (h - 30);

  // grid + labels
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '10px Inter, sans-serif';
  for (let i = 0; i <= 3; i++) {
    const v = y0 + ((y1 - y0) * i) / 3;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(w - 8, y); ctx.stroke();
    ctx.fillText(`${Math.round(v * 10) / 10}${unit}`, 2, y + 3);
  }
  // min/max band (downsampled tiers)
  ctx.beginPath();
  points.forEach((p, i) => { const f = i ? 'lineTo' : 'moveTo'; ctx[f](X(p.ts), Y(p.vmax ?? p.value)); });
  [...points].reverse().forEach((p) => ctx.lineTo(X(p.ts), Y(p.vmin ?? p.value)));
  ctx.closePath();
  ctx.fillStyle = color + '22';
  ctx.fill();
  // main line
  ctx.beginPath();
  points.forEach((p, i) => { const f = i ? 'lineTo' : 'moveTo'; ctx[f](X(p.ts), Y(p.value)); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  // time labels
  const spanMs = x1 - x0;
  const fmt = (t) => spanMs > 12 * 3600e3
    ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(fmt(x0), 36, h - 4);
  const lastLabel = fmt(x1);
  ctx.fillText(lastLabel, w - 8 - ctx.measureText(lastLabel).width, h - 4);
}

// ---------------------------------------------------------------------------
// Router + navigation rail
// ---------------------------------------------------------------------------

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  hardware: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  sessions: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  network: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/>',
  reports: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  updates: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  inventory: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/>',
  alerts: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

// Shared page chrome: a large section title that reuses the page's nav-rail
// glyph (ICONS[id]) so every page header matches its menu item, plus an
// optional tab bar for pages with a primary + secondary view.
function pageHeader(id, title) {
  return `<div class="card-header page-head">
    <div class="card-icon page-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ''}</svg>
    </div>
    <span class="card-title page-title">${title}</span>
  </div>`;
}
// tabs: [{ id, label }]; first is active. Panes are matched by data-pane=id.
function pageTabs(tabs) {
  return `<div class="page-tabs">${tabs.map((t, i) =>
    `<button class="page-tab${i === 0 ? ' page-tab-active' : ''}" data-tab="${t.id}">${t.icon ? `<svg class="page-tab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>` : ''}${t.label}</button>`).join('')}</div>`;
}
// Wire a tab bar within `host`: shows the matching [data-pane], hides others,
// and calls onShow(tabId) when a tab is opened (for lazy loading).
function wirePageTabs(host, onShow) {
  host.querySelectorAll('[data-tab]').forEach((t) => {
    t.onclick = () => {
      // hide any open portaled dropdown belonging to the pane we're leaving
      document.querySelectorAll('body > .rsel-list').forEach((l) => { l.hidden = true; });
      host.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('page-tab-active', x === t));
      host.querySelectorAll('[data-pane]').forEach((p) => { p.style.display = p.dataset.pane === t.dataset.tab ? '' : 'none'; });
      if (onShow) onShow(t.dataset.tab);
    };
  });
}

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'network', label: 'Network' },
  { id: 'reports', label: 'Reports' },
  { id: 'updates', label: 'Updates' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'settings', label: 'Settings' },
];

const pageRenderers = {}; // id -> { mount(el), unmount() }
let activePage = null;
let activeRenderer = null;

function buildNav() {
  const rail = el('nav', 'nav-rail');
  rail.setAttribute('aria-label', 'RaPiSys pages');

  // Collapse toggle (state persisted in localStorage; this is the Pi-served app).
  const collapsed = localStorage.getItem('rapisys.navCollapsed') === '1';
  if (collapsed) document.body.classList.add('nav-collapsed');
  const toggle = el('button', 'nav-item nav-toggle', `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
         stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
    <span class="nav-label">Collapse</span>`);
  toggle.title = 'Collapse / expand menu';
  toggle.addEventListener('click', () => {
    const now = document.body.classList.toggle('nav-collapsed');
    localStorage.setItem('rapisys.navCollapsed', now ? '1' : '0');
  });
  rail.appendChild(toggle);

  for (const p of PAGES) {
    const btn = el('button', 'nav-item', `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round">${ICONS[p.id] || ''}</svg>
      <span class="nav-label">${p.label}</span>`);
    btn.dataset.page = p.id;
    btn.title = p.label + (p.soon ? ' (coming soon)' : '');
    if (p.soon) btn.classList.add('nav-soon');
    btn.addEventListener('click', () => { window.location.hash = `#/${p.id}`; });
    rail.appendChild(btn);
  }
  const authBtn = el('button', 'nav-item nav-auth', `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    <span class="nav-label">Admin</span>`);
  authBtn.style.marginTop = 'auto';
  authBtn.addEventListener('click', async () => {
    const me = await api('/auth/me').catch(() => null);
    if (!me || me.mode === 'monitor') {
      toast('info', 'Monitor-only mode', 'Control features are disabled on this RaPiSys.');
      return;
    }
    if (me.authenticated) {
      if (await rapisysConfirm('Sign out of the admin session?', { confirmLabel: 'Sign out' })) {
        await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
        refreshAuthBadge();
      }
    } else {
      await showLogin();
    }
  });
  rail.appendChild(authBtn);
  // Global "checking now" indicator: a small spinner in the nav rail, visible on
  // any page while a background auto-check is running. Polls every 15s.
  const checkInd = el('div', 'nav-checking', `
    <span class="up-spinner-sm"></span><span class="nav-label">Checking…</span>`);
  checkInd.title = 'An automatic update check is running';
  checkInd.style.display = 'none';
  rail.appendChild(checkInd);
  startGlobalCheckPoll(checkInd);
  document.body.appendChild(rail);
  return rail;
}

// Poll the auto-check schedule for a running background check; toggle the nav
// indicator. Lightweight (one tiny GET) and shared across all pages.
let _globalCheckTimer = null;
function startGlobalCheckPoll(indEl) {
  if (_globalCheckTimer) clearInterval(_globalCheckTimer);
  const tick = async () => {
    try {
      const c = await api('/updates/schedule');
      indEl.style.display = c?._running?.running ? 'flex' : 'none';
    } catch { /* leave as-is on error */ }
  };
  tick();
  _globalCheckTimer = setInterval(tick, 15000);
}

function route() {
  const id = (window.location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  const page = PAGES.find((p) => p.id === id) ? id : 'overview';
  if (page === activePage) return;
  // teardown
  activeRenderer?.unmount?.();
  activeRenderer = null;
  $('.rapisys-page')?.remove();
  // Portaled dropdown lists live on <body>, outside the page host, so they
  // survive the host being torn down. Remove them all on navigation — every
  // page rebuilds its own selects on mount.
  document.querySelectorAll('body > .rsel-list').forEach((l) => l.remove());

  const legacy = $('.container');
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.page === page));

  if (page === 'overview') {
    if (legacy) legacy.style.display = '';
    document.body.classList.remove('rapisys-subpage');
    // F6: apply any saved layout (order/visibility) to the native dashboard.
    initOverviewLayout();
  } else {
    if (legacy) legacy.style.display = 'none';
    document.body.classList.add('rapisys-subpage');
    const host = el('main', 'rapisys-page container');
    document.body.appendChild(host);
    const renderer = pageRenderers[page] || comingSoonPage(page);
    renderer.mount(host);
    enhanceSelects(host);
    activeRenderer = renderer;
  }
  activePage = page;
}

function comingSoonPage(id) {
  return {
    mount(host) {
      const label = PAGES.find((p) => p.id === id)?.label || id;
      host.appendChild(el('div', 'card soon-card', `
        <div class="card-header"><span class="card-title">${label}</span></div>
        <div class="card-body"><p class="soon-text">This section ships in an upcoming RaPiSys phase.</p></div>`));
    },
    unmount() {},
  };
}

// ---------------------------------------------------------------------------
// Hardware page
// ---------------------------------------------------------------------------

pageRenderers.hardware = (() => {
  let timer = null;
  let range = localStorage.getItem('hwRange') || '24h';

  async function refreshLive(host) {
    let hw;
    try { hw = await api('/hardware'); } catch { return; }
    const set = (sel, val) => { const n = $(sel, host); if (n) n.textContent = val; };

    // Fan
    set('[data-hw=rpm]', hw.fan.present ? `${hw.fan.rpm.toLocaleString()} RPM` : 'No cooler detected');
    set('[data-hw=mode]', hw.fan.present ? hw.fan.mode : '—');
    const dutyBar = $('[data-hw=dutybar]', host);
    if (dutyBar) dutyBar.style.width = `${hw.fan.present ? hw.fan.dutyPercent : 0}%`;
    set('[data-hw=duty]', hw.fan.present ? `${hw.fan.dutyPercent}%` : '—');
    if (hw.fan.present) pageRenderers.hardware._syncSlider?.(hw.fan.dutyPercent);

    // Thermal
    set('[data-hw=temp]', hw.thermal.cpuTemp !== null ? `${hw.thermal.cpuTemp.toFixed(1)}°C` : '—');
    const thr = hw.thermal.throttle;
    set('[data-hw=throttle]', !thr.available ? 'n/a'
      : thr.active.length ? thr.active.join(', ') : 'none');
    $('[data-hw=throttle]', host)?.classList.toggle('hw-bad', thr.active.length > 0);

    // Power
    set('[data-hw=freq]', hw.power.cpuFreqMhz ? `${hw.power.cpuFreqMhz} MHz` : '—');
    set('[data-hw=corev]', hw.power.coreVolts ? `${hw.power.coreVolts.toFixed(3)} V` : '—');
    set('[data-hw=supply]', hw.power.supply5v ? `${hw.power.supply5v.toFixed(2)} V` : '—');
    set('[data-hw=watts]', hw.power.watts ? `${hw.power.watts.toFixed(1)} W` : '—');
    const uv = $('[data-hw=undervolt]', host);
    if (uv) {
      uv.textContent = hw.power.undervoltageNow ? 'UNDERVOLTAGE'
        : hw.power.undervoltageOccurred ? 'occurred since boot' : 'ok';
      uv.classList.toggle('hw-bad', hw.power.undervoltageNow);
      uv.classList.toggle('hw-warn', !hw.power.undervoltageNow && hw.power.undervoltageOccurred);
    }
  }

  async function refreshHistory(host) {
    try {
      const data = await api(`/history?metric=temp.cpu&range=${range}`);
      const canvas = $('[data-hw=tempchart]', host);
      if (canvas) drawSeries(canvas, data.points, { color: '#f97316', unit: '°' });
    } catch { /* chart stays empty */ }
  }

  async function setFan(body) {
    try {
      await api('/hardware/fan', { method: 'POST', body });
      toast('success', 'Fan', body.mode === 'auto' ? 'Automatic control restored' : `Duty set to ${body.dutyPercent}%`);
    } catch (err) {
      toast('error', 'Fan control', err.message);
    }
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('hardware', 'Hardware')}</div>
      <div class="rapisys-grid">
        <div class="card">
          <div class="card-header">
            <div class="card-icon temp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v8M12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/></svg></div>
            <span class="card-title">Active Cooling</span>
          </div>
          <div class="card-body">
            <div class="hw-big" data-hw="rpm">—</div>
            <div class="hw-row"><span>Duty cycle</span><span data-hw="duty">—</span></div>
            <div class="hw-bar"><div class="hw-bar-fill" data-hw="dutybar"></div></div>
            <div class="hw-row"><span>Mode</span><span class="hw-mode" data-hw="mode">—</span></div>
            <div class="hw-controls hw-fan-controls">
              <button class="action-btn hw-fan-btn" data-fan="auto">Auto</button>
              <input type="range" min="0" max="100" value="50" data-fan="slider" aria-label="Manual fan duty">
              <button class="action-btn hw-fan-btn" data-fan="apply"><span>Set</span><span data-fan="pct">50</span><span>%</span></button>
            </div>
            <p class="hw-hint">Manual control requires the RaPiSys host agent.</p>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-icon cpu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg></div>
            <span class="card-title">Thermal</span>
            <select class="hw-range" data-hw="range" aria-label="History range">
              <option value="1h">1h</option><option value="6h">6h</option>
              <option value="24h">24h</option><option value="7d">7d</option><option value="30d">30d</option>
            </select>
          </div>
          <div class="card-body">
            <div class="hw-big" data-hw="temp">—</div>
            <canvas class="hw-chart" data-hw="tempchart" height="120"></canvas>
            <div class="hw-row"><span>Throttling</span><span data-hw="throttle">—</span></div>
            <p class="hw-hint">GPU shares the SoC sensor on Pi 5.</p>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-icon memory-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
            <span class="card-title">Power</span>
          </div>
          <div class="card-body">
            <div class="hw-row"><span>CPU frequency</span><span data-hw="freq">—</span></div>
            <div class="hw-row"><span>Core voltage</span><span data-hw="corev">—</span></div>
            <div class="hw-row"><span>5V supply (PMIC)</span><span data-hw="supply">—</span></div>
            <div class="hw-row"><span>Board power</span><span data-hw="watts">—</span></div>
            <div class="hw-row"><span>Undervoltage</span><span data-hw="undervolt">—</span></div>
          </div>
        </div>
      </div>`;

      $('[data-hw=range]', host).value = range;
      $('[data-hw=range]', host).addEventListener('change', (e) => {
        range = e.target.value; localStorage.setItem('hwRange', range); refreshHistory(host);
      });
      const slider = $('[data-fan=slider]', host);
      const pctEl = $('[data-fan=pct]', host);
      slider.addEventListener('input', (e) => {
        slider.dataset.touched = Date.now();   // pause auto-mirror while dragging
        pctEl.textContent = e.target.value;
      });
      // In auto mode the slider mirrors the live duty so the knob tracks the
      // governor; paused for 8s after the user last moved it.
      pageRenderers.hardware._syncSlider = (dutyPercent) => {
        if (document.activeElement === slider) return;
        if (Date.now() - Number(slider.dataset.touched || 0) < 8000) return;
        slider.value = Math.round(dutyPercent);
        pctEl.textContent = Math.round(dutyPercent);
      };
      $('[data-fan=auto]', host).addEventListener('click', async () => {
        await setFan({ mode: 'auto' });
        slider.dataset.touched = 0;            // allow immediate mirroring
        refreshLive(host);
      });
      $('[data-fan=apply]', host).addEventListener('click', () =>
        setFan({ dutyPercent: Number(slider.value) }));

      refreshLive(host); refreshHistory(host);
      timer = setInterval(() => { refreshLive(host); }, 3000);
      this._histTimer = setInterval(() => refreshHistory(host), 30000);
    },
    unmount() {
      clearInterval(timer);
      clearInterval(this._histTimer);
    },
  };
})();

// ---------------------------------------------------------------------------
// Sessions page
// ---------------------------------------------------------------------------

pageRenderers.sessions = (() => {
  let timer = null;
  let term = null, termFit = null, termWs = null, termResizeObs = null;   // SSH terminal state
  let vncRfb = null;                                                       // VNC client state

  function teardownTerm() {
    try { termWs && termWs.close(); } catch { /* */ }
    try { termResizeObs && termResizeObs.disconnect(); } catch { /* */ }
    try { term && term.dispose(); } catch { /* */ }
    termWs = null; term = null; termFit = null; termResizeObs = null;
  }
  function teardownVnc() {
    try { vncRfb && vncRfb.disconnect(); } catch { /* */ }
    vncRfb = null;
  }

  // Open an in-browser SSH terminal (xterm.js ↔ WebSocket ↔ host sshd).
  async function openTerminal(host) {
    const wrap = $('[data-sess=termwrap]', host);
    if (!wrap) return;
    let cfg;
    try { cfg = await api('/remote/config'); } catch { wrap.innerHTML = '<p class="sess-empty">Could not load remote-access config.</p>'; return; }
    if (!cfg.enabled || !cfg.ssh.enabled) {
      wrap.innerHTML = '<p class="sess-empty">In-browser SSH is disabled. Enable it in Settings → Remote Access.</p>';
      return;
    }
    if (!cfg.sshKeyConfigured || !cfg.ssh.username) {
      wrap.innerHTML = '<p class="sess-empty">SSH key or username not configured. Finish setup in Settings → Remote Access.</p>';
      return;
    }
    wrap.innerHTML = '<div class="rt-toolbar"><span class="rt-status" data-rt="status">Connecting…</span><span style="flex:1"></span><button class="set-btn rt-btn" data-rt="fs">⛶ Fullscreen</button><button class="set-btn rt-btn" data-rt="popout">⧉ New Window</button></div><div class="rt-term" data-rt="term"></div>';
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'), import('@xterm/addon-fit'),
    ]);
    await import('@xterm/xterm/css/xterm.css');
    const statusEl = $('[data-rt=status]', host);
    term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, monospace',
      theme: { background: '#0a0a0a', foreground: '#e8e8f0', cursor: '#00d4ff' } });
    termFit = new FitAddon();
    term.loadAddon(termFit);
    term.open($('[data-rt=term]', host));
    try { termFit.fit(); } catch { /* */ }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    termWs = new WebSocket(`${proto}://${location.host}/api/remote/ws/ssh`);
    termWs.binaryType = 'arraybuffer';
    termWs.onopen = () => {
      if (statusEl) { statusEl.textContent = 'Connected'; statusEl.className = 'rt-status rt-ok'; }
      sendResize();
    };
    termWs.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : new Uint8Array(e.data);
      term.write(data);
    };
    termWs.onclose = () => { if (statusEl) { statusEl.textContent = 'Disconnected'; statusEl.className = 'rt-status rt-off'; } };
    termWs.onerror = () => { if (statusEl) { statusEl.textContent = 'Connection error'; statusEl.className = 'rt-status rt-off'; } };
    term.onData((d) => { if (termWs && termWs.readyState === 1) termWs.send(d); });
    const sendResize = () => {
      try { termFit.fit(); } catch { /* */ }
      if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    termResizeObs = new ResizeObserver(() => sendResize());
    termResizeObs.observe($('[data-rt=term]', host));

    // Fullscreen the terminal pane (native Fullscreen API).
    const fsBtn = $('[data-rt=fs]', host);
    if (fsBtn) fsBtn.onclick = () => {
      const el2 = wrap;
      if (!document.fullscreenElement) { el2.requestFullscreen?.().then(() => setTimeout(sendResize, 100)).catch(() => {}); el2.classList.add('rt-fs'); }
      else { document.exitFullscreen?.(); el2.classList.remove('rt-fs'); }
    };
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) wrap.classList.remove('rt-fs');
      setTimeout(sendResize, 120);
    });

    // Pop the terminal out into its own browser window (own SSH session).
    const poBtn = $('[data-rt=popout]', host);
    if (poBtn) poBtn.onclick = () => {
      const w = window.open(`${location.origin}/#/sessions?pop=terminal`, 'rapisys-terminal',
        'width=960,height=600,menubar=no,toolbar=no,location=no,status=no');
      if (w) { try { w.focus(); } catch { /* */ } }
      else toast('info', 'Terminal', 'Popup blocked — allow popups for this site');
    };
  }

  // Open an in-browser VNC desktop (noVNC ↔ WebSocket ↔ host VNC server).
  async function openDesktop(host) {
    const wrap = $('[data-sess=vncwrap]', host);
    if (!wrap) return;
    let cfg;
    try { cfg = await api('/remote/config'); } catch { wrap.innerHTML = '<p class="sess-empty">Could not load remote-access config.</p>'; return; }
    if (!cfg.enabled || !cfg.vnc.enabled) {
      wrap.innerHTML = '<p class="sess-empty">In-browser VNC is disabled. Enable it in Settings → Remote Access.</p>';
      return;
    }
    wrap.innerHTML = '<div class="rt-toolbar"><span class="rt-status" data-rt="vstatus">Connecting…</span><span style="flex:1"></span><button class="set-btn rt-btn" data-rt="vfs">⛶ Fullscreen</button><button class="set-btn rt-btn" data-rt="vpopout">⧉ New Window</button></div><div class="rt-vnc" data-rt="vnc"></div>';
    const statusEl = $('[data-rt=vstatus]', host);
    const RFB = (await import('@novnc/novnc')).default;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      // The bridge presents a plain (already-authenticated) RFB stream — it
      // terminates wayvnc's VeNCrypt/TLS + login upstream — so noVNC connects
      // with no credentials of its own.
      vncRfb = new RFB($('[data-rt=vnc]', host), `${proto}://${location.host}/api/remote/ws/vnc`);
      vncRfb.scaleViewport = true;
      vncRfb.addEventListener('connect', () => { if (statusEl) { statusEl.textContent = 'Connected'; statusEl.className = 'rt-status rt-ok'; } });
      vncRfb.addEventListener('disconnect', (e) => {
        if (statusEl) {
          const clean = e.detail?.clean;
          statusEl.textContent = clean ? 'Disconnected' : 'Disconnected — check VNC login/settings';
          statusEl.className = 'rt-status rt-off';
        }
      });
      vncRfb.addEventListener('securityfailure', (e) => { if (statusEl) { statusEl.textContent = 'Auth failed: ' + (e.detail?.reason || ''); statusEl.className = 'rt-status rt-off'; } });
      const vfsBtn = $('[data-rt=vfs]', host);
      if (vfsBtn) vfsBtn.onclick = () => {
        if (!document.fullscreenElement) { wrap.requestFullscreen?.().catch(() => {}); wrap.classList.add('rt-fs'); }
        else { document.exitFullscreen?.(); wrap.classList.remove('rt-fs'); }
      };
      const vpoBtn = $('[data-rt=vpopout]', host);
      if (vpoBtn) vpoBtn.onclick = () => {
        const w = window.open(`${location.origin}/#/sessions?pop=desktop`, 'rapisys-desktop',
          'width=1100,height=720,menubar=no,toolbar=no,location=no,status=no');
        if (w) { try { w.focus(); } catch { /* */ } }
        else toast('info', 'Desktop', 'Popup blocked — allow popups for this site');
      };
    } catch (err) {
      wrap.innerHTML = `<p class="sess-empty">VNC error: ${esc(err.message)}</p>`;
    }
  }

  const fmtDur = (ms) => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
  };
  const fmtTime = (ts) => rapisysFmtTime(ts);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function refresh(host) {
    let snap;
    try { snap = await api('/sessions'); } catch { return; }
    const now = Date.now();

    const row4 = (cells) => `<div class="sess-row">${cells.map((c) => `<span>${c}</span>`).join('')}</div>`;
    const sshHtml = snap.ssh.length
      ? snap.ssh.map((s) => row4([
          `<b>${esc(s.username)}</b> <span class="sess-tty">${esc(s.meta?.tty || '')}</span>`,
          esc(s.source), fmtDur(now - s.startedAt),
          s.meta?.sessionId
            ? `<button class="inv-act inv-act-danger sess-kick" data-kick="${esc(s.meta.sessionId)}" data-who="${esc(s.username)}@${esc(s.source)}" title="Disconnect ${esc(s.username)}@${esc(s.source)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg></button>`
            : (s.idleMs != null ? `idle ${fmtDur(s.idleMs)}` : '—'),
        ])).join('')
      : '<p class="sess-empty">No active SSH sessions</p>';

    const vncHtml = snap.vnc.length
      ? snap.vnc.map((s) => row4([
          `<b>${esc(s.meta?.server || 'VNC')}</b>`, esc(s.source),
          'connected', `port ${s.meta?.peerPort ?? ''}`,
        ])).join('')
      : '<p class="sess-empty">No active VNC connections</p>';

    const ts = snap.tailscale;
    const onlinePeers = (ts.peers || []).filter((p) => p.online);
    const tsHtml = !ts.installed
      ? '<p class="sess-empty">Tailscale not detected on this Pi</p>'
      : (onlinePeers.length ? onlinePeers.map((p) => row4([
          `<span class="sess-dot on"></span> <b>${esc(p.username)}</b>`,
          esc(p.source), esc(p.os),
          'active now',
        ])).join('') : '<p class="sess-empty">No active Tailscale sessions</p>');

    const consoleHtml = (snap.console || []).length
      ? snap.console.map((s) => row4([
          `<b>${esc(s.username)}</b> <span class="sess-tty">${esc(s.meta?.tty || '')}</span>`,
          'physical console', s.startedAt ? fmtDur(now - s.startedAt) : '—',
          s.idleMs != null ? `idle ${fmtDur(s.idleMs)}` : '—',
        ])).join('')
      : '<p class="sess-empty">No local console sessions</p>';
    $('[data-sess=ssh]', host).innerHTML = sshHtml;
    if ($('[data-sess=console]', host)) $('[data-sess=console]', host).innerHTML = consoleHtml;
    $('[data-sess=vnc]', host).innerHTML = vncHtml;
    $('[data-sess=ts]', host).innerHTML = tsHtml;
    // animate the type glyph when that type has live sessions
    const setActive = (type, on) => { const h = $(`[data-sess-head=${type}]`, host); if (h) h.classList.toggle('sess-h-live', on); };
    setActive('ssh', snap.ssh.length > 0);
    setActive('console', (snap.console || []).length > 0);
    setActive('vnc', snap.vnc.length > 0);
    setActive('ts', onlinePeers.length > 0);
    host.querySelectorAll('[data-kick]').forEach((b) => b.onclick = async () => {
      if (!await rapisysConfirm(`Disconnect ${b.dataset.who}? Their session ends immediately.`,
        { danger: true, confirmLabel: 'Disconnect' })) return;
      try {
        await api(`/sessions/${b.dataset.kick}/terminate`, { method: 'POST', body: {} });
        toast('success', 'Sessions', `Disconnected ${b.dataset.who}`);
        refresh(host);
      } catch (err) { toast('error', 'Sessions', err.message); }
    });
    $('[data-sess=counts]', host).textContent =
      `${snap.ssh.length} SSH · ${snap.vnc.length} VNC · ${ts.peers?.filter((p) => p.online).length || 0} Tailscale online`;
  }

  async function refreshHistory(host) {
    try {
      const rangeSel = $('[data-hist=range]', host);
      const range = (rangeSel && rangeSel.value) || '7d';
      const kind = ($('[data-hist=kind]', host) && $('[data-hist=kind]', host).value) || '';
      let qs = `${kind ? `kind=${encodeURIComponent(kind)}&` : ''}`;
      if (range === 'custom') {
        const fromV = $('[data-hist=from]', host) && $('[data-hist=from]', host).value;
        const toV = $('[data-hist=to]', host) && $('[data-hist=to]', host).value;
        if (!fromV && !toV) { $('[data-sess=hist]', host).innerHTML = '<p class="sess-empty">Pick a From and/or To date.</p>'; return; }
        const fromMs = fromV ? new Date(fromV + 'T00:00:00').getTime() : 0;
        const toMs = toV ? new Date(toV + 'T23:59:59').getTime() : Date.now();
        qs += `from=${fromMs}&to=${toMs}`;
      } else {
        qs += `range=${encodeURIComponent(range)}`;
      }
      const data = await api(`/sessions/history?${qs}`);
      const el2 = $('[data-sess=hist]', host);
      if (!el2) return;
      if (!data.history.length) { el2.innerHTML = '<p class="sess-empty">No login history for this filter</p>'; return; }
      const KIND_LABEL = { ssh: 'SSH', console: 'Console', vnc: 'VNC', tailscale: 'Tailscale' };
      el2.innerHTML = `
        <div class="sess-hist-head">
          <span>User</span><span>Type</span><span>Source</span><span>Started</span><span>Duration</span>
        </div>
        ${data.history.slice(0, 200).map((h) => `
          <div class="sess-row sess-hist-row">
            <span><b>${esc(h.username)}</b></span>
            <span><span class="sess-type-badge sess-type-${esc(h.kind)}">${esc(KIND_LABEL[h.kind] || h.kind)}</span></span>
            <span>${esc(h.source || '—')}</span>
            <span>${fmtTime(h.started_at)}</span>
            <span>${h.ended_at ? fmtDur(h.ended_at - h.started_at) : '<span class="sess-live sess-live-anim">● active</span>'}</span>
          </div>`).join('')}`;
    } catch { /* keep last */ }
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('sessions', 'Sessions')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          ${pageTabs([
            { id: 'active', label: 'Active Sessions', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
            { id: 'history', label: 'Login History', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
            { id: 'terminal', label: 'Terminal', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>' },
            { id: 'desktop', label: 'Desktop', icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>' },
          ])}
          <div class="card-body" data-pane="active">
            <div class="sess-counts" data-sess="counts" style="margin-bottom:14px"></div>
            <h4 class="sess-h sess-h-typed" data-sess-head="ssh"><svg class="sess-h-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg><span>SSH</span></h4><div data-sess="ssh"></div>
            <h4 class="sess-h sess-h-typed" data-sess-head="console"><svg class="sess-h-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Local console</span></h4><div data-sess="console"></div>
            <h4 class="sess-h sess-h-typed" data-sess-head="vnc"><svg class="sess-h-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M2 9h20M7 14h2M11 14h6"/></svg><span>VNC</span></h4><div data-sess="vnc"></div>
            <h4 class="sess-h sess-h-typed" data-sess-head="ts"><svg class="sess-h-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14 0M2 8.82a16 16 0 0 1 20 0M8.5 16.43a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/></svg><span>Tailscale</span></h4><div data-sess="ts"></div>
          </div>
          <div class="card-body" data-pane="history" style="display:none">
            <div class="sess-hist-filters">
              <label>Range
                <select data-hist="range">
                  <option value="24h">Last 24 hours</option>
                  <option value="7d" selected>Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="90d">Last 90 days</option>
                  <option value="custom">Custom…</option>
                </select>
              </label>
              <label data-hist-custom hidden>From
                <input type="date" data-hist="from">
              </label>
              <label data-hist-custom hidden>To
                <input type="date" data-hist="to">
              </label>
              <label>Type
                <select data-hist="kind">
                  <option value="">All types</option>
                  <option value="ssh">SSH</option>
                  <option value="console">Local console</option>
                  <option value="vnc">VNC</option>
                  <option value="tailscale">Tailscale</option>
                </select>
              </label>
            </div>
            <div data-sess="hist"></div>
          </div>
          <div class="card-body" data-pane="terminal" style="display:none">
            <div data-sess="termwrap"></div>
          </div>
          <div class="card-body" data-pane="desktop" style="display:none">
            <div data-sess="vncwrap"></div>
          </div>
        </div>
      </div>`;
      let histEnhanced = false;
      wirePageTabs(host, (tab) => {
        // tear down any live remote session when leaving its tab
        teardownTerm(); teardownVnc();
        if (tab === 'terminal') openTerminal(host);
        if (tab === 'desktop') openDesktop(host);
        // enhance the history filter selects the first time the pane is visible
        // (enhancing while display:none gives them a zero-size anchor rect)
        if (tab === 'history' && !histEnhanced) { histEnhanced = true; enhanceSelects(host); }
      });
      // login-history filters
      const rangeSel = $('[data-hist=range]', host);
      const toggleCustom = () => {
        const on = rangeSel && rangeSel.value === 'custom';
        host.querySelectorAll('[data-hist-custom]').forEach((l) => { l.hidden = !on; });
      };
      if (rangeSel) rangeSel.addEventListener('change', () => { toggleCustom(); refreshHistory(host); });
      const kindSel = $('[data-hist=kind]', host);
      if (kindSel) kindSel.addEventListener('change', () => refreshHistory(host));
      ['from', 'to'].forEach((f) => {
        const inp = $(`[data-hist=${f}]`, host);
        if (inp) inp.addEventListener('change', () => refreshHistory(host));
      });
      refresh(host); refreshHistory(host);
      timer = setInterval(() => { refresh(host); refreshHistory(host); }, 10000);
      // popout window: ?pop=terminal|desktop → jump straight to that tab and
      // strip the nav rail/header for a clean standalone window.
      const popMatch = location.hash.match(/pop=(terminal|desktop)/);
      if (popMatch) {
        document.body.classList.add('rapisys-popout');
        const tbtn = host.querySelector(`[data-tab=${popMatch[1]}]`);
        if (tbtn) tbtn.click();
      }
    },
    unmount() { clearInterval(timer); teardownTerm(); teardownVnc(); },
  };
})();

// ---------------------------------------------------------------------------
// Alerts page
// ---------------------------------------------------------------------------

pageRenderers.alerts = (() => {
  let timer = null, editingId = null;   // editingId: rule being edited (null = adding new)
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SEV_CLASS = { info: 'sev-info', warning: 'sev-warning', critical: 'sev-critical' };

  // Reflect add-vs-edit state in the rule form (title, button label, cancel).
  function updateFormMode(host) {
    const title = $('[data-new=formtitle]', host);
    const addBtn = $('[data-new=add]', host);
    const cancelBtn = $('[data-new=cancel]', host);
    if (!addBtn) return;
    const addLabel = addBtn.querySelector('span') || addBtn;
    if (editingId) {
      if (title) title.textContent = 'Edit rule';
      addLabel.textContent = 'Update rule';
      if (cancelBtn) cancelBtn.style.display = '';
    } else {
      if (title) title.textContent = 'Add rule';
      addLabel.textContent = 'Add rule';
      if (cancelBtn) cancelBtn.style.display = 'none';
    }
  }
  function resetForm(host) {
    editingId = null;
    ['name', 'threshold'].forEach((k) => { const e = $(`[data-new=${k}]`, host); if (e) e.value = ''; });
    const metric = $('[data-new=metric]', host); if (metric) metric.value = '';
    const sustain = $('[data-new=sustain]', host); if (sustain) sustain.value = 120;
    const cooldown = $('[data-new=cooldown]', host); if (cooldown) cooldown.value = 900;
    const sev = $('[data-new=severity]', host); if (sev) sev.value = 'warning';
    const email = $('[data-new=email]', host); if (email) email.checked = false;
    const tgch = $('[data-new=telegram]', host); if (tgch) tgch.checked = false;
    enhanceSelects(host);
    updateFormMode(host);
  }

  async function refresh(host) {
    let rules, active, history, metrics;
    try {
      [rules, active, history, metrics] = await Promise.all([
        api('/alerts/rules'), api('/alerts/active'), api('/alerts/history?limit=20'), api('/alerts/metrics'),
      ]);
    } catch { return; }

    // active summary widget (count by severity)
    const summary = $('[data-al=summary]', host);
    if (summary) {
      const crit = active.active.filter((a) => a.severity === 'critical').length;
      const warn = active.active.filter((a) => a.severity === 'warning').length;
      const info = active.active.filter((a) => a.severity === 'info').length;
      const allClear = active.active.length === 0;
      const okGlyph = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>';
      const alertGlyph = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      summary.innerHTML = `
        <div class="al-sum-card ${allClear ? 'al-sum-ok' : (crit ? 'al-sum-crit' : 'al-sum-warn')}">
          <div class="al-sum-glyph">${allClear ? okGlyph : alertGlyph}</div>
          <div class="al-sum-text">
            <div class="al-sum-big">${allClear ? 'All clear' : active.active.length}</div>
            <div class="al-sum-label">${allClear ? 'No active alerts' : 'active alert' + (active.active.length === 1 ? '' : 's')}</div>
          </div>
        </div>
        <div class="al-sum-breakdown">
          <div class="al-sum-stat"><span class="al-sum-dot al-dot-crit"></span>Critical <b>${crit}</b></div>
          <div class="al-sum-stat"><span class="al-sum-dot al-dot-warn"></span>Warning <b>${warn}</b></div>
          <div class="al-sum-stat"><span class="al-sum-dot al-dot-info"></span>Info <b>${info}</b></div>
          <div class="al-sum-stat"><span class="al-sum-dot"></span>Rules <b>${rules.rules.length}</b></div>
        </div>`;
    }

    // active banner (only when there ARE active alerts; all-clear is shown by the widget)
    const banner = $('[data-al=active]', host);
    banner.innerHTML = active.active.length
      ? active.active.map((a) => `<div class="al-banner ${SEV_CLASS[a.severity]}">⚠ <b>${esc(a.name)}</b> — firing since ${new Date(a.since).toLocaleTimeString()}</div>`).join('')
      : '';

    // rules table
    $('[data-al=rules]', host).innerHTML = rules.rules.map((r) => `
      <div class="al-rule ${r.enabled ? '' : 'al-disabled'}">
        <span class="al-sev ${SEV_CLASS[r.severity]}">${esc(r.severity)}</span>
        <span class="al-name"><b>${esc(r.name)}</b><br><small>${esc(r.metric)} ${esc(r.op)} ${r.threshold} for ${r.sustain_s}s · ${(r.channels || []).join('+')}</small></span>
        <span class="al-actions">
          <button class="inv-act" data-edit="${r.id}" title="Edit rule"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="inv-act" data-toggle="${r.id}" data-enabled="${r.enabled}" title="${r.enabled ? 'Disable rule' : 'Enable rule'}">${r.enabled
            ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>'
            : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14" opacity="0.0"/><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-5"/></svg>'}</button>
          <button class="inv-act inv-act-danger" data-del="${r.id}" title="Delete rule"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </span>
      </div>`).join('') || '<p class="sess-empty">No rules — add one below.</p>';

    // metric dropdown: populate from the live metric list, preserving the
    // current choice (options are read live by the custom dropdown on open)
    const msel = $('[data-new=metric]', host);
    const keep = msel.value;
    msel.innerHTML = '<option value="">Choose a metric…</option>'
      + metrics.metrics.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (keep) msel.value = keep;

    // history
    $('[data-al=hist]', host).innerHTML = history.history.length
      ? history.history.map((h) => `
        <div class="sess-row">
          <span class="al-sev ${SEV_CLASS[h.severity] || ''}">${esc(h.severity || '')}</span>
          <span><b>${esc(h.name || 'deleted rule')}</b> <small>${esc(h.metric || '')}</small></span>
          <span>peak ${h.peak_value != null ? Math.round(h.peak_value * 10) / 10 : '—'}</span>
          <span>${rapisysFmtTime(h.fired_at)}${h.resolved_at ? '' : ' · <span class="sess-live">ongoing</span>'}</span>
        </div>`).join('')
      : '<p class="sess-empty">No incidents recorded</p>';

    // wire row buttons
    host.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
      const rule = rules.rules.find((r) => r.id == b.dataset.edit);
      if (!rule) return;
      editingId = rule.id;
      $('[data-new=name]', host).value = rule.name || '';
      $('[data-new=metric]', host).value = rule.metric || '';
      $('[data-new=op]', host).value = rule.op || '>';
      $('[data-new=threshold]', host).value = rule.threshold ?? '';
      $('[data-new=sustain]', host).value = rule.sustain_s ?? 120;
      $('[data-new=severity]', host).value = rule.severity || 'warning';
      $('[data-new=cooldown]', host).value = rule.cooldown_s ?? 900;
      $('[data-new=email]', host).checked = (rule.channels || []).includes('email');
      $('[data-new=telegram]', host).checked = (rule.channels || []).includes('telegram');
      // re-sync any enhanced selects, then reflect edit mode in the form
      enhanceSelects(host);
      updateFormMode(host);
      $('[data-new=name]', host).scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    host.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
      const rule = rules.rules.find((r) => r.id == b.dataset.toggle);
      try {
        await api(`/alerts/rules/${rule.id}`, { method: 'PUT', body: { ...rule, enabled: !(b.dataset.enabled == 1) } });
        refresh(host);
      } catch (err) { toast('error', 'Alerts', err.message); }
    });
    host.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!await rapisysConfirm('Delete this alert rule?', { danger: true, confirmLabel: 'Delete' })) return;
      try { await api(`/alerts/rules/${b.dataset.del}`, { method: 'DELETE' }); refresh(host); }
      catch (err) { toast('error', 'Alerts', err.message); }
    });
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('alerts', 'Alerts')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          ${pageTabs([{ id: 'active', label: 'Active Alerts' }, { id: 'rules', label: 'Rules' }, { id: 'history', label: 'Incident History' }])}
          <div class="card-body" data-pane="active">
            <div class="al-summary" data-al="summary"></div>
            <div data-al="active"></div>
          </div>
          <div class="card-body" data-pane="rules" style="display:none">
            <h4 class="sess-h">Rules</h4>
            <div data-al="rules"></div>
            <h4 class="sess-h" data-new="formtitle">Add rule</h4>
            <div class="al-form wz-form">
              <label>Name <input data-new="name" placeholder="High CPU temperature" maxlength="80"></label>
              <div class="al-form-row">
                <label>Metric <select data-new="metric"><option value="">Choose a metric…</option></select></label>
                <label>Op <select data-new="op"><option>&gt;</option><option>&lt;</option><option>&gt;=</option><option>&lt;=</option></select></label>
                <label>Threshold <input data-new="threshold" type="number" step="any" placeholder="80"></label>
              </div>
              <div class="al-form-row">
                <label>Sustain (s) <input data-new="sustain" type="number" value="120"></label>
                <label>Severity <select data-new="severity"><option>warning</option><option>critical</option><option>info</option></select></label>
                <label>Cooldown (s) <input data-new="cooldown" type="number" value="900"></label>
              </div>
              <label class="wz-inline"><input type="checkbox" data-new="email"> Also send email</label>
              <label class="wz-inline"><input type="checkbox" data-new="telegram"> Also send Telegram</label>
              <div class="set-actions"><button class="set-btn set-btn-primary" data-new="add"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Add rule</span></button><button class="set-btn set-btn-cancel" data-new="cancel" style="display:none"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg><span>Cancel</span></button><span data-new="status"></span></div>
            </div>
            <p class="hw-hint">Email notifications use the SMTP settings from Settings → Email (SMTP). Rules are evaluated every 30 s.</p>
          </div>
          <div class="card-body" data-pane="history" style="display:none">
            <div class="card-body" data-al="hist"></div>
          </div>
        </div>
      </div>`;
      wirePageTabs(host);

      $('[data-new=add]', host).onclick = async () => {
        const stat = $('[data-new=status]', host);
        const body = {
          name: $('[data-new=name]', host).value.trim(),
          metric: $('[data-new=metric]', host).value.trim(),
          op: $('[data-new=op]', host).value,
          threshold: Number($('[data-new=threshold]', host).value),
          sustain_s: Number($('[data-new=sustain]', host).value),
          severity: $('[data-new=severity]', host).value,
          cooldown_s: Number($('[data-new=cooldown]', host).value),
          channels: ['ui',
            ...($('[data-new=email]', host).checked ? ['email'] : []),
            ...($('[data-new=telegram]', host).checked ? ['telegram'] : [])],
        };
        try {
          if (editingId) {
            await api(`/alerts/rules/${editingId}`, { method: 'PUT', body });
            setStatus(stat, true, '✓ rule updated');
          } else {
            await api('/alerts/rules', { method: 'POST', body });
            setStatus(stat, true, '✓ rule added');
          }
          editingId = null;
          resetForm(host);
          refresh(host);
        } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
      };
      $('[data-new=cancel]', host).onclick = () => { editingId = null; resetForm(host); };

      refresh(host);
      timer = setInterval(() => refresh(host), 15000);
    },
    unmount() { clearInterval(timer); },
  };
})();

// ---------------------------------------------------------------------------
// Settings page — NAS mounts, storage location, retention, mode, SMTP status
// ---------------------------------------------------------------------------

pageRenderers.settings = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // edit-mode flags: when a section is already configured we show a read-only
  // summary with an Edit button, and only reveal the form when editing.
  let editSmtp = false, editDb = false, editNas = false, editPw = false, editTg = false;
  // shared glyphs for the colored edit / test buttons
  const EDIT_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const TEST_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const SAVE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>';
  const CANCEL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  async function load(host) {
    let st;
    try { st = await api('/setup/status'); } catch { return; }

    // ---- NAS card ----
    const nas = st.nas;
    let nasStatus = null;
    if (nas?.mountpoint) {
      try { nasStatus = await api(`/setup/nas/status?mountpoint=${encodeURIComponent(nas.mountpoint)}`); } catch { /* offline */ }
    }
    const mounted = nasStatus?.mounted;
    $('[data-set=nas]', host).innerHTML = nas ? `
      <div class="set-summary">
        <div class="set-kv"><span>Label</span><b>${esc(nas.label)}</b></div>
        <div class="set-kv"><span>Source</span><b>${esc(nas.proto)}://${esc(nas.host)}/${esc(nas.share)}</b></div>
        <div class="set-kv"><span>Mountpoint</span><b>${esc(nas.mountpoint)}</b></div>
        <div class="set-kv"><span>Status</span><b class="${mounted ? 'set-ok' : 'set-err'}">${mounted ? '● Mounted' : '○ Not mounted'}</b></div>
        <div class="set-actions">
          <button class="set-btn set-btn-edit" data-set="nasedit">${EDIT_ICON}<span>Edit</span></button>
          <button class="set-btn set-btn-danger" data-set="unmount">${TRASH_ICON}<span>Unmount</span></button>
          <span data-set="nasmsg"></span>
        </div>
      </div>` : `<p class="sess-empty">No NAS share configured. Mount one below to store metrics off the SD card.</p>`;

    // mount form — hidden behind Edit once a share is configured
    const showNasForm = editNas || !nas;
    $('[data-set=nasform]', host).innerHTML = showNasForm ? `
      <h4 class="sess-h">${nas ? 'Replace share' : 'Mount a share'}</h4>
      <div class="wz-form">
        <label>Label <input data-nf="label" value="${esc(nas?.label || 'mybook')}" maxlength="32"></label>
        <label>Protocol <select data-nf="proto"><option value="cifs">SMB/CIFS</option><option value="nfs">NFS</option></select></label>
        <label>Host <input data-nf="host" value="${esc(nas?.host || '')}" placeholder="192.168.10.6"></label>
        <label>Share <input data-nf="share" value="${esc(nas?.share || '')}" placeholder="rapisys"></label>
        <label data-nf-smb>SMB version <select data-nf="smb">
          <option value="3.0">3.0 (EX2 Ultra &amp; modern NAS)</option>
          <option value="2.1">2.1</option><option value="2.0">2.0</option>
          <option value="1.0">1.0 (My Book World Edition II)</option>
        </select></label>
        <label>Username <input data-nf="user" placeholder="admin"></label>
        <label>Password <input data-nf="pass" type="password"></label>
        <div class="set-actions"><button class="set-btn set-btn-primary" data-nf="mount">${SAVE_ICON}<span>Mount &amp; persist</span></button>${nas ? `<button class="set-btn set-btn-cancel" data-nf="cancel">${CANCEL_ICON}<span>Cancel</span></button>` : ''}<span data-nf="msg"></span></div>
      </div>` : '';
    if (nas?.smbVersion) { const sel = $('[data-nf=smb]', host); if (sel) sel.value = nas.smbVersion; }
    enhanceSelects(host);   // dynamic selects appear after this render

    // ---- storage card ----
    const s = st.storage || {};
    const dbDirVal = nas?.mountpoint || (s.path && s.path.startsWith('/mnt/rapisys/') ? s.path.replace(/\/rapisys\.db$/, '') : '');
    $('[data-set=storage]', host).innerHTML = `
      <div class="set-kv"><span>Database</span><b>${esc(s.path || s.dbPath || '—')}</b></div>
      <div class="set-kv"><span>Filesystem</span><b>${esc(s.fsType || '—')} · ${esc(s.journalMode || '—')} journal</b></div>
      <div class="set-kv"><span>Health</span><b class="${s.degraded ? 'set-err' : 'set-ok'}">${s.degraded ? '○ Degraded (local fallback)' : '● Healthy'}</b></div>
      ${!editDb ? `
        <div class="set-actions"><button class="set-btn set-btn-edit" data-set="dbedit">${EDIT_ICON}<span>Edit location</span></button></div>` : `
        <div class="wz-form">
          <label>Database directory <input data-set="dbdir" value="${esc(dbDirVal)}" placeholder="/mnt/rapisys/mybook"></label>
          <div class="set-actions"><button class="set-btn set-btn-primary" data-set="relocate">${SAVE_ICON}<span>Relocate database</span></button><button class="set-btn set-btn-cancel" data-set="dbcancel">${CANCEL_ICON}<span>Cancel</span></button><span data-set="stmsg"></span></div>
        </div>`}`;

    // ---- services health pane (main tab) ----
    const fmtDbSize = (b) => {
      if (!b && b !== 0) return null;
      if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
      if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
      if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
      return b + ' B';
    };
    const dbSize = fmtDbSize(st.storage?.sizeBytes);
    $('[data-set=health]', host).innerHTML = `
      <div class="set-health-grid">
        <div class="set-health-item">
          <span class="set-health-label">Host agent</span>
          <b class="${st.agent ? 'set-ok' : 'set-err'}">${st.agent ? '● Connected' : '○ Unavailable'}</b>
          <small>Privileged host operations (fan, NAS, updates)</small>
        </div>
        <div class="set-health-item">
          <span class="set-health-label">Database</span>
          <b class="${st.storage?.degraded ? 'set-err' : 'set-ok'}">${st.storage?.degraded ? '○ Degraded (local fallback)' : '● Healthy'}</b>
          <small>${esc(st.storage?.fsType || '—')} · ${esc(st.storage?.journalMode || '—')} journal${dbSize ? ` · ${dbSize}` : ''}</small>
        </div>
        <div class="set-health-item">
          <span class="set-health-label">Encryption</span>
          <b class="${st.encryption ? 'set-ok' : 'set-err'}">${st.encryption ? '● Key present' : '○ No SECRET_KEY'}</b>
          <small>Secrets at rest (SMTP/NAS passwords)</small>
        </div>
        <div class="set-health-item">
          <span class="set-health-label">Email (SMTP)</span>
          <b class="${st.smtpConfigured ? 'set-ok' : ''}">${st.smtpConfigured ? '● Configured' : '○ Not configured'}</b>
          <small>Alert notifications</small>
        </div>
        <div class="set-health-item">
          <span class="set-health-label">NAS mount</span>
          <b class="${nasStatus?.mounted ? 'set-ok' : ''}">${nasStatus?.mounted ? '● Mounted' : '○ None'}</b>
          <small>${esc(nas?.label || 'No share configured')}</small>
        </div>
        <div class="set-health-item">
          <span class="set-health-label">Operating mode</span>
          <b>${st.mode === 'full' ? 'Full control' : 'Monitor only'}</b>
          <small>Retention ${st.retentionDays}d local · ${st.archiveDays}d archived</small>
        </div>
      </div>`;

    // ---- SMTP config pane ----
    const smtp = st.smtp || {};
    const showSmtpForm = editSmtp || !st.smtpConfigured;
    $('[data-set=smtp]', host).innerHTML = `
      <p class="hw-hint">Configure authenticated SMTP for alert email notifications. Recommended free providers: Brevo (300/day), SMTP2GO (1,000/month). Gmail works with an App Password (requires 2FA).</p>
      ${!st.encryption ? '<p class="set-warn">⚠ SECRET_KEY is not set — passwords cannot be stored securely. Run deploy.sh or set SECRET_KEY in .env first.</p>' : ''}
      ${!showSmtpForm ? `
        <div class="set-summary">
          <div class="set-kv"><span>Host</span><b>${esc(smtp.host || '—')}:${esc(smtp.port || 587)}</b></div>
          <div class="set-kv"><span>Security</span><b>${smtp.secure ? 'TLS/SSL' : 'STARTTLS'}</b></div>
          <div class="set-kv"><span>Username</span><b>${esc(smtp.user || '—')}</b></div>
          <div class="set-kv"><span>From</span><b>${esc(smtp.from || '—')}</b></div>
          <div class="set-kv"><span>Send alerts to</span><b>${esc(smtp.to || '—')}</b></div>
          <div class="set-actions">
            <button class="set-btn set-btn-edit" data-sm="edit">${EDIT_ICON}<span>Edit</span></button>
            <button class="set-btn set-btn-test" data-sm="test">${TEST_ICON}<span>Send test email</span></button>
            <span data-sm="msg"></span>
          </div>
        </div>` : `
        <div class="wz-form">
          <div class="al-form-row">
            <label>SMTP host <input data-sm="host" value="${esc(smtp.host || '')}" placeholder="smtp-relay.brevo.com"></label>
            <label>Port <input data-sm="port" type="number" value="${esc(smtp.port || 587)}" placeholder="587"></label>
          </div>
          <label class="wz-inline"><input type="checkbox" data-sm="secure" ${smtp.secure ? 'checked' : ''}> Use TLS/SSL (port 465). Leave off for STARTTLS (587).</label>
          <label>Username <input data-sm="user" value="${esc(smtp.user || '')}" placeholder="your-login@example.com" autocomplete="off"></label>
          <label>Password / API key <input data-sm="pass" type="password" placeholder="${smtp.host ? '•••••• (unchanged)' : 'enter password'}" autocomplete="new-password"></label>
          <div class="al-form-row">
            <label>From address <input data-sm="from" value="${esc(smtp.from || '')}" placeholder="rapisys@example.com"></label>
            <label>Send alerts to <input data-sm="to" value="${esc(smtp.to || '')}" placeholder="you@example.com"></label>
          </div>
          <div class="set-actions">
            <button class="set-btn set-btn-primary" data-sm="save">${SAVE_ICON}<span>Save SMTP settings</span></button>
            ${st.smtpConfigured ? `<button class="set-btn set-btn-cancel" data-sm="cancel">${CANCEL_ICON}<span>Cancel</span></button>` : ''}
            <span data-sm="msg"></span>
          </div>
        </div>`}`;

    // ---- display preferences ----
    renderPrefs(host);

    // ---- account pane ----
    let me = null;
    try { me = await api('/auth/me'); } catch { /* */ }
    const accEl = $('[data-set=account]', host);
    if (accEl) {
      const mfaOn = !!me?.mfaEnabled;
      accEl.innerHTML = `
        <div class="set-summary">
          <div class="set-kv"><span>Username</span><b>${esc(me?.username || '—')}</b></div>
          <div class="set-kv"><span>Password</span><b>•••••••• (set)</b></div>
          <div class="set-kv set-kv-toggle">
            <span>Two-factor authentication (2FA)</span>
            <label class="set-switch" title="${mfaOn ? 'Disable 2FA' : 'Enable 2FA'}">
              <input type="checkbox" data-acc="mfatoggle" ${mfaOn ? 'checked' : ''} ${(!mfaOn && !st.encryption) ? 'disabled' : ''}>
              <span class="set-switch-track"><span class="set-switch-thumb"></span></span>
            </label>
          </div>
          <div class="set-actions">
            <button class="set-btn set-btn-edit" data-acc="pwedit">${EDIT_ICON}<span>Reset Password</span></button>
          </div>
        </div>

        ${editPw ? `
          <div class="wz-form" style="margin-top:14px">
            <h4 class="sess-h">Reset password</h4>
            <label>Current password <input data-acc="cur" type="password" autocomplete="current-password"></label>
            <label>New password <input data-acc="new" type="password" autocomplete="new-password" placeholder="at least 8 characters"></label>
            <label>Confirm new password <input data-acc="new2" type="password" autocomplete="new-password"></label>
            <div class="set-actions"><button class="set-btn set-btn-primary" data-acc="pwsave">${SAVE_ICON}<span>Update password</span></button><button class="set-btn set-btn-cancel" data-acc="pwcancel">${CANCEL_ICON}<span>Cancel</span></button><span data-acc="pwmsg"></span></div>
          </div>` : ''}

        <div data-acc="mfazone"></div>`;
    }

    wire(host, nas, st);
  }

  function wire(host, nas, st) {
    const proto = $('[data-nf=proto]', host);
    const smbWrap = $('[data-nf-smb]', host);
    if (proto && smbWrap) {
      const upd = () => { smbWrap.style.display = proto.value === 'cifs' ? '' : 'none'; };
      proto.addEventListener('change', upd); upd();
    }

    const mountBtn = $('[data-nf=mount]', host);
    if (mountBtn) mountBtn.onclick = async () => {
      const msg = $('[data-nf=msg]', host);
      setStatus(msg, true, 'Mounting…');
      try {
        await api('/setup/nas/mount', { method: 'POST', body: {
          label: $('[data-nf=label]', host).value.trim(),
          proto: $('[data-nf=proto]', host).value,
          host: $('[data-nf=host]', host).value.trim(),
          share: $('[data-nf=share]', host).value.trim(),
          smbVersion: $('[data-nf=smb]', host)?.value,
          username: $('[data-nf=user]', host).value.trim(),
          password: $('[data-nf=pass]', host).value,
        }});
        setStatus(msg, true, '✓ mounted & set to mount on boot');
        editNas = false;
        load(host);
      } catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
    };

    const nasEdit = $('[data-set=nasedit]', host);
    if (nasEdit) nasEdit.onclick = () => { editNas = true; load(host); };
    const nasCancel = $('[data-nf=cancel]', host);
    if (nasCancel) nasCancel.onclick = () => { editNas = false; load(host); };

    const unmount = $('[data-set=unmount]', host);
    if (unmount) unmount.onclick = async () => {
      if (!await rapisysConfirm(`Unmount ${nas.mountpoint}? If the database lives here it will fall back to local storage.`, { danger: true, confirmLabel: 'Unmount' })) return;
      const msg = $('[data-set=nasmsg]', host);
      setStatus(msg, true, 'Unmounting…');
      try { await api('/setup/nas/unmount', { method: 'POST', body: { mountpoint: nas.mountpoint } }); setStatus(msg, true, '✓ unmounted'); load(host); }
      catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
    };

    const dbEdit = $('[data-set=dbedit]', host);
    if (dbEdit) dbEdit.onclick = () => { editDb = true; load(host); };
    const dbCancel = $('[data-set=dbcancel]', host);
    if (dbCancel) dbCancel.onclick = () => { editDb = false; load(host); };

    const relocate = $('[data-set=relocate]', host);
    if (relocate) relocate.onclick = async () => {
      const msg = $('[data-set=stmsg]', host);
      const dir = $('[data-set=dbdir]', host).value.trim();
      relocate.disabled = true; setStatus(msg, true, 'Relocating database…');
      try { const r = await api('/setup/storage', { method: 'POST', body: { dbDir: dir } });
        editDb = false; setStatus(msg, true, `✓ now on ${r.fsType || 'disk'} (${r.journalMode} journal)`); load(host);
      } catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
      finally { relocate.disabled = false; }
    };

    // SMTP edit / cancel toggles
    const smEdit = $('[data-sm=edit]', host);
    if (smEdit) smEdit.onclick = () => { editSmtp = true; load(host); };
    const smCancel = $('[data-sm=cancel]', host);
    if (smCancel) smCancel.onclick = () => { editSmtp = false; load(host); };

    // SMTP save / test
    const smSave = $('[data-sm=save]', host);
    if (smSave) smSave.onclick = async () => {
      const msg = $('[data-sm=msg]', host);
      const body = {
        host: $('[data-sm=host]', host).value.trim(),
        port: Number($('[data-sm=port]', host).value) || 587,
        secure: $('[data-sm=secure]', host).checked,
        user: $('[data-sm=user]', host).value.trim(),
        from: $('[data-sm=from]', host).value.trim(),
        to: $('[data-sm=to]', host).value.trim(),
      };
      const pass = $('[data-sm=pass]', host).value;
      if (pass) body.password = pass;
      if (!body.host) { setStatus(msg, false, '✗ SMTP host is required'); return; }
      smSave.disabled = true; setStatus(msg, true, 'Saving…');
      try { await api('/setup/smtp', { method: 'POST', body }); editSmtp = false; setStatus(msg, true, '✓ saved'); load(host); }
      catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
      finally { smSave.disabled = false; }
    };
    const smTest = $('[data-sm=test]', host);
    if (smTest) smTest.onclick = async () => {
      const msg = $('[data-sm=msg]', host);
      const to = $('[data-sm=to]', host)?.value.trim();
      smTest.disabled = true; setStatus(msg, true, 'Sending test email…');
      try { await api('/setup/smtp/test', { method: 'POST', body: { to } }); setStatus(msg, true, '✓ test email sent'); }
      catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
      finally { smTest.disabled = false; }
    };

    // ---- Telegram config pane ----
    const tg = st.telegram || {};
    const tgConfigured = !!st.telegramConfigured;
    const showTgForm = editTg || !tgConfigured;
    const tgEl = $('[data-set=telegram]', host);
    if (tgEl) {
      tgEl.innerHTML = !showTgForm ? `
        <div class="set-summary">
          <div class="set-kv"><span>Status</span><b class="${tg.enabled ? 'set-ok' : ''}">${tg.enabled ? '● Enabled' : '○ Configured (disabled)'}</b></div>
          <div class="set-kv"><span>Bot token</span><b>•••••••• (stored)</b></div>
          <div class="set-kv"><span>Chat ID</span><b>${esc(tg.chatId || '—')}</b></div>
          <div class="set-actions">
            <button class="set-btn set-btn-edit" data-tg="edit">${EDIT_ICON}<span>Edit</span></button>
            <button class="set-btn set-btn-test" data-tg="test">${TEST_ICON}<span>Send Test Message</span></button>
            <span data-tg="msg"></span>
          </div>
        </div>` : `
        <p class="hw-hint">Send alerts and security-update summaries to Telegram. Create a bot with <b>@BotFather</b> (/newbot) to get a token, send your bot any message, then use “Detect” to fill your chat ID automatically.</p>
        <div class="wz-form">
          <label>Bot token <input data-tg="token" type="password" placeholder="${tg.hasToken ? '•••••• (unchanged)' : '123456:ABC-DEF…'}" autocomplete="off"></label>
          <div class="al-form-row" style="grid-template-columns:1fr auto">
            <label>Chat ID <input data-tg="chatid" value="${esc(tg.chatId || '')}" placeholder="123456789"></label>
            <label style="align-self:end"><button class="set-btn" data-tg="detect" style="margin-top:2px">Detect</button></label>
          </div>
          <label class="wz-inline"><input type="checkbox" data-tg="enabled" ${tg.enabled ? 'checked' : ''}> Enable Telegram notifications</label>
          <div class="set-actions">
            <button class="set-btn set-btn-primary" data-tg="save">${SAVE_ICON}<span>Save Telegram Settings</span></button>
            ${tgConfigured ? `<button class="set-btn set-btn-cancel" data-tg="cancel">${CANCEL_ICON}<span>Cancel</span></button>` : ''}
            <button class="set-btn set-btn-test" data-tg="test">${TEST_ICON}<span>Send Test Message</span></button>
            <span data-tg="msg"></span>
          </div>
        </div>`;
      const tgEdit = $('[data-tg=edit]', host);
      if (tgEdit) tgEdit.onclick = () => { editTg = true; load(host); };
      const tgCancel = $('[data-tg=cancel]', host);
      if (tgCancel) tgCancel.onclick = () => { editTg = false; load(host); };
      const tgDetect = $('[data-tg=detect]', host);
      if (tgDetect) tgDetect.onclick = async () => {
        const msg = $('[data-tg=msg]', host);
        tgDetect.disabled = true; setStatus(msg, true, 'Looking for your chat…');
        try {
          // a token must be saved first for detect to work; if the user typed a
          // new one, save it (token-only) before detecting
          const typed = $('[data-tg=token]', host)?.value.trim();
          if (typed) await api('/setup/telegram', { method: 'POST', body: { token: typed } });
          const r = await api('/setup/telegram/detect', { method: 'POST', body: {} });
          $('[data-tg=chatid]', host).value = r.chatId;
          setStatus(msg, true, `✓ found ${r.name || r.chatId}`);
        } catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
        finally { tgDetect.disabled = false; }
      };
      const tgSave = $('[data-tg=save]', host);
      if (tgSave) tgSave.onclick = async () => {
        const msg = $('[data-tg=msg]', host);
        const body = {
          token: $('[data-tg=token]', host).value.trim() || undefined,
          chatId: $('[data-tg=chatid]', host).value.trim(),
          enabled: $('[data-tg=enabled]', host).checked,
        };
        tgSave.disabled = true; setStatus(msg, true, 'Saving…');
        try { await api('/setup/telegram', { method: 'POST', body }); editTg = false; toast('success', 'Telegram', 'Telegram settings saved'); load(host); }
        catch (err) { setStatus(msg, false, `✗ ${err.message}`); tgSave.disabled = false; }
      };
      const tgTest = $('[data-tg=test]', host);
      if (tgTest) tgTest.onclick = async () => {
        const msg = $('[data-tg=msg]', host);
        const chatId = $('[data-tg=chatid]', host)?.value.trim() || undefined;
        tgTest.disabled = true; setStatus(msg, true, 'Sending test message…');
        try { await api('/setup/telegram/test', { method: 'POST', body: { chatId } }); setStatus(msg, true, '✓ test message sent'); }
        catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
        finally { tgTest.disabled = false; }
      };
    }

    // ---- account: change password ----
    const pwEdit = $('[data-acc=pwedit]', host);
    if (pwEdit) pwEdit.onclick = () => { editPw = true; load(host); };
    const pwCancel = $('[data-acc=pwcancel]', host);
    if (pwCancel) pwCancel.onclick = () => { editPw = false; load(host); };
    const pwSave = $('[data-acc=pwsave]', host);
    if (pwSave) pwSave.onclick = async () => {
      const msg = $('[data-acc=pwmsg]', host);
      const cur = $('[data-acc=cur]', host).value;
      const nw = $('[data-acc=new]', host).value;
      const nw2 = $('[data-acc=new2]', host).value;
      if (nw.length < 8) { setStatus(msg, false, '✗ new password must be at least 8 characters'); return; }
      if (nw !== nw2) { setStatus(msg, false, '✗ new passwords do not match'); return; }
      pwSave.disabled = true; setStatus(msg, true, 'Updating…');
      try {
        await api('/auth/account/password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
        editPw = false;
        toast('success', 'Account', 'Password updated');
        load(host);
      } catch (err) { setStatus(msg, false, `✗ ${err.message}`); pwSave.disabled = false; }
    };

    // ---- account: 2FA toggle (on -> enroll + confirm; off -> code to disable) ----
    const mfaToggle = $('[data-acc=mfatoggle]', host);
    const mfazone = $('[data-acc=mfazone]', host);
    if (mfaToggle) mfaToggle.onchange = async () => {
      if (!mfazone) return;
      if (mfaToggle.checked) {
        // turning ON — begin enrollment
        mfaToggle.disabled = true;
        try {
          const r = await api('/auth/account/mfa/begin', { method: 'POST', body: {} });
          mfazone.innerHTML = `
            <div class="acc-enroll">
              <h4 class="sess-h">Enable two-factor authentication</h4>
              <img src="${r.qrDataUrl}" alt="2FA QR code" class="acc-qr">
              <p class="hw-hint">Scan with your authenticator app, or enter the secret manually: <code>${esc(r.secret)}</code></p>
              <label>Enter the 6-digit code to confirm <input data-acc="enrollcode" inputmode="numeric" autocomplete="off" placeholder="123456" maxlength="6"></label>
              <div class="set-actions"><button class="set-btn set-btn-primary" data-acc="mfaconfirm">${SAVE_ICON}<span>Confirm &amp; activate</span></button><button class="set-btn" data-acc="mfaabort">${CANCEL_ICON}<span>Cancel</span></button><span data-acc="mfamsg"></span></div>
            </div>`;
          const confirm = $('[data-acc=mfaconfirm]', host);
          confirm.onclick = async () => {
            const code = $('[data-acc=enrollcode]', host).value.trim();
            const msg = $('[data-acc=mfamsg]', host);
            confirm.disabled = true; setStatus(msg, true, 'Verifying…');
            try { await api('/auth/account/mfa/confirm', { method: 'POST', body: { code } });
              toast('success', '2FA', 'Two-factor authentication enabled'); load(host);
            } catch (err) { setStatus(msg, false, `✗ ${err.message}`); confirm.disabled = false; }
          };
          // Cancel: the begin() call already flipped mfa_enabled on the server
          // (unconfirmed); disabling without a code isn't allowed, so cancel
          // just reloads — an unconfirmed secret doesn't gate login.
          $('[data-acc=mfaabort]', host).onclick = () => load(host);
        } catch (err) { toast('error', '2FA', err.message); load(host); }
      } else {
        // turning OFF — require a current code
        mfazone.innerHTML = `
          <div class="acc-enroll">
            <h4 class="sess-h">Disable two-factor authentication</h4>
            <p class="hw-hint">Enter a current code from your authenticator app to confirm.</p>
            <label>Authenticator code <input data-acc="discode" inputmode="numeric" autocomplete="off" placeholder="123456" maxlength="6"></label>
            <div class="set-actions"><button class="set-btn set-btn-danger" data-acc="mfadisable">${TRASH_ICON}<span>Disable 2FA</span></button><button class="set-btn" data-acc="mfaabort">${CANCEL_ICON}<span>Cancel</span></button><span data-acc="mfamsg"></span></div>
          </div>`;
        const disable = $('[data-acc=mfadisable]', host);
        disable.onclick = async () => {
          const code = $('[data-acc=discode]', host).value.trim();
          const msg = $('[data-acc=mfamsg]', host);
          disable.disabled = true; setStatus(msg, true, 'Disabling…');
          try { await api('/auth/account/mfa/disable', { method: 'POST', body: { code } });
            toast('success', '2FA', 'Two-factor authentication disabled'); load(host);
          } catch (err) { setStatus(msg, false, `✗ ${err.message}`); disable.disabled = false; }
        };
        $('[data-acc=mfaabort]', host).onclick = () => load(host);
      }
    };
  }

  // ---- Remote Access settings pane ----
  let editRemote = false;
  async function loadRemote(host) {
    const el2 = $('[data-set=remote]', host);
    if (!el2) return;
    let cfg;
    try { cfg = await api('/remote/config'); } catch { el2.innerHTML = '<p class="sess-empty">Could not load remote-access config.</p>'; return; }

    if (!editRemote) {
      const sshState = cfg.ssh.enabled ? '● Enabled' : '○ Disabled';
      const vncState = cfg.vnc.enabled ? '● Enabled' : '○ Disabled';
      el2.innerHTML = `
        <p class="up-sec-hint">Access this Pi's shell and desktop from your browser — no SSH client or VNC viewer needed. Stays on your LAN and uses your admin session. Disabled by default.</p>
        <div class="set-summary">
          <div class="set-kv"><span>Remote access</span><b class="${cfg.enabled ? 'set-ok' : ''}">${cfg.enabled ? '● Enabled' : '○ Disabled'}</b></div>
          <div class="set-kv"><span>SSH terminal</span><b class="${cfg.ssh.enabled ? 'set-ok' : ''}">${sshState}</b></div>
          <div class="set-kv"><span>SSH login</span><b>${cfg.ssh.username ? esc(cfg.ssh.username) + '@' + esc(cfg.ssh.host) + ':' + cfg.ssh.port : '(not set)'}</b></div>
          <div class="set-kv"><span>SSH key</span><b>${cfg.sshKeyConfigured ? '✓ generated' : '✗ not generated'}</b></div>
          <div class="set-kv"><span>VNC desktop</span><b class="${cfg.vnc.enabled ? 'set-ok' : ''}">${vncState}</b></div>
          <div class="set-kv"><span>VNC server</span><b>${esc(cfg.vnc.host)}:${cfg.vnc.port}</b></div>
        </div>
        <div class="set-actions">
          <button class="set-btn set-btn-edit" data-rm="edit">${EDIT_ICON}<span>Edit</span></button>
        </div>`;
      $('[data-rm=edit]', host).onclick = () => { editRemote = true; loadRemote(host); };
      return;
    }

    el2.innerHTML = `
      <div class="wz-form">
        <label class="sched-toggle sched-toggle-main">
          <span class="set-switch"><input type="checkbox" data-rm="enabled" ${cfg.enabled ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
          <span>Enable in-browser remote access</span>
        </label>

        <div class="sched-subnotif" data-rm-sub ${cfg.enabled ? '' : 'hidden'}>
          <h4 class="sess-h">SSH Terminal</h4>
          <label class="sched-toggle">
            <span class="set-switch"><input type="checkbox" data-rm="sshen" ${cfg.ssh.enabled ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
            <span>Enable SSH terminal</span>
          </label>
          <label>SSH username
            <input data-rm="sshuser" value="${esc(cfg.ssh.username || '')}" placeholder="e.g. pi" autocomplete="off">
          </label>
          <div class="wz-row">
            <label style="flex:2">Host <input data-rm="sshhost" value="${esc(cfg.ssh.host)}"></label>
            <label style="flex:1">Port <input data-rm="sshport" type="number" value="${cfg.ssh.port}"></label>
          </div>
          <div class="rm-keybox">
            <div class="rm-key-head"><b>Dashboard SSH key</b> <span class="${cfg.sshKeyConfigured ? 'set-ok' : 'inv-dim'}">${cfg.sshKeyConfigured ? '✓ generated' : 'not generated'}</span></div>
            <p class="up-sec-hint">Add this public key to <code>~/.ssh/authorized_keys</code> on the Pi so the terminal can log in.</p>
            <pre class="rm-pubkey" data-rm="pubkey">${cfg.sshPublicKey ? esc(cfg.sshPublicKey) : '(generate a key to see it here)'}</pre>
            <div class="set-actions" style="border:0;padding-top:0">
              <button class="set-btn" data-rm="genkey">${cfg.sshKeyConfigured ? 'Regenerate Key' : 'Generate Key'}</button>
              ${cfg.sshPublicKey ? '<button class="set-btn" data-rm="copykey">Copy Public Key</button>' : ''}
            </div>
          </div>

          <h4 class="sess-h" style="margin-top:18px">VNC Desktop</h4>
          <label class="sched-toggle">
            <span class="set-switch"><input type="checkbox" data-rm="vncen" ${cfg.vnc.enabled ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
            <span>Enable VNC desktop</span>
          </label>
          <div class="wz-row">
            <label style="flex:2">VNC host <input data-rm="vnchost" value="${esc(cfg.vnc.host)}"></label>
            <label style="flex:1">Port <input data-rm="vncport" type="number" value="${cfg.vnc.port}"></label>
          </div>
          <label>Authentication mode
            <select data-rm="vncauth">
              <option value="auto" ${(cfg.vnc.auth || 'auto') === 'auto' ? 'selected' : ''}>VeNCrypt/TLS + login (wayvnc / RealVNC default)</option>
              <option value="raw" ${cfg.vnc.auth === 'raw' ? 'selected' : ''}>Plain / no encryption (TigerVNC, no-auth)</option>
            </select>
          </label>
          <div class="wz-row" data-rm-vncauth ${(cfg.vnc.auth || 'auto') === 'auto' ? '' : 'hidden'}>
            <label style="flex:1">Login username (PAM) <input data-rm="vncuser" value="${esc(cfg.vnc.username || '')}" placeholder="e.g. ${esc(cfg.ssh.username || 'pi')}" autocomplete="off"></label>
            <label style="flex:1">Password <input data-rm="vncpass" type="password" placeholder="${cfg.vncPasswordConfigured ? '•••••••• (stored)' : 'your login password'}" autocomplete="new-password"></label>
          </div>
          <p class="up-sec-hint">wayvnc (the Raspberry Pi OS default) and RealVNC use encrypted VeNCrypt/TLS — the dashboard terminates that for the browser using your Pi <b>login</b> (PAM) credentials. Leave password blank to keep the stored one.</p>
        </div>

        <div class="set-actions">
          <button class="set-btn set-btn-primary" data-rm="save">${SAVE_ICON}<span>Save</span></button>
          <button class="set-btn set-btn-cancel" data-rm="cancel">${CANCEL_ICON}<span>Cancel</span></button>
          <span data-rm="msg"></span>
        </div>
      </div>`;
    enhanceSelects(host);

    const mainTog = $('[data-rm=enabled]', host);
    const sub = $('[data-rm-sub]', host);
    if (mainTog && sub) mainTog.addEventListener('change', () => { sub.hidden = !mainTog.checked; });
    const vncAuthSel = $('[data-rm=vncauth]', host);
    const vncAuthRow = $('[data-rm-vncauth]', host);
    if (vncAuthSel && vncAuthRow) vncAuthSel.addEventListener('change', () => { vncAuthRow.hidden = vncAuthSel.value !== 'auto'; });

    $('[data-rm=genkey]', host).onclick = async () => {
      const btn = $('[data-rm=genkey]', host); btn.disabled = true; btn.textContent = 'Generating…';
      try {
        const r = await api('/remote/ssh/key', { method: 'POST', body: {} });
        $('[data-rm=pubkey]', host).textContent = r.publicKey;
        toast('success', 'Remote Access', 'SSH key generated');
        editRemote = true; loadRemote(host);
      } catch (err) { toast('error', 'Remote Access', err.message); btn.disabled = false; btn.textContent = 'Generate Key'; }
    };
    const copyBtn = $('[data-rm=copykey]', host);
    if (copyBtn) copyBtn.onclick = async () => {
      const txt = $('[data-rm=pubkey]', host).textContent;
      let ok = false;
      // navigator.clipboard only exists in secure contexts (HTTPS/localhost);
      // over plain-HTTP LAN it's undefined, so fall back to execCommand.
      try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(txt); ok = true; }
        else {
          const ta = document.createElement('textarea');
          ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.focus(); ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } catch { ok = false; }
      if (ok) {
        const orig = copyBtn.innerHTML;
        copyBtn.classList.add('set-btn-test');
        copyBtn.innerHTML = '<span>✓ Copied</span>';
        setTimeout(() => { copyBtn.classList.remove('set-btn-test'); copyBtn.innerHTML = orig; }, 1600);
      } else {
        toast('info', 'Remote Access', 'Could not copy — select the key text and copy manually');
      }
    };

    $('[data-rm=cancel]', host).onclick = () => { editRemote = false; loadRemote(host); };
    $('[data-rm=save]', host).onclick = async () => {
      const body = {
        enabled: $('[data-rm=enabled]', host).checked,
        ssh: {
          enabled: $('[data-rm=sshen]', host).checked,
          username: $('[data-rm=sshuser]', host).value.trim(),
          host: $('[data-rm=sshhost]', host).value.trim() || '127.0.0.1',
          port: Number($('[data-rm=sshport]', host).value) || 22,
        },
        vnc: {
          enabled: $('[data-rm=vncen]', host).checked,
          host: $('[data-rm=vnchost]', host).value.trim() || '127.0.0.1',
          port: Number($('[data-rm=vncport]', host).value) || 5900,
          auth: $('[data-rm=vncauth]', host).value,
          username: $('[data-rm=vncuser]', host) ? $('[data-rm=vncuser]', host).value.trim() : '',
          ...($('[data-rm=vncpass]', host) && $('[data-rm=vncpass]', host).value ? { password: $('[data-rm=vncpass]', host).value } : {}),
        },
      };
      const b = $('[data-rm=save]', host); b.disabled = true; $('[data-rm=msg]', host).textContent = 'Saving…';
      try { await api('/remote/config', { method: 'PUT', body }); toast('success', 'Remote Access', 'Settings saved'); editRemote = false; loadRemote(host); }
      catch (err) { $('[data-rm=msg]', host).textContent = '✗ ' + err.message; b.disabled = false; }
    };
  }

  // ---- Display preferences: date & time format (stored in localStorage) ----
  function renderPrefs(host) {
    const el2 = $('[data-set=prefs]', host);
    if (!el2) return;
    const pref = rapisysDateFmtPref();
    const sample = Date.now();
    const preview = () => rapisysFmtTime(sample);
    el2.innerHTML = `
      <p class="up-sec-hint">Choose how dates and times appear across the dashboard (logs, history, inventory). Saved on this device.</p>
      <div class="wz-row">
        <label style="flex:1">Date format
          <select data-pref="date">
            <option value="auto" ${pref.date === 'auto' ? 'selected' : ''}>Auto (your locale) — ${esc(new Date(sample).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</option>
            <option value="iso" ${pref.date === 'iso' ? 'selected' : ''}>ISO — 2026-06-19</option>
            <option value="us" ${pref.date === 'us' ? 'selected' : ''}>US — 06/19/2026</option>
            <option value="eu" ${pref.date === 'eu' ? 'selected' : ''}>EU — 19/06/2026</option>
            <option value="long" ${pref.date === 'long' ? 'selected' : ''}>Long — Jun 19, 2026</option>
          </select>
        </label>
        <label style="flex:1">Time format
          <select data-pref="time">
            <option value="auto" ${pref.time === 'auto' ? 'selected' : ''}>Auto (your locale)</option>
            <option value="24" ${pref.time === '24' ? 'selected' : ''}>24-hour — 18:30</option>
            <option value="12" ${pref.time === '12' ? 'selected' : ''}>12-hour — 6:30 PM</option>
          </select>
        </label>
      </div>
      <div class="set-summary" style="margin-top:8px">
        <div class="set-kv"><span>Preview</span><b data-pref="preview">${esc(preview())}</b></div>
      </div>`;
    enhanceSelects(host);
    const apply = () => {
      const dv = $('[data-pref=date]', host).value;
      const tv = $('[data-pref=time]', host).value;
      localStorage.setItem(RAPISYS_DATEFMT_KEY, dv);
      localStorage.setItem(RAPISYS_TIMEFMT_KEY, tv);
      const pv = $('[data-pref=preview]', host); if (pv) pv.textContent = preview();
      toast('success', 'Preferences', 'Date/time format updated');
    };
    ['date', 'time'].forEach((f) => { const s = $(`[data-pref=${f}]`, host); if (s) s.addEventListener('change', apply); });
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('settings', 'Settings')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          ${pageTabs([{ id: 'health', label: 'Services Health' }, { id: 'storage', label: 'Storage' }, { id: 'email', label: 'Notifications' }, { id: 'remote', label: 'Remote Access' }, { id: 'account', label: 'Account' }])}
          <div class="card-body" data-pane="health">
            <div data-set="health"></div>
          </div>
          <div class="card-body" data-pane="storage" style="display:none">
            <h4 class="sess-h">Network Storage (NAS)</h4>
            <div data-set="nas"></div><div data-set="nasform"></div>
            <h4 class="sess-h" style="margin-top:24px">Database Storage</h4>
            <div data-set="storage"></div>
          </div>
          <div class="card-body" data-pane="email" style="display:none">
            <h4 class="sess-h">Email (SMTP)</h4>
            <div data-set="smtp"></div>
            <h4 class="sess-h" style="margin-top:24px">Telegram</h4>
            <div data-set="telegram"></div>
          </div>
          <div class="card-body" data-pane="remote" style="display:none">
            <h4 class="sess-h">In-Browser Remote Access</h4>
            <div data-set="remote"></div>
          </div>
          <div class="card-body" data-pane="account" style="display:none">
            <h4 class="sess-h">Display Preferences</h4>
            <div data-set="prefs"></div>
            <h4 class="sess-h" style="margin-top:24px">Administrator Account</h4>
            <div data-set="account"></div>
          </div>
        </div>
      </div>`;
      wirePageTabs(host, (tab) => { if (tab === 'remote') loadRemote(host); });
      load(host);
    },
    unmount() {},
  };
})();

// ---------------------------------------------------------------------------
// Network analytics page
// ---------------------------------------------------------------------------

pageRenderers.network = (() => {
  let liveTimer = null, slowTimer = null, chart = null;
  const series = {};            // iface -> { rx: TimeSeries, tx: TimeSeries }
  const selected = new Set();   // multi-select focus (empty = show all)
  let nethogsLive = false, nethogsTimer = null;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Distinct colors per interface, reused for both the line and its label.
  const PALETTE = ['#00d4ff', '#a855f7', '#10b981', '#f97316', '#eab308', '#ec4899', '#38bdf8', '#84cc16'];
  const ifaceColors = {};
  let colorIdx = 0;
  const colorFor = (iface) => (ifaceColors[iface] ||= PALETTE[colorIdx++ % PALETTE.length]);

  const fmtRate = (bps) => {
    const bits = bps * 8;
    if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
    if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
    return `${Math.round(bits)} b/s`;
  };
  const fmtBytes = (b) => {
    if (b == null) return '—';
    if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
    if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
    return `${b} B`;
  };
  const KIND_LABEL = { wired: 'Ethernet', wifi: 'Wi-Fi', vpn: 'VPN', bridge: 'Bridge', other: '' };

  function ensureSeries(iface) {
    if (series[iface] || typeof TimeSeries === 'undefined') return;
    series[iface] = { rx: new TimeSeries(), tx: new TimeSeries() };
    const col = colorFor(iface);
    chart.addTimeSeries(series[iface].rx, { strokeStyle: col, lineWidth: 2 });
    // tx drawn dashed-lighter via a translucent fill of the same hue
    chart.addTimeSeries(series[iface].tx, { strokeStyle: col + '88', lineWidth: 1 });
  }

  function applyFocus() {
    // dim unselected: when selection non-empty, hide others' series by
    // setting them to transparent; selected (or all) drawn normally.
    for (const [iface, s] of Object.entries(series)) {
      const on = selected.size === 0 || selected.has(iface);
      const col = colorFor(iface);
      s.rx.options = { strokeStyle: on ? col : col + '18', lineWidth: on ? 2 : 1 };
      s.tx.options = { strokeStyle: on ? col + '88' : col + '10', lineWidth: 1 };
    }
  }

  async function refreshLive(host) {
    let t;
    try { t = await api('/network/throughput'); } catch { return; }
    const allIfaces = Object.entries(t.interfaces)
      .sort((a, b) => (b[1].rxRate + b[1].txRate) - (a[1].rxRate + a[1].txRate));
    // Bridges/docker are internal plumbing — hidden unless the user opts in.
    const showVirtual = pageRenderers.network._showVirtual;
    const ifaces = allIfaces.filter(([, v]) => showVirtual || v.kind !== 'bridge');
    const hiddenCount = allIfaces.length - ifaces.length;
    let totalRx = 0, totalTx = 0;
    const now = Date.now();
    for (const [name, v] of allIfaces) {
      ensureSeries(name);
      if (series[name]) {
        series[name].rx.append(now, v.rxRate * 8 / 1e6);
        series[name].tx.append(now, v.txRate * 8 / 1e6);
      }
      if (selected.size === 0 || selected.has(name)) { totalRx += v.rxRate; totalTx += v.txRate; }
    }
    $('[data-net=down]', host).textContent = fmtRate(totalRx);
    $('[data-net=up]', host).textContent = fmtRate(totalTx);

    $('[data-net=ifaces]', host).innerHTML = ifaces.map(([name, v]) => {
      const col = colorFor(name);
      const on = selected.size === 0 || selected.has(name);
      return `
        <button class="net-iface ${on ? '' : 'net-iface-off'}" data-iface="${esc(name)}">
          <span class="net-iface-dot" style="background:${col}"></span>
          <span class="net-iface-name" style="color:${col}">${esc(name)}</span>
          <span class="net-iface-kind">${KIND_LABEL[v.kind] || ''}</span>
          <span class="net-iface-rates">▼ ${fmtRate(v.rxRate)} &nbsp; ▲ ${fmtRate(v.txRate)}</span>
          <span class="net-iface-total">${fmtBytes(v.rxBytes + v.txBytes)}</span>
        </button>`;
    }).join('')
      + (hiddenCount > 0 || showVirtual
        ? `<button class="net-toggle net-virtual-toggle" data-net="togglevirt">${showVirtual ? 'Hide' : 'Show'} ${showVirtual ? '' : hiddenCount + ' '}virtual / bridge interfaces</button>`
        : '');
    const tv = $('[data-net=togglevirt]', host);
    if (tv) tv.onclick = () => { pageRenderers.network._showVirtual = !showVirtual; refreshLive(host); };

    $('[data-net=ifaces]', host).querySelectorAll('[data-iface]').forEach((b) => b.onclick = () => {
      const n = b.dataset.iface;
      if (selected.has(n)) selected.delete(n); else selected.add(n);
      applyFocus(); refreshLive(host);
    });
  }

  // ---- bandwidth history with period filter ----
  let histPeriod = 'days';
  async function refreshHistory(host) {
    let vn;
    try { vn = await api('/network/history'); } catch { return; }
    const vh = $('[data-net=history]', host);
    if (!vn.available) { vh.innerHTML = '<p class="sess-empty">vnStat unavailable.</p>'; return; }
    if (!vn.interfaces.length) { vh.innerHTML = '<p class="sess-empty">vnStat is collecting — history appears shortly.</p>'; return; }

    const KEY = { fiveminute: 'fiveminutes', minute: 'fiveminutes', hour: 'hours', day: 'days', week: 'days', month: 'months' };
    const histIfaces = vn.interfaces.filter((i) => pageRenderers.network._showVirtual || !/^(br-|docker|virbr)/.test(i.name));
    vh.innerHTML = histIfaces.map((i) => {
      let buckets = histPeriod === 'hour' ? i.hours
        : histPeriod === 'month' ? i.months
        : i.days;
      if (histPeriod === 'week') buckets = (i.days || []).slice(-7);
      buckets = (buckets || []).slice(-30);
      const max = Math.max(1, ...buckets.map((d) => (d.rx || 0) + (d.tx || 0)));
      const col = colorFor(i.name);
      const bars = buckets.map((d) => {
        const tot = (d.rx || 0) + (d.tx || 0);
        const h = Math.round((tot / max) * 40);
        const lbl = d.date ? `${d.date.month || ''}/${d.date.day || ''}` : (d.time ? `${d.time.hour}:00` : '');
        return `<div class="net-bar" style="height:${Math.max(2, h)}px;background:${col}" title="${lbl}: ${fmtBytes(tot)}"></div>`;
      }).join('');
      const pad = Math.max(0, 14 - buckets.length);
      const today = i.today ? fmtBytes((i.today.rx || 0) + (i.today.tx || 0)) : '—';
      const total = i.total ? fmtBytes((i.total.rx || 0) + (i.total.tx || 0)) : '—';
      return `<div class="net-hist-iface">
        <div class="net-hist-head"><b style="color:${col}">${esc(i.name)}</b><span>today ${today} · total ${total}</span></div>
        <div class="net-bars">${bars}${'<div class="net-bar net-bar-empty"></div>'.repeat(pad)}</div>
      </div>`;
    }).join('');
  }

  // ---- protocols as % with connection drill-down ----
  let expandedSvc = null;
  async function refreshProtocols(host) {
    let p;
    try { p = await api('/network/protocols'); } catch { return; }
    const max = Math.max(1, ...p.shares.map((s) => s.pct));
    $('[data-net=proto]', host).innerHTML = `<div class="net-proto-summary">${p.total} active connections</div>`
      + (p.shares.length ? p.shares.map((s) => `
        <div class="net-proto-block">
          <button class="net-proto-row" data-svc="${esc(s.service)}">
            <span class="net-proto-name">${esc(s.service)}</span>
            <span class="net-proto-bar"><span style="width:${(s.pct / max) * 100}%"></span></span>
            <span class="net-proto-n">${s.pct.toFixed(0)}%</span>
          </button>
          ${expandedSvc === s.service ? `<div class="net-conns">${
            s.conns.map((c) => `<div class="net-conn">
              <span>${esc(c.comm || '?')}${c.pid ? ` <small>${c.pid}</small>` : ''}</span>
              <span class="net-conn-peer">:${c.localPort ?? '?'} → ${esc(c.peerHost || c.peer)}:${c.peerPort ?? '?'}</span>
            </div>`).join('')
          }</div>` : ''}
        </div>`).join('') : '<p class="sess-empty">No active connections</p>');

    $('[data-net=proto]', host).querySelectorAll('[data-svc]').forEach((b) => b.onclick = () => {
      expandedSvc = expandedSvc === b.dataset.svc ? null : b.dataset.svc;
      refreshProtocols(host);
    });
  }

  // ---- top processes: live nethogs while page is open ----
  async function refreshProcsLive(host) {
    try {
      const r = await api('/network/nethogs', { method: 'POST', body: { seconds: 3 } });
      const list = r.processes || [];
      $('[data-net=procs]', host).innerHTML = list.length
        ? list.map((p) => `<div class="net-proc-row">
            <span><b>${esc(p.comm)}</b> <small>pid ${p.pid}</small></span>
            <span>▼ ${p.recvKBs.toFixed(1)} ▲ ${p.sentKBs.toFixed(1)} KB/s</span>
          </div>`).join('')
        : '<p class="sess-empty">No per-process traffic right now</p>';
    } catch (err) {
      // nethogs not installed yet — offer one-time enable
      $('[data-net=procs]', host).innerHTML = `<p class="sess-empty">Live per-process bandwidth needs nethogs.</p>
        <div class="net-dns-cta"><button class="net-toggle" data-net="nhinstall">Enable real-time process bandwidth</button></div>`;
      const ib = $('[data-net=nhinstall]', host);
      if (ib) ib.onclick = async () => {
        if (!await rapisysConfirm('Install nethogs and start real-time per-process bandwidth? Runs a continuous lightweight packet capture while this page is open.', { confirmLabel: 'Enable' })) return;
        ib.textContent = 'Installing…'; ib.disabled = true;
        nethogsLive = true; startProcs(host);
      };
    }
  }
  function startProcs(host) {
    nethogsLive = true;
    globalThis.__netPageActive = true;
    refreshProcsLive(host);
    clearInterval(nethogsTimer);
    nethogsTimer = setInterval(() => refreshProcsLive(host), 4000);
  }

  // ---- DNS: the Pi's own queries ----
  async function refreshDns(host) {
    let snap;
    try { snap = await api('/network'); } catch { return; }
    const d = snap.dns;
    let html;
    if (d.domains?.length) {
      const max = Math.max(1, ...d.domains.map((x) => x.queries));
      const label = d.ownQueries ? `Queries initiated by this Pi (${d.source})` : `${(d.totalQueries || 0).toLocaleString()} queries logged`;
      html = `<div class="net-proto-summary">${label}</div>`
        + d.domains.map((x) => `<div class="net-proto-row net-proto-static">
            <span class="net-domain">${esc(x.domain)}</span>
            <span class="net-proto-bar"><span style="width:${(x.queries / max) * 100}%"></span></span>
            <span class="net-proto-n">${x.queries}</span>
          </div>`).join('');
      if (d.source === 'dnsmasq') html += `<div class="net-dns-cta"><button class="net-toggle" data-net="dnsoff">disable logging</button></div>`;
    } else if (d.source === 'resolved') {
      html = `<div class="set-kv"><span>Total queries</span><b>${(d.total ?? 0).toLocaleString()}</b></div>
        <div class="set-kv"><span>Cache hits</span><b>${(d.cacheHits ?? 0).toLocaleString()}</b></div>
        <div class="set-kv"><span>Cache misses</span><b>${(d.cacheMisses ?? 0).toLocaleString()}</b></div>`;
    } else if (d.resolver) {
      html = `<div class="set-kv"><span>Active resolver</span><b>${esc(d.resolver)}</b></div>
        <p class="net-dns-note">This Pi resolves DNS through ${esc(d.resolver)}. Per-domain query history isn\u2019t exposed by this resolver. You can insert a local logging forwarder to capture queries (reversible).</p>
        <div class="net-dns-cta"><button class="net-toggle" data-net="fwdon">Enable query logging (local forwarder)</button></div>`;
    } else {
      html = '<p class="sess-empty">No DNS data available from this Pi\u2019s resolver.</p>';
    }
    $('[data-net=dns]', host).innerHTML = html;
    const off = $('[data-net=dnsoff]', host);
    if (off) off.onclick = async () => { try { await api('/network/dns/logging', { method: 'POST', body: { enabled: false } }); setTimeout(() => refreshDns(host), 1200); } catch (e) { toast('error', 'DNS', e.message); } };
    const fwdOn = $('[data-net=fwdon]', host);
    if (fwdOn) fwdOn.onclick = async () => {
      if (!await rapisysConfirm('Insert a local DNS logging forwarder in front of ' + esc(d.resolver) + '? This installs dnsmasq (if needed), repoints the Pi\u2019s resolver to a local logging proxy, and is fully reversible. Queries will then appear here.', { confirmLabel: 'Enable logging' })) return;
      fwdOn.textContent = 'Setting up… (may install dnsmasq)'; fwdOn.disabled = true;
      try { await api('/network/dns/forwarder', { method: 'POST', body: { enable: true } }); toast('success', 'DNS', 'Logging forwarder active'); setTimeout(() => refreshDns(host), 2500); }
      catch (e) {
        toast('error', 'DNS', 'Could not enable query logging');
        const cta = fwdOn.parentElement;
        fwdOn.remove();
        const note = el('p', 'net-dns-note'); note.textContent = e.message; cta.appendChild(note);
      }
    };
  }

  function initChart(host) {
    const canvas = $('[data-net=chart]', host);
    if (!canvas || typeof SmoothieChart === 'undefined') return;
    chart = new SmoothieChart({
      millisPerPixel: 60, grid: { fillStyle: 'transparent', strokeStyle: 'rgba(255,255,255,0.05)', millisPerLine: 10000, verticalSections: 4 },
      labels: { fillStyle: '#8b8b9e', fontSize: 11 }, responsive: true, tooltip: false, minValue: 0,
    });
    chart.streamTo(canvas, 1000);
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('network', 'Network')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg></div><span class="card-title">Live Throughput</span>
            <span class="net-headline"><span class="net-dl">▼ <b data-net="down">—</b></span> <span class="net-ul">▲ <b data-net="up">—</b></span></span>
          </div>
          <div class="card-body">
            <canvas data-net="chart" class="net-chart"></canvas>
            <p class="net-hint">Click an interface to focus (multi-select); others dim.</p>
            <div class="net-ifaces" data-net="ifaces"></div>
          </div>
        </div>
        <div class="card sess-span">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg></div><span class="card-title">Bandwidth History</span>
            <select class="net-period" data-net="period">
              <option value="hour">Hourly</option><option value="day" selected>Daily</option>
              <option value="week">Weekly</option><option value="month">Monthly</option>
            </select>
          </div>
          <div class="card-body" data-net="history"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20" opacity="0.3"/><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 6 15.7"/></svg></div><span class="card-title">Protocols (% of connections)</span></div>
          <div class="card-body" data-net="proto"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div><span class="card-title">Top Processes (live)</span></div>
          <div class="card-body" data-net="procs"></div>
        </div>
        <div class="card sess-span">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="8"/><path d="M4 10h5M15 10h5M12 2a12 12 0 0 0 0 16M12 2a12 12 0 0 1 0 16"/><rect x="8" y="7" width="8" height="6" rx="1" fill="var(--bg-card)"/><path d="M12 18v3M8 21h8" /></svg></div><span class="card-title">DNS — Pi Queries</span></div>
          <div class="card-body" data-net="dns"></div>
        </div>
      </div>`;
      initChart(host);
      $('[data-net=period]', host).addEventListener('change', (e) => { histPeriod = e.target.value; refreshHistory(host); });
      enhanceSelects(host);
      refreshLive(host); refreshHistory(host); refreshProtocols(host); refreshDns(host);
      startProcs(host);
      liveTimer = setInterval(() => refreshLive(host), 1000);
      slowTimer = setInterval(() => { refreshProtocols(host); refreshHistory(host); refreshDns(host); }, 15000);
    },
    unmount() {
      clearInterval(liveTimer); clearInterval(slowTimer); clearInterval(nethogsTimer);
      globalThis.__netPageActive = false;
      if (chart) { chart.stop(); chart = null; }
      for (const k of Object.keys(series)) delete series[k];
    },
  };
})();

// ---------------------------------------------------------------------------
// Reports page — daily/weekly/monthly aggregation, health score, export
// ---------------------------------------------------------------------------

pageRenderers.reports = (() => {
  let view = 'daily';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const METRIC_LABEL = { 'cpu.usage': 'CPU %', 'mem.percent': 'Memory %', 'temp.cpu': 'CPU Temp °C', 'fan.rpm': 'Fan RPM', 'power.watts': 'Power W', 'load.avg1': 'Load 1m' };
  const fix = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString());

  function healthRing(score) {
    const col = score >= 80 ? '#10b981' : score >= 60 ? '#eab308' : '#ef4444';
    const circ = 2 * Math.PI * 52;
    const off = circ * (1 - score / 100);
    return `<svg viewBox="0 0 120 120" class="rep-ring">
      <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border-color)" stroke-width="10"/>
      <circle cx="60" cy="60" r="52" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 60 60)"/>
      <text x="60" y="58" text-anchor="middle" class="rep-ring-score" fill="${col}">${score}</text>
      <text x="60" y="76" text-anchor="middle" class="rep-ring-label">/ 100</text>
    </svg>`;
  }

  function sparkline(values, col = '#00d4ff') {
    if (!values.length) return '';
    const max = Math.max(...values), min = Math.min(...values), rng = max - min || 1;
    const w = 120, h = 28;
    const pts = values.map((v, i) => `${(i / (values.length - 1 || 1)) * w},${h - ((v - min) / rng) * h}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" class="rep-spark"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"/></svg>`;
  }

  async function load(host) {
    if (view === 'daily') {
      let data;
      try { data = await api('/reports/daily?days=30'); } catch { return; }
      const days = data.days;
      if (!days.length) {
        $('[data-rep=body]', host).innerHTML = '<p class="sess-empty">No daily summaries yet. Reports build overnight; click Rebuild to generate now.</p>';
        return;
      }
      const latest = days[days.length - 1];
      const health = latest.health || { overall: 0, factors: [] };
      // sparkline series across days per metric
      const series = {};
      for (const m of Object.keys(METRIC_LABEL)) series[m] = days.map((d) => d.metrics?.[m]?.avg).filter((v) => v != null);

      $('[data-rep=body]', host).innerHTML = `
        <div class="rep-health">
          <div class="rep-health-ring">${healthRing(health.overall)}<div class="rep-health-cap">Health · ${esc(latest.day)}${latest.partial ? ' <span class="rep-live">live</span>' : ''}</div></div>
          <div class="rep-health-factors">
            ${(health.factors || []).map((f) => `
              <div class="rep-factor">
                <span class="rep-factor-name">${esc(f.name)}</span>
                <span class="rep-factor-bar"><span style="width:${f.score}%;background:${f.score >= 80 ? '#10b981' : f.score >= 60 ? '#eab308' : '#ef4444'}"></span></span>
                <span class="rep-factor-detail">${esc(f.detail || '')}</span>
              </div>`).join('')}
          </div>
        </div>
        <h4 class="sess-h">Metric trends (30 days, daily avg)</h4>
        <div class="rep-metrics">
          ${Object.entries(METRIC_LABEL).map(([m, label]) => {
            const s = latest.metrics?.[m];
            if (!s) return '';
            return `<div class="rep-metric">
              <div class="rep-metric-head"><b>${esc(label)}</b>${sparkline(series[m])}</div>
              <div class="rep-metric-stats"><span>min ${fix(s.min)}</span><span>avg ${fix(s.avg)}</span><span>max ${fix(s.max)}</span><span>p95 ${fix(s.p95)}</span></div>
            </div>`;
          }).join('')}
        </div>`;
    } else {
      let data;
      try { data = await api(`/reports/${view}`); } catch { return; }
      if (!data.days?.length) { $('[data-rep=body]', host).innerHTML = '<p class="sess-empty">Not enough daily data yet for this view.</p>'; return; }
      $('[data-rep=body]', host).innerHTML = `
        <div class="rep-health">
          <div class="rep-health-ring">${healthRing(data.health?.overall || 0)}<div class="rep-health-cap">Avg health · ${view}</div></div>
          <div class="rep-health-factors">
            ${Object.entries(data.metrics).map(([m, s]) => `
              <div class="rep-factor">
                <span class="rep-factor-name">${esc(METRIC_LABEL[m] || m)}</span>
                <span class="rep-factor-detail">min ${fix(s.min)} · avg ${fix(s.avg)} · max ${fix(s.max)} ${s.trend ? `· trend ${s.trend > 0 ? '▲' : '▼'} ${fix(Math.abs(s.trend))}` : ''}</span>
              </div>`).join('')}
          </div>
        </div>
        <p class="net-hint">Aggregated from ${data.days.length} daily summaries.</p>`;
    }
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('reports', 'Reports')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header">
            <div class="rep-tabs">
              <button class="rep-tab active" data-rep-tab="daily">Daily</button>
              <button class="rep-tab" data-rep-tab="weekly">Weekly</button>
              <button class="rep-tab" data-rep-tab="monthly">Monthly</button>
            </div>
          </div>
          <div class="card-body">
            <div class="rep-actions">
              <button class="net-toggle" data-rep="rebuild">Rebuild now</button>
              <a class="net-toggle keep-case" href="/api/reports/export.csv?days=30" download>Export CSV</a>
              <a class="net-toggle keep-case" href="/api/reports/export.json?days=30" download>Export JSON</a>
              <button class="net-toggle keep-case" data-rep="print">Export PDF (print)</button>
            </div>
            <div data-rep="body"></div>
          </div>
        </div>
      </div>`;
      host.querySelectorAll('[data-rep-tab]').forEach((b) => b.onclick = () => {
        view = b.dataset.repTab;
        host.querySelectorAll('[data-rep-tab]').forEach((x) => x.classList.toggle('active', x === b));
        load(host);
      });
      $('[data-rep=rebuild]', host).onclick = async () => {
        const btn = $('[data-rep=rebuild]', host); btn.textContent = 'Rebuilding…'; btn.disabled = true;
        try { await api('/reports/rebuild', { method: 'POST', body: {} }); toast('success', 'Reports', 'Summaries rebuilt'); load(host); }
        catch (e) { toast('error', 'Reports', e.message); }
        finally { btn.textContent = 'Rebuild now'; btn.disabled = false; }
      };
      $('[data-rep=print]', host).onclick = () => window.print();
      load(host);
    },
    unmount() {},
  };
})();

// ---------------------------------------------------------------------------
// Inventory page — packages / services / containers, searchable & paginated
// ---------------------------------------------------------------------------

pageRenderers.inventory = (() => {
  let kind = 'package', q = '', offset = 0, total = 0;
  let fCategory = '', fPriority = '', fSection = '';
  let facetData = null;
  const LIMIT = 50;
  let searchTimer = null;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtDate = (ts) => ts ? rapisysFmtDate(ts) : '—';
  const fmtSize = (kb) => kb ? (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`) : '';

  function statusBadge(kind, status) {
    let cls = 'inv-badge';
    if (kind === 'container') cls += status === 'running' ? ' inv-ok' : ' inv-off';
    else if (kind === 'service') cls += /active\/running|active\/exited/.test(status) ? ' inv-ok' : /failed/.test(status) ? ' inv-err' : ' inv-off';
    else cls += ' inv-neutral';
    return `<span class="${cls}">${esc(status || '')}</span>`;
  }

  async function loadSummary(host) {
    let s;
    try { s = await api('/inventory/summary'); } catch { return; }
    const c = s.counts || {};
    facetData = s.facets || null;
    renderFilters(host);
    const KIND_ICONS = {
      package: '<path d="M16.5 9.4 7.5 4.21M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/>',
      service: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
      container: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
      cleanup: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
    };
    $('[data-inv=chips]', host).innerHTML = `
      <div class="page-tabs inv-kind-tabs">
        <button class="page-tab ${kind === 'package' ? 'page-tab-active' : ''}" data-inv-kind="package"><svg class="page-tab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${KIND_ICONS.package}</svg>Packages <span class="inv-tab-count">${c.package || 0}</span></button>
        <button class="page-tab ${kind === 'service' ? 'page-tab-active' : ''}" data-inv-kind="service"><svg class="page-tab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${KIND_ICONS.service}</svg>Services <span class="inv-tab-count">${c.service || 0}</span></button>
        <button class="page-tab ${kind === 'container' ? 'page-tab-active' : ''}" data-inv-kind="container"><svg class="page-tab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${KIND_ICONS.container}</svg>Containers <span class="inv-tab-count">${c.container || 0}</span></button>
        <button class="page-tab inv-tab-cleanup ${kind === 'cleanup' ? 'page-tab-active' : ''}" data-inv-kind="cleanup"><svg class="page-tab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${KIND_ICONS.cleanup}</svg>Recommended to Remove</button>
      </div>`;
    host.querySelectorAll('[data-inv-kind]').forEach((b) => b.onclick = () => {
      kind = b.dataset.invKind; offset = 0;
      fCategory = fPriority = fSection = '';
      host.querySelectorAll('[data-inv-kind]').forEach((x) => x.classList.toggle('page-tab-active', x === b));
      // cleanup tab has its own view; hide the search/filter chrome
      const isCleanup = kind === 'cleanup';
      const search = $('[data-inv=search]', host); if (search) search.style.display = isCleanup ? 'none' : '';
      if (isCleanup) { renderFilters(host); loadRecommendations(host); }
      else { renderFilters(host); loadRows(host); }
    });
  }

  async function loadRows(host) {
    let data;
    const params = new URLSearchParams({ kind, q, limit: LIMIT, offset });
    if (fCategory) params.set('category', fCategory);
    if (fPriority) params.set('priority', fPriority);
    if (fSection) params.set('section', fSection);
    try { data = await api(`/inventory?${params}`); } catch { return; }
    total = data.total;
    const rows = data.rows;
    const head = kind === 'package'
      ? '<th>Package</th><th>Description</th><th>Version</th><th>Size</th><th>Installed</th><th>Category</th><th>Priority</th><th>Section</th><th class="inv-actions">Action</th>'
      : kind === 'service'
      ? '<th>Service</th><th>Status</th><th>Description</th><th class="inv-actions">Action</th>'
      : '<th>Container</th><th>Image</th><th>Status</th><th class="inv-actions">Action</th>';

    // Explicit column widths (table-layout:fixed). Description is left to absorb
    // the remaining space ('auto'), the rest are sized to their content so the
    // table fills the container without bloating short columns.
    const cols = kind === 'package'
      ? ['16%', 'auto', '11%', '7%', '8%', '8%', '8%', '9%', '92px']
      : kind === 'service'
      ? ['22%', '12%', 'auto', '92px']
      : ['22%', '28%', 'auto', '92px'];
    const colgroup = `<colgroup>${cols.map((w) => `<col style="width:${w}">`).join('')}</colgroup>`;

    $('[data-inv=table]', host).innerHTML = rows.length ? `
      <div class="up-table-scroll">
      <table class="inv-table inv-table-fixed">
        ${colgroup}
        <thead><tr>${head}</tr></thead>
        <tbody>${rows.map((r) => {
          const trash = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
          const stopIco = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
          if (kind === 'package') {
            const ess = r.meta?.essential || r.meta?.priority === 'required';
            const btn = ess
              ? `<span class="inv-protected" title="Essential/required — protected">protected</span>`
              : `<button class="inv-act inv-act-danger" data-act="pkg-remove" data-name="${esc(r.name)}" title="Uninstall">${trash}</button>`;
            const cap = (v, cls) => v ? `<span class="inv-cap ${cls}">${esc(v)}</span>` : '<span class="inv-dim">—</span>';
            return `<tr><td><b>${esc(r.name)}</b></td><td class="inv-dim inv-desc">${esc(r.meta?.description || '')}</td><td>${esc(r.version)}</td>`
              + `<td class="inv-dim">${fmtSize(r.meta?.sizeKB)}</td><td class="inv-dim">${fmtDate(r.installedAt)}</td>`
              + `<td>${cap(r.category, 'inv-cap-cat')}</td>`
              + `<td>${cap(r.meta?.priority, 'inv-cap-pri')}</td>`
              + `<td>${cap(r.meta?.section, 'inv-cap-sec')}</td>`
              + `<td class="inv-actions">${btn}</td></tr>`;
          }
          if (kind === 'service') {
            const running = /active\/running/.test(r.status);
            const btn = `<button class="inv-act" data-act="svc-toggle" data-name="${esc(r.name)}" data-action="${running ? 'stop' : 'start'}" title="${running ? 'Stop' : 'Start'}">${running ? stopIco : '▶'}</button>`;
            return `<tr><td><b>${esc(r.name)}</b></td><td>${statusBadge('service', r.status)}</td><td class="inv-dim inv-desc">${esc(r.meta?.description || '')}</td><td class="inv-actions">${btn}</td></tr>`;
          }
          const btn = `<button class="inv-act inv-act-danger" data-act="ctr-remove" data-name="${esc(r.name)}" title="Remove container">${trash}</button>`;
          return `<tr><td><b>${esc(r.name)}</b></td><td class="inv-dim">${esc(r.meta?.image || r.source)}</td><td>${statusBadge('container', r.status)}</td><td class="inv-actions">${btn}</td></tr>`;
        }).join('')}</tbody>
      </table></div>` : '<p class="sess-empty">No matches.</p>';

    // action handlers
    host.querySelectorAll('[data-act=pkg-remove]').forEach((b) => b.onclick = () => pkgRemove(host, b.dataset.name, b));
    host.querySelectorAll('[data-act=svc-toggle]').forEach((b) => b.onclick = () => svcToggle(host, b.dataset.name, b.dataset.action));
    host.querySelectorAll('[data-act=ctr-remove]').forEach((b) => b.onclick = () => ctrRemove(host, b.dataset.name));

    const from = total ? offset + 1 : 0, to = Math.min(offset + LIMIT, total);
    const filtering = !!(q || fCategory || fPriority || fSection);
    $('[data-inv=pager]', host).innerHTML = `
      <span class="inv-count">${from}–${to} of ${total}${filtering ? ' <span class="inv-count-filtered">(filtered)</span>' : ''}</span>
      <button class="net-toggle" data-inv=prev ${offset === 0 ? 'disabled' : ''}>Prev</button>
      <button class="net-toggle" data-inv=next ${to >= total ? 'disabled' : ''}>Next</button>`;
    const prev = $('[data-inv=prev]', host), next = $('[data-inv=next]', host);
    if (prev) prev.onclick = () => { offset = Math.max(0, offset - LIMIT); loadRows(host); };
    if (next) next.onclick = () => { offset += LIMIT; loadRows(host); };
  }

  function renderFilters(host) {
    const bar = $('[data-inv=filters]', host);
    if (!bar) return;
    if (kind !== 'package' || !facetData) { bar.innerHTML = ''; return; }

    // Compact, consistent dropdowns for all three facets (enhanceSelects turns
    // them into searchable menus). Active selections appear as removable pills
    // below so what's applied is always visible at a glance.
    const opt = (obj, sel, allLabel) => `<option value="">${allLabel}</option>` +
      Object.entries(obj || {}).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `<option value="${esc(k)}" ${sel === k ? 'selected' : ''}>${esc(k)} (${n})</option>`).join('');

    const active = [];
    if (fCategory) active.push(['category', 'Category', fCategory]);
    if (fPriority) active.push(['priority', 'Priority', fPriority]);
    if (fSection) active.push(['section', 'Section', fSection]);

    bar.innerHTML = `
      <div class="inv-fbar">
        <span class="inv-filter-label">Refine</span>
        <div class="inv-fselects">
          <select class="inv-filter" data-filter="category" aria-label="Category">${opt(facetData.category, fCategory, 'Category')}</select>
          <select class="inv-filter" data-filter="priority" aria-label="Priority">${opt(facetData.priority, fPriority, 'Priority')}</select>
          <select class="inv-filter" data-filter="section" aria-label="Section">${opt(facetData.section, fSection, 'Section')}</select>
        </div>
      </div>
      ${active.length ? `<div class="inv-pills">
        ${active.map(([f, label, val]) => `<span class="inv-pill" data-pill="${f}"><span class="inv-pill-k">${label}:</span> ${esc(val)} <button class="inv-pill-x" data-pill-rm="${f}" title="Remove ${label} filter">✕</button></span>`).join('')}
        <button class="inv-pill-clear" data-filter="clear">Clear all</button>
      </div>` : ''}`;

    const setFacet = (f, v) => {
      if (f === 'category') fCategory = v; else if (f === 'priority') fPriority = v; else fSection = v;
      offset = 0; renderFilters(host); loadRows(host);
    };
    bar.querySelector('[data-filter=category]').onchange = (e) => setFacet('category', e.target.value);
    bar.querySelector('[data-filter=priority]').onchange = (e) => setFacet('priority', e.target.value);
    bar.querySelector('[data-filter=section]').onchange = (e) => setFacet('section', e.target.value);
    bar.querySelectorAll('[data-pill-rm]').forEach((b) => b.onclick = () => setFacet(b.dataset.pillRm, ''));
    const clr = bar.querySelector('[data-filter=clear]');
    if (clr) clr.onclick = () => { fCategory = fPriority = fSection = ''; offset = 0; renderFilters(host); loadRows(host); };
    enhanceSelects(host);
  }

  // Reload whichever view is active after an action.
  function reloadActive(host) {
    loadSummary(host);
    if (kind === 'cleanup') { recData = null; loadRecommendations(host, { refresh: true }); } else loadRows(host);
  }

  const REC_REASON = {
    orphaned: { label: 'Orphaned', cls: 'rec-safe', icon: '🔗' },
    failed: { label: 'Failed', cls: 'rec-review', icon: '✕' },
    inactive: { label: 'Inactive', cls: 'rec-review', icon: '○' },
    stopped: { label: 'Stopped', cls: 'rec-safe', icon: '■' },
    'large-old': { label: 'Large & old', cls: 'rec-review', icon: '◇' },
  };

  let recFilter = 'all';        // 'all' | reason key
  let recSelected = new Set();   // `${kind}:${name}`
  let recData = null;            // last loaded snapshot

  async function loadRecommendations(host, { refresh = false } = {}) {
    const tbl = $('[data-inv=table]', host);
    const pager = $('[data-inv=pager]', host);
    if (pager) pager.innerHTML = '';
    // show an animated indeterminate progress bar while we wait (analysis runs
    // server-side; on first run / re-analyze it can take a few seconds).
    if (tbl && (!recData || refresh)) {
      tbl.innerHTML = `
        <div class="rec-loading">
          <div class="rec-loading-head"><span class="up-spinner"></span><span>${refresh ? 'Re-analyzing installed software…' : 'Analyzing installed software…'}</span></div>
          <div class="rec-progress"><div class="rec-progress-bar"></div></div>
          <p class="up-sec-hint" style="margin-top:8px">Checking for orphaned packages, failed/inactive services and stopped containers.</p>
        </div>`;
    }
    try { recData = await api(`/inventory/recommendations${refresh ? '?refresh=1' : ''}`); }
    catch (e) { if (tbl) tbl.innerHTML = `<p class="sess-empty">Could not analyze: ${esc(e.message)}</p>`; return; }
    recSelected = new Set();   // selection resets on (re)load
    renderRecommendations(host);
  }

  function renderRecommendations(host) {
    const tbl = $('[data-inv=table]', host);
    if (!tbl || !recData) return;
    const all = recData.recommendations || [];
    if (!all.length) {
      tbl.innerHTML = '<p class="sess-empty">Nothing to recommend — no orphaned packages, failed services, or stopped containers found.</p>';
      return;
    }
    // counts per reason for the filter capsules
    const reasonCounts = {};
    all.forEach((r) => { reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1; });
    const REASONS = [
      ['all', 'All', all.length],
      ['orphaned', 'Orphaned', reasonCounts.orphaned || 0],
      ['failed', 'Failed', reasonCounts.failed || 0],
      ['inactive', 'Inactive', reasonCounts.inactive || 0],
      ['stopped', 'Stopped', reasonCounts.stopped || 0],
      ['large-old', 'Large & old', reasonCounts['large-old'] || 0],
    ].filter(([k, , n]) => k === 'all' || n > 0);

    const shown = recFilter === 'all' ? all : all.filter((r) => r.reason === recFilter);

    const stopIco = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
    const trash = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    const actionBtn = (r) => {
      if (r.kind === 'package') return `<button class="inv-act inv-act-danger" data-rec-act="pkg" data-name="${esc(r.name)}" title="Uninstall ${esc(r.name)}">${trash}</button>`;
      if (r.kind === 'service') return `<button class="inv-act" data-rec-act="svc" data-name="${esc(r.name)}" title="Stop ${esc(r.name)}">${stopIco}</button>`;
      return `<button class="inv-act inv-act-danger" data-rec-act="ctr" data-name="${esc(r.name)}" title="Remove container ${esc(r.name)}">${trash}</button>`;
    };

    const age = recData.generatedAt ? `analyzed ${rapisysFmtTime(recData.generatedAt)}` : '';
    const KIND_TITLE = { package: 'Packages', service: 'Services', container: 'Containers' };
    const groups = {};
    shown.forEach((r) => { (groups[r.kind] || (groups[r.kind] = [])).push(r); });

    const sections = Object.entries(groups).map(([k, arr]) => {
      const isPkg = k === 'package';
      const colgroup = isPkg
        ? '<colgroup><col style="width:36px"><col style="width:18%"><col style="width:13%"><col style="width:auto"><col style="width:8%"><col style="width:8%"><col style="width:9%"><col style="width:9%"><col style="width:56px"></colgroup>'
        : '<colgroup><col style="width:36px"><col style="width:22%"><col style="width:14%"><col style="width:auto"><col style="width:56px"></colgroup>';
      const headRow = isPkg
        ? '<th></th><th>Name</th><th>Reason</th><th>Why</th><th>Version</th><th>Size</th><th>Installed</th><th>Category</th><th></th>'
        : '<th></th><th>Name</th><th>Reason</th><th>Why</th><th></th>';
      return `
      <h4 class="sess-h" style="margin-top:18px">${KIND_TITLE[k] || k} <span class="inv-tab-count">${arr.length}</span></h4>
      <div class="up-table-scroll"><table class="inv-table inv-table-fixed">
        ${colgroup}
        <thead><tr>${headRow}</tr></thead>
        <tbody>${arr.map((r) => {
          const meta = REC_REASON[r.reason] || { label: r.reason, cls: 'rec-review' };
          const key = `${r.kind}:${r.name}`;
          const cap = (v, cls) => v ? `<span class="inv-cap ${cls}">${esc(v)}</span>` : '<span class="inv-dim">—</span>';
          const extra = isPkg
            ? `<td>${esc(r.version || '—')}</td>`
              + `<td class="inv-dim">${fmtSize(r.sizeKB || r.meta?.sizeKB)}</td>`
              + `<td class="inv-dim">${fmtDate(r.installedAt)}</td>`
              + `<td>${cap(r.category, 'inv-cap-cat')}</td>`
            : '';
          return `<tr>
            <td><input type="checkbox" class="rec-cb" data-rec-key="${esc(key)}" ${recSelected.has(key) ? 'checked' : ''}></td>
            <td><b>${esc(r.name)}</b></td>
            <td><span class="rec-badge ${meta.cls}">${esc(meta.label)}</span></td>
            <td class="inv-dim inv-desc">${esc(r.detail || '')}</td>
            ${extra}
            <td class="inv-actions">${actionBtn(r)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
    }).join('');

    tbl.innerHTML = `
      <div class="rec-toolbar">
        <div class="rec-filters">
          ${REASONS.map(([k, label, n]) => `<button class="rec-fchip ${recFilter === k ? 'active' : ''}" data-rec-filter="${k}">${label} <b>${n}</b></button>`).join('')}
        </div>
        <div class="rec-bulk">
          <span class="rec-age">${age}</span>
          <button class="net-toggle" data-rec="reanalyze">↻ Re-analyze</button>
          <button class="set-btn set-btn-danger" data-rec="removesel" disabled>Remove selected <span data-rec="selcount">(0)</span></button>
        </div>
      </div>
      <p class="up-sec-hint">Observations, not certainties — RaPiSys can't judge intent. "Orphaned"/"Stopped" are generally safe; "Failed"/"Inactive"/"Large &amp; old" deserve a look. Each removal still confirms and shows the dependency cascade.</p>
      ${sections || '<p class="sess-empty">No items match this filter.</p>'}`;

    // filter capsules
    host.querySelectorAll('[data-rec-filter]').forEach((b) => b.onclick = () => { recFilter = b.dataset.recFilter; renderRecommendations(host); });
    // re-analyze (force fresh)
    const reBtn = $('[data-rec=reanalyze]', host);
    if (reBtn) reBtn.onclick = async () => { reBtn.textContent = 'Analyzing…'; reBtn.disabled = true; recData = null; await loadRecommendations(host, { refresh: true }); };
    // row checkboxes
    const updateSelCount = () => {
      const n = recSelected.size;
      const btn = $('[data-rec=removesel]', host), cnt = $('[data-rec=selcount]', host);
      if (cnt) cnt.textContent = `(${n})`;
      if (btn) btn.disabled = n === 0;
    };
    host.querySelectorAll('.rec-cb').forEach((cb) => cb.onchange = () => {
      if (cb.checked) recSelected.add(cb.dataset.recKey); else recSelected.delete(cb.dataset.recKey);
      updateSelCount();
    });
    updateSelCount();
    // bulk remove
    const rmBtn = $('[data-rec=removesel]', host);
    if (rmBtn) rmBtn.onclick = () => removeSelectedRecs(host);
    // per-row actions
    host.querySelectorAll('[data-rec-act=pkg]').forEach((b) => b.onclick = () => pkgRemove(host, b.dataset.name, b));
    host.querySelectorAll('[data-rec-act=svc]').forEach((b) => b.onclick = () => svcToggle(host, b.dataset.name, 'stop'));
    host.querySelectorAll('[data-rec-act=ctr]').forEach((b) => b.onclick = () => ctrRemove(host, b.dataset.name));
  }

  // Remove all checked items in sequence, with one upfront confirmation.
  async function removeSelectedRecs(host) {
    const keys = [...recSelected];
    if (!keys.length) return;
    const items = keys.map((k) => { const i = k.indexOf(':'); return { kind: k.slice(0, i), name: k.slice(i + 1) }; });
    const byKind = { package: [], service: [], container: [] };
    items.forEach((it) => { (byKind[it.kind] || (byKind[it.kind] = [])).push(it.name); });
    const lines = [];
    if (byKind.package.length) lines.push(`Uninstall ${byKind.package.length} package(s): <span class="inv-cascade">${byKind.package.map(esc).join(', ')}</span>`);
    if (byKind.service.length) lines.push(`Stop ${byKind.service.length} service(s): <span class="inv-cascade">${byKind.service.map(esc).join(', ')}</span>`);
    if (byKind.container.length) lines.push(`Remove ${byKind.container.length} container(s): <span class="inv-cascade">${byKind.container.map(esc).join(', ')}</span>`);
    const ok = await rapisysConfirm(`Remove ${keys.length} selected item(s)?<br><br>${lines.join('<br>')}<br><br>Each is processed in turn; protected items are refused automatically.`,
      { danger: true, confirmLabel: `Remove ${keys.length}`, html: true });
    if (!ok) return;
    const prog = removalOverlay(`Removing ${keys.length} item(s)`);
    let done = 0, failed = 0;
    const failures = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      prog.setStatus(`(${i + 1}/${items.length}) ${it.kind === 'package' ? 'Uninstalling' : it.kind === 'service' ? 'Stopping' : 'Removing'} ${it.name}…`);
      try {
        if (it.kind === 'package') await api('/inventory/package/remove', { method: 'POST', body: { name: it.name, confirm: it.name } });
        else if (it.kind === 'service') await api('/inventory/service/control', { method: 'POST', body: { name: it.name, action: 'stop' } });
        else await api('/inventory/container/remove', { method: 'POST', body: { name: it.name } });
        done++;
      } catch (e) { failed++; failures.push(`${it.name}: ${e.message}`); }
    }
    prog.finish({
      ok: failed === 0,
      message: `${done} removed${failed ? `, ${failed} failed/skipped` : ''}.`,
      detail: failures.length ? `<span class="inv-dim">Skipped/failed:</span><br><span class="inv-cascade">${failures.map(esc).join('<br>')}</span>` : null,
      onClose: () => { loadSummary(host); recData = null; loadRecommendations(host, { refresh: true }); },
    });
  }

  // A progress overlay for removal/stop operations: spinner + animated bar +
  // status, then a clear completion state with what was removed. Returns
  // { setStatus, finish }.
  function removalOverlay(title) {
    const ov = el('div', 'wizard-overlay up-install-overlay');
    ov.innerHTML = `
      <div class="up-install-card" role="dialog" aria-modal="true">
        <div class="up-install-head">
          <div class="up-install-title"><span class="up-spinner" data-rmo="spin"></span><b data-rmo="title">${esc(title)}</b></div>
          <button class="up-install-close" data-rmo="close" hidden title="Close">✕</button>
        </div>
        <div class="up-install-bar"><div class="up-install-bar-fill" data-rmo="bar"></div></div>
        <div class="up-install-status" data-rmo="status">Starting…</div>
        <div class="up-install-result" data-rmo="result" hidden></div>
      </div>`;
    document.body.appendChild(ov);
    const q = (s) => ov.querySelector(`[data-rmo=${s}]`);
    const bar = q('bar'), status = q('status'), result = q('result'), closeBtn = q('close'), spin = q('spin'), titleEl = q('title');
    let pct = 8; bar.style.width = pct + '%';
    const tick = setInterval(() => { pct = Math.min(90, pct + 4); bar.style.width = pct + '%'; }, 350);
    let finished = false;
    const close = () => { if (closeCb) closeCb(); ov.remove(); };
    let closeCb = null;
    closeBtn.onclick = close;
    ov.addEventListener('click', (e) => { if (e.target === ov && finished) close(); });
    return {
      setStatus: (t) => { status.textContent = t; },
      finish: ({ ok, message, detail, onClose }) => {
        clearInterval(tick); finished = true; closeCb = onClose;
        bar.style.width = '100%';
        bar.classList.add(ok ? 'up-install-bar-ok' : 'up-install-bar-err');
        spin.remove();
        titleEl.innerHTML = ok ? '✓ ' + esc(titleEl.textContent) : '✕ ' + esc(titleEl.textContent);
        status.textContent = message || (ok ? 'Done.' : 'Failed.');
        if (detail) { result.hidden = false; result.innerHTML = detail; }
        closeBtn.hidden = false;
        // auto-close success after a short beat so the flow feels snappy
        if (ok) setTimeout(() => { if (document.body.contains(ov)) close(); }, 1400);
      },
    };
  }

  async function pkgRemove(host, name, btn) {
    // Computing the cascade (apt-get -s remove) takes a moment — show a
    // spinner on the button so the click feels responsive, not frozen.
    const original = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.classList.add('inv-act-busy'); btn.innerHTML = '<span class="inv-spinner"></span>'; }
    const restore = () => { if (btn) { btn.disabled = false; btn.classList.remove('inv-act-busy'); btn.innerHTML = original; } };
    // simulate first to show the full cascade
    let sim;
    try { sim = await api('/inventory/package/simulate', { method: 'POST', body: { name } }); }
    catch (e) { toast('error', 'Inventory', e.message); restore(); return; }
    restore();
    if (!sim.allowed) { toast('error', 'Cannot remove', sim.reason || 'protected'); return; }
    const others = (sim.removed || []).filter((p) => p !== name);
    const msg = `Uninstall <b>${esc(name)}</b>?`
      + (others.length ? `<br><br>This will also remove ${others.length} dependent package(s):<br><span class="inv-cascade">${others.map(esc).join(', ')}</span>` : '<br><br>No other packages are affected.');
    if (!await rapisysConfirm(msg, { danger: true, confirmLabel: `Uninstall ${others.length ? `(${others.length + 1})` : ''}`.trim(), html: true })) return;
    // progress overlay during the apt operation (can take many seconds)
    const prog = removalOverlay(`Uninstalling ${name}`);
    prog.setStatus(others.length ? `Removing ${name} and ${others.length} dependent package(s)…` : `Removing ${name}…`);
    try {
      const res = await api('/inventory/package/remove', { method: 'POST', body: { name, confirm: name } });
      const removedList = res?.removed && res.removed.length ? res.removed : [name];
      prog.finish({ ok: true, message: `${removedList.length} package(s) removed.`,
        detail: `<span class="inv-dim">Removed:</span> <span class="inv-cascade">${removedList.map(esc).join(', ')}</span>`,
        onClose: () => reloadActive(host) });
    } catch (e) {
      prog.finish({ ok: false, message: e.message, onClose: () => reloadActive(host) });
    }
  }
  async function svcToggle(host, name, action) {
    if (!await rapisysConfirm(`${action === 'stop' ? 'Stop' : 'Start'} service <b>${esc(name)}</b>?`, { confirmLabel: action === 'stop' ? 'Stop' : 'Start', html: true, danger: action === 'stop' })) return;
    try { await api('/inventory/service/control', { method: 'POST', body: { name, action } }); toast('success', 'Service', `${name} ${action}ed`); setTimeout(() => reloadActive(host), 800); }
    catch (e) { toast('error', 'Service', e.message); }
  }
  async function ctrRemove(host, name) {
    if (!await rapisysConfirm(`Stop and remove container <b>${esc(name)}</b>?`, { danger: true, confirmLabel: 'Remove', html: true })) return;
    try { await api('/inventory/container/remove', { method: 'POST', body: { name } }); toast('success', 'Container', `${name} removed`); reloadActive(host); }
    catch (e) { toast('error', 'Container', e.message); }
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('inventory', 'Inventory')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header">
            <div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/></svg></div>
            <span class="card-title">Software Inventory</span>
            <button class="net-toggle" data-inv="sync" style="margin-left:auto">Re-sync</button>
          </div>
          <div class="card-body">
            <div class="inv-chips" data-inv="chips"></div>
            <input class="inv-search" data-inv="search" placeholder="Search by name or description…" autocomplete="off">
            <div class="inv-filters" data-inv="filters"></div>
            <div data-inv="table"></div>
            <div class="inv-pager" data-inv="pager"></div>
          </div>
        </div>
      </div>`;
      $('[data-inv=search]', host).addEventListener('input', (e) => {
        q = e.target.value.trim(); offset = 0;
        clearTimeout(searchTimer); searchTimer = setTimeout(() => loadRows(host), 250);
      });
      $('[data-inv=sync]', host).onclick = async () => {
        const b = $('[data-inv=sync]', host); b.textContent = 'Syncing…'; b.disabled = true;
        try { await api('/inventory/sync', { method: 'POST', body: {} }); toast('success', 'Inventory', 'Re-synced'); loadSummary(host); loadRows(host); }
        catch (e) { toast('error', 'Inventory', e.message); }
        finally { b.textContent = 'Re-sync'; b.disabled = false; }
      };
      loadSummary(host); loadRows(host);
    },
    unmount() { clearTimeout(searchTimer); },
  };
})();

// ---------------------------------------------------------------------------
// Updates page (F8) — apt + firmware updates with live progress & history
// ---------------------------------------------------------------------------

pageRenderers.updates = (() => {
  let updates = [], firmware = null, selected = new Set(), activeFilter = 'all';
  let streaming = false, expandedLog = null, logCache = {}, editSchedule = false, schedPollHost = null;
  const oldExpanded = new Set();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // inline glyphs (stroke icons matching the app's Lucide-style set)
  const ICN = {
    refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z"/><path d="m9 12 2 2 4-4"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8a2 2 0 0 0-3 0zM12 15l-3-3a22 22 0 0 1 8-10c2 0 4 2 4 4a22 22 0 0 1-10 8zM9 12H4s.5-3 2-4 5 0 5 0M12 15v5s3-.5 4-2 0-5 0-5"/></svg>',
    chip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  };
  // Escape, then color-code CVE ids, security markers, and urgency by severity.
  const hlSec = (s) => esc(s)
    .replace(/(CVE-\d{4}-\d+)/g, '<span class="up-cve">$1</span>')
    .replace(/(trixie-security|-security;)/gi, '<span class="up-sec-mark">$1</span>')
    .replace(/urgency=(\w+)/gi, (m, lvl) => {
      const l = lvl.toLowerCase();
      const cls = (l === 'high' || l === 'critical' || l === 'emergency') ? 'up-urg-high'
        : l === 'medium' ? 'up-urg-medium'
        : l === 'low' ? 'up-urg-low' : 'up-urg-other';
      return `urgency=<span class="${cls}">${esc(lvl)}</span>`;
    });
  // Client-side Debian version compare (mirror of the server's) so the changelog
  // split is consistent: everything NEWER than installed = the new block.
  function cParseVer(v){v=String(v||'').trim();let e=null;const ci=v.indexOf(':');if(ci>=0){e=parseInt(v.slice(0,ci),10)||0;v=v.slice(ci+1);}let up=v,rev='';const di=v.lastIndexOf('-');if(di>=0){up=v.slice(0,di);rev=v.slice(di+1);}return{epoch:e,upstream:up,revision:rev};}
  function cCmpPart(a,b){a=a||'';b=b||'';let i=0,j=0;while(i<a.length||j<b.length){let nd='',md='';while(i<a.length&&!/\d/.test(a[i]))nd+=a[i++];while(j<b.length&&!/\d/.test(b[j]))md+=b[j++];if(nd!==md){for(let k=0;k<Math.max(nd.length,md.length);k++){const ca=nd[k]||'',cb=md[k]||'';if(ca===cb)continue;if(ca==='~')return -1;if(cb==='~')return 1;const oa=ca===''?0:(/[a-zA-Z]/.test(ca)?ca.charCodeAt(0):ca.charCodeAt(0)+256);const ob=cb===''?0:(/[a-zA-Z]/.test(cb)?cb.charCodeAt(0):cb.charCodeAt(0)+256);return oa<ob?-1:1;}}let na='',ma='';while(i<a.length&&/\d/.test(a[i]))na+=a[i++];while(j<b.length&&/\d/.test(b[j]))ma+=b[j++];const ia=parseInt(na||'0',10),ib=parseInt(ma||'0',10);if(ia!==ib)return ia<ib?-1:1;}return 0;}
  function cVercmp(x,y,de){const a=cParseVer(x),b=cParseVer(y);const ea=a.epoch==null?de:a.epoch;const eb=b.epoch==null?de:b.epoch;if(ea!==eb)return ea<eb?-1:1;const u=cCmpPart(a.upstream,b.upstream);if(u)return u;return cCmpPart(a.revision,b.revision);}

  // Split a candidate changelog into the NEW block (entries newer than the
  // installed version) and the OLD block (the rest). Applied to every package.
  function splitChangelog(body, candidateVersion, installedVersion) {
    const ver = candidateVersion;
    const head = ver ? `▼ Changes in ${ver} (new version)` : '';
    if (!installedVersion) return { head, newBlock: body, rest: '', plain: '' };
    const candE = cParseVer(candidateVersion).epoch;
    const instE = cParseVer(installedVersion).epoch;
    const de = (candE != null ? candE : (instE != null ? instE : 0));
    const lines = body.split('\n');
    const re = /^\S+\s+\(([^)]+)\)/;
    const newLines = [], oldLines = [];
    let isNew = true;
    for (const line of lines) {
      const m = line.match(re);
      if (m) isNew = cVercmp(m[1], installedVersion, de) > 0;
      (isNew ? newLines : oldLines).push(line);
    }
    return { head, newBlock: newLines.join('\n').trim(), rest: oldLines.join('\n').trim(), plain: '' };
  }

  const fmtBytes = (b) => {
    if (!b) return '—';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  };
  const urgBadge = (u) => {
    if (!u) return '<span class="inv-dim">—</span>';
    const l = String(u).toLowerCase();
    const cls = (l === 'high' || l === 'critical' || l === 'emergency') ? 'up-urg-high'
      : l === 'medium' ? 'up-urg-medium' : l === 'low' ? 'up-urg-low' : 'up-urg-other';
    return `<span class="up-urg-badge ${cls}">${esc(l)}</span>`;
  };
  const ACTION_BTN = (act, icon, label, cls = '', disabled = false) =>
    `<button class="up-btn ${cls} ${disabled ? 'up-btn-dim' : ''}" data-up="${act}"${disabled ? ' disabled' : ''}>${icon}<span>${label}</span></button>`;

  let lastChecked = null, autoCheck = null;
  async function load(host) {
    let data;
    try { data = await api('/updates'); } catch { return; }
    updates = data.updates || [];
    lastChecked = data.checkedAt || null;
    // pull the auto-check last-run summary so we can show "Auto-checked Xh ago"
    autoCheck = await api('/updates/schedule').then((c) => c.lastRun || null).catch(() => null);
    firmware = await api('/updates/firmware').catch(() => null);
    if (data.available) render(host);   // we have a cached scan (even if 0 updates)
    else {
      // never checked on this install
      $('[data-up=chips]', host).innerHTML = '<span class="up-chip">never checked</span>';
      $('[data-up=actions]', host).innerHTML = ACTION_BTN('refresh', ICN.refresh, 'Check for updates');
      wireActions(host);
      $('[data-up=table]', host).innerHTML = '<p class="sess-empty">Click \u201cCheck for updates\u201d to scan.</p>';
    }
  }

  // Filter the visible rows by the active chip filter.
  function filteredUpdates() {
    if (activeFilter === 'security') return updates.filter((u) => u.security);
    if (activeFilter === 'kernel') return updates.filter((u) => u.kernel);
    if (activeFilter === 'firmware') return [];   // firmware isn't a package row
    return updates;
  }

  function wireFilters(host) {
    host.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.classList.toggle('up-filter-active', btn.dataset.filter === activeFilter);
      btn.onclick = () => {
        activeFilter = btn.dataset.filter;
        render(host);   // re-render reflects active filter + table
      };
    });
  }

  function fmtChecked(ts) {
    if (!ts) return '';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return rapisysFmtDate(ts);
  }

  function render(host) {
    const sec = updates.filter((u) => u.security).length;
    const kern = updates.filter((u) => u.kernel).length;
    const fw = firmware?.updateAvailable;

    // "checked" is fresh (normal colour) if < 24h old, else dimmed/stale.
    const checkedFresh = lastChecked && (Date.now() - lastChecked) < 86400e3;

    $('[data-up=chips]', host).innerHTML = `
      <button class="up-chip up-filter" data-filter="all">All (${updates.length})</button>
      <button class="up-chip up-filter up-chip-sec" data-filter="security">Security (${sec})</button>
      <button class="up-chip up-filter up-chip-kern" data-filter="kernel">Kernel (${kern})</button>
      <button class="up-chip up-filter ${fw ? 'up-chip-fw' : ''}" data-filter="firmware">Firmware ${fw ? `(1)` : '(0)'}</button>
      ${lastChecked ? `<span class="up-checked ${checkedFresh ? 'up-checked-fresh' : 'up-checked-stale'}">Checked ${fmtChecked(lastChecked)}</span>` : ''}
      ${autoCheck ? `<span class="up-checked up-autocheck" title="Last automatic background check: ${autoCheck.checked} updates, ${autoCheck.security} security">Auto-checked ${fmtChecked(autoCheck.ts)}</span>` : ''}`;
    wireFilters(host);

    $('[data-up=actions]', host).innerHTML =
      ACTION_BTN('refresh', ICN.refresh, 'Check for updates')
      + ACTION_BTN('security', ICN.shield, sec ? `Install security updates (${sec})` : 'No security updates', 'up-act-sec', !sec)
      + ACTION_BTN('selected', ICN.download, 'Update selected (0)', 'up-btn-sel', selected.size === 0)
      + ACTION_BTN('full', ICN.rocket, `Full Upgrade (${updates.length})`, 'up-act-danger', !updates.length)
      + ACTION_BTN('firmware', ICN.chip, fw ? 'Update Firmware (1)' : 'Firmware (0)', 'up-act-fw', !fw);
    wireActions(host);

    $('[data-up=table]', host).innerHTML = updates.length ? `
      <p class="up-sec-hint">Security tags (CVEs / urgency) are detected during \u201cCheck for updates\u201d by scanning each changelog directly from the archive \u2014 no full package download.</p>
      <div class="up-table-scroll">
      <table class="inv-table up-table inv-table-fixed">
        <colgroup><col style="width:34px"><col style="width:13%"><col style="width:22%"><col style="width:15%"><col style="width:15%"><col style="width:70px"><col style="width:9%"><col style="width:10%"><col style="width:7%"><col style="width:58px"></colgroup>
        <thead><tr><th><input type="checkbox" data-up="all"></th><th>Package</th><th>Description</th><th>Installed</th><th>Available</th><th>Size</th><th>Last updated</th><th>Tags</th><th>Urgency</th><th>View</th></tr></thead>
        <tbody>${filteredUpdates().map((u) => `
          <tr>
            <td><input type="checkbox" class="up-cb" data-pkg="${esc(u.package)}" ${selected.has(u.package) ? 'checked' : ''}></td>
            <td><b>${esc(u.package)}</b></td>
            <td class="inv-dim inv-desc">${esc(u.description || '')}</td>
            <td class="inv-dim up-ver">${esc(u.installed || '—')}</td>
            <td class="up-new up-ver">${esc(u.candidate)}</td>
            <td class="inv-dim">${u.sizeBytes ? fmtBytes(u.sizeBytes) : '—'}</td>
            <td class="inv-dim">${u.installedAt ? rapisysFmtDate(u.installedAt) : '—'}</td>
            <td class="up-tags-cell"><div class="up-tags-stack">${u.security ? '<span class="up-tag up-tag-sec">security</span>' : ''}${u.cves ? `<span class="up-tag up-tag-cve">${u.cves} CVE${u.cves > 1 ? 's' : ''}</span>` : ''}${u.kernel ? '<span class="up-tag up-tag-kern">kernel</span>' : ''}</div></td>
            <td>${urgBadge(u.urgency)}</td>
            <td><button class="up-link" data-changelog="${esc(u.package)}">view</button></td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<p class="sess-empty">System is up to date. 🎉</p>';
    wireTable(host);
  }

  function wireActions(host) {
    const refresh = $('[data-up=refresh]', host);
    if (refresh) refresh.onclick = () => {
      if (streaming) { toast('info', 'Updates', 'A check is already running'); return; }
      streaming = true;
      refresh.disabled = true; refresh.classList.add('up-btn-busy', 'up-btn-glow');
      refresh.innerHTML = '<span class="up-spinner-sm"></span><span>Checking…</span>';
      const scanStart = Date.now();
      const setProg = (label, done, total) => {
        // Determinate progress with % and ETA when we have counts; the chips
        // row just shows a quiet status (no redundant "working…" pill).
        let pct = 0, eta = '';
        if (total > 0) {
          pct = Math.round((done / total) * 100);
          const elapsed = (Date.now() - scanStart) / 1000;
          if (done > 0) {
            const perItem = elapsed / done;
            const remain = Math.max(0, Math.round(perItem * (total - done)));
            eta = remain >= 60 ? `~${Math.floor(remain / 60)}m ${remain % 60}s left` : `~${remain}s left`;
          }
        }
        $('[data-up=table]', host).innerHTML = total > 0
          ? `<div class="up-scan-status">
               <div class="up-progbar"><span style="width:${pct}%"></span></div>
               <div class="up-prog-meta"><span>${esc(label)}</span><span class="up-prog-pct">${pct}% · ${done}/${total}${eta ? ' · ' + eta : ''}</span></div>
             </div>`
          : `<div class="up-scan-status"><div class="up-scanbar up-scanbar-active"><span></span></div><p class="up-scan-label">${esc(label)}</p></div>`;
      };
      setProg('Running apt-get update…');
      const ev = new EventSource('/api/updates/refresh/stream');
      ev.addEventListener('progress', (e) => {
        const p = JSON.parse(e.data);
        if (p.phase === 'apt-update') setProg('Updating package index…');
        else if (p.phase === 'listing') setProg('Listing upgradable packages…');
        else if (p.phase === 'scanning') setProg(`Scanning ${p.pkg || ''}`.trim(), p.done || 0, p.total || 0);
      });
      ev.addEventListener('done', async (e) => {
        ev.close(); streaming = false; refresh.classList.remove('up-btn-glow');
        let unscanned = []; try { unscanned = JSON.parse(e.data).unscanned || []; } catch { /* */ }
        await load(host);
        toast('success', 'Updates', 'Check complete');
        if (unscanned.length) promptLargeScan(host, unscanned);
      });
      ev.addEventListener('error', (e) => { let m = 'check failed'; try { m = JSON.parse(e.data).message; } catch { /* */ } ev.close(); streaming = false; refresh.classList.remove('up-btn-glow'); toast('error', 'Updates', m); render(host); });
    };
    const sec = $('[data-up=security]', host);
    if (sec) sec.onclick = () => confirmUpgrade(host, { packages: updates.filter((u) => u.security).map((u) => u.package), label: 'security updates' });
    const selBtn = $('[data-up=selected]', host);
    if (selBtn) selBtn.onclick = () => confirmUpgrade(host, { packages: [...selected], label: `${selected.size} selected package(s)` });
    const full = $('[data-up=full]', host);
    if (full) full.onclick = () => confirmFull(host);
    const fw = $('[data-up=firmware]', host);
    if (fw) fw.onclick = () => startFirmware(host);
  }

  function wireTable(host) {
    const all = $('[data-up=all]', host);
    if (all) all.onclick = () => {
      if (all.checked) updates.forEach((u) => selected.add(u.package)); else selected.clear();
      render(host);
    };
    host.querySelectorAll('.up-cb').forEach((cb) => cb.onclick = () => {
      if (cb.checked) selected.add(cb.dataset.pkg); else selected.delete(cb.dataset.pkg);
      const b = $('[data-up=selected]', host);
      if (b) { b.disabled = selected.size === 0; b.classList.toggle('up-btn-dim', selected.size === 0); const sp = b.querySelector('span'); if (sp) sp.textContent = `Update selected (${selected.size})`; }
    });
    host.querySelectorAll('[data-changelog]').forEach((b) => b.onclick = () => showChangelog(host, b.dataset.changelog));
    const b = $('[data-up=selected]', host);
    if (b) { b.disabled = selected.size === 0; b.classList.toggle('up-btn-dim', selected.size === 0); const sp = b.querySelector('span'); if (sp) sp.textContent = `Update selected (${selected.size})`; }
  }

  function promptLargeScan(host, pkgs) {
    const list = pkgs.slice(0, 8).map(esc).join(', ') + (pkgs.length > 8 ? `, +${pkgs.length - 8} more` : '');
    const msg = `<b>${pkgs.length}</b> large package(s) couldn't be scanned for security info from the archive headers and need a full download to check:`
      + `<br><br><span class="up-confirm-list">${list}</span>`
      + `<br><br>Download them now to complete security tagging?`;
    rapisysConfirm(msg, { confirmLabel: `Download ${pkgs.length}`, html: true }).then((ok) => { if (ok) scanLarge(host, pkgs); });
  }

  function scanLarge(host, pkgs) {
    if (streaming) return;
    streaming = true;
    const panel = $('[data-up=progress]', host);
    panel.style.display = 'block';
    panel.className = 'up-progress';
    panel.innerHTML = '<div class="up-progress-head"><b>Scanning large packages…</b><span class="up-spinner"></span></div><div class="up-scanlarge" data-up="sl"></div>';
    const slEl = panel.querySelector('[data-up=sl]');
    const ev = new EventSource(`/api/updates/scan-large/stream?packages=${encodeURIComponent(pkgs.join(','))}`);
    ev.addEventListener('pkg', (e) => { const p = JSON.parse(e.data); slEl.innerHTML = `<div class="up-sl-row"><span>${esc(p.pkg)} (${p.index}/${p.total})</span><span class="up-sl-pct" data-pct>starting…</span></div><div class="up-progbar"><span data-bar style="width:0%"></span></div>`; });
    ev.addEventListener('progress', (e) => { const p = JSON.parse(e.data); const pct = p.pct || 0; const bar = slEl.querySelector('[data-bar]'); const pc = slEl.querySelector('[data-pct]'); if (bar) bar.style.width = pct + '%'; if (pc) pc.textContent = `${pct}% · ${(p.downloaded/1e6).toFixed(1)}/${p.total?(p.total/1e6).toFixed(1):'?'} MB`; });
    ev.addEventListener('tagged', (e) => { const t = JSON.parse(e.data); const u = updates.find((x) => x.package === t.pkg); if (u) { u.security = t.security; u.cves = t.cves; u.urgency = t.urgency; } });
    ev.addEventListener('done', () => { ev.close(); streaming = false; panel.style.display = 'none'; load(host); toast('success', 'Updates', 'Large packages scanned'); });
    ev.addEventListener('error', () => { ev.close(); streaming = false; });
  }

  function downloadFullChangelog(host, pkg) {
    const t0 = Date.now();
    logCache[pkg] = { downloading: true, pct: 0, mb: '0.0', totalMb: '?', elapsed: '0' };
    render(host);
    const ev = new EventSource(`/api/updates/changelog/${encodeURIComponent(pkg)}/full/stream`);
    ev.addEventListener('progress', (e) => {
      const p = JSON.parse(e.data);
      const c = logCache[pkg]; if (!c || !c.downloading) return;
      c.pct = p.pct || 0;
      c.mb = (p.downloaded / 1e6).toFixed(1);
      c.totalMb = p.total ? (p.total / 1e6).toFixed(1) : '?';
      c.elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      if (expandedLog === pkg) render(host);
    });
    ev.addEventListener('done', (e) => {
      ev.close();
      const r = JSON.parse(e.data);
      if (!r.changelog) { logCache[pkg] = { plain: r.error || 'No changelog available.' }; if (expandedLog === pkg) render(host); return; }
      const ver = r.candidateVersion ? decodeURIComponent(r.candidateVersion) : null;
      const body = r.changelog;
      let newBlock = body, rest = '';
      const lines = body.split('\n'); let splitAt = -1, seen = false;
      for (let i = 0; i < lines.length; i++) { if (/^\S.*\([^)]+\)\s/.test(lines[i])) { if (seen) { splitAt = i; break; } seen = true; } }
      if (splitAt > 0) { newBlock = lines.slice(0, splitAt).join('\n'); rest = lines.slice(splitAt).join('\n'); }
      logCache[pkg] = { head: ver ? `▼ Changes in ${ver} (new version)` : '', newBlock, rest, plain: '' };
      if (r.security !== undefined) { const u = updates.find((x) => x.package === pkg); if (u) { u.security = r.security; u.cves = r.cves || 0; u.urgency = r.urgency; } }
      if (expandedLog === pkg) render(host);
    });
    ev.addEventListener('error', () => { ev.close(); logCache[pkg] = { plain: 'Download failed.' }; if (expandedLog === pkg) render(host); });
  }

  // Parse a changelog into version sections (header + body), newest first.
  function parseSections(body) {
    const lines = String(body || '').split('\n');
    const re = /^(\S+)\s+\(([^)]+)\)\s+(\S+);\s*(.*)$/;
    const sections = []; let cur = null;
    for (const line of lines) {
      const m = line.match(re);
      if (m) { cur = { version: m[2], dist: m[3], meta: m[4], lines: [line] }; sections.push(cur); }
      else if (cur) cur.lines.push(line);
      else { cur = { version: '(header)', dist: '', meta: '', lines: [line] }; sections.push(cur); }
    }
    return sections;
  }

  function openChangelogModal(host, pkg, data, installed) {
    // data: { changelog, candidateVersion, needsFull, error }
    const ov = el('div', 'wizard-overlay up-cl-overlay');
    const close = () => ov.remove();
    const expanded = new Set();        // version indices currently expanded
    let activeIdx = null;
    const renderBody = () => {
      if (data.error) return `<p class="up-cl-empty">${esc(data.error)}</p>`;
      if (data.noChangelog) {
        return `<div class="up-cl-needfull">
            <p class="up-cl-empty">No changelog available for this package.</p>
            <button class="up-cl-retry" data-cl="retry">Try again</button>
            <div class="up-cl-dlprog" data-cl="dlprog" style="display:none"></div>
          </div>`;
      }
      if (data.needsFull) {
        return `<div class="up-cl-needfull">
            <p>This package is large, so the new-version changelog isn't cached yet. The notes below are the <b>installed</b> version. Download the new package to see what's changing?</p>
            <button class="up-btn up-act-fw" data-cl="dl">${ICN.download}<span>Download New Changelog</span></button>
            <div class="up-cl-dlprog" data-cl="dlprog" style="display:none"></div>
            <pre class="up-cl-pre">${hlSec(data.changelog || '')}</pre>
          </div>`;
      }
      const candE = parseVerEpoch(data.candidateVersion);
      const instE = parseVerEpoch(installed);
      const de = candE != null ? candE : (instE != null ? instE : 0);
      const sections = parseSections(data.changelog).filter((s) => s.version !== '(header)');
      // newest = first section; expand it by default on first render
      if (activeIdx === null && sections.length) { activeIdx = 0; expanded.add(0); }
      const nav = sections.map((s, i) => {
        const isNewest = i === 0;          // only the candidate's own entry is cyan
        const isActive = i === activeIdx;
        return `<button class="up-cl-navitem ${isNewest ? 'up-cl-nav-new' : ''} ${isActive ? 'up-cl-nav-active' : ''}" data-nav="${i}">${esc(s.version)}${isNewest ? ' <span class="up-cl-newdot">●</span>' : ''}</button>`;
      }).join('');
      const bodyHtml = sections.map((s, i) => {
        const isNew = installed && cVercmp(s.version, installed, de) > 0;
        const isNewest = i === 0;          // the candidate's own entry
        const open = expanded.has(i);
        const headerLine = s.lines[0] || s.version;
        const restLines = s.lines.slice(1).join('\n');
        return `<div class="up-cl-sec ${isNew ? 'up-cl-sec-new' : ''} ${isNewest ? 'up-cl-sec-newest' : ''}" id="sec${i}">
            <button class="up-cl-sechead ${open ? 'open' : ''}" data-sec="${i}">
              <span class="up-cl-caret">${open ? '▾' : '▸'}</span>
              <span class="up-cl-sechdr">${hlSec(headerLine)}</span>
            </button>
            ${open ? `<pre class="up-cl-pre ${isNewest ? 'up-cl-pre-cyan' : ''}">${hlSec(restLines)}</pre>` : ''}
          </div>`;
      }).join('');
      return `<div class="up-cl-layout">
          <div class="up-cl-nav">${nav || '<span class="up-cl-empty">No versions</span>'}</div>
          <div class="up-cl-content" data-cl="content">${bodyHtml}</div>
        </div>`;
    };
    const instTitle = installed ? ` <span class="up-cl-inst">(installed: ${esc(installed)})</span>` : '';
    ov.innerHTML = `<div class="wizard card up-cl-modal">
        <div class="up-cl-head">
          <div><b>${esc(pkg)}</b> <span class="inv-dim">changelog</span>${data.candidateVersion ? ` <span class="up-cl-ver">→ ${esc(decodeURIComponent(data.candidateVersion))}</span>` : ''}${instTitle}</div>
          <button class="up-link" data-cl="close">close ✕</button>
        </div>
        <div class="up-cl-main" data-cl="main">${data.changelog || data.needsFull || data.error ? renderBody() : '<div class="up-log-loading"><span class="up-spinner-sm"></span>Loading changelog…</div>'}</div>
      </div>`;
    document.body.appendChild(ov);
    const wire = () => {
      ov.querySelector('[data-cl=close]').onclick = close;
      // sidebar nav: set active, expand it, scroll to it
      ov.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => {
        const i = Number(b.dataset.nav);
        activeIdx = i; expanded.add(i);
        ov.querySelector('[data-cl=main]').innerHTML = renderBody(); wire();
        const t = ov.querySelector('#sec' + i);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      // section header: toggle expand/collapse
      ov.querySelectorAll('[data-sec]').forEach((b) => b.onclick = () => {
        const i = Number(b.dataset.sec);
        expanded.has(i) ? expanded.delete(i) : expanded.add(i);
        activeIdx = i;
        ov.querySelector('[data-cl=main]').innerHTML = renderBody(); wire();
      });
      const dl = ov.querySelector('[data-cl=dl]');
      if (dl) dl.onclick = () => downloadFullToModal(host, pkg, ov, installed);
      const retry = ov.querySelector('[data-cl=retry]');
      if (retry) retry.onclick = () => downloadFullToModal(host, pkg, ov, installed);
    };
    wire();
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    ov._rerender = (newData) => { Object.assign(data, newData); activeIdx = null; expanded.clear(); ov.querySelector('[data-cl=main]').innerHTML = renderBody(); wire(); };
    return ov;
  }

  function parseVerEpoch(v) { const m = String(v || '').match(/^(\d+):/); return m ? parseInt(m[1], 10) : null; }

  function downloadFullToModal(host, pkg, ov, installed) {
    const prog = ov.querySelector('[data-cl=dlprog]');
    const btn = ov.querySelector('[data-cl=dl]') || ov.querySelector('[data-cl=retry]');
    if (btn) btn.disabled = true;
    if (prog) { prog.style.display = 'block'; prog.innerHTML = '<div class="up-dl-row"><span class="up-spinner-sm"></span><span>Starting…</span></div><div class="up-progbar"><span data-bar style="width:0%"></span></div>'; }
    const t0 = Date.now();
    const ev = new EventSource(`/api/updates/changelog/${encodeURIComponent(pkg)}/full/stream`);
    ev.addEventListener('progress', (e) => {
      const p = JSON.parse(e.data); const pct = p.pct || 0;
      if (prog) { const bar = prog.querySelector('[data-bar]'); if (bar) bar.style.width = pct + '%';
        prog.querySelector('span:last-of-type'); prog.querySelector('.up-dl-row').innerHTML = `<span class="up-spinner-sm"></span><span>${pct}% · ${(p.downloaded/1e6).toFixed(1)}/${p.total?(p.total/1e6).toFixed(1):'?'} MB · ${((Date.now()-t0)/1000).toFixed(0)}s</span>`; }
    });
    ev.addEventListener('done', (e) => {
      ev.close(); const r = JSON.parse(e.data);
      logCache[pkg] = undefined; // invalidate
      const u = updates.find((x) => x.package === pkg);
      if (r.security !== undefined && u) { u.security = r.security; u.cves = r.cves || 0; u.urgency = r.urgency; render(host); }
      if (r.changelog) {
        if (ov._rerender) ov._rerender({ changelog: r.changelog, candidateVersion: r.candidateVersion, needsFull: false, noChangelog: false, error: null });
      } else {
        // still nothing even after the source-package fallback — settle on the
        // "no changelog" state (the backend has now persisted a marker).
        if (ov._rerender) ov._rerender({ changelog: '', needsFull: false, noChangelog: true, error: null });
      }
    });
    ev.addEventListener('error', () => { ev.close(); if (prog) prog.innerHTML = '<span class="up-cl-empty">Download failed.</span>'; if (btn) btn.disabled = false; });
  }

  async function showChangelog(host, pkg) {
    const u = updates.find((x) => x.package === pkg);
    const installed = u ? u.installed : null;
    // open modal immediately with a loading state
    const ov = openChangelogModal(host, pkg, {}, installed);
    try {
      const r = await api(`/updates/changelog/${encodeURIComponent(pkg)}`);
      if (r.security !== undefined && u) { u.security = r.security; u.cves = r.cves || 0; u.urgency = r.urgency; render(host); }
      if (r.none) {
        // we've already downloaded this package and it has no changelog — offer
        // a manual retry (which re-downloads and tries the source package too).
        ov._rerender({ changelog: '', noChangelog: true, error: null });
        return;
      }
      const needsFull = (r.source === 'installed' || r.source === 'none');
      ov._rerender({ changelog: r.changelog || 'No changelog available.', candidateVersion: r.candidateVersion, needsFull, error: null });
    } catch (e) {
      ov._rerender({ error: 'Error: ' + e.message });
    }
  }

  async function confirmFull(host) {
    // typed confirmation for the big hammer
    const ov = el('div', 'wizard-overlay');
    ov.innerHTML = `<div class="wizard card rconfirm">
      <p class="rconfirm-msg">Full system upgrade (<b>apt dist-upgrade</b>) can install, remove, and change many packages at once. Type <b>UPGRADE</b> to confirm.</p>
      <input class="inv-search" data-up="typed" placeholder="Type UPGRADE" autocomplete="off" style="margin-bottom:12px">
      <div class="wz-row"><button class="action-btn rconfirm-danger" data-up="go" disabled>Full upgrade</button><button class="action-btn set-btn-cancel" data-up="cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);
    const typed = ov.querySelector('[data-up=typed]'), go = ov.querySelector('[data-up=go]');
    typed.oninput = () => { go.disabled = typed.value.trim() !== 'UPGRADE'; };
    go.onclick = () => { ov.remove(); startUpgrade(host, { full: true, label: 'full system upgrade' }); };
    ov.querySelector('[data-up=cancel]').onclick = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    setTimeout(() => typed.focus(), 50);
  }

  async function confirmUpgrade(host, { packages, label }) {
    if (!packages || !packages.length) { toast('info', 'Updates', 'Nothing selected'); return; }
    // Show the list and let apt's simulation reveal any extra deps pulled in.
    const preview = packages.slice(0, 20).map(esc).join(', ') + (packages.length > 20 ? `, +${packages.length - 20} more` : '');
    const msg = `Update <b>${packages.length}</b> package(s) — ${esc(label)}?`
      + `<br><br><span class="up-confirm-list">${preview}</span>`
      + `<br><br>apt will also pull in any required dependencies. Output streams live below.`;
    if (!await rapisysConfirm(msg, { confirmLabel: `Update ${packages.length}`, html: true })) return;
    startUpgrade(host, { packages, label });
  }

  function startUpgrade(host, { packages = null, full = false, label }) {
    if (streaming) { toast('info', 'Updates', 'An upgrade is already running'); return; }
    if (!full && (!packages || !packages.length)) return;
    streaming = true;
    const pkgList = full ? [] : (packages || []);
    // Render the install flow as an overlay above the page.
    const ov = el('div', 'wizard-overlay up-install-overlay');
    ov.innerHTML = `
      <div class="up-install-card" role="dialog" aria-modal="true">
        <div class="up-install-head">
          <div class="up-install-title"><span class="up-spinner"></span><b>Installing ${esc(label)}</b></div>
          <button class="up-install-close" data-up="close" hidden title="Close">✕</button>
        </div>
        <div class="up-install-bar"><div class="up-install-bar-fill" data-up="bar"></div></div>
        <div class="up-install-status" data-up="status">Starting…</div>
        <button class="up-install-toggle" data-up="toggle">▸ Show details</button>
        <pre class="up-log up-install-log" data-up="log" hidden></pre>
        <div class="up-install-result" data-up="result" hidden></div>
      </div>`;
    document.body.appendChild(ov);
    const card = ov.querySelector('.up-install-card');
    const logEl = card.querySelector('[data-up=log]');
    const barEl = card.querySelector('[data-up=bar]');
    const statusEl = card.querySelector('[data-up=status]');
    const toggleEl = card.querySelector('[data-up=toggle]');
    const resultEl = card.querySelector('[data-up=result]');
    const closeBtn = card.querySelector('[data-up=close]');
    // click-to-expand the detailed apt log
    toggleEl.onclick = () => {
      const show = logEl.hasAttribute('hidden');
      if (show) { logEl.removeAttribute('hidden'); toggleEl.textContent = '▾ Hide details'; }
      else { logEl.setAttribute('hidden', ''); toggleEl.textContent = '▸ Show details'; }
    };
    // progress is indeterminate from apt, so advance a soft estimate as lines
    // stream in (caps below 90% until 'done' snaps it to 100).
    let pct = 5; barEl.style.width = pct + '%';
    const bump = () => { pct = Math.min(90, pct + 1.5); barEl.style.width = pct + '%'; };

    let finished = false;
    const closeAndRefresh = () => { ov.remove(); load(host); };
    // closing the card (only once finished) refreshes Available Updates so
    // upgraded packages drop off the list.
    closeBtn.onclick = closeAndRefresh;
    ov.addEventListener('click', (e) => { if (e.target === ov && finished) closeAndRefresh(); });

    const qs = full ? 'full=1' : `packages=${encodeURIComponent(pkgList.join(','))}`;
    const ev = new EventSource(`/api/updates/stream?${qs}`);
    ev.addEventListener('line', (e) => {
      const line = JSON.parse(e.data).line;
      logEl.textContent += line + '\n'; logEl.scrollTop = logEl.scrollHeight;
      if (/^(Get:|Fetched|Reading)/.test(line)) statusEl.textContent = 'Downloading packages…';
      else if (/Unpacking/.test(line)) statusEl.textContent = 'Unpacking…';
      else if (/Setting up|Preparing to/.test(line)) statusEl.textContent = 'Installing…';
      else if (/Processing triggers/.test(line)) statusEl.textContent = 'Finishing up…';
      bump();
    });
    ev.addEventListener('done', (e) => {
      const d = JSON.parse(e.data);
      card.querySelector('.up-spinner')?.remove();
      barEl.style.width = '100%';
      barEl.classList.add(d.ok ? 'up-install-bar-ok' : 'up-install-bar-err');
      statusEl.textContent = d.ok ? 'Done' : `Finished with errors (code ${d.code})`;
      resultEl.removeAttribute('hidden');
      resultEl.innerHTML = d.ok
        ? '<span class="up-install-success">✓ Completed successfully</span>'
        : `<span class="up-install-fail">✗ Finished with errors (code ${d.code})</span>`;
      closeBtn.hidden = false; finished = true;
      toast(d.ok ? 'success' : 'error', 'Updates', d.ok ? 'Upgrade complete' : 'Upgrade had errors');
      ev.close(); streaming = false; selected.clear();
    });
    ev.addEventListener('error', (e) => {
      let m = 'stream error'; try { m = JSON.parse(e.data).message; } catch { /* */ }
      logEl.removeAttribute('hidden'); logEl.textContent += `\n✗ ${m}\n`;
      card.querySelector('.up-spinner')?.remove();
      statusEl.textContent = 'Error';
      resultEl.removeAttribute('hidden');
      resultEl.innerHTML = `<span class="up-install-fail">✗ ${esc(m)}</span>`;
      closeBtn.hidden = false; finished = true;
      ev.close(); streaming = false;
    });
  }

  function startFirmware(host) {
    if (streaming) return;
    streaming = true;
    const panel = $('[data-up=progress]', host);
    panel.style.display = 'block';
    panel.className = 'up-progress';
    panel.innerHTML = `<div class="up-progress-head"><b>Updating firmware (rpi-eeprom)</b><span class="up-spinner"></span></div><pre class="up-log" data-up="log"></pre>`;
    const logEl = panel.querySelector('[data-up=log]');
    const ev = new EventSource('/api/updates/firmware/stream');
    ev.addEventListener('line', (e) => { logEl.textContent += JSON.parse(e.data).line + '\n'; logEl.scrollTop = logEl.scrollHeight; });
    ev.addEventListener('done', (e) => { const d = JSON.parse(e.data); logEl.textContent += `\n✓ ${d.note || 'done'}\n`; toast('success', 'Firmware', d.note || 'Staged'); ev.close(); streaming = false; });
    ev.addEventListener('error', () => { logEl.textContent += '\n✗ error\n'; ev.close(); streaming = false; });
  }

  async function loadHistory(host) {
    let h;
    try { h = await api('/updates/history'); } catch { return; }
    const target = $('[data-up=history]', host);
    if (!target) return;
    target.innerHTML = h.history.length ? `
      <div class="up-table-scroll">
      <table class="inv-table"><thead><tr><th>When</th><th>Package</th><th>Description</th><th>Version</th><th>Tags</th><th>Result</th></tr></thead>
      <tbody>${h.history.map((e) => {
        const ver = e.fromV || e.toV
          ? `<span class="inv-dim">${esc(e.fromV || '—')}</span> <span class="up-new">\u2192 ${esc(e.toV || '—')}</span>`
          : '<span class="inv-dim">—</span>';
        // Prefer the real tags captured at upgrade time (stored on the history
        // row). Older rows predating this have null flags — fall back to the
        // best-effort log/name heuristic for those only.
        const tags = [];
        if (e.security != null || e.cves != null || e.kernel != null) {
          if (e.security) tags.push('<span class="up-tag up-tag-sec">Security</span>');
          if (e.cves) tags.push(`<span class="up-tag up-tag-cve">${e.cves} CVE${e.cves > 1 ? 's' : ''}</span>`);
          if (e.kernel) tags.push('<span class="up-tag up-tag-kern">Kernel</span>');
        } else {
          const log = (e.log || '').toLowerCase();
          if (/security|-security/.test(log)) tags.push('<span class="up-tag up-tag-sec">Security</span>');
          if (/cve-\d/.test(log)) tags.push('<span class="up-tag up-tag-cve">CVE</span>');
          if (/linux-image|kernel/.test(log) || /kernel/i.test(e.package)) tags.push('<span class="up-tag up-tag-kern">Kernel</span>');
        }
        return `<tr>
        <td class="inv-dim">${rapisysFmtTime(e.ts)}</td>
        <td><b>${esc(e.package)}</b></td>
        <td class="inv-dim inv-desc">${esc(e.description || '—')}</td>
        <td>${ver}</td>
        <td class="up-tags-cell"><div class="up-tags-stack">${tags.join('') || '<span class="inv-dim">—</span>'}</div></td>
        <td><span class="inv-badge ${e.result === 'success' ? 'inv-ok' : 'inv-err'}">${esc(e.result)}</span></td>
      </tr>`;
      }).join('')}</tbody></table></div>` : '<p class="sess-empty">No update history yet.</p>';
  }

  // Auto-check schedule tab: read config, render a small form, wire save + run.
  async function loadSchedule(host) {
    const target = $('[data-up=schedule]', host);
    if (!target) return;
    let cfg;
    try { cfg = await api('/updates/schedule'); } catch { target.innerHTML = '<p class="sess-empty">Could not load schedule.</p>'; return; }
    // present the stored 24h "HH:MM" as 12h hour/minute/AM-PM
    const to12 = (hhmm) => {
      const [H, M] = String(hhmm || '03:00').split(':').map(Number);
      const ampm = H >= 12 ? 'PM' : 'AM';
      const hour = ((H % 12) || 12);
      return { hour, min: M || 0, ampm };
    };
    const t12 = to12(cfg.time);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const scheduleText = cfg.frequency === 'daily' ? 'Daily'
      : cfg.frequency === 'weekly' ? `Weekly on ${dayNames[cfg.dayOfWeek]}`
      : `Monthly on day ${cfg.dayOfMonth}`;
    const timeText = `${t12.hour}:${String(t12.min).padStart(2, '0')} ${t12.ampm}`;

    // compute the next fire time in the user's local timezone (matches how the
    // server evaluates it: at the chosen hour, on the matching day)
    const nextRunText = (() => {
      const [H, M] = String(cfg.time || '03:00').split(':').map(Number);
      const now = new Date();
      const cand = new Date(now);
      cand.setHours(H, M, 0, 0);
      const bump = () => cand.setDate(cand.getDate() + 1);
      if (cand <= now) bump();
      // advance to the matching weekday / day-of-month
      for (let i = 0; i < 366; i++) {
        if (cfg.frequency === 'daily') break;
        if (cfg.frequency === 'weekly' && cand.getDay() === cfg.dayOfWeek) break;
        if (cfg.frequency === 'monthly' && cand.getDate() === cfg.dayOfMonth) break;
        bump();
      }
      return cand.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    })();

    // run history list
    const history = cfg.runHistory || [];
    const historyHtml = history.length ? `
      <h4 class="sess-h">Run history</h4>
      <div class="up-table-scroll">
      <table class="inv-table"><thead><tr><th>When</th><th>Updates</th><th>Security</th><th>Email</th><th>Telegram</th></tr></thead>
      <tbody>${history.map((h) => `<tr>
        <td class="inv-dim">${rapisysFmtTime(h.ts)}</td>
        <td><b>${h.checked}</b></td>
        <td><b class="${h.security ? 'sched-sec' : ''}">${h.security}</b></td>
        <td>${h.emailed ? '<span class="inv-badge inv-ok">sent</span>' : '<span class="inv-dim">—</span>'}</td>
        <td>${h.telegrammed ? '<span class="inv-badge inv-ok">sent</span>' : '<span class="inv-dim">—</span>'}</td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="sess-empty">No automatic checks have run yet.</p>';

    // VIEW MODE: a schedule is configured and we're not editing → summary + glyphs
    const showForm = editSchedule || !cfg.enabled;
    if (!showForm) {
      const running = cfg._running?.running;
      target.innerHTML = `
        <p class="up-sec-hint">Periodically run a security check in the background and email you new security updates. Uses the SMTP settings from Settings \u2192 Email (SMTP).</p>
        ${running ? `<div class="sched-checking"><span class="up-spinner-sm"></span><span>Checking for updates now…</span></div>` : ''}
        <div class="set-summary sched-summary">
          <div class="sched-sum-main">
            <div class="set-kv"><span>Status</span><b class="set-ok">● Enabled</b></div>
            <div class="set-kv"><span>Schedule</span><b>${scheduleText} at ${timeText}</b></div>
            <div class="set-kv"><span>Next run</span><b class="sched-next">${nextRunText}</b></div>
            <div class="set-kv"><span>Notify via</span><b>${[cfg.emailEnabled ? 'Email' : null, cfg.telegramEnabled ? 'Telegram' : null].filter(Boolean).join(' + ') || 'None'}</b></div>
            <div class="set-kv"><span>Last run</span><b>${cfg.lastRun ? `${fmtChecked(cfg.lastRun.ts)} \u2014 ${cfg.lastRun.security} security of ${cfg.lastRun.checked}` : 'not yet'}</b></div>
          </div>
          <div class="sched-sum-acts">
            <button class="inv-act" data-sch="edit" title="Edit schedule"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="inv-act inv-act-danger" data-sch="disable" title="Disable schedule"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg></button>
          </div>
        </div>
        <div class="set-actions" style="border:none;padding:0;margin:8px 0 18px">
          <button class="set-btn set-btn-test" data-sch="run"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg><span>Run check now</span></button>
          <span data-sch="msg"></span>
        </div>
        ${historyHtml}`;
      // Always poll while viewing the schedule (view mode): show the banner the
      // moment a background check starts, and re-render when it finishes so the
      // run history + last-run update without a manual refresh.
      if (!host._schedPoll) {
        schedPollHost = host;
        let wasRunning = running;
        host._schedPoll = setInterval(async () => {
          try {
            const c = await api('/updates/schedule');
            const now = !!c?._running?.running;
            if (now !== wasRunning) {   // state changed → re-render to reflect it
              wasRunning = now;
              loadSchedule(host);
            }
          } catch { /* keep polling */ }
        }, 4000);
      }
      $('[data-sch=edit]', host).onclick = () => { editSchedule = true; loadSchedule(host); };
      $('[data-sch=disable]', host).onclick = async () => {
        if (!await rapisysConfirm('Disable automatic update checks?', { danger: true, confirmLabel: 'Disable' })) return;
        try { await api('/updates/schedule', { method: 'PUT', body: { enabled: false } }); toast('success', 'Updates', 'Auto-check disabled'); editSchedule = false; loadSchedule(host); }
        catch (err) { toast('error', 'Updates', err.message); }
      };
      wireRunNow(host);
      return;
    }

    // EDIT MODE: show the configuration form
    target.innerHTML = `
      <p class="up-sec-hint">Periodically run a security check in the background and email you the list of new security updates that need patching. Uses the SMTP settings from Settings \u2192 Email (SMTP).</p>
      <div class="wz-form up-sched">
        <label class="wz-inline"><input type="checkbox" data-sch="enabled" ${cfg.enabled ? 'checked' : ''}> Enable automatic update checks</label>

        <div class="sched-row">
          <label>Frequency
            <select data-sch="freq">
              <option value="daily" ${cfg.frequency === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="weekly" ${cfg.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="monthly" ${cfg.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
            </select>
          </label>
          <label data-sch-dow ${cfg.frequency === 'weekly' ? '' : 'hidden'}>Day of week
            <select data-sch="dow">
              ${dayNames.map((d, i) => `<option value="${i}" ${cfg.dayOfWeek === i ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </label>
          <label data-sch-dom ${cfg.frequency === 'monthly' ? '' : 'hidden'}>Day of month
            <select data-sch="dom">
              ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${cfg.dayOfMonth === d ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </label>
          <label>Time
            <span class="sched-time">
              <input type="number" data-sch="hour" min="1" max="12" value="${esc(t12.hour)}" aria-label="Hour">
              <span class="sched-colon">:</span>
              <input type="number" data-sch="min" min="0" max="59" value="${esc(String(t12.min).padStart(2, '0'))}" aria-label="Minute">
              <select data-sch="ampm">
                <option value="AM" ${t12.ampm === 'AM' ? 'selected' : ''}>AM</option>
                <option value="PM" ${t12.ampm === 'PM' ? 'selected' : ''}>PM</option>
              </select>
            </span>
          </label>
        </div>

        <div class="sched-notif">
          <label class="sched-toggle sched-toggle-main">
            <span class="set-switch"><input type="checkbox" data-sch="notify" ${(cfg.emailEnabled || cfg.telegramEnabled) ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
            <svg class="sched-tg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            <span>Enable notifications</span>
          </label>
          <div class="sched-subnotif" data-sch-subnotif ${(cfg.emailEnabled || cfg.telegramEnabled) ? '' : 'hidden'}>
            <label class="sched-toggle">
              <span class="set-switch"><input type="checkbox" data-sch="email" ${cfg.emailEnabled ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
              <svg class="sched-tg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>
              <span>Email</span>
            </label>
            <label class="sched-toggle">
              <span class="set-switch"><input type="checkbox" data-sch="telegram" ${cfg.telegramEnabled ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
              <svg class="sched-tg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
              <span>Telegram</span>
            </label>
            <label class="sched-toggle">
              <span class="set-switch"><input type="checkbox" data-sch="onlysec" ${cfg.onlySecurity ? 'checked' : ''}><span class="set-switch-track"><span class="set-switch-thumb"></span></span></span>
              <svg class="sched-tg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>Security updates only</span>
            </label>
          </div>
        </div>
        <div class="set-actions">
          <button class="set-btn set-btn-primary" data-sch="save"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg><span>Save schedule</span></button>
          ${cfg.enabled ? `<button class="set-btn set-btn-cancel" data-sch="cancel"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg><span>Cancel</span></button>` : ''}
          <button class="set-btn set-btn-test" data-sch="run"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg><span>Run check now</span></button>
          <span data-sch="msg"></span>
        </div>
      </div>`;
    enhanceSelects(host);
    const cancelBtn = $('[data-sch=cancel]', host);
    if (cancelBtn) cancelBtn.onclick = () => { editSchedule = false; loadSchedule(host); };
    // show the day picker that matches the chosen frequency
    const freqSel = $('[data-sch=freq]', host);
    const syncFreq = () => {
      const f = freqSel.value;
      const dow = $('[data-sch-dow]', host), dom = $('[data-sch-dom]', host);
      if (dow) dow.hidden = f !== 'weekly';
      if (dom) dom.hidden = f !== 'monthly';
    };
    freqSel.addEventListener('change', syncFreq); syncFreq();
    // master "Enable notifications" toggle reveals the email/telegram/security sub-toggles
    const notifyMain = $('[data-sch=notify]', host);
    const subNotif = $('[data-sch-subnotif]', host);
    if (notifyMain && subNotif) {
      notifyMain.addEventListener('change', () => {
        subNotif.hidden = !notifyMain.checked;
        if (!notifyMain.checked) {
          // turning the master off disables the channels
          const e = $('[data-sch=email]', host), t = $('[data-sch=telegram]', host);
          if (e) e.checked = false; if (t) t.checked = false;
        }
      });
    }
    const msg = $('[data-sch=msg]', host);
    $('[data-sch=save]', host).onclick = async () => {
      let h = Number($('[data-sch=hour]', host).value) % 12;
      if ($('[data-sch=ampm]', host).value === 'PM') h += 12;
      const mm = Math.max(0, Math.min(59, Number($('[data-sch=min]', host).value) || 0));
      const time24 = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const body = {
        enabled: $('[data-sch=enabled]', host).checked,
        frequency: $('[data-sch=freq]', host).value,
        time: time24,
        dayOfWeek: Number($('[data-sch=dow]', host).value),
        dayOfMonth: Number($('[data-sch=dom]', host).value),
        emailEnabled: $('[data-sch=email]', host).checked,
        telegramEnabled: $('[data-sch=telegram]', host).checked,
        onlySecurity: $('[data-sch=onlysec]', host).checked,
        // minutes to ADD to UTC to get local time (Doha UTC+3 → +180)
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
      };
      const b = $('[data-sch=save]', host); b.disabled = true; msg.textContent = 'Saving…';
      try { await api('/updates/schedule', { method: 'PUT', body }); toast('success', 'Updates', 'Auto-check schedule saved'); editSchedule = false; loadSchedule(host); }
      catch (err) { msg.textContent = `✗ ${err.message}`; b.disabled = false; }
    };
    wireRunNow(host);
  }

  // shared "Run check now" wiring (used by both view and edit modes)
  function wireRunNow(host) {
    const runBtn = $('[data-sch=run]', host);
    if (!runBtn) return;
    const msg = $('[data-sch=msg]', host);
    const original = runBtn.innerHTML;
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      runBtn.classList.add('up-btn-busy', 'up-btn-glow');
      runBtn.innerHTML = '<span class="up-spinner-sm"></span><span>Checking…</span>';
      if (msg) msg.textContent = '';
      try {
        const r = await api('/updates/schedule/run', { method: 'POST', body: {} });
        if (r.skipped) {
          if (msg) msg.textContent = r.skipped === 'disabled' ? '✗ enable the schedule first' : `✗ ${r.skipped}`;
          runBtn.innerHTML = original;
        } else {
          if (msg) msg.textContent = `✓ ${r.security} security of ${r.checked} updates${r.emailed ? ' · emailed' : ''}${r.telegrammed ? ' · telegrammed' : ''}`;
          runBtn.innerHTML = '<span>✓ Done</span>';
          setTimeout(() => loadSchedule(host), 1400);
        }
      } catch (err) {
        if (msg) msg.textContent = `✗ ${err.message}`;
        runBtn.innerHTML = original;
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('up-btn-busy', 'up-btn-glow');
      }
    };
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="page-lead">${pageHeader('updates', 'Software Updates')}</div>
      <div class="rapisys-grid">
        <div class="card sess-span">
          ${pageTabs([{ id: 'available', label: 'Available Updates' }, { id: 'history', label: 'Update History' }, { id: 'schedule', label: 'Auto-Check' }])}
          <div class="card-body" data-pane="available">
            <div class="up-chips" data-up="chips"></div>
            <div class="up-actions" data-up="actions"></div>
            <div class="up-progress" data-up="progress" style="display:none"></div>
            <div data-up="table"></div>
          </div>
          <div class="card-body" data-pane="history" style="display:none">
            <div data-up="history"></div>
          </div>
          <div class="card-body" data-pane="schedule" style="display:none">
            <div data-up="schedule"></div>
          </div>
        </div>
      </div>`;
      wirePageTabs(host, (tab) => {
        // leaving the schedule tab stops its poll
        if (tab !== 'schedule' && host._schedPoll) { clearInterval(host._schedPoll); host._schedPoll = null; }
        if (tab === 'history') loadHistory(host);
        if (tab === 'schedule') loadSchedule(host);
      });
      // Draw the action toolbar immediately so "Check for updates" is always
      // available, even before (or without) a cached upgrade list.
      $('[data-up=chips]', host).innerHTML = '<span class="up-chip up-checking"><span class="up-spinner-sm"></span>checking…</span>';
      $('[data-up=actions]', host).innerHTML = ACTION_BTN('refresh', ICN.refresh, 'Check for updates');
      wireActions(host);
      $('[data-up=table]', host).innerHTML = '<div class="up-scanbar"><span></span></div><p class="sess-empty">Click \u201cCheck for updates\u201d to scan for available updates.</p>';
      load(host);
    },
    unmount() { streaming = false; if (schedPollHost?._schedPoll) { clearInterval(schedPollHost._schedPoll); schedPollHost._schedPoll = null; } },
  };
})();

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

async function maybeShowWizard() {
  let status;
  try { status = await api('/setup/status'); } catch { return; }
  if (status.completed) return;

  // Freeze the animated dashboard underneath: continuous canvas repaints
  // beneath a backdrop-filter make every wizard interaction janky.
  document.body.classList.add('wizard-open');
  const wiz = el('div', 'wizard-overlay');
  wiz.innerHTML = `
    <div class="wizard card">
      <div class="wizard-head">
        <h2><span class="wz-cyan">Ra</span><span class="wz-purple">Pi</span>Sys setup</h2>
        <div class="wizard-steps">
          ${['Welcome', 'Mode', 'Storage', 'Retention', 'Email', 'Done'].map((s, i) =>
            `<span class="wz-step" data-step="${i}">${s}</span>`).join('<span class="wz-sep">›</span>')}
        </div>
      </div>
      <div class="wizard-body"></div>
      <div class="wizard-foot">
        <button class="action-btn" data-wz="back" style="visibility:hidden">Back</button>
        <button class="action-btn wz-primary" data-wz="next">Get started</button>
      </div>
    </div>`;
  document.body.appendChild(wiz);

  const body = $('.wizard-body', wiz);
  const backBtn = $('[data-wz=back]', wiz);
  const nextBtn = $('[data-wz=next]', wiz);
  let step = 0;
  const state = { nas: null, dbDir: '', retention: status.retentionDays || 90,
    mode: 'monitor', adminReady: false };

  const steps = [
    // 0 — Welcome / environment
    {
      render() {
        body.innerHTML = `
          <p class="wz-lead">Let's configure where RaPiSys stores its history, how long to keep it, and how it reaches you.</p>
          <div class="wz-checks">
            <div class="wz-check ${status.agent ? 'ok' : 'warn'}">Host agent ${status.agent ? 'connected' : 'not detected — fan control, NAS mounting and updates need <code>deploy.sh</code> on the Pi'}</div>
            <div class="wz-check ${status.encryption ? 'ok' : 'warn'}">Secret key ${status.encryption ? 'present — credentials will be encrypted at rest' : 'missing — set SECRET_KEY before storing SMTP passwords'}</div>
            <div class="wz-check ok">Database: ${status.storage.engine} (${status.storage.journalMode}) at ${status.storage.path}</div>
          </div>`;
        nextBtn.textContent = 'Get started';
      },
      async next() { return true; },
    },
    // 1 — Operating mode (+ admin registration with MFA for full control)
    {
      async render() {
        // Recover server-side state: a reload mid-wizard must not forget an
        // already-registered admin (the flag lived only in page memory).
        try {
          const me = await api('/auth/me');
          if (me.adminConfigured) { state.adminReady = true; state.mode = 'full'; }
        } catch { /* older server */ }
        body.innerHTML = `
          <p class="wz-lead">How much should this dashboard be able to do?</p>
          <div class="wz-modes">
            <button class="wz-mode ${state.mode === 'monitor' ? 'sel' : ''}" data-mode="monitor">
              <b>Monitor only</b>
              <span>Read-only dashboard, like the original Pi-Dashboard. No fan control, no NAS changes, no updates from the UI. No account needed.</span>
            </button>
            <button class="wz-mode ${state.mode === 'full' ? 'sel' : ''}" data-mode="full">
              <b>Full control</b>
              <span>Fan control, NAS management, software updates and reboot from the UI — protected by a local admin account with two-factor authentication.</span>
            </button>
          </div>
          <div class="wz-admin" data-adm="panel" ${state.mode === 'full' ? '' : 'hidden'}>
            <h4 class="sess-h">Administrator account</h4>
            <div class="wz-form" data-adm="step1" ${state.adminReady ? 'hidden' : ''}>
              <label>Username <input data-adm="user" autocomplete="off" maxlength="32" placeholder="admin"></label>
              <label>Password <input data-adm="pass" type="password" autocomplete="new-password" placeholder="min. 8 characters"></label>
              <label>Confirm password <input data-adm="pass2" type="password" autocomplete="new-password"></label>
              <label class="wz-inline"><input type="checkbox" data-adm="mfa" checked> Protect with two-factor authentication (recommended)</label>
              <div class="wz-row">
                <button class="action-btn" data-adm="create">Create account</button>
                <span data-adm="status1"></span>
              </div>
            </div>
            <div class="wz-form" data-adm="step2" hidden>
              <p class="wz-hint">Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, Apple Passwords…), then enter the 6-digit code it shows. Everything stays on your Pi — no cloud involved.</p>
              <div class="wz-qr"><img data-adm="qr" alt="TOTP QR code"><code data-adm="secret"></code></div>
              <label>Code from the app <input data-adm="code" inputmode="numeric" maxlength="6" placeholder="123456"></label>
              <div class="wz-row">
                <button class="action-btn" data-adm="verify">Verify & activate</button>
                <span data-adm="status2"></span>
              </div>
            </div>
            <p class="wz-status-ok" data-adm="done" ${state.adminReady ? '' : 'hidden'}>✓ Administrator account active — this browser is signed in.</p>
          </div>`;

        body.querySelectorAll('.wz-mode').forEach((btn) => btn.onclick = () => {
          state.mode = btn.dataset.mode;
          body.querySelectorAll('.wz-mode').forEach((x) => x.classList.toggle('sel', x === btn));
          $('[data-adm=panel]', body).hidden = state.mode !== 'full';
        });

        $('[data-adm=create]', body)?.addEventListener('click', async () => {
          const stat = $('[data-adm=status1]', body);
          const pass = $('[data-adm=pass]', body).value;
          if (pass !== $('[data-adm=pass2]', body).value) {
            return setStatus(stat, false, '✗ passwords do not match');
          }
          try {
            const r = await api('/auth/register', { method: 'POST', body: {
              username: $('[data-adm=user]', body).value.trim(), password: pass,
              mfa: $('[data-adm=mfa]', body).checked,
            }});
            $('[data-adm=step1]', body).hidden = true;
            if (r.mfa === false) {
              // MFA declined — account is active and this browser signed in.
              state.adminReady = true;
              $('[data-adm=done]', body).hidden = false;
              refreshAuthBadge();
            } else {
              $('[data-adm=qr]', body).src = r.qrDataUrl;
              $('[data-adm=secret]', body).textContent = r.secret;
              $('[data-adm=step2]', body).hidden = false;
            }
          } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
        });

        $('[data-adm=verify]', body)?.addEventListener('click', async () => {
          const stat = $('[data-adm=status2]', body);
          try {
            await api('/auth/verify-mfa', { method: 'POST', body: { code: $('[data-adm=code]', body).value.trim() } });
            state.adminReady = true;
            $('[data-adm=step2]', body).hidden = true;
            $('[data-adm=done]', body).hidden = false;
            refreshAuthBadge();
          } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
        });

        nextBtn.textContent = 'Continue';
      },
      async next() {
        if (state.mode === 'full' && !state.adminReady) {
          toast('error', 'Setup', 'Create and verify the administrator account first (or choose Monitor only).');
          return false;
        }
        await api('/setup/mode', { method: 'POST', body: { mode: state.mode } });
        return true;
      },
    },
    // 2 — Storage
    {
      render() {
        body.innerHTML = `
          <p class="wz-lead">Where should the metrics database live? Storing it on your NAS protects your SD card from write wear.</p>
          ${status.agent ? `
          <details class="wz-nas" open>
            <summary>Mount a NAS share first (optional)</summary>
            <div class="wz-form">
              <label>Label <input data-nas="label" placeholder="mybook" maxlength="32"></label>
              <label>Protocol <select data-nas="proto"><option value="cifs">SMB/CIFS</option><option value="nfs">NFS</option></select></label>
              <label>Host <input data-nas="host" placeholder="192.168.1.20"></label>
              <label>Share <input data-nas="share" placeholder="rapisys"></label>
              <label data-smb>SMB version <select data-nas="vers">
                <option value="3.0">3.0 (EX2 Ultra & modern NAS)</option>
                <option value="2.1">2.1</option>
                <option value="2.0">2.0</option>
                <option value="1.0">1.0 (My Book World Edition II ⚠️)</option>
              </select></label>
              <label data-nfs style="display:none">NFS version <select data-nas="nfsvers">
                <option value="4.1">4.1 (default)</option>
                <option value="4">4</option>
                <option value="3">3 (older NAS, incl. WD EX2)</option>
                <option value="4.2">4.2</option>
              </select></label>
              <label data-smb>Username <input data-nas="user"></label>
              <label data-smb>Password <input data-nas="pass" type="password"></label>
              <p class="wz-warn" data-smb1 hidden>SMB1 is insecure — only use it on a trusted LAN/VLAN. Required by the WD My Book World Edition II.</p>
              <button class="action-btn" data-nas="mount">Mount share</button>
              <span class="wz-mount-status" data-nas="status"></span>
            </div>
          </details>` : `<p class="wz-warn">Host agent not detected — NAS mounting from here is unavailable. You can still point RaPiSys at any directory already mounted on the Pi (bind-mounted into the container), or keep the local default and relocate later in Settings.</p>`}
          <div class="wz-form">
            <label>Database directory
              <input data-st="dir" placeholder="/mnt/rapisys/mybook  (leave empty for local)" value="">
            </label>
            <p class="wz-hint">On a network share RaPiSys automatically uses a NAS-safe journal mode, and falls back to local storage with a warning if the NAS is offline.</p>
          </div>`;
        const versSel = $('[data-nas=vers]', body);
        versSel?.addEventListener('change', () => {
          $('[data-smb1]', body).hidden = versSel.value !== '1.0';
        });
        $('[data-nas=proto]', body)?.addEventListener('change', (e) => {
          const cifs = e.target.value === 'cifs';
          body.querySelectorAll('[data-smb]').forEach((n) => { n.style.display = cifs ? '' : 'none'; });
          body.querySelectorAll('[data-nfs]').forEach((n) => { n.style.display = cifs ? 'none' : ''; });
        });
        $('[data-nas=mount]', body)?.addEventListener('click', async () => {
          const stat = $('[data-nas=status]', body);
          stat.classList.remove('wz-status-ok', 'wz-status-err');
          stat.textContent = 'Mounting…';
          try {
            const r = await api('/setup/nas/mount', { method: 'POST', body: {
              label: $('[data-nas=label]', body).value.trim() || 'nas',
              proto: $('[data-nas=proto]', body).value,
              host: $('[data-nas=host]', body).value.trim(),
              share: $('[data-nas=share]', body).value.trim(),
              smbVersion: $('[data-nas=vers]', body)?.value,
              nfsVersion: $('[data-nas=nfsvers]', body)?.value,
              username: $('[data-nas=user]', body)?.value,
              password: $('[data-nas=pass]', body)?.value,
            }});
            setStatus(stat, true, `✓ mounted at ${r.mountpoint}`);
            $('[data-st=dir]', body).value = r.mountpoint;
            state.nas = r.mountpoint;
          } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
        });
        nextBtn.textContent = 'Continue';
      },
      busyLabel: 'Relocating database…',
      async next() {
        const dir = $('[data-st=dir]', body).value.trim();
        if (!dir) return true; // keep local default
        const r = await api('/setup/storage', { method: 'POST', body: { dbDir: dir } });
        toast('success', 'Storage', `Database now at ${r.path} (${r.journalMode}${r.degraded ? ', DEGRADED' : ''})`);
        return true;
      },
    },
    // 2 — Retention
    {
      render() {
        body.innerHTML = `
          <p class="wz-lead">How long should RaPiSys keep detailed history? Older data is downsampled in tiers before it is removed.</p>
          <div class="wz-retention">
            ${[7, 30, 90, 180, 365].map((d) =>
              `<button class="action-btn wz-ret ${state.retention === d ? 'sel' : ''}" data-ret="${d}">${d} days</button>`).join('')}
            <label class="wz-custom">Custom <input type="number" min="1" max="3650" data-ret-custom placeholder="days"></label>
          </div>`;
        body.querySelectorAll('[data-ret]').forEach((b) => b.addEventListener('click', () => {
          state.retention = Number(b.dataset.ret);
          body.querySelectorAll('.wz-ret').forEach((x) => x.classList.toggle('sel', x === b));
          $('[data-ret-custom]', body).value = '';
        }));
        $('[data-ret-custom]', body).addEventListener('input', (e) => {
          const v = Number(e.target.value);
          if (v >= 1) { state.retention = v; body.querySelectorAll('.wz-ret').forEach((x) => x.classList.remove('sel')); }
        });
        nextBtn.textContent = 'Continue';
      },
      async next() {
        await api('/setup/retention', { method: 'POST', body: { days: state.retention } });
        return true;
      },
    },
    // 3 — SMTP
    {
      render() {
        body.innerHTML = `
          <p class="wz-lead">Email for alerts (optional — you can skip and configure later).</p>
          <div class="wz-form">
            <label>SMTP host <input data-sm="host" placeholder="smtp-relay.brevo.com"></label>
            <label>Port <input data-sm="port" type="number" value="587"></label>
            <label class="wz-inline"><input type="checkbox" data-sm="secure"> Implicit TLS (port 465)</label>
            <label>Username <input data-sm="user" autocomplete="off"></label>
            <label>Password <input data-sm="pass" type="password" autocomplete="new-password"></label>
            <label>From <input data-sm="from" placeholder="rapisys@yourdomain"></label>
            <label>Alert recipient <input data-sm="to" placeholder="you@example.com"></label>
            <div class="wz-row">
              <button class="action-btn" data-sm="save">Save</button>
              <button class="action-btn" data-sm="test" disabled>Send test email</button>
              <span data-sm="status"></span>
            </div>
            <p class="wz-hint">Free options: <b>Brevo</b> (300/day) or <b>SMTP2GO</b> (1000/mo) — recommended. Gmail works with an App Password (2FA required). Outlook/Microsoft 365 no longer supports password SMTP (retired April 2026).</p>
          </div>`;
        $('[data-sm=save]', body).addEventListener('click', async () => {
          const stat = $('[data-sm=status]', body);
          try {
            await api('/setup/smtp', { method: 'POST', body: {
              host: $('[data-sm=host]', body).value.trim(),
              port: Number($('[data-sm=port]', body).value),
              secure: $('[data-sm=secure]', body).checked,
              user: $('[data-sm=user]', body).value.trim(),
              password: $('[data-sm=pass]', body).value,
              from: $('[data-sm=from]', body).value.trim(),
              to: $('[data-sm=to]', body).value.trim(),
            }});
            setStatus(stat, true, '✓ saved');
            $('[data-sm=test]', body).disabled = false;
          } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
        });
        $('[data-sm=test]', body).addEventListener('click', async () => {
          const stat = $('[data-sm=status]', body);
          stat.classList.remove('wz-status-ok', 'wz-status-err');
          stat.textContent = 'Sending…';
          try {
            await api('/setup/smtp/test', { method: 'POST', body: { to: $('[data-sm=to]', body).value.trim() } });
            setStatus(stat, true, '✓ test email sent');
          } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
        });
        nextBtn.textContent = 'Continue';
      },
      async next() { return true; },
    },
    // 4 — Done
    {
      render() {
        body.innerHTML = `
          <p class="wz-lead">All set. RaPiSys is now recording history in the background — charts fill in as data arrives.</p>
          <p class="wz-hint">Everything here can be changed later from Settings.</p>`;
        nextBtn.textContent = 'Finish';
      },
      async next() {
        await api('/setup/complete', { method: 'POST', body: {} });
        wiz.remove();
        document.body.classList.remove('wizard-open');
        toast('success', 'Welcome to RaPiSys', 'Setup complete');
        return false;
      },
    },
  ];

  async function show(i) {
    step = i;
    wiz.querySelectorAll('.wz-step').forEach((s, idx) => s.classList.toggle('active', idx === step));
    backBtn.style.visibility = step === 0 ? 'hidden' : 'visible';
    await steps[step].render();
    enhanceSelects(body);
  }
  backBtn.addEventListener('click', () => show(Math.max(0, step - 1)));
  nextBtn.addEventListener('click', async () => {
    // Slow steps (DB relocation onto a NAS can take a while over SMB1)
    // need visible progress, or people understandably click again.
    const label = nextBtn.textContent;
    nextBtn.disabled = true;
    nextBtn.classList.add('wz-busy');
    nextBtn.textContent = steps[step].busyLabel || 'Working…';
    try {
      const advance = await steps[step].next();
      if (advance && step < steps.length - 1) show(step + 1);
    } catch (err) {
      toast('error', 'Setup', err.message);
    } finally {
      nextBtn.disabled = false;
      nextBtn.classList.remove('wz-busy');
      if (nextBtn.textContent === (steps[step].busyLabel || 'Working…')) nextBtn.textContent = label;
    }
  });
  show(0);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  buildNav();
  setLayoutToast(toast);
  window.addEventListener('hashchange', route);
  route();
  maybeShowWizard();
  refreshAuthBadge();
});
