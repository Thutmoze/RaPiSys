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

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = localStorage.getItem('adminToken');
  if (token) headers['X-Admin-Token'] = token;
  const res = await fetch(`${API}${path}`, { ...opts, headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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
  updates: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  inventory: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/>',
  alerts: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'sessions', label: 'Sessions', soon: true },
  { id: 'network', label: 'Network', soon: true },
  { id: 'reports', label: 'Reports', soon: true },
  { id: 'updates', label: 'Updates', soon: true },
  { id: 'inventory', label: 'Inventory', soon: true },
  { id: 'alerts', label: 'Alerts', soon: true },
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
            <div class="hw-controls">
              <button class="action-btn" data-fan="auto">Auto</button>
              <input type="range" min="0" max="100" value="50" data-fan="slider" aria-label="Manual fan duty">
              <button class="action-btn" data-fan="apply">Set duty</button>
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
      $('[data-fan=auto]', host).addEventListener('click', () => setFan({ mode: 'auto' }));
      $('[data-fan=apply]', host).addEventListener('click', () =>
        setFan({ dutyPercent: Number($('[data-fan=slider]', host).value) }));

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
// First-run setup wizard
// ---------------------------------------------------------------------------

async function maybeShowWizard() {
  let status;
  try { status = await api('/setup/status'); } catch { return; }
  if (status.completed) return;

  const wiz = el('div', 'wizard-overlay');
  wiz.innerHTML = `
    <div class="wizard card">
      <div class="wizard-head">
        <h2><span class="wz-cyan">Ra</span><span class="wz-purple">Pi</span>Sys setup</h2>
        <div class="wizard-steps">
          ${['Welcome', 'Storage', 'Retention', 'Email', 'Done'].map((s, i) =>
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
  const state = { nas: null, dbDir: '', retention: status.retentionDays || 90 };

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
    // 1 — Storage
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
            stat.textContent = `✓ mounted at ${r.mountpoint}`;
            $('[data-st=dir]', body).value = r.mountpoint;
            state.nas = r.mountpoint;
          } catch (err) { stat.textContent = `✗ ${err.message}`; }
        });
        nextBtn.textContent = 'Continue';
      },
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
            stat.textContent = '✓ saved';
            $('[data-sm=test]', body).disabled = false;
          } catch (err) { stat.textContent = `✗ ${err.message}`; }
        });
        $('[data-sm=test]', body).addEventListener('click', async () => {
          const stat = $('[data-sm=status]', body);
          stat.textContent = 'Sending…';
          try {
            await api('/setup/smtp/test', { method: 'POST', body: { to: $('[data-sm=to]', body).value.trim() } });
            stat.textContent = '✓ test email sent';
          } catch (err) { stat.textContent = `✗ ${err.message}`; }
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
        toast('success', 'Welcome to RaPiSys', 'Setup complete');
        return false;
      },
    },
  ];

  function show(i) {
    step = i;
    wiz.querySelectorAll('.wz-step').forEach((s, idx) => s.classList.toggle('active', idx === step));
    backBtn.style.visibility = step === 0 ? 'hidden' : 'visible';
    steps[step].render();
  }
  backBtn.addEventListener('click', () => show(Math.max(0, step - 1)));
  nextBtn.addEventListener('click', async () => {
    nextBtn.disabled = true;
    try {
      const advance = await steps[step].next();
      if (advance && step < steps.length - 1) show(step + 1);
    } catch (err) {
      toast('error', 'Setup', err.message);
    } finally { nextBtn.disabled = false; }
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
});
