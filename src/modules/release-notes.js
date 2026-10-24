/**
 * RaPiSys — GitHub release notes (markdown) as safe HTML, for the Pi-hole
 * changelog viewer in Updates.
 *
 * Only the subset GitHub's generated notes use: headings, bullets, bold,
 * inline code, links, and "**High**"-style severity lines, which become
 * coloured labels. Every piece of text is escaped; links are kept only for
 * https URLs and open in a new tab. Bare GHSA ids link to the advisory.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

const INLINE_RE = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s)<>]+)|`([^`]+)`|\*\*([^*]+)\*\*|\b(GHSA(?:-[a-z0-9]{4}){3})\b/gi;

/** One line of inline markdown as HTML. */
export function inlineHtml(raw) {
  let out = '';
  let last = 0;
  for (const m of String(raw).matchAll(INLINE_RE)) {
    out += esc(raw.slice(last, m.index));
    if (m[2]) out += link(m[2], m[1]);
    else if (m[3]) out += link(m[3], m[3].replace(/^https:\/\/github\.com\//, ''));
    else if (m[4] != null) out += `<code>${esc(m[4])}</code>`;
    else if (m[5] != null) out += `<b>${esc(m[5])}</b>`;
    else if (m[6]) out += link(`https://github.com/advisories/${m[6]}`, m[6]);
    last = m.index + m[0].length;
  }
  return out + esc(String(raw).slice(last));
}

/** Release notes markdown as HTML. */
export function releaseNotesHtml(md) {
  let html = '';
  let list = false;
  const closeList = () => { if (list) { html += '</ul>'; list = false; } };
  for (const line of String(md || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const t = line.trim();
    let m;
    if (!t) { closeList(); continue; }
    if ((m = t.match(/^#{1,6}\s+(.*)$/))) { closeList(); html += `<h5>${inlineHtml(m[1])}</h5>`; continue; }
    if ((m = t.match(/^\*\*(critical|high|medium|low)\*\*:?$/i))) {
      closeList();
      html += `<span class="up-rn-sev up-rn-sev-${m[1].toLowerCase()}">${esc(m[1])}</span>`;
      continue;
    }
    if ((m = t.match(/^[-*+]\s+(.*)$/))) {
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${inlineHtml(m[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineHtml(t)}</p>`;
  }
  closeList();
  return html;
}
