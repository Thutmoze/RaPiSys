/**
 * RaPiSys — Pi-hole release notes for the Updates tab.
 *
 * Pi-hole is four projects released separately: the Docker image, Core, Web
 * and FTL. Pi-hole's own version cache (read by the agent) says which of them
 * are behind; their GitHub releases say what changed and which security
 * advisories each fixes. Release lists are cached per repo: GitHub allows 60
 * unauthenticated requests an hour, and a check needs at most four.
 */

const REPOS = [
  { key: 'DOCKER', repo: 'docker-pi-hole', group: 'Docker image', dockerOnly: true },
  { key: 'CORE', repo: 'pi-hole', group: 'Core' },
  { key: 'WEB', repo: 'web', group: 'Web' },
  { key: 'FTL', repo: 'FTL', group: 'FTL' },
];
const SEVERITY = ['low', 'medium', 'high', 'critical'];
const MAX_BODY = 20000;

/** Numeric compare of "v6.5" / "6.6.1" / "2026.10.0"; non-numeric parts compare as 0. */
export function cmpVer(a, b) {
  const pa = String(a || '').replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Published releases newer than `from` and up to `to`, newest first. */
export function notesBetween(releases, from, to) {
  return (releases || [])
    .filter((r) => r && !r.draft && !r.prerelease && r.tag_name
      && cmpVer(r.tag_name, from) > 0 && cmpVer(r.tag_name, to) <= 0)
    .sort((a, b) => cmpVer(b.tag_name, a.tag_name));
}

/**
 * Security summary of a set of notes: distinct GHSA advisories, the highest
 * severity named next to them ("**High**" headings or "(High)" after an id),
 * and the newest release date.
 */
export function summarizeNotes(notes = []) {
  const ids = new Set();
  let worst = -1;
  let released = 0;
  for (const n of notes) {
    released = Math.max(released, Date.parse(n.date) || 0);
    let section = -1;      // severity of the current "**High**" block
    for (const line of String(n.body || '').split('\n')) {
      const head = line.trim().match(/^\*\*(critical|high|medium|low)\*\*$/i);
      if (head) { section = SEVERITY.indexOf(head[1].toLowerCase()); continue; }
      if (/^#/.test(line.trim())) section = -1;
      // "(…, duplicate [GHSA-x](…))" names a second id for the same advisory.
      const found = line.replace(/duplicate\s+\[?GHSA(?:-[a-z0-9]{4}){3}/gi, '').match(/GHSA(?:-[a-z0-9]{4}){3}/gi);
      if (!found) continue;
      for (const id of found) ids.add(id.toUpperCase());
      const inline = line.match(/\((critical|high|medium|low)\)/i);
      worst = Math.max(worst, section, inline ? SEVERITY.indexOf(inline[1].toLowerCase()) : -1);
    }
  }
  return {
    advisories: ids.size,
    urgency: ids.size && worst >= 0 ? SEVERITY[worst] : null,
    released: released || null,
  };
}

const cleanBody = (b) => String(b || '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, MAX_BODY);

export function createPiholeReleases({ fetchImpl = globalThis.fetch, ttlMs = 6 * 3600e3, now = () => Date.now() } = {}) {
  const cache = new Map();   // repo -> { at, list }

  async function releases(repo) {
    const hit = cache.get(repo);
    if (hit && now() - hit.at < ttlMs) return hit.list;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/pi-hole/${repo}/releases?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RaPiSys' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for pi-hole/${repo}`);
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error(`unexpected GitHub response for pi-hole/${repo}`);
      cache.set(repo, { at: now(), list });
      return list;
    } catch (err) {
      if (hit) return hit.list;     // stale beats nothing
      throw err;
    }
  }

  /**
   * Notes for every part that is behind, in REPOS order. `status` is the
   * cached update status: { method, currentVersion, latestVersion, components }.
   */
  async function notesFor(status = {}) {
    const cur = { ...(status.components?.current || {}) };
    const lat = { ...(status.components?.latest || {}) };
    if (status.method === 'docker') { cur.DOCKER = status.currentVersion; lat.DOCKER = status.latestVersion; }
    const out = [];
    for (const r of REPOS) {
      if (r.dockerOnly && status.method !== 'docker') continue;
      if (!cur[r.key] || !lat[r.key] || cmpVer(lat[r.key], cur[r.key]) <= 0) continue;
      const list = notesBetween(await releases(r.repo), cur[r.key], lat[r.key]);
      for (const rel of list) {
        out.push({ key: r.key, group: r.group, repo: r.repo, tag: rel.tag_name, installed: cur[r.key],
          date: rel.published_at || null, url: rel.html_url || null, body: cleanBody(rel.body) });
      }
    }
    return out;
  }

  return { notesFor };
}
