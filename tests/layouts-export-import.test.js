/** RaPiSys — portable dashboard export / import (patch 0294) tests. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createLayoutsRepo } = await import('../server/repositories/layouts.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-lx-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  return createLayoutsRepo(db);
}

const P = (id, x = 0, y = 0, w = 3, h = 12, visible = true) => ({ id, x, y, w, h, visible });

/** A node with the built-in tab plus two custom ones, all with saved layouts. */
function seeded() {
  const r = repo();
  r.saveActive('overview', [P('cpu'), P('memory', 3)]);
  const a = r.addDashboard('System', 'cpu');
  r.saveActive(r.pageForDashboard(a.id), [P('temp'), P('sum-power', 3)]);
  const b = r.addDashboard('Net Watch', 'network');
  r.saveActive(r.pageForDashboard(b.id), [P('network', 0, 0, 12, 20)]);
  return { r, a, b };
}

describe('export', () => {
  it('bundles every tab with its layout by default', () => {
    const { r } = seeded();
    const bundle = r.exportBundle();
    expect(bundle.kind).toBe('rapisys.dashboards');
    expect(bundle.version).toBe(1);
    expect(bundle.dashboards.map((d) => d.name)).toEqual(['Overview', 'System', 'Net Watch']);
    expect(bundle.dashboards[0].layout).toHaveLength(2);
    expect(bundle.dashboards[2].layout[0].id).toBe('network');
  });

  it('honours an id subset and drops the active pointer when it is excluded', () => {
    const { r, a } = seeded();
    const bundle = r.exportBundle([a.id]);
    expect(bundle.dashboards).toHaveLength(1);
    expect(bundle.dashboards[0].name).toBe('System');
    expect(bundle.active).toBeNull();
  });

  it('reads the built-in tab through its legacy overview page key', () => {
    const { r } = seeded();
    const d = r.exportBundle(['default']).dashboards[0];
    expect(d.id).toBe('default');
    expect(d.layout.map((p) => p.id)).toEqual(['cpu', 'memory']);
  });

  it('emits an empty layout for a tab still on the default arrangement', () => {
    const r = repo();
    const d = r.addDashboard('Fresh', null);
    const found = r.exportBundle([d.id]).dashboards[0];
    expect(found.layout).toEqual([]);
  });
});

describe('import: merge', () => {
  it('appends imported tabs and leaves existing ones untouched', () => {
    const src = seeded();
    const bundle = src.r.exportBundle();
    const dst = repo();
    dst.saveActive('overview', [P('disk')]);

    const out = dst.importBundle(bundle, { mode: 'merge' });
    expect(out.tabs).toBe(3);
    const { dashboards } = dst.listDashboards();
    expect(dashboards).toHaveLength(4);              // built-in + three imported
    expect(dst.getActive('overview').map((p) => p.id)).toEqual(['disk']);   // untouched
    expect(dashboards.map((d) => d.name)).toEqual(['Overview', 'Overview', 'System', 'Net Watch']);
  });

  it('mints fresh ids so a repeat import duplicates rather than overwrites', () => {
    const src = seeded();
    const bundle = src.r.exportBundle();
    const dst = repo();
    dst.importBundle(bundle, { mode: 'merge' });
    dst.importBundle(bundle, { mode: 'merge' });
    const names = dst.listDashboards().dashboards.map((d) => d.name);
    expect(names.filter((n) => n === 'System')).toHaveLength(2);
    const ids = dst.listDashboards().dashboards.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('import: replace', () => {
  it('wipes local tabs and restores the bundle exactly', () => {
    const src = seeded();
    const bundle = src.r.exportBundle();
    const dst = repo();
    dst.addDashboard('Local only', null);
    dst.saveActive('overview', [P('processes')]);

    const out = dst.importBundle(bundle, { mode: 'replace' });
    expect(out.tabs).toBe(3);
    const { dashboards, active } = dst.listDashboards();
    expect(dashboards.map((d) => d.name)).toEqual(['Overview', 'System', 'Net Watch']);
    expect(dashboards.some((d) => d.name === 'Local only')).toBe(false);
    expect(active).toBe('default');
    expect(dst.getActive('overview').map((p) => p.id)).toEqual(['cpu', 'memory']);
  });

  it('keeps the built-in row alive and rewrites it from the first tab', () => {
    const src = seeded();
    const bundle = src.r.exportBundle();
    const dst = repo();
    dst.importBundle(bundle, { mode: 'replace' });
    const built = dst.listDashboards().dashboards.find((d) => d.id === 'default');
    expect(built).toBeDefined();
    expect(dst.deleteDashboard('default')).toBe(false);
  });
});

describe('import: validation and widget availability', () => {
  it('skips widgets this node does not have and reports them', () => {
    const src = seeded();
    src.r.saveActive('overview', [P('cpu'), P('sum-case'), P('memory', 3)]);
    const bundle = src.r.exportBundle(['default']);

    const dst = repo();
    const out = dst.importBundle(bundle, { mode: 'merge', available: ['cpu', 'memory'] });
    expect(out.skipped).toEqual(['sum-case']);
    expect(out.widgets).toBe(2);
    const page = dst.pageForDashboard(dst.listDashboards().dashboards[1].id);
    expect(dst.getActive(page).map((p) => p.id)).toEqual(['cpu', 'memory']);
  });

  it('keeps every widget when no availability list is supplied', () => {
    const src = seeded();
    src.r.saveActive('overview', [P('cpu'), P('sum-case')]);
    const dst = repo();
    const out = dst.importBundle(src.r.exportBundle(['default']), { mode: 'merge' });
    expect(out.skipped).toEqual([]);
    expect(out.widgets).toBe(2);
  });

  it('rejects a foreign file, a bad version, and an empty bundle', () => {
    const r = repo();
    expect(() => r.importBundle({ kind: 'something.else', dashboards: [] })).toThrow(/not a RaPiSys/);
    expect(() => r.importBundle({ kind: 'rapisys.dashboards', version: 99, dashboards: [{ name: 'x' }] }))
      .toThrow(/unsupported bundle version/);
    expect(() => r.importBundle({ kind: 'rapisys.dashboards', version: 1, dashboards: [] }))
      .toThrow(/no dashboards/);
  });

  it('leaves the database unchanged when an import throws midway', () => {
    const r = repo();
    r.saveActive('overview', [P('cpu')]);
    const before = r.listDashboards().dashboards.length;
    expect(() => r.importBundle({ kind: 'rapisys.dashboards', version: 1, dashboards: null })).toThrow();
    expect(r.listDashboards().dashboards).toHaveLength(before);
    expect(r.getActive('overview').map((p) => p.id)).toEqual(['cpu']);
  });
});

describe('round trip', () => {
  it('survives export then replace-import with identical placements', () => {
    const src = seeded();
    const bundle = JSON.parse(JSON.stringify(src.r.exportBundle()));   // as it would travel on disk
    const dst = repo();
    dst.importBundle(bundle, { mode: 'replace' });
    const back = dst.exportBundle();
    expect(back.dashboards.map((d) => ({ name: d.name, glyph: d.glyph, layout: d.layout })))
      .toEqual(bundle.dashboards.map((d) => ({ name: d.name, glyph: d.glyph, layout: d.layout })));
  });
});
