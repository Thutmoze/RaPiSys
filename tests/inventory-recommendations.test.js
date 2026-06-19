/** RaPiSys — inventory "recommended to remove" analyzer tests. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
