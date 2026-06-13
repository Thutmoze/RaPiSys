/** RaPiSys — dashboard layout (F6).
 *
 * Architecture: the Overview dashboard renders NATIVELY by default (its own
 * CSS grid / sections, pixel-identical to upstream — zero risk). A saved layout
 * only adjusts widget ORDER and VISIBILITY on the native view, which needs no
 * grid engine. GridStack is loaded lazily and used ONLY while the user is in
 * "edit layout" mode (phase b), then torn down — so the normal view never pays
 * the fixed-row-height cost that clips content-driven cards.
 *
 * Phase a scope (this file): widget registry + load/apply saved order &
 * visibility to the native dashboard. Edit mode arrives in phase b.
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

let savedLayout = null;       // last fetched layout (array) or null
let applied = false;

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

/**
 * Apply a saved layout to the NATIVE dashboard: reorder the stat cards within
 * their grid, reorder the sections, and hide widgets flagged not-visible.
 * Uses CSS `order` for the stat grid and physical re-append for sections.
 */
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
  // Sections sit in normal flow, so re-append them physically in saved order.
  const dashboard = document.querySelector('main.dashboard');
  if (dashboard) {
    const sectionWidgets = layout
      .map((p) => OVERVIEW_WIDGETS.find((w) => w.id === p.id))
      .filter((w) => w && w.group === 'section');
    for (const w of sectionWidgets) {
      const node = widgetNode(w);
      if (node) dashboard.appendChild(node);
    }
  }
}

/** Public: called when the Overview page becomes active. */
export async function initOverviewLayout() {
  savedLayout = await fetchLayout();
  if (savedLayout && !applied) {
    applyToNative(savedLayout);
    applied = true;
  }
}

/** Re-read + re-apply (used after the editor saves). */
export async function reloadOverviewLayout() {
  savedLayout = await fetchLayout();
  applied = false;
  applyToNative(savedLayout);
  applied = true;
}

export function getSavedLayout() { return savedLayout; }
