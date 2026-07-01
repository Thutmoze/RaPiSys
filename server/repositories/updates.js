/** RaPiSys — update_history repository. */

export function createUpdatesRepo(db) {
  // sentinel stored in update_changelogs.changelog to mark "we downloaded the
  // package and it has no obtainable changelog" — distinct from "never fetched".
  const NONE_MARKER = '\u001f__NO_CHANGELOG__\u001f';
  // Cache the upgradable list + last-check time in a tiny kv row (reuse the
  // secrets-style pattern via a dedicated table created on demand).
  db.exec(`CREATE TABLE IF NOT EXISTS update_cache (id INTEGER PRIMARY KEY CHECK (id=1), checked_at INTEGER, payload TEXT)`);
  function saveCache(updates) {
    db.prepare(`INSERT INTO update_cache (id, checked_at, payload) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, payload=excluded.payload`)
      .run(Date.now(), JSON.stringify(updates));
  }
  function getCache() {
    const row = db.prepare(`SELECT checked_at AS checkedAt, payload FROM update_cache WHERE id=1`).get();
    if (!row) return { checkedAt: null, updates: [] };
    return { checkedAt: row.checkedAt, updates: JSON.parse(row.payload || '[]') };
  }

  // Per-package security tags learned lazily from viewed changelogs.
  db.exec(`CREATE TABLE IF NOT EXISTS update_sectags (package TEXT PRIMARY KEY, candidate TEXT, security INTEGER, cves INTEGER, urgency TEXT, changelog TEXT)`);
  // add changelog column if upgrading from an older schema
  try { db.exec(`ALTER TABLE update_sectags ADD COLUMN changelog TEXT`); } catch { /* already exists */ }
  // candidate release date (epoch ms), parsed from the top changelog entry
  try { db.exec(`ALTER TABLE update_sectags ADD COLUMN release_date INTEGER`); } catch { /* already exists */ }
  function saveSecurityTag(pkg, { candidate, security, cves, urgency, changelog, releaseDate }) {
    db.prepare(`INSERT INTO update_sectags (package, candidate, security, cves, urgency, changelog, release_date) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(package) DO UPDATE SET candidate=excluded.candidate, security=excluded.security, cves=excluded.cves, urgency=excluded.urgency, changelog=COALESCE(excluded.changelog, update_sectags.changelog), release_date=COALESCE(excluded.release_date, update_sectags.release_date)`)
      .run(pkg, candidate || null, security ? 1 : 0, cves || 0, urgency || null, changelog || null, releaseDate || null);
    // also reflect into the cached list so the table updates on next load
    try {
      const c = getCache();
      const u = c.updates.find((x) => x.package === pkg);
      if (u) { u.security = !!security; u.cves = cves || 0; u.urgency = urgency || null; if (releaseDate) u.releaseDate = releaseDate; saveCache(c.updates); }
    } catch { /* */ }
  }
  // Persist only a candidate release date without disturbing security fields
  // (used when a changelog is fetched outside the bulk security scan).
  function saveReleaseDate(pkg, candidate, releaseDate) {
    if (!releaseDate) return;
    db.prepare(`INSERT INTO update_sectags (package, candidate, security, cves, urgency, release_date) VALUES (?, ?, 0, 0, NULL, ?)
                ON CONFLICT(package) DO UPDATE SET candidate=COALESCE(excluded.candidate, update_sectags.candidate), release_date=excluded.release_date`)
      .run(pkg, candidate || null, releaseDate);
    try {
      const c = getCache();
      const u = c.updates.find((x) => x.package === pkg);
      if (u) { u.releaseDate = releaseDate; saveCache(c.updates); }
    } catch { /* */ }
  }
  function getCachedChangelog(pkg) {
    const row = db.prepare(`SELECT candidate, changelog FROM update_sectags WHERE package=?`).get(pkg);
    return row && row.changelog ? { candidateVersion: row.candidate, changelog: row.changelog } : null;
  }

  // Dedicated changelog cache: any successful fetch (range OR full download) is
  // stored here keyed by package + candidate version, so we never re-fetch and
  // every view renders consistently. Invalidated automatically when the
  // candidate version changes (a new upgrade supersedes the old notes).
  db.exec(`CREATE TABLE IF NOT EXISTS update_changelogs (package TEXT PRIMARY KEY, candidate TEXT, changelog TEXT, fetched_at INTEGER)`);
  function saveChangelog(pkg, candidate, changelog) {
    if (!changelog) return;
    db.prepare(`INSERT INTO update_changelogs (package, candidate, changelog, fetched_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(package) DO UPDATE SET candidate=excluded.candidate, changelog=excluded.changelog, fetched_at=excluded.fetched_at`)
      .run(pkg, candidate || null, changelog, Date.now());
  }
  function getChangelog(pkg, candidate) {
    const row = db.prepare(`SELECT candidate, changelog FROM update_changelogs WHERE package=?`).get(pkg);
    if (!row || !row.changelog) return null;
    // Reuse if it's for the same candidate. The stored candidate comes from the
    // .deb filename (epoch dropped, e.g. '149.0...') while the passed candidate
    // comes from apt (with epoch, '1:149.0...'), so compare ignoring the epoch.
    if (candidate && row.candidate) {
      const strip = (v) => String(v).replace(/^\d+:/, '');
      if (strip(row.candidate) !== strip(candidate)) return null;
    }
    // a stored NONE_MARKER means we already downloaded and found no changelog —
    // surface that as a sentinel so callers don't re-download every time.
    if (row.changelog === NONE_MARKER) return { candidateVersion: row.candidate, changelog: '', none: true };
    return { candidateVersion: row.candidate, changelog: row.changelog };
  }
  // record that a package has no obtainable changelog for this candidate, so the
  // expensive full download isn't retried on every view.
  function markNoChangelog(pkg, candidate) {
    db.prepare(`INSERT INTO update_changelogs (package, candidate, changelog, fetched_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(package) DO UPDATE SET candidate=excluded.candidate, changelog=excluded.changelog, fetched_at=excluded.fetched_at`)
      .run(pkg, candidate || null, NONE_MARKER, Date.now());
  }
  function getSecurityTags() {
    const rows = db.prepare(`SELECT package, candidate, security, cves, urgency, release_date AS releaseDate FROM update_sectags`).all();
    const out = {};
    for (const r of rows) out[r.package] = { candidate: r.candidate, security: !!r.security, cves: r.cves, urgency: r.urgency, releaseDate: r.releaseDate || null };
    return out;
  }

  // update_history rows also store the real security/cve/kernel flags captured
  // at record time (from update_sectags) — far more reliable than re-deriving
  // them from the apt install log text after the fact.
  try { db.exec(`ALTER TABLE update_history ADD COLUMN security INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE update_history ADD COLUMN cves INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE update_history ADD COLUMN kernel INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE update_history ADD COLUMN description TEXT`); } catch { /* exists */ }

  function record({ ts, packageName, fromV, toV, result, log, description }) {
    // capture the package's known security tags at the moment of the upgrade
    let sec = null, cves = null, kern = null;
    try {
      const t = db.prepare(`SELECT security, cves FROM update_sectags WHERE package=?`).get(packageName);
      if (t) { sec = t.security ? 1 : 0; cves = t.cves || 0; }
      kern = (/linux-image|^linux-headers|kernel/i.test(packageName)) ? 1 : 0;
    } catch { /* best-effort */ }
    db.prepare(`INSERT INTO update_history (ts, package, from_v, to_v, result, log, security, cves, kernel, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ts, packageName, fromV || null, toV || null, result, (log || '').slice(0, 20000), sec, cves, kern, description || null);
  }
  function recordBatch(entries) {
    const tx = db.transaction((rows) => { for (const r of rows) record(r); });
    tx(entries);
  }
  function recent(limit = 50) {
    const rows = db.prepare(`SELECT id, ts, package, from_v AS fromV, to_v AS toV, result, log,
                              security, cves, kernel, description
                       FROM update_history ORDER BY ts DESC LIMIT ?`).all(Math.min(limit, 200));
    // Backfill rows that predate per-row tag capture (security IS NULL): if the
    // package still has a tag in update_sectags, surface it so older history
    // entries show Security/CVE badges too. Computed at read time, not stored.
    let tags = null;
    for (const r of rows) {
      if (r.security == null && r.cves == null) {
        if (!tags) {
          tags = {};
          try { for (const t of db.prepare(`SELECT package, security, cves FROM update_sectags`).all()) tags[t.package] = t; }
          catch { tags = {}; }
        }
        const t = tags[r.package];
        if (t) { r.security = t.security ? 1 : 0; r.cves = t.cves || 0; }
        if (r.kernel == null) r.kernel = /linux-image|^linux-headers|kernel/i.test(r.package) ? 1 : 0;
      }
    }
    return rows;
  }
  return { record, recordBatch, recent, saveCache, getCache, saveSecurityTag, saveReleaseDate, getSecurityTags, getCachedChangelog, saveChangelog, getChangelog, markNoChangelog };
}
