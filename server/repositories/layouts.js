/** RaPiSys — dashboard layout repository.
 *
 * Single-admin model: layouts are global (auth-gated for writes). A "layout" is
 * a JSON array of widget placements: [{ id, x, y, w, h, visible }].
 *
 * Two scopes are stored in the same table, distinguished by the `name` column:
 *   - the ACTIVE layout for a page uses name = '' (empty string)
 *   - named presets use name = 'ops' | 'network' | 'kiosk' | <user preset>
 * The built-in "default" preset is NOT stored — an empty/missing layout means
 * "use the upstream default positions", so the dashboard is pixel-identical
 * out of the box and resetting is just a delete.
 */
export function createLayoutsRepo(db) {
  // The 001 migration created layouts(page PRIMARY KEY, layout). Widen it to a
  // (page, name) composite so we can store the active layout plus named presets.
  // Done idempotently so existing single-key rows are preserved.
  const cols = db.prepare(`PRAGMA table_info(layouts)`).all().map((c) => c.name);
  if (!cols.includes('name')) {
    db.exec('BEGIN');
    try {
      db.exec(`ALTER TABLE layouts RENAME TO layouts_old`);
      db.exec(`CREATE TABLE layouts (
        page    TEXT NOT NULL,
        name    TEXT NOT NULL DEFAULT '',   -- '' = active layout, else preset name
        layout  TEXT NOT NULL,              -- JSON [{id,x,y,w,h,visible}]
        updated_at INTEGER,
        PRIMARY KEY (page, name)
      )`);
      db.exec(`INSERT INTO layouts (page, name, layout, updated_at)
               SELECT page, '', layout, ${Date.now()} FROM layouts_old`);
      db.exec(`DROP TABLE layouts_old`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const getStmt = db.prepare(`SELECT layout FROM layouts WHERE page = ? AND name = ?`);
  const upsertStmt = db.prepare(`
    INSERT INTO layouts (page, name, layout, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(page, name) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`);
  const delStmt = db.prepare(`DELETE FROM layouts WHERE page = ? AND name = ?`);
  const listPresetsStmt = db.prepare(`SELECT DISTINCT name FROM layouts WHERE name <> '' ORDER BY name`);

  /** Active layout for a page (or null → upstream default). */
  function getActive(page) {
    const row = getStmt.get(page, '');
    return row ? JSON.parse(row.layout) : null;
  }
  /** Save the active layout for a page. */
  function saveActive(page, layout) {
    upsertStmt.run(page, '', JSON.stringify(layout), Date.now());
  }
  /** Reset a page to upstream default (delete the stored active layout). */
  function resetActive(page) {
    delStmt.run(page, '');
  }
  /** A named preset's layout, or null. */
  function getPreset(page, name) {
    const row = getStmt.get(page, name);
    return row ? JSON.parse(row.layout) : null;
  }
  /** Save a named preset. */
  function savePreset(page, name, layout) {
    if (!name) throw new Error('preset name required');
    upsertStmt.run(page, name, JSON.stringify(layout), Date.now());
  }
  function deletePreset(page, name) {
    if (!name) return;
    delStmt.run(page, name);
  }
  /** All preset names that exist for any page. */
  function listPresets() {
    return listPresetsStmt.all().map((r) => r.name);
  }
  /** Everything for a page: active + all presets (used by the editor). */
  function getPageBundle(page) {
    const rows = db.prepare(`SELECT name, layout FROM layouts WHERE page = ?`).all(page);
    const out = { active: null, presets: {} };
    for (const r of rows) {
      if (r.name === '') out.active = JSON.parse(r.layout);
      else out.presets[r.name] = JSON.parse(r.layout);
    }
    return out;
  }

  // ---- Overview dashboards registry ----------------------------------------
  // A user can keep several named Overview dashboards, each with its own layout
  // stored under page='overview:<id>'. This table tracks the list + order + the
  // currently-selected one. The built-in 'default' dashboard maps to the legacy
  // page='overview' layout so existing single-dashboard setups are preserved.
  db.exec(`CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS dashboard_meta (k TEXT PRIMARY KEY, v TEXT)`);
  // add glyph column if upgrading from an older schema
  try { db.exec(`ALTER TABLE dashboards ADD COLUMN glyph TEXT`); } catch { /* already exists */ }
  // Ensure the built-in default always exists (maps to the legacy overview page).
  db.prepare(`INSERT OR IGNORE INTO dashboards (id, name, glyph, sort, created_at) VALUES ('default','Overview','overview',0,?)`).run(Date.now());

  function listDashboards() {
    const rows = db.prepare(`SELECT id, name, glyph FROM dashboards ORDER BY sort, created_at`).all();
    const active = db.prepare(`SELECT v FROM dashboard_meta WHERE k='active'`).get()?.v || rows[0].id;
    return { dashboards: rows, active };
  }
  function addDashboard(name, glyph) {
    const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const maxSort = db.prepare(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM dashboards`).get().s;
    db.prepare(`INSERT INTO dashboards (id, name, glyph, sort, created_at) VALUES (?,?,?,?,?)`)
      .run(id, String(name || 'New dashboard').slice(0, 40), glyph || null, maxSort, Date.now());
    return { id, name, glyph: glyph || null };
  }
  function renameDashboard(id, name, glyph) {
    if (glyph !== undefined) {
      db.prepare(`UPDATE dashboards SET name=?, glyph=? WHERE id=?`).run(String(name || '').slice(0, 40), glyph || null, id);
    } else {
      db.prepare(`UPDATE dashboards SET name=? WHERE id=?`).run(String(name || '').slice(0, 40), id);
    }
  }
  function deleteDashboard(id) {
    if (id === 'default') return false;   // built-in cannot be deleted
    db.prepare(`DELETE FROM dashboards WHERE id=?`).run(id);
    db.prepare(`DELETE FROM layouts WHERE page=?`).run(`overview:${id}`);
    const cur = db.prepare(`SELECT v FROM dashboard_meta WHERE k='active'`).get()?.v;
    if (cur === id) db.prepare(`INSERT INTO dashboard_meta (k,v) VALUES ('active','default') ON CONFLICT(k) DO UPDATE SET v='default'`).run();
    return true;
  }
  // Reorder: given an array of ids in the desired order, rewrite sort indices.
  // Any existing dashboard not in the list keeps its relative order after these.
  function reorderDashboards(ids) {
    if (!Array.isArray(ids)) return;
    const upd = db.prepare(`UPDATE dashboards SET sort=? WHERE id=?`);
    const tx = db.transaction((list) => { list.forEach((id, i) => upd.run(i, id)); });
    tx(ids.filter((x) => typeof x === 'string'));
  }
  function setActiveDashboard(id) {
    db.prepare(`INSERT INTO dashboard_meta (k,v) VALUES ('active',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(id);
  }
  // Map a dashboard id to its layouts-table page key ('default' → legacy 'overview').
  function pageForDashboard(id) { return id === 'default' ? 'overview' : `overview:${id}`; }

  // ---- Portable export / import (patch 0294) -------------------------------
  // A bundle is the whole "Tabs & Widgets" arrangement in one JSON object: the
  // dashboard tabs plus each tab's widget placements. Nothing else travels with
  // it — no credentials, no metrics, no history — so it is safe to move between
  // nodes or keep as a plain backup file.
  const BUNDLE_KIND = 'rapisys.dashboards';
  const BUNDLE_VERSION = 1;

  /**
   * Build a bundle from the tabs named in `ids` (all tabs when omitted).
   * Layout arrays are read through pageForDashboard so the built-in tab's
   * legacy page='overview' row is picked up alongside the 'overview:<id>' rows.
   */
  function exportBundle(ids = null) {
    const { dashboards, active } = listDashboards();
    const want = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const picked = dashboards.filter((d) => !want || want.has(d.id));
    return {
      kind: BUNDLE_KIND,
      version: BUNDLE_VERSION,
      exportedAt: Date.now(),
      active: picked.some((d) => d.id === active) ? active : null,
      dashboards: picked.map((d, i) => ({
        id: d.id,
        name: d.name,
        glyph: d.glyph || null,
        sort: i,
        layout: getActive(pageForDashboard(d.id)) || [],
      })),
    };
  }

  /**
   * Apply a bundle.
   *
   * mode 'merge'   — every incoming tab is appended under a freshly minted id,
   *                  so nothing already on this node is touched and re-importing
   *                  the same file twice gives you two copies rather than a
   *                  silent overwrite.
   * mode 'replace' — every tab and layout is dropped first, then the bundle is
   *                  restored with its original ids. The built-in 'default' row
   *                  is never deleted (deleteDashboard refuses it and the rest
   *                  of the app assumes it exists); it is rewritten in place
   *                  from the bundle's first tab instead.
   *
   * `available` is the caller's set of widget ids this node actually has. Any
   * placement outside it is dropped rather than stored as a dead entry, and the
   * dropped ids come back in the result so the UI can report them.
   */
  function importBundle(bundle, { mode = 'merge', available = null } = {}) {
    if (!bundle || bundle.kind !== BUNDLE_KIND) throw new Error('not a RaPiSys dashboard export');
    if (Number(bundle.version) !== BUNDLE_VERSION) throw new Error(`unsupported bundle version ${bundle.version}`);
    if (!Array.isArray(bundle.dashboards) || !bundle.dashboards.length) throw new Error('bundle contains no dashboards');
    if (bundle.dashboards.length > 50) throw new Error('too many dashboards');

    const have = available instanceof Set ? available : (Array.isArray(available) ? new Set(available) : null);
    const skipped = new Set();
    const keep = (layout) => (Array.isArray(layout) ? layout : []).filter((p) => {
      if (!have || have.has(p.id)) return true;
      skipped.add(p.id);
      return false;
    });

    const run = db.transaction(() => {
      const result = { mode, tabs: 0, widgets: 0 };

      if (mode === 'replace') {
        db.prepare(`DELETE FROM layouts WHERE page = 'overview' OR page LIKE 'overview:%'`).run();
        db.prepare(`DELETE FROM dashboards WHERE id <> 'default'`).run();
      }

      const baseSort = mode === 'replace'
        ? 0
        : db.prepare(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM dashboards`).get().s;

      bundle.dashboards.forEach((d, i) => {
        const name = String(d.name || 'Imported').slice(0, 40);
        const glyph = d.glyph || null;
        const layout = keep(d.layout);
        let id;

        if (mode === 'replace' && i === 0) {
          // First incoming tab takes over the built-in row.
          id = 'default';
          db.prepare(`UPDATE dashboards SET name=?, glyph=?, sort=? WHERE id='default'`).run(name, glyph, baseSort + i);
        } else if (mode === 'replace') {
          id = String(d.id || '') && d.id !== 'default' ? String(d.id) : addDashboard(name, glyph).id;
          db.prepare(`INSERT OR REPLACE INTO dashboards (id, name, glyph, sort, created_at) VALUES (?,?,?,?,?)`)
            .run(id, name, glyph, baseSort + i, Date.now());
        } else {
          // Merge always mints a new id, so an incoming tab can never collide
          // with or overwrite one already here.
          id = addDashboard(name, glyph).id;
          db.prepare(`UPDATE dashboards SET sort=? WHERE id=?`).run(baseSort + i, id);
        }

        if (layout.length) saveActive(pageForDashboard(id), layout);
        result.tabs += 1;
        result.widgets += layout.length;
      });

      if (mode === 'replace') setActiveDashboard('default');
      result.skipped = [...skipped];
      return result;
    });

    return run();
  }

  return {
    getActive, saveActive, resetActive,
    getPreset, savePreset, deletePreset, listPresets, getPageBundle,
    listDashboards, addDashboard, renameDashboard, deleteDashboard, reorderDashboards, setActiveDashboard, pageForDashboard,
    exportBundle, importBundle,
  };
}
