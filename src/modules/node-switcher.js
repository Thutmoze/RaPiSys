/**
 * RaPiSys — header node switcher (§14.6 multi-node federation).
 * ============================================================
 * A pill in the header listing this node and every configured peer, each with a
 * status dot. Selecting a peer opens that node's own dashboard in a new tab.
 *
 * Deliberately not a proxied context swap. Each node serves its own complete
 * dashboard from its own database, so "open the other one" IS the failover
 * story — there is no takeover to orchestrate, and no cross-node session to
 * hold. A proxy would add a dependency on the very node most likely to be dead
 * at the moment you need this.
 *
 * The whole control stays hidden until at least one peer exists, so a
 * single-node install looks exactly as it did before.
 */

const REFRESH_MS = 30000;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Map a peer state to the dot class used across the app. */
function dotClass(node) {
  if (node.state === 'cert-changed') return 'ns-dot ns-dot-warn';
  if (node.reachable) return 'ns-dot';
  return 'ns-dot ns-dot-down';
}

function subtitleFor(node) {
  if (node.state === 'cert-changed') return 'certificate changed';
  if (node.state === 'auth-failed') return 'API key rejected';
  if (node.reachable) {
    const t = node.summary?.cpu?.temp;
    return t ? `healthy · ${Math.round(t)}°C` : 'healthy';
  }
  if (node.lastSeen) {
    const mins = Math.max(1, Math.round((Date.now() - node.lastSeen) / 60000));
    return `unreachable · ${mins}m ago`;
  }
  return 'unreachable';
}

export function initNodeSwitcher({ onManage } = {}) {
  const host = document.getElementById('node-switcher');
  if (!host) return { refresh: () => {} };

  let open = false;

  function close() { open = false; host.classList.remove('open'); }

  async function refresh() {
    let nodes = [];
    let selfName = '';
    try {
      const r = await fetch('/api/nodes', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      nodes = body.nodes || [];
      // The server reports its own hostname; location.hostname would just echo
      // back whatever address the operator typed to get here.
      selfName = body.self?.name || '';
    } catch {
      // Not authenticated yet, or the endpoint is unavailable. Stay hidden
      // rather than showing a broken control.
      host.hidden = true;
      return;
    }

    if (!nodes.length) { host.hidden = true; return; }
    host.hidden = false;

    const down = nodes.filter((n) => !n.reachable).length;
    const label = selfName || location.hostname || 'this node';

    host.innerHTML = `
      <button class="ns-btn" type="button" aria-haspopup="true" aria-expanded="${open}">
        <span class="${down ? 'ns-dot ns-dot-down' : 'ns-dot'}"></span>
        <span class="ns-name">${esc(label)}</span>
        ${down ? `<span class="ns-badge">${down}</span>` : ''}
        <span class="ns-chev">▾</span>
      </button>
      <div class="ns-menu" role="menu">
        <div class="ns-item ns-item-cur">
          <span class="ns-dot"></span>
          <div class="ns-meta"><div class="ns-item-name">${esc(label)}</div><div class="ns-sub">this node</div></div>
          <span class="ns-tag">viewing</span>
        </div>
        ${nodes.map((n) => `
          <div class="ns-item${n.reachable ? '' : ' ns-item-off'}" role="menuitem" tabindex="0" data-url="${esc(n.baseUrl)}">
            <span class="${dotClass(n)}"></span>
            <div class="ns-meta">
              <div class="ns-item-name">${esc(n.name)}</div>
              <div class="ns-sub">${esc(subtitleFor(n))}</div>
            </div>
          </div>`).join('')}
        <div class="ns-sep"></div>
        <div class="ns-foot" role="menuitem" tabindex="0" data-manage="1">Manage nodes…</div>
      </div>`;

    host.querySelector('.ns-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      open = !open;
      host.classList.toggle('open', open);
    });

    host.querySelectorAll('[data-url]').forEach((el) => {
      const go = () => {
        // noopener: the peer tab must not get a handle back to this one.
        window.open(el.dataset.url, '_blank', 'noopener');
        close();
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    const foot = host.querySelector('[data-manage]');
    if (foot) {
      const go = () => { close(); if (onManage) onManage(); else { window.location.hash = '#/settings'; } };
      foot.addEventListener('click', go);
      foot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
  }

  document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  refresh();
  setInterval(refresh, REFRESH_MS);
  return { refresh };
}
