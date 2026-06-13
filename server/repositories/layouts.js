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

  return {
    getActive, saveActive, resetActive,
    getPreset, savePreset, deletePreset, listPresets, getPageBundle,
  };
}
