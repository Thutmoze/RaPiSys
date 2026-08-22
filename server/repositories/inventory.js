/** RaPiSys — inventory repository: bulk sync + searchable, paginated reads. */

export function createInventoryRepo(db) {
  const upsert = db.prepare(`
    INSERT INTO inventory (kind, name, version, installed_at, source, status, last_used, meta, category, priority, section)
    VALUES (@kind, @name, @version, @installedAt, @source, @status, @lastUsed, @meta, @category, @priority, @section)
    ON CONFLICT(kind, name) DO UPDATE SET
      version=excluded.version, status=excluded.status, source=excluded.source,
      installed_at=COALESCE(excluded.installed_at, inventory.installed_at),
      meta=excluded.meta, category=excluded.category, priority=excluded.priority, section=excluded.section`);

  const deleteOne = db.prepare(`DELETE FROM inventory WHERE kind = ? AND name = ?`);

  /** Flatten a collector item into the exact column values the upsert writes. */
  function normalize(it) {
    return {
      kind: it.kind, name: it.name, version: it.version ?? null,
      installedAt: it.installedAt ?? null, source: it.source ?? null,
      status: it.status ?? null, lastUsed: it.lastUsed ?? null,
      meta: it.meta ? JSON.stringify(it.meta) : null,
      category: it.category ?? null, priority: it.meta?.priority ?? null, section: it.meta?.section ?? null,
    };
  }

  /**
   * True when running the upsert would actually change the stored row.
   *
   * This mirrors the upsert's DO UPDATE clause exactly: `last_used` is never
   * written on update, and `installed_at` is COALESCEd, so a null incoming
   * install time leaves the existing value alone and is not a difference.
   */
  function differs(prev, next) {
    return prev.version !== next.version
      || prev.status !== next.status
      || prev.source !== next.source
      || prev.meta !== next.meta
      || prev.category !== next.category
      || prev.priority !== next.priority
      || prev.section !== next.section
      || (next.installedAt !== null && prev.installed_at !== next.installedAt);
  }

  /**
   * Reconcile the inventory for the given kinds against `items`, writing only
   * the rows that actually changed.
   *
   * This used to delete every row for these kinds and reinsert all of them, so
   * a routine sync rewrote ~1,500 package rows even when nothing had changed.
   * better-sqlite3 is synchronous, so when the database lives on a network
   * mount that burst of page writes blocks the event loop for tens of seconds
   * and the entire UI stops responding. Between syncs almost nothing actually
   * moves, so we read the current state first and touch only the differences —
   * a steady-state sync now issues zero writes.
   *
   * Returns per-run counts so callers can log or assert on the write volume.
   */
  const sync = db.transaction((items, kinds) => {
    const ph = kinds.map(() => '?').join(',');
    const existing = new Map();
    const rows = db.prepare(
      `SELECT kind, name, version, installed_at, source, status, meta, category, priority, section
         FROM inventory WHERE kind IN (${ph})`).all(...kinds);
    for (const row of rows) existing.set(`${row.kind}\u0000${row.name}`, row);

    const seen = new Set();
    let inserted = 0; let updated = 0; let removed = 0;

    for (const it of items) {
      const key = `${it.kind}\u0000${it.name}`;
      if (seen.has(key)) continue;          // collector duplicates collapse to one row anyway
      seen.add(key);
      const next = normalize(it);
      const prev = existing.get(key);
      if (!prev) { upsert.run(next); inserted++; } else if (differs(prev, next)) { upsert.run(next); updated++; }
    }

    for (const [key, row] of existing) {
      if (seen.has(key)) continue;          // gone from the system since the last sync
      deleteOne.run(row.kind, row.name);
      removed++;
    }

    return { inserted, updated, removed, unchanged: seen.size - inserted - updated };
  });

  function search({ kind = null, q = '', limit = 50, offset = 0, sort = 'name', category = null, priority = null, section = null } = {}) {
    const where = [];
    const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (priority) { where.push('priority = ?'); args.push(priority); }
    if (section) { where.push('section = ?'); args.push(section); }
    if (q) { where.push('(name LIKE ? OR meta LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = sort === 'installed' ? 'installed_at DESC NULLS LAST' : sort === 'status' ? 'status, name' : 'name';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM inventory ${wsql}`).get(...args).n;
    const rows = db.prepare(
      `SELECT kind, name, version, installed_at AS installedAt, source, status, last_used AS lastUsed, meta, category
       FROM inventory ${wsql} ORDER BY ${order} LIMIT ? OFFSET ?`
    ).all(...args, Math.min(limit, 200), offset);
    return { total, rows: rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) };
  }

  function counts() {
    const rows = db.prepare(`SELECT kind, COUNT(*) AS n FROM inventory GROUP BY kind`).all();
    const out = {};
    for (const r of rows) out[r.kind] = r.n;
    return out;
  }

  function facets() {
    const cat = db.prepare(`SELECT category, COUNT(*) n FROM inventory WHERE kind='package' AND category IS NOT NULL GROUP BY category`).all();
    const pri = db.prepare(`SELECT priority, COUNT(*) n FROM inventory WHERE kind='package' AND priority IS NOT NULL AND priority!='' GROUP BY priority`).all();
    const sec = db.prepare(`SELECT section, COUNT(*) n FROM inventory WHERE kind='package' AND section IS NOT NULL AND section!='' GROUP BY section ORDER BY n DESC LIMIT 20`).all();
    return {
      category: Object.fromEntries(cat.map((r) => [r.category, r.n])),
      priority: Object.fromEntries(pri.map((r) => [r.priority, r.n])),
      section: Object.fromEntries(sec.map((r) => [r.section, r.n])),
    };
  }

  function lastSync() {
    return db.prepare(`SELECT MAX(installed_at) AS t FROM inventory`).get()?.t || null;
  }

  // ---- "recommended to remove" cache (single-row JSON snapshot) -------------
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_recs (id INTEGER PRIMARY KEY CHECK (id=1), generated_at INTEGER, payload TEXT)`);
  function saveRecommendations(result) {
    db.prepare(`INSERT INTO inventory_recs (id, generated_at, payload) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET generated_at=excluded.generated_at, payload=excluded.payload`)
      .run(result.generatedAt || Date.now(), JSON.stringify(result));
  }
  function getRecommendations() {
    const row = db.prepare(`SELECT generated_at AS generatedAt, payload FROM inventory_recs WHERE id=1`).get();
    if (!row) return null;
    try { return { ...JSON.parse(row.payload), generatedAt: row.generatedAt }; } catch { return null; }
  }

  // ---- install / uninstall activity history --------------------------------
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_history (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
    name TEXT NOT NULL, action TEXT NOT NULL, version TEXT, result TEXT, detail TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_hist_ts ON inventory_history(ts)`);
  function recordHistory({ kind, name, action, version = null, result = 'ok', detail = null }) {
    db.prepare(`INSERT INTO inventory_history (ts, kind, name, action, version, result, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), kind, name, action, version, result, detail);
  }
  function history(limit = 100) {
    return db.prepare(`SELECT id, ts, kind, name, action, version, result, detail
      FROM inventory_history ORDER BY ts DESC LIMIT ?`).all(Math.min(limit, 500));
  }

  return { sync, search, counts, facets, lastSync, saveRecommendations, getRecommendations, recordHistory, history };
}
