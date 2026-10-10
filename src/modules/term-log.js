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
export function createTermLog({ host = 'pi', cmd = '' } = {}) {
  const user = String(host).trim().replace(/[^\w.-]/g, '') || 'pi';
  const el = document.createElement('div');
  el.className = 'up-term';
  el.innerHTML = `
    <div class="up-term-bar">${ICON_TERM}<span class="up-term-title">root@${esc(user)}: ~</span>
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

  if (cmd) {
    add(`<span class="t-prompt">root@${esc(user)}</span>:<span class="t-path">~</span># <span class="t-cmd">${esc(cmd)}</span>`);
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
