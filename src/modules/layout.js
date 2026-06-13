/** RaPiSys — dashboard layout (F6, option 1: true 12-col grid).
 *
 * Model:
 *   - NO saved layout  → pure native dashboard (upstream, untouched, zero risk).
 *   - A saved layout    → rendered with GridStack in LOCKED mode, so what you
 *                         arranged (position AND size) is exactly what shows.
 *   - Edit mode         → the same grid, UNLOCKED for drag/resize, plus chrome.
 *
 * Clipping fix: each widget's content lives in a scroll container
 * (`.gs-body { overflow:auto }`) that fills the grid cell, so a widget smaller
 * than its content scrolls WITHIN itself instead of overflowing the page.
 * Default sizes are measured from real content so widgets open un-clipped.
 */
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { SUMMARY_WIDGETS, buildSummaryCard } from './summary-widgets.js';

export const OVERVIEW_WIDGETS = [
  { id: 'cpu',        sel: '.cpu-card',          title: 'CPU Usage',     group: 'stats',   home: '.stats-grid',    fit: 'scale' },
  { id: 'memory',     sel: '.memory-card',       title: 'Memory',        group: 'stats',   home: '.stats-grid',    fit: 'scale' },
  { id: 'temp',       sel: '.temp-card',         title: 'Temperature',   group: 'stats',   home: '.stats-grid',    fit: 'scale' },
  { id: 'uptime',     sel: '.uptime-card',       title: 'Uptime & Load', group: 'stats',   home: '.stats-grid',    fit: 'scale' },
  { id: 'services',   sel: '.services-section',  title: 'Services',      group: 'section', home: 'main.dashboard', fit: 'scroll' },
  { id: 'containers', sel: '.containers-section',title: 'Containers',    group: 'section', home: 'main.dashboard', fit: 'scroll' },
  { id: 'wireguard',  sel: '.wireguard-section', title: 'WireGuard',     group: 'section', home: 'main.dashboard', fit: 'scroll' },
  { id: 'network',    sel: '.network-section',   title: 'Network',       group: 'section', home: 'main.dashboard', fit: 'scroll' },
  { id: 'processes',  sel: '.processes-section', title: 'Processes',     group: 'section', home: 'main.dashboard', fit: 'scroll' },
  { id: 'disk',       sel: '.disk-section',      title: 'Disk',          group: 'section', home: 'main.dashboard', fit: 'scale' },
  // Summary widgets (compact, opt-in via the editor). Each has a stable id and
  // selector pointing at its parked card; they default to a 3-col stat size.
  // Simple content → scale to fit (no scrollbar).
  ...SUMMARY_WIDGETS.map((s) => ({
    id: s.id, sel: `[data-sw-id="${s.id}"]`, title: s.title, group: 'stats', home: '#sw-parking', summary: true, fit: 'scale',
  })),
];
const WById = Object.fromEntries(OVERVIEW_WIDGETS.map((w) => [w.id, w]));

const CELL = 10, MARGIN = 8, COLS = 12;

let savedLayout = null;
let grid = null;            // active GridStack instance (locked view OR editor)
let editing = false;
let toast = (t, h, m) => console.log(t, h, m);
export function setToast(fn) { if (typeof fn === 'function') toast = fn; }

function findNode(w) {
  // node may be in its home container, inside a grid item, or parked
  return document.querySelector(`[data-rapisys-widget="${w.id}"]`)
    || document.querySelector(w.sel);
}

async function fetchLayout() {
  try {
    const res = await fetch('/api/layouts/overview', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.layout) ? data.layout : null;
  } catch { return null; }
}

// --- grid construction (shared by locked view + editor) --------------------

/** Build a GridStack item wrapping a widget's existing node. */
function makeItem(widget, placement, { editable }) {
  const node = findNode(widget);
  if (!node) return null;
  node.setAttribute('data-rapisys-widget', widget.id);

  const item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.setAttribute('gs-id', widget.id);
  if (placement.x != null) item.setAttribute('gs-x', placement.x);
  if (placement.y != null) item.setAttribute('gs-y', placement.y);
  item.setAttribute('gs-w', placement.w);
  item.setAttribute('gs-h', placement.h);

  const content = document.createElement('div');
  content.className = 'grid-stack-item-content';

  if (editable) {
    const bar = document.createElement('div');
    bar.className = 'gs-edit-bar';
    bar.innerHTML = `<span class="gs-edit-title">${widget.title}</span>
      <span class="gs-size-ctrl">
        <input type="number" class="gs-size-w" min="1" max="12" value="${placement.w}" title="Width (columns)">
        <span class="gs-size-x">×</span>
        <input type="number" class="gs-size-h" min="2" max="60" value="${placement.h}" title="Height (rows)">
      </span>
      <button class="gs-hide-btn" data-hide="${widget.id}" title="Hide widget">✕</button>`;
    content.appendChild(bar);
  }
  const body = document.createElement('div');
  body.className = 'gs-body';
  const fit = widget.fit || 'scale';
  body.dataset.fit = fit;
  const scale = document.createElement('div');
  scale.className = 'gs-scale';
  if (node.parentNode) node.parentNode.removeChild(node);
  scale.appendChild(node);
  body.appendChild(scale);
  content.appendChild(body);
  item.appendChild(content);
  if (fit === 'scale') observeScale(body, scale);
  return item;
}

// Scale each widget's content to fit its cell using a CSS transform, so EVERY
// piece of content (fonts, charts, gauges, spacing) shrinks/grows together —
// the only general way to make arbitrary card internals resize with the widget.
const scaleObservers = new WeakMap();
function observeScale(body, scale) {
  const apply = () => {
    const availW = body.clientWidth;
    const availH = body.clientHeight;
    if (availW <= 0 || availH <= 0) return;
    // 'scale' widgets hold simple content (a gauge, a number, a bar), so we
    // scale to fit BOTH dimensions — no scrollbar, always fully visible.
    scale.style.transform = 'none';
    scale.style.width = `${availW}px`;
    scale.style.height = 'auto';
    const naturalW = Math.max(availW, scale.scrollWidth);
    const naturalH = scale.scrollHeight;
    if (naturalW <= 0 || naturalH <= 0) return;
    const s = Math.min(availW / naturalW, availH / naturalH, 1);  // never upscale
    scale.style.width = `${naturalW}px`;
    scale.style.transform = s < 1 ? `scale(${s})` : 'none';
    scale.style.transformOrigin = 'top center';
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(apply));
  ro.observe(body);
  scaleObservers.set(body, ro);
  requestAnimationFrame(apply);
  setTimeout(apply, 120);
}

/** Measure a widget's natural height in grid rows (for default sizing). */
function measureRows(widget) {
  const node = findNode(widget);
  if (!node) return 6;
  const h = node.getBoundingClientRect().height || 280;
  return Math.max(3, Math.ceil((h + MARGIN) / (CELL + MARGIN)));
}

/** Compute placements: saved layout if present, else sensible defaults. */
function computePlacements() {
  if (savedLayout) {
    const out = [];
    for (const p of savedLayout) {
      const w = WById[p.id];
      if (w && findNode(w) && p.visible !== false) {
        out.push({ widget: w, x: p.x, y: p.y, w: p.w, h: p.h });
      }
    }
    return out;
  }
  // defaults: stat cards 3-wide in a row, sections 12-wide stacked, measured h
  const out = [];
  let y = 0;
  const stats = OVERVIEW_WIDGETS.filter((w) => w.group === 'stats' && findNode(w));
  stats.forEach((w, i) => out.push({ widget: w, x: i * 3, y: 0, w: 3, h: measureRows(w) }));
  y = Math.max(0, ...out.map((o) => o.h)) || 4;
  for (const w of OVERVIEW_WIDGETS.filter((w) => w.group === 'section' && findNode(w))) {
    const h = measureRows(w); out.push({ widget: w, x: 0, y, w: 12, h }); y += h;
  }
  return out;
}

function buildGrid({ editable }) {
  const dashboard = document.querySelector('main.dashboard');
  if (!dashboard) return null;

  const placements = computePlacements();
  const gridEl = document.createElement('div');
  gridEl.className = 'grid-stack rapisys-grid';
  for (const p of placements) {
    const item = makeItem(p.widget, p, { editable });
    if (item) gridEl.appendChild(item);
  }
  // hide native children, mount grid
  [...dashboard.children].forEach((c) => { if (c !== gridEl) c.style.display = 'none'; });
  dashboard.appendChild(gridEl);

  // Widen the container BEFORE GridStack measures, so its column math uses the
  // full available width (not the 1400px reading cap) — otherwise right-edge
  // widgets get laid out past the viewport.
  document.body.classList.add('layout-grid-active');

  const g = GridStack.init({
    column: COLS, cellHeight: CELL, margin: MARGIN,
    float: true,
    staticGrid: !editable,
    disableResize: !editable,
    disableDrag: !editable,
    handle: '.gs-edit-bar',
    // NOTE: no responsive column breakpoints. GridStack's 12→N column remap
    // strips gs-w and collapses items to zero width on load (saved layouts are
    // authored in 12 columns). We keep a fixed 12-col grid; narrow screens just
    // get a denser grid rather than a broken one.
  }, gridEl);

  // GridStack can measure the grid element before the browser has finished
  // laying out the page (fonts/reflow), computing a near-zero cell width →
  // widgets render as thin slivers until a resize event fires. Force a robust
  // recompute after paint: re-assert the column count (which recalculates cell
  // width against the now-settled element width) across a couple of frames and
  // a short timeout as a safety net.
  const recompute = () => {
    try {
      if (gridEl.offsetWidth > 0) {
        g.onParentResize?.();
        g.cellHeight(CELL);          // re-assert sizing → triggers relayout
      }
    } catch { /* */ }
  };
  requestAnimationFrame(() => requestAnimationFrame(recompute));
  setTimeout(recompute, 80);
  setTimeout(recompute, 300);
  // Also recompute the first time the grid element actually gains width (e.g.
  // it was built while hidden/0-width during page activation). Disconnect once
  // a real width is seen so we don't keep firing.
  let lastW = 0;
  const widthRO = new ResizeObserver(() => {
    const w = gridEl.offsetWidth;
    if (w > 0 && Math.abs(w - lastW) > 4) { lastW = w; recompute(); }
  });
  widthRO.observe(gridEl);
  g._widthRO = widthRO;
  return g;
}

/** Restore all widget nodes to their home containers and remove the grid. */
function teardownGrid() {
  try { grid?._widthRO?.disconnect(); } catch { /* */ }
  const grids = document.querySelectorAll('.grid-stack.rapisys-grid');
  // disconnect scale observers
  grids.forEach((g) => g.querySelectorAll('.gs-body').forEach((b) => {
    const ro = scaleObservers.get(b); if (ro) { ro.disconnect(); scaleObservers.delete(b); }
  }));
  document.querySelectorAll('[data-rapisys-widget]').forEach((node) => {
    const id = node.getAttribute('data-rapisys-widget');
    const widget = WById[id];
    const home = widget ? document.querySelector(widget.home) : null;
    // clear any inline styles applied while gridded
    node.style.removeProperty('transform');
    node.style.removeProperty('width');
    node.style.removeProperty('height');
    if (home) home.appendChild(node);
  });
  grids.forEach((g) => g.remove());
  document.body.classList.remove('layout-grid-active');
  const dashboard = document.querySelector('main.dashboard');
  if (dashboard) [...dashboard.children].forEach((c) => { c.style.removeProperty('display'); });
}

// --- public entry ----------------------------------------------------------

let summaryBuilt = false;
function ensureSummaryCards() {
  if (summaryBuilt) return;
  let park = document.getElementById('sw-parking');
  if (!park) { park = document.createElement('div'); park.id = 'sw-parking'; park.style.display = 'none'; document.body.appendChild(park); }
  for (const def of SUMMARY_WIDGETS) {
    if (park.querySelector(`[data-sw-id="${def.id}"]`)) continue;
    park.appendChild(buildSummaryCard(def));
  }
  summaryBuilt = true;
}

let rendered = false;
export async function initOverviewLayout() {
  ensureSummaryCards();
  // Only the authenticated admin sees the custom layout + edit button. Everyone
  // else (no login) gets the original Pi-Dashboard view untouched.
  let isAdmin = false;
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    isAdmin = !!me.authenticated && me.mode !== 'monitor';
  } catch { isAdmin = false; }

  if (!isAdmin) return;        // native view, no edit affordance, no saved layout

  ensureEditButton();
  if (rendered) return;
  savedLayout = await fetchLayout();
  if (savedLayout) {
    grid = buildGrid({ editable: false });   // locked view of the saved layout
  }
  rendered = true;
}

// --- edit mode -------------------------------------------------------------

function ensureEditButton() {
  if (document.getElementById('layout-edit-btn')) return;
  const actions = document.querySelector('header .header-actions');
  if (!actions) return;
  const btn = document.createElement('button');
  btn.className = 'action-btn';
  btn.id = 'layout-edit-btn';
  btn.title = 'Edit dashboard layout';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/>
      <rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`;
  btn.addEventListener('click', () => { if (!editing) enterEditMode(); });
  actions.insertBefore(btn, actions.firstChild);
}

async function enterEditMode() {
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    if (me.mode === 'monitor') { toast('info', 'Monitor-only mode', 'Layout editing is disabled.'); return; }
    if (!me.authenticated) { toast('info', 'Sign in required', 'Sign in as admin to edit the layout.'); return; }
  } catch { /* save will reject if truly unauthorized */ }

  editing = true;
  document.body.classList.add('layout-editing');
  // tear down any locked view, rebuild as editable
  if (grid) { teardownGrid(); grid = null; }
  grid = buildGrid({ editable: true });
  buildEditToolbar();
  wireHideButtons();
  wireSizeInputs();
  // keep the W×H inputs in sync when the user drags-resizes
  grid.on('change', (e, nodes) => {
    for (const n of nodes || []) {
      const el = n.el;
      const wi = el.querySelector('.gs-size-w'); const hi = el.querySelector('.gs-size-h');
      if (wi) wi.value = n.w; if (hi) hi.value = n.h;
    }
  });
}

function wireSizeInputs() {
  document.querySelectorAll('.gs-size-ctrl').forEach((ctrl) => {
    const item = ctrl.closest('.grid-stack-item');
    const wi = ctrl.querySelector('.gs-size-w');
    const hi = ctrl.querySelector('.gs-size-h');
    const apply = () => {
      const w = Math.min(12, Math.max(1, Number(wi.value) || 1));
      const h = Math.min(60, Math.max(2, Number(hi.value) || 2));
      if (grid && item) grid.update(item, { w, h });
    };
    wi.onchange = apply; hi.onchange = apply;
    // don't let clicks on the inputs start a drag
    ctrl.addEventListener('mousedown', (e) => e.stopPropagation());
    ctrl.addEventListener('pointerdown', (e) => e.stopPropagation());
  });
}

function ensureParking() {
  let park = document.getElementById('layout-parking');
  if (!park) { park = document.createElement('div'); park.id = 'layout-parking'; park.style.display = 'none'; document.body.appendChild(park); }
  return park;
}

function wireHideButtons() {
  document.querySelectorAll('.gs-hide-btn').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.hide;
      const item = b.closest('.grid-stack-item');
      const node = item?.querySelector('[data-rapisys-widget]');
      if (node) ensureParking().appendChild(node);
      if (item && grid) grid.removeWidget(item, true);
      refreshToolbarPalette();
    };
  });
}

function addWidget(id) {
  const widget = WById[id];
  if (!widget || !grid) return;
  const node = findNode(widget);
  if (!node) return;
  const item = makeItem(widget, { w: widget.group === 'stats' ? 3 : 12, h: measureRows(widget) }, { editable: true });
  if (!item) return;
  grid.makeWidget(item);
  wireHideButtons();
  wireSizeInputs();
  refreshToolbarPalette();
}

let toolbarEl = null;
function buildEditToolbar() {
  toolbarEl?.remove();
  toolbarEl = document.createElement('div');
  toolbarEl.className = 'layout-toolbar';
  toolbarEl.innerHTML = `
    <div class="layout-toolbar-inner">
      <span class="layout-toolbar-title">Editing — drag the title bar, resize from the corner</span>
      <div class="layout-palette" data-palette></div>
      <div class="layout-toolbar-actions">
        <button class="lt-btn lt-save" data-lt="save">Save</button>
        <button class="lt-btn lt-reset" data-lt="reset">Reset to default</button>
        <button class="lt-btn" data-lt="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(toolbarEl);
  toolbarEl.querySelector('[data-lt=save]').onclick = saveLayout;
  toolbarEl.querySelector('[data-lt=reset]').onclick = resetLayout;
  toolbarEl.querySelector('[data-lt=cancel]').onclick = cancelEdit;
  refreshToolbarPalette();
}

function refreshToolbarPalette() {
  const pal = toolbarEl?.querySelector('[data-palette]');
  if (!pal || !grid) return;
  const present = new Set(grid.engine.nodes.map((n) => n.el.getAttribute('gs-id')));
  const missing = OVERVIEW_WIDGETS.filter((w) => !present.has(w.id) && findNode(w));
  pal.innerHTML = missing.length
    ? `<span class="layout-palette-label">Hidden:</span>` + missing.map((w) =>
        `<button class="layout-chip" data-add="${w.id}">+ ${w.title}</button>`).join('')
    : '';
  pal.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addWidget(b.dataset.add));
}

function serializeGrid() {
  const visibleIds = new Set();
  const layout = grid.engine.nodes.map((n) => {
    const id = n.el.getAttribute('gs-id'); visibleIds.add(id);
    return { id, x: n.x, y: n.y, w: n.w, h: n.h, visible: true };
  });
  for (const w of OVERVIEW_WIDGETS) {
    if (!visibleIds.has(w.id) && findNode(w)) layout.push({ id: w.id, x: 0, y: 999, w: 12, h: 4, visible: false });
  }
  return layout;
}

async function saveLayout() {
  const layout = serializeGrid();
  try {
    const res = await fetch('/api/layouts/overview', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); toast('error', 'Save failed', e.error || 'Could not save.'); return; }
    savedLayout = layout;
    toast('success', 'Layout saved', 'Your arrangement was saved.');
    finishEdit();
  } catch (err) { toast('error', 'Save failed', err.message); }
}

async function resetLayout() {
  try { await fetch('/api/layouts/overview', { method: 'DELETE', credentials: 'same-origin' }); } catch { /* */ }
  savedLayout = null;
  toast('success', 'Layout reset', 'Restored the default dashboard.');
  finishEdit();
}

function cancelEdit() { finishEdit(); }

/** Exit edit mode: rebuild as the locked view (saved) or pure native (none). */
function finishEdit() {
  toolbarEl?.remove(); toolbarEl = null;
  document.body.classList.remove('layout-editing');
  editing = false;
  if (grid) { teardownGrid(); grid = null; }
  document.getElementById('layout-parking')?.remove();
  if (savedLayout) grid = buildGrid({ editable: false });  // locked view
  // else: native children were un-hidden by teardownGrid → pure native
}

export function getSavedLayout() { return savedLayout; }
