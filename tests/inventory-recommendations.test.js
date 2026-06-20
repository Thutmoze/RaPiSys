/** RaPiSys — inventory "recommended to remove" analyzer tests. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = process.env.SECRET_KEY || 'a'.repeat(64);

// Mock the agent client so we can feed controlled package/service/orphan data.
const agentResponses = {};
vi.mock('../server/core/agent-client.js', () => ({
  agentConfigured: () => true,
  agentCall: (op) => Promise.resolve(agentResponses[op] ?? {}),
  agentAvailable: () => Promise.resolve(true),
}));

// Docker socket isn't present in CI; the collector's dockerApiGet resolves null
// on connection error, which the analyzer treats as "no containers".
const { createInventoryCollector } = await import('../server/collectors/inventory.js');

describe('inventory recommendations', () => {
  beforeEach(() => {
    for (const k of Object.keys(agentResponses)) delete agentResponses[k];
  });

  it('flags orphaned packages as safe', async () => {
    agentResponses['inventory.packages'] = { packages: [
      { name: 'libfoo1', version: '1.0', installedAt: Date.now(), sizeKB: 100, priority: 'optional', section: 'libs' },
      { name: 'oldtool', version: '2.0', installedAt: Date.now(), sizeKB: 200, priority: 'optional', section: 'utils' },
    ] };
    agentResponses['inventory.services'] = { services: [] };
    agentResponses['inventory.autoremovable'] = { packages: ['libfoo1'] };

    const inv = createInventoryCollector();
    const { recommendations, counts } = await inv.recommendations();
    const orphan = recommendations.find((r) => r.name === 'libfoo1');
    expect(orphan).toBeTruthy();
    expect(orphan.reason).toBe('orphaned');
    expect(orphan.severity).toBe('safe');
    expect(counts.safe).toBeGreaterThanOrEqual(1);
  });

  it('flags failed and inactive services for review', async () => {
    agentResponses['inventory.packages'] = { packages: [] };
    agentResponses['inventory.autoremovable'] = { packages: [] };
    agentResponses['inventory.services'] = { services: [
      { name: 'broken', load: 'loaded', active: 'failed', sub: 'failed', description: 'A broken unit' },
      { name: 'idle', load: 'loaded', active: 'inactive', sub: 'dead', description: 'An idle unit' },
      { name: 'running', load: 'loaded', active: 'active', sub: 'running', description: 'A healthy unit' },
    ] };

    const inv = createInventoryCollector();
    const { recommendations } = await inv.recommendations();
    const names = recommendations.map((r) => r.name);
    expect(names).toContain('broken');
    expect(names).toContain('idle');
    expect(names).not.toContain('running');           // healthy services are not recommended
    expect(recommendations.find((r) => r.name === 'broken').reason).toBe('failed');
  });

  it('never recommends kernel/firmware packages even when apt lists them as orphans', async () => {
    agentResponses['inventory.packages'] = { packages: [
      { name: 'linux-image-6.12.75+rpt-rpi-2712', version: '1', installedAt: Date.now(), sizeKB: 90000, priority: 'optional', section: 'kernel' },
      { name: 'oldlib', version: '1', installedAt: Date.now(), sizeKB: 100, priority: 'optional', section: 'utils' },
    ] };
    agentResponses['inventory.services'] = { services: [] };
    // apt reports the kernel AND a normal lib as autoremovable
    agentResponses['inventory.autoremovable'] = { packages: ['linux-image-6.12.75+rpt-rpi-2712', 'oldlib'] };

    const inv = createInventoryCollector();
    const { recommendations } = await inv.recommendations();
    const names = recommendations.map((r) => r.name);
    expect(names).not.toContain('linux-image-6.12.75+rpt-rpi-2712');   // kernels are protected
    expect(names).toContain('oldlib');                                  // normal orphan still suggested
  });

  it('does not recommend essential/system packages even if large and old', async () => {
    const old = Date.now() - 400 * 86400e3;
    agentResponses['inventory.packages'] = { packages: [
      { name: 'systemd', version: '1', installedAt: old, sizeKB: 80000, priority: 'required', essential: true, section: 'admin' },
    ] };
    agentResponses['inventory.services'] = { services: [] };
    agentResponses['inventory.autoremovable'] = { packages: [] };

    const inv = createInventoryCollector();
    const { recommendations } = await inv.recommendations();
    expect(recommendations.find((r) => r.name === 'systemd')).toBeFalsy();
  });
});

describe('inventory recommendations cache', () => {
  it('persists and returns the recommendations snapshot', async () => {
    const { openDatabase } = await import('../server/core/db.js');
    const { createInventoryRepo } = await import('../server/repositories/inventory.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-rec-'));
    const handle = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const repo = createInventoryRepo(handle.db);
    expect(repo.getRecommendations()).toBeNull();
    const snap = { recommendations: [{ kind: 'package', name: 'libfoo1', reason: 'orphaned', severity: 'safe' }],
      counts: { total: 1, safe: 1, review: 0 }, generatedAt: 1700000000000 };
    repo.saveRecommendations(snap);
    const got = repo.getRecommendations();
    expect(got.recommendations).toHaveLength(1);
    expect(got.recommendations[0].name).toBe('libfoo1');
    expect(got.generatedAt).toBe(1700000000000);
    // upsert (single row) overwrites
    repo.saveRecommendations({ recommendations: [], counts: { total: 0, safe: 0, review: 0 }, generatedAt: 1700000001000 });
    expect(repo.getRecommendations().recommendations).toHaveLength(0);
  });

  it('records and returns install/uninstall activity history (newest first)', async () => {
    const { openDatabase } = await import('../server/core/db.js');
    const { createInventoryRepo } = await import('../server/repositories/inventory.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-hist-'));
    const handle = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const repo = createInventoryRepo(handle.db);
    expect(repo.history()).toHaveLength(0);
    repo.recordHistory({ kind: 'package', name: 'python3-flask', action: 'uninstall', detail: 'with 5 dependent package(s)' });
    repo.recordHistory({ kind: 'package', name: 'python3-flask', action: 'install', result: 'ok' });
    const h = repo.history();
    expect(h).toHaveLength(2);
    expect(h[0].action).toBe('install');         // newest first
    expect(h[1].action).toBe('uninstall');
    expect(h[1].detail).toContain('5 dependent');
  });
});
