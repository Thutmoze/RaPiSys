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

export const OVERVIEW_WIDGETS = [
  { id: 'cpu',        sel: '.cpu-card',          title: 'CPU Usage',     group: 'stats',   home: '.stats-grid' },
  { id: 'memory',     sel: '.memory-card',       title: 'Memory',        group: 'stats',   home: '.stats-grid' },
  { id: 'temp',       sel: '.temp-card',         title: 'Temperature',   group: 'stats',   home: '.stats-grid' },
  { id: 'uptime',     sel: '.uptime-card',       title: 'Uptime & Load', group: 'stats',   home: '.stats-grid' },
  { id: 'services',   sel: '.services-section',  title: 'Services',      group: 'section', home: 'main.dashboard' },
  { id: 'containers', sel: '.containers-section',title: 'Containers',    group: 'section', home: 'main.dashboard' },
  { id: 'wireguard',  sel: '.wireguard-section', title: 'WireGuard',     group: 'section', home: 'main.dashboard' },
  { id: 'network',    sel: '.network-section',   title: 'Network',       group: 'section', home: 'main.dashboard' },
  { id: 'processes',  sel: '.processes-section', title: 'Processes',     group: 'section', home: 'main.dashboard' },
  { id: 'disk',       sel: '.disk-section',      title: 'Disk',          group: 'section', home: 'main.dashboard' },
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
      <button class="gs-hide-btn" data-hide="${widget.id}" title="Hide widget">✕</button>`;
    content.appendChild(bar);
  }
  const body = document.createElement('div');
  body.className = 'gs-body';
  if (node.parentNode) node.parentNode.removeChild(node);
  body.appendChild(node);
  content.appendChild(body);
  item.appendChild(content);
  return item;
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

  const g = GridStack.init({
    column: COLS, cellHeight: CELL, margin: MARGIN,
    float: true,
    staticGrid: !editable,
    disableResize: !editable,
    disableDrag: !editable,
    handle: '.gs-edit-bar',
  }, gridEl);
  document.body.classList.add('layout-grid-active');
  return g;
}

/** Restore all widget nodes to their home containers and remove the grid. */
function teardownGrid() {
  const grids = document.querySelectorAll('.grid-stack.rapisys-grid');
  document.querySelectorAll('[data-rapisys-widget]').forEach((node) => {
    const id = node.getAttribute('data-rapisys-widget');
    const widget = WById[id];
    const home = widget ? document.querySelector(widget.home) : null;
    if (home) home.appendChild(node);
  });
  grids.forEach((g) => g.remove());
  document.body.classList.remove('layout-grid-active');
  const dashboard = document.querySelector('main.dashboard');
  if (dashboard) [...dashboard.children].forEach((c) => { c.style.removeProperty('display'); });
}

// --- public entry ----------------------------------------------------------

let rendered = false;
export async function initOverviewLayout() {
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
