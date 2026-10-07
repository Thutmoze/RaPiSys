/**
 * RaPiSys — node switcher (§14.6 federation, §14.7 unified view).
 * ===============================================================
 * Picks which node the whole dashboard shows. Up to four nodes render as an
 * inline segmented switch; more collapse into one pill with a filterable
 * menu. Selecting a peer does not open a new tab: node-context.js reroutes
 * every /api call through this node's relay, and the page reloads its data
 * in place (rapisys:nodechange).
 *
 * The old "open the peer's own dashboard" path is still the failover story:
 * if THIS node is down, open the other one directly. The relay only matters
 * while you are looking at a peer.
 *
 * The control stays hidden until at least one peer exists, so a single-node
 * install looks exactly as it did before.
 */

import { currentNode, setNode, localFetch } from './node-context.js';

const REFRESH_MS = 30000;
const INLINE_MAX = 4;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Map a peer state to the dot class used across the app. */
function dotClass(node) {
  if (node.self) return 'ns-dot';
  if (node.state === 'cert-changed') return 'ns-dot ns-dot-warn';
  if (node.reachable) return 'ns-dot';
  return 'ns-dot ns-dot-down';
}

function subtitleFor(node) {
  if (node.self) return 'this node';
  if (!node.enabled) return 'disabled';
  if (node.state === 'cert-changed') return 'certificate changed';
  if (node.state === 'auth-failed') return 'API key rejected';
  if (node.reachable) {
    const t = node.summary?.cpu?.temp;
    const parts = ['healthy'];
    if (t) parts.push(`${Math.round(t)}°C`);
    if (node.latencyMs != null) parts.push(`${node.latencyMs} ms`);
    return parts.join(' · ');
  }
  if (node.lastSeen) return `unreachable · ${minsAgo(node.lastSeen)}`;
  return 'unreachable';
}

function minsAgo(ts) {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

const ICO_SCREEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const ICO_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
const ICO_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

export function initNodeSwitcher({ onManage } = {}) {
  const host = document.getElementById('node-switcher');
  if (!host) return { refresh: () => {}, place: () => {} };
  // Home slot in the overview header, so place() can put it back.
  const homeParent = host.parentElement;
  const homeNext = host.nextSibling;

  const strip = document.createElement('div');
  strip.className = 'nctx';
  strip.hidden = true;

  let open = false;
  let filter = '';
  let list = [];        // [{ self:true, ... }, ...peers]
  let selfName = '';

  function close() {
    if (!open) return;
    open = false; filter = '';
    host.classList.remove('open');
    render();
  }

  function select(id) {
    close();
    const n = list.find((x) => String(x.id) === String(id));
    if (!n) return;
    setNode(n.self ? null : { id: n.id, name: n.name });
  }

  function selectedEntry() {
    const cur = currentNode();
    return (cur && list.find((n) => !n.self && String(n.id) === cur.id)) || list[0];
  }

  function renderStrip() {
    const cur = currentNode();
    const n = cur && list.find((x) => !x.self && String(x.id) === cur.id);
    if (!n) { strip.hidden = true; strip.innerHTML = ''; return; }
    strip.hidden = false;
    const back = `<span class="nctx-r"><button class="nctx-back" type="button" data-back>Back to ${esc(selfName)}</button></span>`;
    if (n.state === 'cert-changed') {
      strip.className = 'nctx nctx-warn';
      strip.innerHTML = `${ICO_WARN}<span><b>${esc(n.name)}</b> presented a different certificate. <span class="nctx-detail">Nothing is sent to it until you re-confirm it in Settings → Nodes.</span></span>${back}`;
    } else if (n.state === 'auth-failed') {
      strip.className = 'nctx nctx-warn';
      strip.innerHTML = `${ICO_WARN}<span><b>${esc(n.name)}</b> rejected this node's API key. <span class="nctx-detail">Update it in Settings → Nodes.</span></span>${back}`;
    } else if (!n.reachable) {
      strip.className = 'nctx nctx-down';
      strip.innerHTML = `${ICO_OFF}<span><b>${esc(n.name)}</b> is unreachable. <span class="nctx-detail">What you see may be out of date${n.lastSeen ? `; last reply ${minsAgo(n.lastSeen)}` : ''}.</span></span>${back}`;
    } else {
      strip.className = 'nctx';
      strip.innerHTML = `${ICO_SCREEN}<span>Viewing <b>${esc(n.name)}</b><span class="nctx-detail"> through ${esc(selfName)}${n.latencyMs != null ? ` · ${n.latencyMs} ms` : ''}</span></span>${back}`;
    }
    strip.querySelector('[data-back]').onclick = () => setNode(null);
  }

  function render() {
    if (list.length < 2) { host.hidden = true; strip.hidden = true; return; }
    host.hidden = false;
    const sel = selectedEntry();
    const remote = !sel.self;

    if (list.length <= INLINE_MAX) {
      host.innerHTML = `<div class="nsw" role="tablist" aria-label="Node">${list.map((n, i) => {
        const act = n === sel;
        return `<button type="button" class="nsw-opt${act ? ' act' : ''}${act && remote ? ' remote' : ''}${!n.self && !n.reachable ? ' off' : ''}"
          role="tab" aria-selected="${act}" data-node="${esc(n.id)}" title="${esc(`${n.name}: ${subtitleFor(n)} (Alt+${i + 1})`)}">
          <span class="${dotClass(n)}"></span><span class="nsw-name">${esc(n.name)}</span><span class="nsw-key">${i + 1}</span>
        </button>`;
      }).join('')}</div>`;
    } else {
      const down = list.filter((n) => !n.self && !n.reachable).length;
      const q = filter.toLowerCase();
      host.innerHTML = `
        <div class="nsw"><button type="button" class="nsw-opt act${remote ? ' remote' : ''}" data-toggle aria-haspopup="true" aria-expanded="${open}">
          <span class="${dotClass(sel)}"></span><span class="nsw-name">${esc(sel.name)}</span>
          <span class="nsw-count">${list.length} nodes${down ? ` · <span class="nsw-down">${down} down</span>` : ''}</span>
          <span class="ns-chev">▾</span>
        </button></div>
        <div class="ns-menu" role="menu">
          <input class="ns-filter" type="text" placeholder="Filter nodes" value="${esc(filter)}" data-filter>
          ${list.map((n, i) => (q && !n.name.toLowerCase().includes(q)) ? '' : `
            <div class="ns-item${n === sel ? ' ns-item-cur' : ''}${n === sel && remote ? ' remote' : ''}${!n.self && !n.reachable ? ' ns-item-off' : ''}" role="menuitem" tabindex="0" data-node="${esc(n.id)}">
              <span class="${dotClass(n)}"></span>
              <div class="ns-meta"><div class="ns-item-name">${esc(n.name)}</div><div class="ns-sub">${esc(subtitleFor(n))}</div></div>
              ${n === sel ? '<span class="ns-tag">viewing</span>' : (i < 9 ? `<span class="nsw-key ns-key-r">${i + 1}</span>` : '')}
            </div>`).join('')}
          <div class="ns-sep"></div>
          <div class="ns-foot" role="menuitem" tabindex="0" data-manage>Manage nodes…</div>
        </div>`;
      host.classList.toggle('open', open);
      const t = host.querySelector('[data-toggle]');
      t.addEventListener('click', (e) => { e.stopPropagation(); open = !open; render(); if (open) host.querySelector('[data-filter]')?.focus(); });
      const f = host.querySelector('[data-filter]');
      f.addEventListener('click', (e) => e.stopPropagation());
      f.addEventListener('input', () => {
        filter = f.value;
        render();
        const again = host.querySelector('[data-filter]');
        again.focus(); again.setSelectionRange(filter.length, filter.length);
      });
      const foot = host.querySelector('[data-manage]');
      const manage = () => { close(); setNode(null); if (onManage) onManage(); else window.location.hash = '#/settings'; };
      foot.addEventListener('click', manage);
      foot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manage(); } });
    }

    host.querySelectorAll('[data-node]').forEach((el) => {
      const go = () => select(el.dataset.node);
      el.addEventListener('click', (e) => { e.stopPropagation(); go(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    renderStrip();
  }

  async function refresh() {
    let body;
    try {
      const r = await localFetch('/api/nodes', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      body = await r.json();
    } catch {
      // Not authenticated yet, or the endpoint is unavailable. Stay hidden
      // rather than showing a broken control.
      host.hidden = true;
      return;
    }
    // The server reports its own hostname; location.hostname would just echo
    // back whatever address the operator typed to get here.
    selfName = body.self?.name || location.hostname || 'this node';
    list = [{ self: true, id: 'self', name: selfName }, ...(body.nodes || [])];

    // A remembered peer that was since removed would leave every request
    // failing: fall back to this node.
    const cur = currentNode();
    if (cur && !list.some((n) => !n.self && String(n.id) === cur.id)) setNode(null);
    render();
  }

  /**
   * Put the switch and the context strip where the current page can show
   * them: the overview header, or a subpage's title row.
   */
  function place() {
    const pageHead = document.querySelector('.rapisys-page .page-head');
    if (pageHead) {
      pageHead.classList.add('page-head-ns');
      pageHead.appendChild(host);
      pageHead.after(strip);
    } else if (homeParent) {
      homeParent.insertBefore(host, homeNext && homeNext.parentNode === homeParent ? homeNext : homeParent.firstChild);
      const header = homeParent.closest('header');
      if (header) header.after(strip);
    }
  }

  window.addEventListener('rapisys:nodechange', () => { render(); refresh(); });
  document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    // Alt+1..9 picks a node in list order (Option+digit on macOS).
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code) && list.length > 1) {
      const n = list[Number(e.code.slice(5)) - 1];
      if (n) { e.preventDefault(); select(n.id); }
    }
  });

  place();
  refresh();
  setInterval(refresh, REFRESH_MS);
  return { refresh, place };
}
