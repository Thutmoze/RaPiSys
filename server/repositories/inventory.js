/** RaPiSys — inventory repository: bulk sync + searchable, paginated reads. */

export function createInventoryRepo(db) {
  const upsert = db.prepare(`
    INSERT INTO inventory (kind, name, version, installed_at, source, status, last_used, meta, category, priority, section)
    VALUES (@kind, @name, @version, @installedAt, @source, @status, @lastUsed, @meta, @category, @priority, @section)
    ON CONFLICT(kind, name) DO UPDATE SET
      version=excluded.version, status=excluded.status, source=excluded.source,
      installed_at=COALESCE(excluded.installed_at, inventory.installed_at),
      meta=excluded.meta, category=excluded.category, priority=excluded.priority, section=excluded.section`);

  /** Replace the whole inventory for the given kinds in one transaction. */
  const sync = db.transaction((items, kinds) => {
    const ph = kinds.map(() => '?').join(',');
    db.prepare(`DELETE FROM inventory WHERE kind IN (${ph})`).run(...kinds);
    for (const it of items) {
      upsert.run({
        kind: it.kind, name: it.name, version: it.version ?? null,
        installedAt: it.installedAt ?? null, source: it.source ?? null,
        status: it.status ?? null, lastUsed: it.lastUsed ?? null,
        meta: it.meta ? JSON.stringify(it.meta) : null,
        category: it.category ?? null, priority: it.meta?.priority ?? null, section: it.meta?.section ?? null,
      });
    }
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
