/** RaPiSys — the sampler does not read a failed Docker listing as "all containers removed". */
import { describe, it, expect } from 'vitest';
import { createSampler } from '../server/services/sampler.js';

function harness() {
  const batches = [];
  const state = { ok: true, containers: [{ name: 'pihole', image: 'pihole/pihole', state: 'running' }] };
  const sampler = createSampler({
    metricsRepo: { writeBatch: (ts, rows) => batches.push(rows) },
    eventsRepo: { add: () => {} },
    hardware: { snapshot: async () => null, throttleTransitions: () => [] },
    containerHealth: () => new Map(),
    dockerListOk: () => state.ok,
    getStats: async () => ({ cpu: {}, memory: {}, load: {}, temperature: {}, containers: state.ok ? state.containers : [] }),
  });
  const last = () => Object.fromEntries(batches.at(-1).map((r) => [r.metric, r.value]));
  return { sampler, state, last };
}

describe('sampler and Docker read failures', () => {
  it('records a running container as up', async () => {
    const { sampler, last } = harness();
    await sampler.sampleOnce();
    expect(last()['docker.pihole.up']).toBe(1);
  });

  it('records nothing for containers while Docker cannot be read', async () => {
    const { sampler, state, last } = harness();
    await sampler.sampleOnce();
    state.ok = false;
    await sampler.sampleOnce();
    expect(last()).not.toHaveProperty('docker.pihole.up');
    expect(sampler.getContainers()[0].state).toBe('running');
  });

  it('still marks a container that really vanished as down', async () => {
    const { sampler, state, last } = harness();
    await sampler.sampleOnce();
    state.containers = [];
    await sampler.sampleOnce();
    expect(last()['docker.pihole.up']).toBe(0);
    expect(sampler.getContainers()[0].state).toBe('removed');
  });
});
