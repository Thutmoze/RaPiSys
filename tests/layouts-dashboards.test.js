/** RaPiSys — dashboards registry (multiple Overview dashboards) tests. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createLayoutsRepo } = await import('../server/repositories/layouts.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-dash-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  return createLayoutsRepo(db);
}

describe('dashboards registry', () => {
  it('seeds a built-in default mapped to the legacy overview page', () => {
    const r = repo();
    const { dashboards, active } = r.listDashboards();
    expect(dashboards.length).toBe(1);
    expect(dashboards[0].id).toBe('default');
    expect(active).toBe('default');
    expect(r.pageForDashboard('default')).toBe('overview');
    expect(r.pageForDashboard('dXYZ')).toBe('overview:dXYZ');
  });

  it('adds a dashboard with a glyph and persists it', () => {
    const r = repo();
    const d = r.addDashboard('Network View', 'network');
    expect(d.id).toMatch(/^d/);
    const found = r.listDashboards().dashboards.find((x) => x.id === d.id);
    expect(found.name).toBe('Network View');
    expect(found.glyph).toBe('network');
  });

  it('renames and changes glyph; can clear the glyph', () => {
    const r = repo();
    const d = r.addDashboard('A', 'hardware');
    r.renameDashboard(d.id, 'B', 'sessions');
    let f = r.listDashboards().dashboards.find((x) => x.id === d.id);
    expect(f.name).toBe('B'); expect(f.glyph).toBe('sessions');
    r.renameDashboard(d.id, 'B', null);
    f = r.listDashboards().dashboards.find((x) => x.id === d.id);
    expect(f.glyph).toBeNull();
  });

  it('reorders dashboards by id list', () => {
    const r = repo();
    const a = r.addDashboard('A');
    const b = r.addDashboard('B');
    const c = r.addDashboard('C');
    // default, A, B, C initially
    r.reorderDashboards([c.id, a.id, b.id, 'default']);
    const ids = r.listDashboards().dashboards.map((x) => x.id);
    expect(ids).toEqual([c.id, a.id, b.id, 'default']);
  });

  it('refuses to delete the built-in default; deletes others and repoints active', () => {
    const r = repo();
    const d = r.addDashboard('Temp');
    r.setActiveDashboard(d.id);
    expect(r.deleteDashboard('default')).toBe(false);
    expect(r.deleteDashboard(d.id)).toBe(true);
    expect(r.listDashboards().active).toBe('default');
  });
});
