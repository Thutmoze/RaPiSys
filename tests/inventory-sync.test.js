/**
 * RaPiSys — inventory sync write volume.
 *
 * The sync used to delete and reinsert every row on each run, which froze the
 * event loop for tens of seconds against a network-mounted database. These
 * tests pin the contract that keeps it cheap: an unchanged sync must write
 * nothing at all, and a changed sync must write only what moved.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);

const { openDatabase } = await import('../server/core/db.js');
const { createInventoryRepo } = await import('../server/repositories/inventory.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-inv-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  return { db, repo: createInventoryRepo(db) };
}

const KINDS = ['package', 'service', 'container'];

function pkg(name, version, extra = {}) {
  return { kind: 'package', name, version, source: 'apt', status: 'installed', ...extra };
}

describe('inventory sync', () => {
  it('inserts everything on a first run', () => {
    const { repo } = tmpRepo();
    const w = repo.sync([pkg('nginx', '1.24'), pkg('curl', '8.5')], KINDS);
    expect(w).toMatchObject({ inserted: 2, updated: 0, removed: 0, unchanged: 0 });
    expect(repo.counts().package).toBe(2);
  });

  it('writes nothing when the second run is identical', () => {
    const { repo } = tmpRepo();
    const items = [pkg('nginx', '1.24'), pkg('curl', '8.5'), pkg('vim', '9.1')];
    repo.sync(items, KINDS);
    const w = repo.sync(items, KINDS);
    expect(w).toMatchObject({ inserted: 0, updated: 0, removed: 0, unchanged: 3 });
  });

  it('writes only the rows that changed', () => {
    const { repo } = tmpRepo();
    repo.sync([pkg('nginx', '1.24'), pkg('curl', '8.5'), pkg('vim', '9.1')], KINDS);
    const w = repo.sync([
      pkg('nginx', '1.25'),      // upgraded
      pkg('curl', '8.5'),        // untouched
      pkg('htop', '3.3'),        // newly installed
    ], KINDS);                   // vim removed
    expect(w).toMatchObject({ inserted: 1, updated: 1, removed: 1, unchanged: 1 });

    const rows = repo.search({ kind: 'package', limit: 50 }).rows;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['curl', 'htop', 'nginx']);
    expect(rows.find((r) => r.name === 'nginx').version).toBe('1.25');
  });

  it('treats a status flip as a change', () => {
    const { repo } = tmpRepo();
    const base = { kind: 'service', name: 'ssh', version: null, source: 'systemd' };
    repo.sync([{ ...base, status: 'active' }], KINDS);
    const w = repo.sync([{ ...base, status: 'inactive' }], KINDS);
    expect(w).toMatchObject({ inserted: 0, updated: 1, removed: 0 });
  });

  it('does not treat a missing install time as a change', () => {
    const { repo } = tmpRepo();
    repo.sync([pkg('nginx', '1.24', { installedAt: 1700000000 })], KINDS);
    const w = repo.sync([pkg('nginx', '1.24')], KINDS);
    expect(w).toMatchObject({ updated: 0, unchanged: 1 });
    const row = repo.search({ kind: 'package' }).rows[0];
    expect(row.installedAt).toBe(1700000000);   // preserved, not nulled out
  });

  it('collapses duplicate items from the collector', () => {
    const { repo } = tmpRepo();
    const w = repo.sync([pkg('nginx', '1.24'), pkg('nginx', '1.24')], KINDS);
    expect(w).toMatchObject({ inserted: 1, updated: 0 });
    expect(repo.counts().package).toBe(1);
  });

  it('leaves other kinds alone', () => {
    const { repo } = tmpRepo();
    repo.sync([pkg('nginx', '1.24')], ['package']);
    repo.sync([{ kind: 'userapp', name: 'thonny', version: '4.1' }], ['userapp']);
    const w = repo.sync([pkg('nginx', '1.24')], ['package']);
    expect(w).toMatchObject({ removed: 0, unchanged: 1 });
    expect(repo.counts().userapp).toBe(1);
  });
});
