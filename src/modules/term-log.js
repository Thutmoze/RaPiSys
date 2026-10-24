/**
 * RaPiSys — shell-style log for streamed apt output (Updates install card).
 * ===========================================================================
 * apt-get prints no colour when it is not on a tty, so colour is derived from
 * the shape of each line, mirroring what a coloured shell would show. dpkg's
 * "(Reading database ... N%" redraws arrive as separate lines (the agent splits
 * on \r) and collapse into one in-place progress line here.
 *
 * termLineHtml() is pure (unit-tested); createTermLog() builds the DOM.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;

/**
 * dpkg's in-place database progress, e.g. "(Reading database ... 45%". Off a
 * tty dpkg may print only the bare prefix before the final count; that is
 * progress too (no percentage) and is replaced by the next line.
 */
export const DB_PROGRESS_RE = /^\(Reading database \.\.\. ?(?:(\d+)%)?$/;

/**
 * HTML for one finished line. `st` carries state between lines: which package
 * list ("will be upgraded" / "REMOVED" / "NEW" / no longer required) indented
 * names belong to, and whether a dpkg conffile notice block is open.
 */
export function termLineHtml(raw, st = {}) {
  const l = esc(raw);
  let m;
  if (/^The following packages will be upgraded/.test(raw)) { st.list = 'up'; return span('t-b', raw); }
  if (/^The following packages will be REMOVED/.test(raw)) { st.list = 'rm'; return span('t-red', raw); }
  if (/^The following (NEW packages|additional packages)/.test(raw)) { st.list = 'new'; return span('t-b', raw); }
  if (/no longer required:$/.test(raw)) { st.list = 'auto'; return span('t-dim', raw); }
  if (st.list && /^\s{2}\S/.test(raw)) {
    return span({ up: 't-pkg-up', rm: 't-pkg-rm', new: 't-pkg-new', auto: 't-dim' }[st.list], raw);
  }
  st.list = null;
  if (/^Use 'apt autoremove'/.test(raw)) return span('t-dim', raw);
  if (/^(Reading package lists|Building dependency tree|Reading state information)/.test(raw)) {
    return `<span class="t-dim">${l.replace(/ Done$/, ' <span class="t-green">Done</span>')}</span>`;
  }
  if ((m = raw.match(/^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\.$/))) {
    return `${span('t-green t-b', m[1])} upgraded, ${span('t-cyan t-b', m[2])} newly installed, `
      + `${span(+m[3] ? 't-red' : 't-b', m[3])} to remove and ${span('t-dim', `${m[4]} not upgraded`)}.`;
  }
  if (/^(Need to get|After this operation)/.test(raw)) return span('t-dim', raw);
  if ((m = raw.match(/^(Get|Hit|Ign):(\d+) (\S+) (.*?)(?: (\S+) (\S+) (\S+) (\[[^\]]+\]))?$/))) {
    const tag = { Get: 't-cyan', Hit: 't-green', Ign: 't-dim' }[m[1]];
    const head = `${span(tag, `${m[1]}:${m[2]}`)} ${span('t-dim', `${m[3]} ${m[4]}`)}`;
    return m[5] ? `${head} ${span('t-b', m[5])} ${span('t-dim', m[6])} ${span('t-green', m[7])} ${span('t-dim', m[8])}` : head;
  }
  if (/^Fetched /.test(raw)) return span('t-cyan', raw);
  if (/^\(Reading database \.\.\. \d+ files/.test(raw)) return span('t-dim', raw);
  if (/^Preparing to unpack/.test(raw)) return span('t-dim', raw);
  if ((m = raw.match(/^Unpacking (\S+) \(([^)]+)\)(?: over \(([^)]+)\))? \.\.\.$/))) {
    return `${span('t-yellow t-tag', 'Unpacking')} ${span('t-b', m[1])} ${span('t-green', m[2])}`
      + `${m[3] ? ` ${span('t-dim', `over ${m[3]}`)}` : ''} ${span('t-dim', '...')}`;
  }
  if ((m = raw.match(/^Setting up (\S+) \(([^)]+)\) \.\.\.$/))) {
    return `${span('t-green t-tag', 'Setting up')} ${span('t-b', m[1])} ${span('t-green', m[2])} ${span('t-dim', '...')}`;
  }
  if ((m = raw.match(/^Removing (\S+) \(([^)]+)\) \.\.\.$/))) {
    return `${span('t-red t-tag', 'Removing')} ${span('t-b', m[1])} ${span('t-dim', `(${m[2]}) ...`)}`;
  }
  if ((m = raw.match(/^Processing triggers for (\S+) \(([^)]+)\) \.\.\.$/))) {
    return `${span('t-purple', 'Processing triggers for')} ${esc(m[1])} ${span('t-dim', `(${m[2]}) ...`)}`;
  }
  if (/^Configuration file '/.test(raw)) { st.block = true; return span('t-orange t-b', raw); }
  if (/^\s*==> Keeping old config file/.test(raw)) { st.blockEnd = true; return span('t-green', raw); }
  if (/^\s*==> (Installing new version of config file|Using new config file)/.test(raw)) { st.blockEnd = true; return span('t-cyan', raw); }
  if (/^\s*==> /.test(raw)) return span('t-orange', raw);
  if (/^(E:|dpkg: error|Errors were encountered|\s*Sub-process .* returned an error)/.test(raw)) return span('t-red', raw);
  // Maintainer scripts' own failures ("Failed to open connection ...",
  // "Error: ...", "Unable to ...", "foo: error: ..."): red, like stderr in a shell.
  if (/^\s*(Failed|Unable|Error|ERROR|Fatal|FATAL|Could not|Cannot)\b/.test(raw) || /\b(error|failed|fatal):\s/i.test(raw)) return span('t-red', raw);
  if (/^W:/.test(raw)) return span('t-orange', raw);
  if (/^N:/.test(raw)) return span('t-cyan', raw);
  return l;
}

// ---- Docker (compose pull / up, docker pull) ---------------------------------
// In a terminal Docker redraws each image layer's progress in place; through
// the agent every redraw is its own line, so a pull is dozens of near-identical
// lines. They become one live row per layer, collapsed to a summary once the
// image is pulled. Container events get the same tags as apt's steps.

const LAYER_RE = /^([0-9a-f]{12}):? (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)\b\s*(.*)$/;
const SIZE_RE = /(\d+(?:\.\d+)?)\s*([kKMG]?B)\b/g;
const LAYER_STATE = {
  'Pulling fs layer': 'wait', Waiting: 'wait', Downloading: 'dl', 'Verifying Checksum': 'done',
  'Download complete': 'done', Extracting: 'ex', 'Pull complete': 'ok', 'Already exists': 'have',
};

/**
 * What a Docker output line is, or null for anything else (apt, scripts).
 * step: a RaPiSys progress line ("Pulling latest image…").
 */
export function dockerEvent(raw) {
  const l = String(raw).trim();
  let m;
  if (/^[A-Z][^:]*…$/.test(l)) return { type: 'step', text: l };
  if ((m = l.match(/^Image (\S+) Pulling$/)) || (m = l.match(/^\S+: Pulling from (\S+)$/))) return { type: 'pullStart', image: m[1] };
  if ((m = l.match(/^Image (\S+) Pulled$/)) || (m = l.match(/^Status: (?:Downloaded newer image|Image is up to date) for (\S+)$/))) {
    return { type: 'pulled', image: m[1] };
  }
  if ((m = l.match(LAYER_RE))) {
    // "1.2MB/12MB" (classic progress) gives a fraction; a bare size does not.
    const sizes = [...(m[3] || '').matchAll(SIZE_RE)].map((x) => `${x[1]}${x[2]}`);
    return { type: 'layer', id: m[1], state: LAYER_STATE[m[2]], size: sizes[0] || null, total: sizes[1] || null };
  }
  if ((m = l.match(/^Container (\S+)\s+(Recreate|Recreated|Create|Creating|Created|Starting|Started|Stopping|Stopped|Removing|Removed|Running|Healthy|Waiting)$/))) {
    return { type: 'container', name: m[1], action: m[2] };
  }
  return null;
}

const toBytes = (s) => {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*([kKMG]?)B/);
  return m ? +m[1] * ({ '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[m[2]]) : 0;
};
const shortSize = (s) => {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*([kKMG]?B)/);
  return m ? `${(+m[1]).toFixed(+m[1] < 10 ? 1 : 0)} ${m[2].toUpperCase()}` : '';
};

/** Inner HTML of one layer row. */
export function layerRowHtml(ev) {
  const id = span('t-dim', ev.id.slice(0, 8));
  if (ev.state === 'dl') {
    const pct = ev.total ? Math.min(100, Math.round((toBytes(ev.size) / toBytes(ev.total)) * 100)) : null;
    const meter = pct == null ? '<span class="t-meter t-indet"><i></i></span>' : `<span class="t-meter"><i style="width:${pct}%"></i></span>`;
    return `${id}${meter}<span class="t-layer-st">${span('t-cyan', shortSize(ev.size) || 'downloading')}</span>`;
  }
  const [meter, label] = {
    wait: ['', span('t-dim', 'waiting')],
    done: [' t-full', span('t-dim', 'downloaded')],
    ex: [' t-extract', span('t-purple', 'extracting')],
    ok: [' t-full', span('t-green', '✓ done')],
    have: [' t-full', span('t-dim', 'present')],
  }[ev.state] || ['', ''];
  return `${id}<span class="t-meter${meter}"><i></i></span><span class="t-layer-st">${label}</span>`;
}

/** The line a finished pull collapses to. */
export function pulledHtml(image, layers, present) {
  const got = layers - present;
  const detail = layers ? `${got} layer${got === 1 ? '' : 's'} downloaded${present ? `, ${present} already present` : ''}` : 'up to date';
  return `${span('t-green t-tag', 'Pulled')} ${span('t-b', image)} ${span('t-dim', detail)}${layers ? ' <span class="t-sum-k">▸ layers</span>' : ''}`;
}

/** A container event: in-progress actions yellow, finished ones green. */
export function containerHtml(ev) {
  const done = /(ed|Running|Healthy)$/.test(ev.action);
  return `${span(done ? 't-green t-tag' : 't-yellow t-tag', ev.action)} ${span('t-b', ev.name)}`;
}

const ICON_TERM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

async function copyText(txt) {
  // navigator.clipboard only exists in secure contexts (HTTPS/localhost);
  // over plain-HTTP LAN it's undefined, so fall back to execCommand.
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(txt); return true; }
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/**
 * Terminal panel: `el` goes in the page; line() feeds streamed output, note()
 * adds a RaPiSys message (✓ / ✗ / ↻), exit() replaces the cursor with the code.
 */
export function createTermLog({ host = 'pi', cmd = '', cwd = '~' } = {}) {
  const user = String(host).trim().replace(/[^\w.-]/g, '') || 'pi';
  const el = document.createElement('div');
  el.className = 'up-term';
  el.innerHTML = `
    <div class="up-term-bar">${ICON_TERM}<span class="up-term-title">root@${esc(user)}: ${esc(cwd)}</span>
      <button type="button" class="up-term-copy" title="Copy log">${ICON_COPY}<span>Copy</span></button></div>
    <div class="up-term-body"></div>`;
  const body = el.querySelector('.up-term-body');
  const cursor = document.createElement('div');
  cursor.innerHTML = '<span class="t-cursor"></span>';
  body.appendChild(cursor);
  const st = {};
  let plain = '';
  let progEl = null;
  let blockEl = null;

  const stick = () => { body.scrollTop = body.scrollHeight; };
  const add = (html, parent = body) => {
    const d = document.createElement('div');
    d.innerHTML = html || '&nbsp;';
    parent.insertBefore(d, parent === body ? cursor : null);
    return d;
  };
  const endProgress = () => { progEl?.remove(); progEl = null; };

  // Docker pull in progress: the layer block and its rows by layer id.
  let pull = null;
  const docker = (ev) => {
    if (ev.type === 'step') { add(span('t-step', ev.text)); return; }
    if (ev.type === 'pullStart') {
      const block = document.createElement('div');
      block.className = 't-layers';
      body.insertBefore(block, cursor);
      pull = { block, rows: new Map(), present: 0 };
      return;
    }
    if (ev.type === 'layer') {
      if (!pull) { add(`${span('t-dim', ev.id)} ${esc(ev.state)}`); return; }
      let row = pull.rows.get(ev.id);
      if (!row) { row = document.createElement('div'); row.className = 't-layer'; pull.block.appendChild(row); pull.rows.set(ev.id, row); }
      if (ev.state === 'have' && row.dataset.st !== 'have') pull.present++;
      row.dataset.st = ev.state;
      row.innerHTML = layerRowHtml(ev);
      return;
    }
    if (ev.type === 'pulled') {
      const sum = add(pulledHtml(ev.image, pull ? pull.rows.size : 0, pull ? pull.present : 0));
      if (pull) {
        // The summary goes where the rows were; click it to see them again.
        const { block } = pull;
        body.insertBefore(sum, block);
        block.hidden = true;
        sum.classList.add('t-sum');
        sum.onclick = () => {
          block.hidden = !block.hidden;
          const k = sum.querySelector('.t-sum-k');
          if (k) k.textContent = block.hidden ? '▸ layers' : '▾ layers';
        };
      }
      pull = null;
      return;
    }
    if (ev.type === 'container') add(containerHtml(ev));
  };

  if (cmd) {
    add(`<span class="t-prompt">root@${esc(user)}</span>:<span class="t-path">${esc(cwd)}</span># <span class="t-cmd">${esc(cmd)}</span>`);
    plain += `# ${cmd}\n`;
  }

  el.querySelector('.up-term-copy').onclick = async (e) => {
    const lbl = e.currentTarget.querySelector('span');
    lbl.textContent = (await copyText(plain)) ? 'Copied' : 'Copy failed';
    setTimeout(() => { lbl.textContent = 'Copy'; }, 1500);
  };

  return {
    el,
    line(raw) {
      const p = String(raw).match(DB_PROGRESS_RE);
      if (p) {
        if (!progEl) { progEl = document.createElement('div'); progEl.className = 't-progress'; body.insertBefore(progEl, cursor); }
        const pct = p[1] == null ? null : Math.min(100, +p[1]);
        progEl.innerHTML = `<span class="t-dim">Reading database ...</span>`
          + (pct == null ? '' : `<span class="t-meter"><i style="width:${pct}%"></i></span><span class="t-cyan">${pct}%</span>`);
        stick();
        return;
      }
      endProgress();
      plain += raw + '\n';
      const ev = dockerEvent(raw);
      if (ev) { docker(ev); stick(); return; }
      const html = termLineHtml(raw, st);
      if (st.block) {
        if (!blockEl) { blockEl = document.createElement('div'); blockEl.className = 't-block'; body.insertBefore(blockEl, cursor); }
        add(html, blockEl);
        if (st.blockEnd) { st.block = false; st.blockEnd = false; blockEl = null; }
      } else {
        st.blockEnd = false;
        add(html);
      }
      stick();
    },
    note(text, kind = 'info') {
      endProgress();
      plain += text + '\n';
      add(span({ ok: 't-green', err: 't-red', warn: 't-orange', info: 't-cyan' }[kind] || 't-cyan', text));
      stick();
    },
    exit(code) {
      endProgress();
      const ok = code === 0;
      cursor.innerHTML = span(ok ? 't-green' : 't-red', `${ok ? '✓' : '✗'} exit ${code ?? '?'}`);
      plain += `exit ${code ?? '?'}\n`;
      stick();
    },
    /** Stop the cursor without an exit code (connection lost, chained phase). */
    stop() { endProgress(); cursor.innerHTML = ''; },
  };
}
