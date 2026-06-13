/** RaPiSys — dashboard layout foundation (F6, phase a).
 *
 * Wraps the existing Overview dashboard blocks as GridStack widgets WITHOUT
 * changing their appearance by default. Each "widget" is one of the existing
 * top-level blocks (the four stat cards and the six sections). They keep their
 * original DOM nodes and ids/classes, so the live-update code in main.js keeps
 * targeting them unchanged.
 *
 * Phase a scope: load a saved layout if one exists and apply it; otherwise the
 * dashboard renders exactly as upstream. No edit UI yet (that is phase b).
 */
import { GridStack } from 'gridstack';

// The widget registry. `sel` selects the existing block in index.html; `def`
// is the default 12-column grid placement chosen to reproduce the current
// layout (stat cards in a 4-up row, sections full width stacked below).
export const OVERVIEW_WIDGETS = [
  { id: 'cpu',        sel: '.stats-grid .cpu-card',     title: 'CPU Usage',     def: { x: 0, y: 0, w: 3, h: 4 } },
  { id: 'memory',     sel: '.stats-grid .memory-card',  title: 'Memory',        def: { x: 3, y: 0, w: 3, h: 4 } },
  { id: 'temp',       sel: '.stats-grid .temp-card',    title: 'Temperature',   def: { x: 6, y: 0, w: 3, h: 4 } },
  { id: 'uptime',     sel: '.stats-grid .uptime-card',  title: 'Uptime & Load', def: { x: 9, y: 0, w: 3, h: 4 } },
  { id: 'services',   sel: '.services-section',         title: 'Services',      def: { x: 0, y: 4,  w: 12, h: 4 } },
  { id: 'containers', sel: '.containers-section',       title: 'Containers',    def: { x: 0, y: 8,  w: 12, h: 4 } },
  { id: 'wireguard',  sel: '.wireguard-section',        title: 'WireGuard',     def: { x: 0, y: 12, w: 12, h: 4 } },
  { id: 'network',    sel: '.network-section',          title: 'Network',       def: { x: 0, y: 16, w: 12, h: 4 } },
  { id: 'processes',  sel: '.processes-section',        title: 'Processes',     def: { x: 0, y: 20, w: 12, h: 5 } },
  { id: 'disk',       sel: '.disk-section',             title: 'Disk',          def: { x: 0, y: 25, w: 12, h: 5 } },
];

let grid = null;
let installed = false;

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
 * Convert the existing dashboard into a GridStack grid. The blocks are moved
 * into grid-item wrappers in place. Idempotent: only runs once.
 *
 * @param {Array|null} saved  saved layout to apply, or null for defaults
 */
function buildGrid(saved) {
  const dashboard = document.querySelector('main.dashboard');
  if (!dashboard || installed) return;

  // Map saved placements by id for quick lookup.
  const savedById = {};
  if (saved) for (const w of saved) savedById[w.id] = w;

  // Create the grid container that will host the items.
  const gridEl = document.createElement('div');
  gridEl.className = 'grid-stack rapisys-grid';

  // Collect each widget's existing node and wrap it as a grid item.
  const items = [];
  for (const widget of OVERVIEW_WIDGETS) {
    const node = dashboard.querySelector(widget.sel);
    if (!node) continue; // block not present (e.g. wireguard hidden) — skip

    const placement = savedById[widget.id] || widget.def;
    // Honor a saved "hidden" flag by not adding the item at all (kept in DOM,
    // detached, so it can be restored later in edit mode).
    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.setAttribute('gs-id', widget.id);
    item.setAttribute('gs-x', placement.x);
    item.setAttribute('gs-y', placement.y);
    item.setAttribute('gs-w', placement.w);
    item.setAttribute('gs-h', placement.h);

    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    // Move the original node inside the grid item content (preserves it intact).
    node.parentNode.removeChild(node);
    content.appendChild(node);
    item.appendChild(content);

    if (placement.visible === false) {
      item.dataset.hidden = '1';
      item.style.display = 'none';
    }
    items.push(item);
    gridEl.appendChild(item);
  }

  // Replace the dashboard's children with the grid.
  dashboard.appendChild(gridEl);

  // Initialize GridStack in STATIC mode (no drag/resize until edit mode).
  grid = GridStack.init({
    column: 12,
    cellHeight: 70,
    margin: 8,
    staticGrid: true,           // locked by default; phase b unlocks for editing
    float: false,
    disableResize: true,
    disableDrag: true,
  }, gridEl);

  installed = true;
}

/** Public: called when the Overview page becomes active. */
export async function initOverviewLayout() {
  if (installed) return;
  const saved = await fetchLayout();
  buildGrid(saved);
}

/** Expose the grid + registry for the (future) editor. */
export function getGrid() { return grid; }
