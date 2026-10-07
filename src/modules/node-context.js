/**
 * RaPiSys — selected-node context (unified node view, §14.7).
 * ===========================================================
 * Which node the dashboard is showing. When it is a peer, every same-origin
 * /api/* request (fetch, EventSource, download links) is rewritten to
 * /api/nodes/<id>/proxy/*, which this node relays to the peer over pinned
 * HTTPS. The rest of the UI keeps calling plain /api/... and never needs to
 * know: that is what lets one page show any node in place.
 *
 * Imported first by main.js so the hooks are in before the first request.
 *
 * A few paths always stay on this node: the session (/api/auth), the setup
 * wizard check, the legacy display preferences (theme, refresh interval), the liveness probe, and federation itself
 * (/api/nodes, including the relay): peers are managed from the node you
 * opened, and a peer refuses relayed changes to its own federation anyway.
 */

const STORE_KEY = 'rapisys.node';
// Dashboards and their layouts are NOT here on purpose: each node keeps its
// own (it may have widgets another node lacks, e.g. a Pironman case), so
// /api/layouts follows the switcher like everything else.

function isLocalOnly(path) {
  return path.startsWith('/api/auth')
    || path === '/api/setup/status'
    || path === '/api/settings'
    || path === '/api/health'
    || path.startsWith('/api/nodes');
}

let current = null; // { id, name } of the selected peer, or null for this node
try {
  const raw = localStorage.getItem(STORE_KEY);
  const v = raw ? JSON.parse(raw) : null;
  if (v && v.id != null && v.name) current = { id: String(v.id), name: String(v.name) };
} catch { /* storage unavailable: start on this node */ }

export function currentNode() { return current; }
export function isRemoteNode() { return !!current; }

/** Select a peer ({ id, name }) or this node (null) and tell the page. */
export function setNode(node) {
  const next = node ? { id: String(node.id), name: String(node.name) } : null;
  if ((next?.id ?? null) === (current?.id ?? null)) return;
  current = next;
  try {
    if (next) localStorage.setItem(STORE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* the choice just won't survive a reload */ }
  document.body.classList.toggle('node-remote', !!next);
  window.dispatchEvent(new CustomEvent('rapisys:nodechange', { detail: next }));
}

/** Rewrite a request URL for the selected node. Leaves anything else alone. */
export function nodeUrl(input) {
  if (!current || typeof input !== 'string') return input;
  let u;
  try { u = new URL(input, location.href); } catch { return input; }
  // Same origin, or the vite dev server's backend on :3001.
  const sameBackend = u.origin === location.origin || (location.port === '5173' && u.port === '3001');
  if (!sameBackend || !u.pathname.startsWith('/api/') || isLocalOnly(u.pathname)) return input;
  u.pathname = `/api/nodes/${encodeURIComponent(current.id)}/proxy/${u.pathname.slice(5)}`;
  return u.origin === location.origin ? u.pathname + u.search : u.href;
}

// ---- hooks -----------------------------------------------------------------

const nativeFetch = window.fetch.bind(window);
/** fetch that always hits this node, for the switcher's own bookkeeping. */
export const localFetch = nativeFetch;

window.fetch = (input, init) => {
  if (typeof input === 'string') return nativeFetch(nodeUrl(input), init);
  if (input instanceof URL) return nativeFetch(nodeUrl(input.href), init);
  if (input instanceof Request) {
    const rewritten = nodeUrl(input.url);
    return nativeFetch(rewritten === input.url ? input : new Request(rewritten, input), init);
  }
  return nativeFetch(input, init);
};

if (window.EventSource) {
  const NativeES = window.EventSource;
  window.EventSource = class extends NativeES {
    constructor(url, opts) { super(nodeUrl(String(url)), opts); }
  };
}

// <a href="/api/..." download> (report exports): rewrite at click time so
// markup rendered before a switch still targets the node now shown.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="/api/"]');
  if (!a) return;
  const orig = a.dataset.nodeHref || a.getAttribute('href');
  a.dataset.nodeHref = orig;
  a.setAttribute('href', current ? nodeUrl(orig) : orig);
}, true);

if (current) {
  if (document.body) document.body.classList.add('node-remote');
  else document.addEventListener('DOMContentLoaded', () => document.body.classList.add('node-remote'));
}
