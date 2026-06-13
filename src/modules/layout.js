/** RaPiSys — dashboard layout (F6).
 *
 * Normal view renders NATIVELY (pixel-identical to upstream). A saved layout
 * adjusts widget ORDER and VISIBILITY on the native view via CSS order + DOM
 * reordering — no grid engine. GridStack is lazy-loaded ONLY in edit mode and
 * torn down on exit, so the normal view never pays the fixed-grid cost.
 */

// Each widget is one existing top-level block on the Overview page.
export const OVERVIEW_WIDGETS = [
  { id: 'cpu',        sel: '.stats-grid .cpu-card',    title: 'CPU Usage',     group: 'stats' },
  { id: 'memory',     sel: '.stats-grid .memory-card', title: 'Memory',        group: 'stats' },
  { id: 'temp',       sel: '.stats-grid .temp-card',   title: 'Temperature',   group: 'stats' },
  { id: 'uptime',     sel: '.stats-grid .uptime-card', title: 'Uptime & Load', group: 'stats' },
  { id: 'services',   sel: '.services-section',        title: 'Services',      group: 'section' },
  { id: 'containers', sel: '.containers-section',      title: 'Containers',    group: 'section' },
  { id: 'wireguard',  sel: '.wireguard-section',       title: 'WireGuard',     group: 'section' },
  { id: 'network',    sel: '.network-section',         title: 'Network',       group: 'section' },
  { id: 'processes',  sel: '.processes-section',       title: 'Processes',     group: 'section' },
  { id: 'disk',       sel: '.disk-section',            title: 'Disk',          group: 'section' },
];

const WById = Object.fromEntries(OVERVIEW_WIDGETS.map((w) => [w.id, w]));

let savedLayout = null;       // last fetched layout (array) or null
let applied = false;
let editing = false;
let grid = null;              // GridStack instance while editing
let toast = (t, h, m) => console.log(t, h, m);   // injected by app.js

export function setToast(fn) { if (typeof fn === 'function') toast = fn; }

function widgetNode(w) { return document.querySelector(w.sel); }

/** Fetch the saved active layout for the overview page (null if none). */
async function fetchLayout() {
  try {
    const res = await fetch('/api/layouts/overview', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.layout) ? data.layout : null;
  } catch { return null; }
}

/** Apply a saved layout to the NATIVE dashboard (order + visibility). */
function applyToNative(layout) {
  if (!layout) return;
  const byId = {};
  layout.forEach((w, i) => { byId[w.id] = { ...w, _idx: i }; });
  for (const widget of OVERVIEW_WIDGETS) {
    const node = widgetNode(widget);
    if (!node) continue;
    const placement = byId[widget.id];
    if (!placement) { node.style.order = ''; node.style.removeProperty('display'); continue; }
    node.style.display = placement.visible === false ? 'none' : '';
    node.style.order = String(placement._idx);
  }
  const dashboard = document.querySelector('main.dashboard');
  if (dashboard) {
    const sectionWidgets = layout
      .map((p) => WById[p.id]).filter((w) => w && w.group === 'section');
    for (const w of sectionWidgets) {
      const node = widgetNode(w);
      if (node) dashboard.appendChild(node);
    }
  }
}

/** Public: called when the Overview page becomes active. */
export async function initOverviewLayout() {
  savedLayout = await fetchLayout();
  if (savedLayout && !applied) { applyToNative(savedLayout); applied = true; }
  ensureEditButton();
}

export async function reloadOverviewLayout() {
  savedLayout = await fetchLayout();
  applied = false;
  applyToNative(savedLayout);
  applied = true;
}

export function getSavedLayout() { return savedLayout; }

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

/** Inject the "Edit Layout" header button once (Overview only). */
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
  // place it first in the actions row
  actions.insertBefore(btn, actions.firstChild);
}

/** Build the list of widgets with current visibility (saved or all-visible). */
function currentWidgetState() {
  const byId = {};
  if (savedLayout) for (const w of savedLayout) byId[w.id] = w;
  // order: saved order first, then any remaining widgets in registry order
  const ordered = [];
  if (savedLayout) for (const w of savedLayout) { if (WById[w.id]) ordered.push(WById[w.id]); }
  for (const w of OVERVIEW_WIDGETS) if (!ordered.includes(w)) ordered.push(w);
  return ordered.map((w) => ({
    widget: w,
    visible: byId[w.id] ? byId[w.id].visible !== false : true,
    w: byId[w.id]?.w, h: byId[w.id]?.h, x: byId[w.id]?.x, y: byId[w.id]?.y,
  }));
}

async function enterEditMode() {
  // admin gate: editing requires an authenticated control session
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    if (me.mode === 'monitor') { toast('info', 'Monitor-only mode', 'Layout editing is disabled.'); return; }
    if (!me.authenticated) { toast('info', 'Sign in required', 'Sign in as admin to edit the layout.'); return; }
  } catch { /* if auth check fails, the save will be rejected anyway */ }

  editing = true;
  document.body.classList.add('layout-editing');

  // lazy-load GridStack (JS + CSS) only now
  const [{ GridStack }] = await Promise.all([
    import('gridstack'),
    import('gridstack/dist/gridstack.min.css'),
  ]);

  const dashboard = document.querySelector('main.dashboard');
  const state = currentWidgetState();

  // Build the grid container; default sizes: stats 3-wide, sections 12-wide.
  // Heights are measured so items open at their natural size.
  const gridEl = document.createElement('div');
  gridEl.className = 'grid-stack rapisys-grid';
  const CELL = 10, MARGIN = 8;

  const hidden = [];
  for (const s of state) {
    const node = widgetNode(s.widget);
    if (!node) continue;
    if (!s.visible) {
      // park hidden widgets so they show up in the palette to re-add
      node.dataset.parkId = s.widget.id;
      ensureParking().appendChild(node);
      hidden.push(s.widget);
      continue;
    }
    const rect = node.getBoundingClientRect();
    const measuredH = Math.max(2, Math.ceil((rect.height + MARGIN) / (CELL + MARGIN)));
    const w = s.w || (s.widget.group === 'stats' ? 3 : 12);
    const h = s.h || measuredH;

    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.setAttribute('gs-id', s.widget.id);
    if (s.x != null) item.setAttribute('gs-x', s.x);
    if (s.y != null) item.setAttribute('gs-y', s.y);
    item.setAttribute('gs-w', w);
    item.setAttribute('gs-h', h);

    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    // edit chrome: title bar + hide button (drag handle is the whole item)
    const bar = document.createElement('div');
    bar.className = 'gs-edit-bar';
    bar.innerHTML = `<span class="gs-edit-title">${s.widget.title}</span>
      <button class="gs-hide-btn" data-hide="${s.widget.id}" title="Hide widget">✕</button>`;
    content.appendChild(bar);
    node.parentNode.removeChild(node);
    content.appendChild(node);
    item.appendChild(content);
    gridEl.appendChild(item);
  }

  // Hide the native dashboard children and mount the grid.
  dashboard.dataset.editing = '1';
  // stash native children we didn't move (e.g. stats-grid wrapper) by hiding
  [...dashboard.children].forEach((c) => { if (c !== gridEl) c.style.display = 'none'; });
  dashboard.appendChild(gridEl);

  grid = GridStack.init({
    column: 12, cellHeight: CELL, margin: MARGIN, float: true,
    handle: '.gs-edit-bar',
  }, gridEl);

  buildEditToolbar(hidden);
  wireHideButtons();
}

function ensureParking() {
  let park = document.getElementById('layout-parking');
  if (!park) {
    park = document.createElement('div');
    park.id = 'layout-parking';
    park.style.display = 'none';
    document.body.appendChild(park);
  }
  return park;
}

function wireHideButtons() {
  document.querySelectorAll('.gs-hide-btn').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.hide;
      const item = b.closest('.grid-stack-item');
      const content = item?.querySelector('.grid-stack-item-content');
      const wrapped = content ? [...content.children].find((c) => !c.classList.contains('gs-edit-bar')) : null;
      if (wrapped) { wrapped.dataset.parkId = id; ensureParking().appendChild(wrapped); }
      if (item && grid) grid.removeWidget(item, true);
      refreshToolbarPalette();
    };
  });
}

let toolbarEl = null;
function buildEditToolbar() {
  if (toolbarEl) toolbarEl.remove();
  toolbarEl = document.createElement('div');
  toolbarEl.className = 'layout-toolbar';
  toolbarEl.innerHTML = `
    <div class="layout-toolbar-inner">
      <span class="layout-toolbar-title">Editing layout — drag to move, resize from the corner</span>
      <div class="layout-palette" data-palette></div>
      <div class="layout-toolbar-actions">
        <button class="action-btn keep-case" data-lt="save">Save</button>
        <button class="action-btn keep-case" data-lt="reset">Reset to default</button>
        <button class="action-btn keep-case" data-lt="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(toolbarEl);
  toolbarEl.querySelector('[data-lt=save]').onclick = saveLayout;
  toolbarEl.querySelector('[data-lt=reset]').onclick = resetLayout;
  toolbarEl.querySelector('[data-lt=cancel]').onclick = () => exitEditMode(false);
  refreshToolbarPalette();
}

/** The palette lists hidden widgets so they can be re-added. */
function refreshToolbarPalette() {
  const pal = toolbarEl?.querySelector('[data-palette]');
  if (!pal || !grid) return;
  const present = new Set(grid.engine.nodes.map((n) => n.el.getAttribute('gs-id')));
  const missing = OVERVIEW_WIDGETS.filter((w) => !present.has(w.id) && widgetNode(w));
  pal.innerHTML = missing.length
    ? `<span class="layout-palette-label">Hidden:</span>` + missing.map((w) =>
        `<button class="layout-chip" data-add="${w.id}">+ ${w.title}</button>`).join('')
    : '';
  pal.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addWidget(b.dataset.add));
}

function addWidget(id) {
  const widget = WById[id];
  // node may be parked (hidden) or still in the native DOM
  const node = document.querySelector(`#layout-parking > [data-park-id="${id}"]`) || widgetNode(widget);
  if (!widget || !node || !grid) return;
  node.removeAttribute('data-park-id');
  const w = widget.group === 'stats' ? 3 : 12;
  const item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.setAttribute('gs-id', id);
  item.setAttribute('gs-w', w);
  item.setAttribute('gs-h', 6);
  const content = document.createElement('div');
  content.className = 'grid-stack-item-content';
  const bar = document.createElement('div');
  bar.className = 'gs-edit-bar';
  bar.innerHTML = `<span class="gs-edit-title">${widget.title}</span>
    <button class="gs-hide-btn" data-hide="${id}" title="Hide widget">✕</button>`;
  content.appendChild(bar);
  if (node.parentNode) node.parentNode.removeChild(node);
  content.appendChild(node);
  item.appendChild(content);
  grid.makeWidget(item);
  wireHideButtons();
  refreshToolbarPalette();
}

/** Serialize the current grid into our layout array. */
function serializeGrid() {
  const nodes = grid.engine.nodes;
  const visibleIds = new Set();
  const layout = nodes.map((n) => {
    const id = n.el.getAttribute('gs-id');
    visibleIds.add(id);
    return { id, x: n.x, y: n.y, w: n.w, h: n.h, visible: true };
  });
  // append hidden widgets so visibility:false persists
  for (const w of OVERVIEW_WIDGETS) {
    if (!visibleIds.has(w.id) && widgetNode(w)) {
      layout.push({ id: w.id, x: 0, y: 999, w: 12, h: 4, visible: false });
    }
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
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      toast('error', 'Save failed', e.error || 'Could not save layout.');
      return;
    }
    savedLayout = layout;
    toast('success', 'Layout saved', 'Your dashboard arrangement was saved.');
    exitEditMode(true);
  } catch (err) {
    toast('error', 'Save failed', err.message);
  }
}

async function resetLayout() {
  try {
    await fetch('/api/layouts/overview', { method: 'DELETE', credentials: 'same-origin' });
  } catch { /* ignore */ }
  savedLayout = null;
  toast('success', 'Layout reset', 'Restored the default dashboard layout.');
  exitEditMode(true);
}

/** Tear down the grid and restore the native dashboard. */
function exitEditMode() {
  if (!editing) return;
  const dashboard = document.querySelector('main.dashboard');
  const statsGrid = dashboard?.querySelector('.stats-grid');

  // Move every wrapped widget node back to its home container (stats-grid for
  // stat cards, dashboard for sections). Covers items still in the grid.
  if (grid) {
    grid.engine.nodes.slice().forEach((n) => {
      const id = n.el.getAttribute('gs-id');
      const widget = WById[id];
      const content = n.el.querySelector('.grid-stack-item-content');
      const wrapped = content ? [...content.children].find((c) => !c.classList.contains('gs-edit-bar')) : null;
      if (wrapped) {
        (widget?.group === 'stats' && statsGrid ? statsGrid : dashboard)?.appendChild(wrapped);
      }
    });
    grid.destroy(false);
    grid = null;
  }
  // Restore any parked (hidden) widget nodes back into their home container.
  document.querySelectorAll('#layout-parking > *').forEach((node) => {
    const id = node.dataset.parkId;
    const widget = WById[id];
    (widget?.group === 'stats' && statsGrid ? statsGrid : dashboard)?.appendChild(node);
    node.removeAttribute('data-park-id');
  });
  document.getElementById('layout-parking')?.remove();
  document.querySelector('.grid-stack.rapisys-grid')?.remove();

  // unhide native children
  if (dashboard) [...dashboard.children].forEach((c) => { c.style.display = ''; });
  dashboard?.removeAttribute('data-editing');

  toolbarEl?.remove(); toolbarEl = null;
  document.body.classList.remove('layout-editing');
  editing = false;

  // re-apply saved order/visibility to the now-native view
  applied = false;
  applyToNative(savedLayout);
  applied = true;
}
