/** RaPiSys — inventory repository: bulk sync + searchable, paginated reads. */

export function createInventoryRepo(db) {
  const upsert = db.prepare(`
    INSERT INTO inventory (kind, name, version, installed_at, source, status, last_used, meta)
    VALUES (@kind, @name, @version, @installedAt, @source, @status, @lastUsed, @meta)
    ON CONFLICT(kind, name) DO UPDATE SET
      version=excluded.version, status=excluded.status, source=excluded.source,
      installed_at=COALESCE(excluded.installed_at, inventory.installed_at),
      meta=excluded.meta`);

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
      });
    }
  });

  function search({ kind = null, q = '', limit = 50, offset = 0, sort = 'name' } = {}) {
    const where = [];
    const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (q) { where.push('name LIKE ?'); args.push(`%${q}%`); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = sort === 'installed' ? 'installed_at DESC NULLS LAST' : sort === 'status' ? 'status, name' : 'name';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM inventory ${wsql}`).get(...args).n;
    const rows = db.prepare(
      `SELECT kind, name, version, installed_at AS installedAt, source, status, last_used AS lastUsed, meta
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

  function lastSync() {
    return db.prepare(`SELECT MAX(installed_at) AS t FROM inventory`).get()?.t || null;
  }

  return { sync, search, counts, lastSync };
}
