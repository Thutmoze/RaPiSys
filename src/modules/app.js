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
          <button class="action-btn" data-rc="cancel">Cancel</button>
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
    document.body.appendChild(list);

    function renderItems(q = '') {
      items.innerHTML = '';
      const needle = q.trim().toLowerCase();
      [...sel.options].forEach((o, i) => {
        if (needle && !o.text.toLowerCase().includes(needle)) return;
        const item = el('button', 'rsel-item' + (i === sel.selectedIndex ? ' sel' : ''));
        item.type = 'button';
        item.textContent = o.text;
        item.onclick = () => {
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
      list.style.left = `${r.left}px`;
      list.style.width = `${r.width}px`;
      const below = window.innerHeight - r.bottom;
      if (below < 260 && r.top > 260) { list.style.top = ''; list.style.bottom = `${window.innerHeight - r.top + 4}px`; }
      else { list.style.bottom = ''; list.style.top = `${r.bottom + 4}px`; }
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
            <button class="action-btn" data-lg="cancel">Cancel</button>
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
  document.body.appendChild(rail);
  return rail;
}

function route() {
  const id = (window.location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  const page = PAGES.find((p) => p.id === id) ? id : 'overview';
  if (page === activePage) return;
  // teardown
  activeRenderer?.unmount?.();
  activeRenderer = null;
  $('.rapisys-page')?.remove();

  const legacy = $('.container');
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.page === page));

  if (page === 'overview') {
    if (legacy) legacy.style.display = '';
    document.body.classList.remove('rapisys-subpage');
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

  const fmtDur = (ms) => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
  };
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
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
            ? `<button class="action-btn sess-kick" data-kick="${esc(s.meta.sessionId)}" data-who="${esc(s.username)}@${esc(s.source)}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg><span>Disconnect</span></button>`
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
    const tsHtml = !ts.installed
      ? '<p class="sess-empty">Tailscale not detected on this Pi</p>'
      : (ts.peers.length ? ts.peers.map((p) => row4([
          `<span class="sess-dot ${p.online ? 'on' : ''}"></span> <b>${esc(p.username)}</b>`,
          esc(p.source), esc(p.os),
          p.online ? 'active now' : `last seen ${fmtTime(p.lastActive)}`,
        ])).join('') : '<p class="sess-empty">No peers in the tailnet</p>');

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
      const data = await api('/sessions/history?range=7d');
      const el2 = $('[data-sess=hist]', host);
      if (!data.history.length) { el2.innerHTML = '<p class="sess-empty">No login history yet</p>'; return; }
      el2.innerHTML = data.history.slice(0, 30).map((h) => `
        <div class="sess-row">
          <span><b>${esc(h.username)}</b> <span class="sess-kind">${esc(h.kind)}</span></span>
          <span>${esc(h.source || '')}</span>
          <span>${fmtTime(h.started_at)}</span>
          <span>${h.ended_at ? fmtDur(h.ended_at - h.started_at) : '<span class="sess-live">active</span>'}</span>
        </div>`).join('');
    } catch { /* keep last */ }
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header">
            <div class="card-icon cpu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>
            <span class="card-title">Active Sessions</span>
            <span class="sess-counts" data-sess="counts"></span>
          </div>
          <div class="card-body">
            <h4 class="sess-h">SSH</h4><div data-sess="ssh"></div>
            <h4 class="sess-h">Local console</h4><div data-sess="console"></div>
            <h4 class="sess-h">VNC</h4><div data-sess="vnc"></div>
            <h4 class="sess-h">Tailscale</h4><div data-sess="ts"></div>
          </div>
        </div>
        <div class="card sess-span">
          <div class="card-header">
            <div class="card-icon uptime-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
            <span class="card-title">Login History (7 days)</span>
          </div>
          <div class="card-body" data-sess="hist"></div>
        </div>
      </div>`;
      refresh(host); refreshHistory(host);
      timer = setInterval(() => { refresh(host); refreshHistory(host); }, 10000);
    },
    unmount() { clearInterval(timer); },
  };
})();

// ---------------------------------------------------------------------------
// Alerts page
// ---------------------------------------------------------------------------

pageRenderers.alerts = (() => {
  let timer = null;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SEV_CLASS = { info: 'sev-info', warning: 'sev-warning', critical: 'sev-critical' };

  async function refresh(host) {
    let rules, active, history, metrics;
    try {
      [rules, active, history, metrics] = await Promise.all([
        api('/alerts/rules'), api('/alerts/active'), api('/alerts/history?limit=20'), api('/alerts/metrics'),
      ]);
    } catch { return; }

    // active banner
    const banner = $('[data-al=active]', host);
    banner.innerHTML = active.active.length
      ? active.active.map((a) => `<div class="al-banner ${SEV_CLASS[a.severity]}">⚠ <b>${esc(a.name)}</b> — firing since ${new Date(a.since).toLocaleTimeString()}</div>`).join('')
      : '<div class="al-banner al-ok">✓ No active alerts</div>';

    // rules table
    $('[data-al=rules]', host).innerHTML = rules.rules.map((r) => `
      <div class="al-rule ${r.enabled ? '' : 'al-disabled'}">
        <span class="al-sev ${SEV_CLASS[r.severity]}">${esc(r.severity)}</span>
        <span class="al-name"><b>${esc(r.name)}</b><br><small>${esc(r.metric)} ${esc(r.op)} ${r.threshold} for ${r.sustain_s}s · ${(r.channels || []).join('+')}</small></span>
        <span class="al-actions">
          <button class="action-btn al-btn" data-toggle="${r.id}" data-enabled="${r.enabled}">${r.enabled ? 'Disable' : 'Enable'}</button>
          <button class="action-btn al-btn al-del" data-del="${r.id}">Delete</button>
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
          <span>${new Date(h.fired_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${h.resolved_at ? '' : ' · <span class="sess-live">ongoing</span>'}</span>
        </div>`).join('')
      : '<p class="sess-empty">No incidents recorded</p>';

    // wire row buttons
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
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header">
            <div class="card-icon temp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
            <span class="card-title">Alerts</span>
          </div>
          <div class="card-body">
            <div data-al="active"></div>
            <h4 class="sess-h">Rules</h4>
            <div data-al="rules"></div>
            <h4 class="sess-h">Add rule</h4>
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
              <div class="wz-row"><button class="action-btn" data-new="add">Add rule</button><span data-new="status"></span></div>
            </div>
            <p class="hw-hint">Email notifications use the SMTP settings from Setup (Settings → re-run wizard sections coming soon). Rules are evaluated every 30 s.</p>
          </div>
        </div>
        <div class="card sess-span">
          <div class="card-header">
            <div class="card-icon uptime-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg></div>
            <span class="card-title">Incident History</span>
          </div>
          <div class="card-body" data-al="hist"></div>
        </div>
      </div>`;

      $('[data-new=add]', host).onclick = async () => {
        const stat = $('[data-new=status]', host);
        try {
          await api('/alerts/rules', { method: 'POST', body: {
            name: $('[data-new=name]', host).value.trim(),
            metric: $('[data-new=metric]', host).value.trim(),
            op: $('[data-new=op]', host).value,
            threshold: Number($('[data-new=threshold]', host).value),
            sustain_s: Number($('[data-new=sustain]', host).value),
            severity: $('[data-new=severity]', host).value,
            cooldown_s: Number($('[data-new=cooldown]', host).value),
            channels: $('[data-new=email]', host).checked ? ['ui', 'email'] : ['ui'],
          }});
          setStatus(stat, true, '✓ rule added');
          refresh(host);
        } catch (err) { setStatus(stat, false, `✗ ${err.message}`); }
      };

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
      <div class="set-kv"><span>Label</span><b>${esc(nas.label)}</b></div>
      <div class="set-kv"><span>Source</span><b>${esc(nas.proto)}://${esc(nas.host)}/${esc(nas.share)}</b></div>
      <div class="set-kv"><span>Mountpoint</span><b>${esc(nas.mountpoint)}</b></div>
      <div class="set-kv"><span>Status</span><b class="${mounted ? 'set-ok' : 'set-err'}">${mounted ? '● mounted' : '○ not mounted'}</b></div>
      <div class="wz-row set-btn-row">
        <button class="action-btn set-pill" data-set="remount">Remount</button>
        <button class="action-btn set-pill set-pill-danger" data-set="unmount">Unmount</button>
        <span data-set="nasmsg"></span>
      </div>` : `<p class="sess-empty">No NAS share configured. Mount one below to store metrics off the SD card.</p>`;

    // mount form (always available to add/replace)
    $('[data-set=nasform]', host).innerHTML = `
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
        <div class="wz-row"><button class="action-btn" data-nf="mount">Mount &amp; persist</button><span data-nf="msg"></span></div>
      </div>`;
    if (nas?.smbVersion) { const sel = $('[data-nf=smb]', host); if (sel) sel.value = nas.smbVersion; }
    enhanceSelects(host);   // dynamic selects appear after this render

    // ---- storage card ----
    const s = st.storage || {};
    $('[data-set=storage]', host).innerHTML = `
      <div class="set-kv"><span>Database</span><b>${esc(s.path || s.dbPath || '—')}</b></div>
      <div class="set-kv"><span>Filesystem</span><b>${esc(s.fsType || '—')} · ${esc(s.journalMode || '—')} journal</b></div>
      <div class="set-kv"><span>Health</span><b class="${s.degraded ? 'set-err' : 'set-ok'}">${s.degraded ? '○ degraded (local fallback)' : '● healthy'}</b></div>
      <div class="wz-form">
        <label>Database directory <input data-set="dbdir" value="${esc(nas?.mountpoint || (s.path && s.path.startsWith('/mnt/rapisys/') ? s.path.replace(/\/rapisys\.db$/, '') : ''))}" placeholder="/mnt/rapisys/mybook"></label>
        <div class="wz-row"><button class="action-btn" data-set="relocate">Relocate database</button><span data-set="stmsg"></span></div>
      </div>`;

    // ---- meta card ----
    $('[data-set=meta]', host).innerHTML = `
      <div class="set-kv"><span>Operating mode</span><b>${st.mode === 'full' ? 'Full control' : 'Monitor only'}</b></div>
      <div class="set-kv"><span>Retention</span><b>${st.retentionDays} days local · ${st.archiveDays} days archived</b></div>
      <div class="set-kv"><span>Email (SMTP)</span><b class="${st.smtpConfigured ? 'set-ok' : ''}">${st.smtpConfigured ? '● configured' : 'not configured'}</b></div>
      <div class="set-kv"><span>Host agent</span><b class="${st.agent ? 'set-ok' : 'set-err'}">${st.agent ? '● connected' : '○ unavailable'}</b></div>`;

    wire(host, nas);
  }

  function wire(host, nas) {
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
        load(host);
      } catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
    };

    const remount = $('[data-set=remount]', host);
    if (remount) remount.onclick = () => { $('[data-nf=host]', host).scrollIntoView({ behavior: 'smooth' }); toast('info', 'Remount', 'Re-enter the password and click Mount & persist.'); };

    const unmount = $('[data-set=unmount]', host);
    if (unmount) unmount.onclick = async () => {
      if (!await rapisysConfirm(`Unmount ${nas.mountpoint}? If the database lives here it will fall back to local storage.`, { danger: true, confirmLabel: 'Unmount' })) return;
      const msg = $('[data-set=nasmsg]', host);
      setStatus(msg, true, 'Unmounting…');
      try { await api('/setup/nas/unmount', { method: 'POST', body: { mountpoint: nas.mountpoint } }); setStatus(msg, true, '✓ unmounted'); load(host); }
      catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
    };

    const relocate = $('[data-set=relocate]', host);
    if (relocate) relocate.onclick = async () => {
      const msg = $('[data-set=stmsg]', host);
      const dir = $('[data-set=dbdir]', host).value.trim();
      relocate.disabled = true; setStatus(msg, true, 'Relocating database…');
      try { const r = await api('/setup/storage', { method: 'POST', body: { dbDir: dir } });
        setStatus(msg, true, `✓ now on ${r.fsType || 'disk'} (${r.journalMode} journal)`); load(host);
      } catch (err) { setStatus(msg, false, `✗ ${err.message}`); }
      finally { relocate.disabled = false; }
    };
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><line x1="7" y1="7" x2="7" y2="7"/><line x1="7" y1="17" x2="7" y2="17"/></svg></div><span class="card-title">Network Storage (NAS)</span></div>
          <div class="card-body"><div data-set="nas"></div><div data-set="nasform"></div></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div><span class="card-title">Database Storage</span></div>
          <div class="card-body" data-set="storage"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.2 4.2l4.3 4.3M15.5 15.5l4.3 4.3M1 12h6M17 12h6"/></svg></div><span class="card-title">Configuration</span></div>
          <div class="card-body" data-set="meta"></div>
        </div>
      </div>`;
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
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header">
            <div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg></div>
            <span class="card-title">Reports</span>
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
  const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString() : '—';
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
    $('[data-inv=chips]', host).innerHTML = `
      <button class="inv-chip ${kind === 'package' ? 'active' : ''}" data-inv-kind="package">Packages <b>${c.package || 0}</b></button>
      <button class="inv-chip ${kind === 'service' ? 'active' : ''}" data-inv-kind="service">Services <b>${c.service || 0}</b></button>
      <button class="inv-chip ${kind === 'container' ? 'active' : ''}" data-inv-kind="container">Containers <b>${c.container || 0}</b></button>`;
    host.querySelectorAll('[data-inv-kind]').forEach((b) => b.onclick = () => {
      kind = b.dataset.invKind; offset = 0;
      fCategory = fPriority = fSection = '';
      host.querySelectorAll('[data-inv-kind]').forEach((x) => x.classList.toggle('active', x === b));
      renderFilters(host); loadRows(host);
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
      ? '<th>Package</th><th>Description</th><th>Version</th><th>Size</th><th>Installed</th><th class="inv-actions">Action</th>'
      : kind === 'service'
      ? '<th>Service</th><th>Status</th><th>Description</th><th class="inv-actions">Action</th>'
      : '<th>Container</th><th>Image</th><th>Status</th><th class="inv-actions">Action</th>';

    $('[data-inv=table]', host).innerHTML = rows.length ? `
      <table class="inv-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows.map((r) => {
          const trash = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
          const stopIco = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
          if (kind === 'package') {
            const ess = r.meta?.essential || r.meta?.priority === 'required';
            const btn = ess
              ? `<span class="inv-protected" title="Essential/required — protected">protected</span>`
              : `<button class="inv-act inv-act-danger" data-act="pkg-remove" data-name="${esc(r.name)}" title="Uninstall">${trash}</button>`;
            return `<tr><td><b>${esc(r.name)}</b></td><td class="inv-dim inv-desc">${esc(r.meta?.description || '')}</td><td>${esc(r.version)}</td><td class="inv-dim">${fmtSize(r.meta?.sizeKB)}</td><td class="inv-dim">${fmtDate(r.installedAt)}</td><td class="inv-actions">${btn}</td></tr>`;
          }
          if (kind === 'service') {
            const running = /active\/running/.test(r.status);
            const btn = `<button class="inv-act" data-act="svc-toggle" data-name="${esc(r.name)}" data-action="${running ? 'stop' : 'start'}" title="${running ? 'Stop' : 'Start'}">${running ? stopIco : '▶'}</button>`;
            return `<tr><td><b>${esc(r.name)}</b></td><td>${statusBadge('service', r.status)}</td><td class="inv-dim inv-desc">${esc(r.meta?.description || '')}</td><td class="inv-actions">${btn}</td></tr>`;
          }
          const btn = `<button class="inv-act inv-act-danger" data-act="ctr-remove" data-name="${esc(r.name)}" title="Remove container">${trash}</button>`;
          return `<tr><td><b>${esc(r.name)}</b></td><td class="inv-dim">${esc(r.meta?.image || r.source)}</td><td>${statusBadge('container', r.status)}</td><td class="inv-actions">${btn}</td></tr>`;
        }).join('')}</tbody>
      </table>` : '<p class="sess-empty">No matches.</p>';

    // action handlers
    host.querySelectorAll('[data-act=pkg-remove]').forEach((b) => b.onclick = () => pkgRemove(host, b.dataset.name, b));
    host.querySelectorAll('[data-act=svc-toggle]').forEach((b) => b.onclick = () => svcToggle(host, b.dataset.name, b.dataset.action));
    host.querySelectorAll('[data-act=ctr-remove]').forEach((b) => b.onclick = () => ctrRemove(host, b.dataset.name));

    const from = total ? offset + 1 : 0, to = Math.min(offset + LIMIT, total);
    $('[data-inv=pager]', host).innerHTML = `
      <span class="inv-count">${from}–${to} of ${total}</span>
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
    const opt = (obj, sel, allLabel) => `<option value="">${allLabel}</option>` +
      Object.entries(obj || {}).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `<option value="${esc(k)}" ${sel === k ? 'selected' : ''}>${esc(k)} (${n})</option>`).join('');
    bar.innerHTML = `
      <select class="inv-filter" data-filter="category">${opt(facetData.category, fCategory, 'All categories')}</select>
      <select class="inv-filter" data-filter="priority">${opt(facetData.priority, fPriority, 'All priorities')}</select>
      <select class="inv-filter" data-filter="section">${opt(facetData.section, fSection, 'All sections')}</select>
      ${(fCategory || fPriority || fSection) ? '<button class="net-toggle" data-filter="clear">Clear</button>' : ''}`;
    bar.querySelector('[data-filter=category]').onchange = (e) => { fCategory = e.target.value; offset = 0; loadRows(host); };
    bar.querySelector('[data-filter=priority]').onchange = (e) => { fPriority = e.target.value; offset = 0; loadRows(host); };
    bar.querySelector('[data-filter=section]').onchange = (e) => { fSection = e.target.value; offset = 0; loadRows(host); };
    const clr = bar.querySelector('[data-filter=clear]');
    if (clr) clr.onclick = () => { fCategory = fPriority = fSection = ''; offset = 0; renderFilters(host); loadRows(host); };
    enhanceSelects(host);
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
    try {
      await api('/inventory/package/remove', { method: 'POST', body: { name, confirm: name } });
      toast('success', 'Inventory', `${name} removed`);
      loadSummary(host); loadRows(host);
    } catch (e) { toast('error', 'Inventory', e.message); }
  }
  async function svcToggle(host, name, action) {
    if (!await rapisysConfirm(`${action === 'stop' ? 'Stop' : 'Start'} service <b>${esc(name)}</b>?`, { confirmLabel: action === 'stop' ? 'Stop' : 'Start', html: true, danger: action === 'stop' })) return;
    try { await api('/inventory/service/control', { method: 'POST', body: { name, action } }); toast('success', 'Service', `${name} ${action}ed`); setTimeout(() => loadRows(host), 800); }
    catch (e) { toast('error', 'Service', e.message); }
  }
  async function ctrRemove(host, name) {
    if (!await rapisysConfirm(`Stop and remove container <b>${esc(name)}</b>?`, { danger: true, confirmLabel: 'Remove', html: true })) return;
    try { await api('/inventory/container/remove', { method: 'POST', body: { name } }); toast('success', 'Container', `${name} removed`); loadSummary(host); loadRows(host); }
    catch (e) { toast('error', 'Container', e.message); }
  }

  return {
    mount(host) {
      host.innerHTML = `
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
  let updates = [], firmware = null, selected = new Set();
  let streaming = false, expandedLog = null, logCache = {};
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

  const urgBadge = (u) => {
    if (!u) return '<span class="inv-dim">—</span>';
    const l = String(u).toLowerCase();
    const cls = (l === 'high' || l === 'critical' || l === 'emergency') ? 'up-urg-high'
      : l === 'medium' ? 'up-urg-medium' : l === 'low' ? 'up-urg-low' : 'up-urg-other';
    return `<span class="up-urg-badge ${cls}">${esc(l)}</span>`;
  };
  const ACTION_BTN = (act, icon, label, cls = '', disabled = false) =>
    `<button class="up-btn ${cls} ${disabled ? 'up-btn-dim' : ''}" data-up="${act}"${disabled ? ' disabled' : ''}>${icon}<span>${label}</span></button>`;

  let lastChecked = null;
  async function load(host) {
    let data;
    try { data = await api('/updates'); } catch { return; }
    updates = data.updates || [];
    lastChecked = data.checkedAt || null;
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

  function fmtChecked(ts) {
    if (!ts) return '';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function render(host) {
    const sec = updates.filter((u) => u.security).length;
    const kern = updates.filter((u) => u.kernel).length;
    const fw = firmware?.updateAvailable;

    $('[data-up=chips]', host).innerHTML = `
      <span class="up-chip">${updates.length} update${updates.length !== 1 ? 's' : ''}</span>
      ${sec ? `<span class="up-chip up-chip-sec">${sec} security</span>` : ''}
      ${kern ? `<span class="up-chip up-chip-kern">${kern} kernel</span>` : ''}
      <span class="up-chip ${fw ? 'up-chip-fw' : ''}">firmware ${fw ? 'update available' : 'ok'}</span>
      ${lastChecked ? `<span class="up-checked">checked ${fmtChecked(lastChecked)}</span>` : ''}`;

    $('[data-up=actions]', host).innerHTML =
      ACTION_BTN('refresh', ICN.refresh, 'Check for updates')
      + ACTION_BTN('security', ICN.shield, sec ? `Install security updates (${sec})` : 'No security updates', 'up-act-sec', !sec)
      + ACTION_BTN('selected', ICN.download, 'Update selected (0)', 'up-btn-sel', selected.size === 0)
      + ACTION_BTN('full', ICN.rocket, 'Full upgrade…', 'up-act-danger', !updates.length)
      + ACTION_BTN('firmware', ICN.chip, fw ? 'Update firmware' : 'Firmware up to date', 'up-act-fw', !fw);
    wireActions(host);

    $('[data-up=table]', host).innerHTML = updates.length ? `
      <p class="up-sec-hint">Security tags (CVEs / urgency) are detected during \u201cCheck for updates\u201d by scanning each changelog directly from the archive \u2014 no full package download.</p>
      <table class="inv-table up-table">
        <thead><tr><th><input type="checkbox" data-up="all"></th><th>Package</th><th>Description</th><th>Installed</th><th>Available</th><th>Last updated</th><th>Tags</th><th>Urgency</th><th>Changelog</th></tr></thead>
        <tbody>${updates.map((u) => `
          <tr>
            <td><input type="checkbox" class="up-cb" data-pkg="${esc(u.package)}" ${selected.has(u.package) ? 'checked' : ''}></td>
            <td><b>${esc(u.package)}</b></td>
            <td class="inv-dim inv-desc">${esc(u.description || '')}</td>
            <td class="inv-dim">${esc(u.installed || '—')}</td>
            <td class="up-new">${esc(u.candidate)}</td>
            <td class="inv-dim">${u.installedAt ? new Date(u.installedAt).toLocaleDateString() : '—'}</td>
            <td class="up-tags-cell">${u.security ? '<span class="up-tag up-tag-sec">security</span>' : ''}${u.cves ? `<span class="up-tag up-tag-cve">${u.cves} CVE${u.cves > 1 ? 's' : ''}</span>` : ''}${u.kernel ? '<span class="up-tag up-tag-kern">kernel</span>' : ''}</td>
            <td>${urgBadge(u.urgency)}</td>
            <td><button class="up-link" data-changelog="${esc(u.package)}">${expandedLog === u.package ? 'hide' : 'view'}</button></td>
          </tr>
          ${expandedLog === u.package ? `<tr class="up-log-row"><td colspan="9"><div class="up-inline-log">${(() => {
            const c = logCache[u.package];
            if (c === undefined) return '<div class="up-log-loading"><span class="up-spinner-sm"></span>Fetching new version changelog…<div class="up-scanbar up-scanbar-active"><span></span></div></div>';
            if (c.downloading) return `<div class="up-dl-prog"><div class="up-dl-row"><span class="up-spinner-sm"></span><span>Downloading package… ${c.pct || 0}%</span><span class="up-dl-meta">${c.mb || '0.0'} / ${c.totalMb || '?'} MB · ${c.elapsed || '0'}s</span></div><div class="up-scanbar"><span style="width:${c.pct || 0}%;margin-left:0;animation:none;background:var(--accent-cyan)"></span></div></div>`;
            if (c.needsFull) return `<div class="up-needfull"><p>This package is large, so the new-version changelog needs a full download. The notes below are for the <b>installed</b> version.</p><button class="net-toggle up-dl-btn" data-dlfull="${esc(u.package)}">${ICN.download}<span>Download new changelog</span></button><pre class="up-log-text" style="margin-top:10px">${hlSec(c.rest || '')}</pre></div>`;
            if (c.plain) return `<pre class="up-log-text">${hlSec(c.plain)}</pre>`;
            return `${c.head ? `<div class="up-log-head">${esc(c.head)}</div>` : ''}`
              + `${c.newBlock ? `<pre class="up-log-new">${hlSec(c.newBlock)}</pre>` : ''}`
              + `${c.rest ? `<div class="up-log-older"><button class="up-link up-older-toggle" data-older="${esc(u.package)}">${oldExpanded.has(u.package) ? '▾ Hide older versions' : '▸ Show older versions'}</button>${oldExpanded.has(u.package) ? `<pre class="up-log-text">${hlSec(c.rest)}</pre>` : ''}</div>` : ''}`;
          })()}</div></td></tr>` : ''}`).join('')}</tbody>
      </table>` : '<p class="sess-empty">System is up to date. 🎉</p>';
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
    host.querySelectorAll('[data-dlfull]').forEach((b) => b.onclick = () => downloadFullChangelog(host, b.dataset.dlfull));
    host.querySelectorAll('[data-older]').forEach((b) => b.onclick = () => { const p = b.dataset.older; oldExpanded.has(p) ? oldExpanded.delete(p) : oldExpanded.add(p); render(host); });
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

  async function showChangelog(host, pkg) {
    // toggle inline row directly under the clicked package
    if (expandedLog === pkg) { expandedLog = null; oldExpanded.delete(pkg); render(host); return; }
    expandedLog = pkg;
    render(host);
    if (logCache[pkg] === undefined) {
      try {
        const r = await api(`/updates/changelog/${encodeURIComponent(pkg)}`);
        // big package: quick fetch only returned the installed changelog.
        if (r.source === 'installed' || (r.source === 'none')) {
          logCache[pkg] = { needsFull: true, head: '', newBlock: '', rest: r.changelog || '', plain: '' };
          if (expandedLog === pkg) render(host);
          return;
        }
        const ver = r.candidateVersion ? decodeURIComponent(r.candidateVersion) : null;
        const u = updates.find((x) => x.package === pkg);
        const installed = u ? u.installed : null;
        logCache[pkg] = splitChangelog(r.changelog || 'No changelog available.', ver, installed);
        // lazily learned security tag — reflect it in the row immediately
        if (r.security !== undefined) {
          const u = updates.find((x) => x.package === pkg);
          if (u) { u.security = r.security; u.cves = r.cves || 0; u.urgency = r.urgency; }
        }
      }
      catch (e) { logCache[pkg] = { head: '', newBlock: '', rest: '', plain: 'Error: ' + e.message }; }
      if (expandedLog === pkg) render(host);
    }
  }

  async function confirmFull(host) {
    // typed confirmation for the big hammer
    const ov = el('div', 'wizard-overlay');
    ov.innerHTML = `<div class="wizard card rconfirm">
      <p class="rconfirm-msg">Full system upgrade (<b>apt dist-upgrade</b>) can install, remove, and change many packages at once. Type <b>UPGRADE</b> to confirm.</p>
      <input class="inv-search" data-up="typed" placeholder="Type UPGRADE" autocomplete="off" style="margin-bottom:12px">
      <div class="wz-row"><button class="action-btn rconfirm-danger" data-up="go" disabled>Full upgrade</button><button class="action-btn" data-up="cancel">Cancel</button></div>
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
    const panel = $('[data-up=progress]', host);
    panel.style.display = 'block';
    panel.innerHTML = `<div class="up-progress-head"><b>Upgrading: ${esc(label)}</b><span class="up-spinner"></span></div><pre class="up-log" data-up="log"></pre>`;
    const logEl = panel.querySelector('[data-up=log]');
    const qs = full ? 'full=1' : `packages=${encodeURIComponent((packages || []).join(','))}`;
    const ev = new EventSource(`/api/updates/stream?${qs}`);
    ev.addEventListener('line', (e) => { logEl.textContent += JSON.parse(e.data).line + '\n'; logEl.scrollTop = logEl.scrollHeight; });
    ev.addEventListener('done', (e) => {
      const d = JSON.parse(e.data);
      panel.querySelector('.up-spinner')?.remove();
      logEl.textContent += `\n${d.ok ? '✓ Completed successfully' : '✗ Finished with errors (code ' + d.code + ')'}\n`;
      toast(d.ok ? 'success' : 'error', 'Updates', d.ok ? 'Upgrade complete' : 'Upgrade had errors');
      ev.close(); streaming = false; selected.clear(); load(host);
    });
    ev.addEventListener('error', (e) => {
      let m = 'stream error'; try { m = JSON.parse(e.data).message; } catch { /* */ }
      logEl.textContent += `\n✗ ${m}\n`; panel.querySelector('.up-spinner')?.remove();
      ev.close(); streaming = false;
    });
  }

  function startFirmware(host) {
    if (streaming) return;
    streaming = true;
    const panel = $('[data-up=progress]', host);
    panel.style.display = 'block';
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
    $('[data-up=history]', host).innerHTML = h.history.length ? `
      <table class="inv-table"><thead><tr><th>When</th><th>Package</th><th>Result</th></tr></thead>
      <tbody>${h.history.map((e) => `<tr>
        <td class="inv-dim">${new Date(e.ts).toLocaleString()}</td>
        <td><b>${esc(e.package)}</b></td>
        <td><span class="inv-badge ${e.result === 'success' ? 'inv-ok' : 'inv-err'}">${esc(e.result)}</span></td>
      </tr>`).join('')}</tbody></table>` : '<p class="sess-empty">No update history yet.</p>';
  }

  return {
    mount(host) {
      host.innerHTML = `
      <div class="rapisys-grid">
        <div class="card sess-span">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg></div><span class="card-title">Software Updates</span></div>
          <div class="card-body">
            <div class="up-chips" data-up="chips"></div>
            <div class="up-actions" data-up="actions"></div>
            <div class="up-progress" data-up="progress" style="display:none"></div>
            <div data-up="table"></div>
          </div>
        </div>
        <div class="card sess-span">
          <div class="card-header"><div class="card-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0z"/></svg></div><span class="card-title">Update History</span></div>
          <div class="card-body" data-up="history"></div>
        </div>
      </div>`;
      // Draw the action toolbar immediately so "Check for updates" is always
      // available, even before (or without) a cached upgrade list.
      $('[data-up=chips]', host).innerHTML = '<span class="up-chip up-checking"><span class="up-spinner-sm"></span>checking…</span>';
      $('[data-up=actions]', host).innerHTML = ACTION_BTN('refresh', ICN.refresh, 'Check for updates');
      wireActions(host);
      $('[data-up=table]', host).innerHTML = '<div class="up-scanbar"><span></span></div><p class="sess-empty">Click \u201cCheck for updates\u201d to scan for available updates.</p>';
      load(host); loadHistory(host);
    },
    unmount() { streaming = false; },
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
  window.addEventListener('hashchange', route);
  route();
  maybeShowWizard();
  refreshAuthBadge();
});
