/** RaPiSys — update_history repository. */

export function createUpdatesRepo(db) {
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
  function saveSecurityTag(pkg, { candidate, security, cves, urgency, changelog }) {
    db.prepare(`INSERT INTO update_sectags (package, candidate, security, cves, urgency, changelog) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(package) DO UPDATE SET candidate=excluded.candidate, security=excluded.security, cves=excluded.cves, urgency=excluded.urgency, changelog=COALESCE(excluded.changelog, update_sectags.changelog)`)
      .run(pkg, candidate || null, security ? 1 : 0, cves || 0, urgency || null, changelog || null);
    // also reflect into the cached list so the table updates on next load
    try {
      const c = getCache();
      const u = c.updates.find((x) => x.package === pkg);
      if (u) { u.security = !!security; u.cves = cves || 0; u.urgency = urgency || null; saveCache(c.updates); }
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
    // only reuse if it's for the same candidate version we're upgrading to
    if (candidate && row.candidate && row.candidate !== candidate) return null;
    return { candidateVersion: row.candidate, changelog: row.changelog };
  }
  function getSecurityTags() {
    const rows = db.prepare(`SELECT package, candidate, security, cves, urgency FROM update_sectags`).all();
    const out = {};
    for (const r of rows) out[r.package] = { candidate: r.candidate, security: !!r.security, cves: r.cves, urgency: r.urgency };
    return out;
  }

  function record({ ts, packageName, fromV, toV, result, log }) {
    db.prepare(`INSERT INTO update_history (ts, package, from_v, to_v, result, log)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(ts, packageName, fromV || null, toV || null, result, (log || '').slice(0, 20000));
  }
  function recordBatch(entries) {
    const tx = db.transaction((rows) => { for (const r of rows) record(r); });
    tx(entries);
  }
  function recent(limit = 50) {
    return db.prepare(`SELECT id, ts, package, from_v AS fromV, to_v AS toV, result, log
                       FROM update_history ORDER BY ts DESC LIMIT ?`).all(Math.min(limit, 200));
  }
  return { record, recordBatch, recent, saveCache, getCache, saveSecurityTag, getSecurityTags, getCachedChangelog, saveChangelog, getChangelog };
}
