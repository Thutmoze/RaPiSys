/** RaPiSys — peer poller tests (§14.3). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The poller's job is orchestration, not transport, so the probe is stubbed and
// the assertions cover what it records: health rows, the alertable metric, and
// transition events.
const probeResult = { current: null };
vi.mock('../server/services/peer-client.js', () => ({
  probePeer: async () => probeResult.current,
}));

const { createPeerPoller } = await import('../server/services/peer-poller.js');

function harness({ peers = [], unreachableMs = 0 } = {}) {
  const health = [];
  const metrics = [];
  const events = [];
  const pinned = new Map();

  const peersRepo = {
    list: () => peers,
    apiKeyFor: () => 'key',
    pinFingerprint: (id, fp) => pinned.set(id, fp),
    recordHealth: (row) => health.push(row),
    unreachableSince: () => unreachableMs,
    pruneHealth: () => { events.push({ type: 'pruned' }); },
  };
  const metricsRepo = { writeBatch: (ts, samples) => metrics.push(...samples) };
  const eventsRepo = { add: (type, severity, payload) => events.push({ type, severity, payload }) };

  return {
    poller: createPeerPoller({ peersRepo, metricsRepo, eventsRepo }),
    health, metrics, events, pinned,
  };
}

const PEER = { id: 1, name: 'rapi-02', baseUrl: 'https://rapi-02.local:3443', certFingerprint: 'AA:BB', enabled: true };

beforeEach(() => { probeResult.current = null; });

describe('peer poller', () => {
  it('writes peer.<name>.up = 1 for a reachable peer', async () => {
    probeResult.current = { ok: true, state: 'ok', latencyMs: 12, json: { cpu: { usage: 5 } } };
    const h = harness({ peers: [PEER] });
    await h.poller.pollAll();

    expect(h.metrics).toEqual([{ metric: 'peer.rapi-02.up', value: 1 }]);
    expect(h.health[0].reachable).toBe(true);
    expect(h.health[0].snapshot).toEqual({ cpu: { usage: 5 } });
  });

  it('writes peer.<name>.up = 0 for an unreachable peer, and stores no snapshot', async () => {
    probeResult.current = { ok: false, state: 'unreachable', latencyMs: 6000, error: 'no response within 6s' };
    const h = harness({ peers: [PEER] });
    await h.poller.pollAll();

    expect(h.metrics).toEqual([{ metric: 'peer.rapi-02.up', value: 0 }]);
    expect(h.health[0].reachable).toBe(false);
    expect(h.health[0].snapshot).toBeNull();
  });

  it('writes the metric on every cycle, not only on failure', async () => {
    // A rule with a sustain window needs a continuous series to evaluate; gaps
    // would read as "metric not collected" and silently skip the rule.
    probeResult.current = { ok: true, state: 'ok', latencyMs: 5, json: {} };
    const h = harness({ peers: [PEER] });
    await h.poller.pollAll();
    await h.poller.pollAll();
    await h.poller.pollAll();
    expect(h.metrics).toHaveLength(3);
    expect(h.metrics.every((m) => m.value === 1)).toBe(true);
  });

  it('emits an event on the down transition, then stays quiet', async () => {
    const h = harness({ peers: [PEER] });
    probeResult.current = { ok: true, state: 'ok', latencyMs: 5, json: {} };
    await h.poller.pollAll();                       // establishes 'ok'
    probeResult.current = { ok: false, state: 'unreachable', latencyMs: 6000, error: 'gone' };
    await h.poller.pollAll();                       // transition -> one event
    await h.poller.pollAll();                       // still down -> no repeat

    const down = h.events.filter((e) => e.type === 'peer.unreachable');
    expect(down).toHaveLength(1);
    expect(down[0].payload.name).toBe('rapi-02');
  });

  it('emits a recovery event when the peer comes back', async () => {
    const h = harness({ peers: [PEER] });
    probeResult.current = { ok: true, state: 'ok', latencyMs: 5, json: {} };
    await h.poller.pollAll();
    probeResult.current = { ok: false, state: 'unreachable', latencyMs: 6000 };
    await h.poller.pollAll();
    probeResult.current = { ok: true, state: 'ok', latencyMs: 7, json: {} };
    await h.poller.pollAll();

    expect(h.events.some((e) => e.type === 'peer.reachable')).toBe(true);
  });

  it('raises a critical event for a changed certificate', async () => {
    probeResult.current = { ok: false, state: 'cert-changed', fingerprint: 'ZZ:ZZ', error: 'cert changed' };
    const h = harness({ peers: [PEER] });
    await h.poller.pollAll();

    const ev = h.events.find((e) => e.type === 'peer.cert_changed');
    expect(ev).toBeTruthy();
    expect(ev.severity).toBe('critical');
  });

  it('never auto-re-pins a changed certificate', async () => {
    // Accepting a new fingerprint silently would defeat the point of pinning:
    // re-confirmation has to be an explicit operator action.
    probeResult.current = { ok: false, state: 'cert-changed', fingerprint: 'ZZ:ZZ' };
    const h = harness({ peers: [PEER] });
    await h.poller.pollAll();
    expect(h.pinned.has(PEER.id)).toBe(false);
  });

  it('pins on first use when nothing is pinned yet', async () => {
    probeResult.current = { ok: true, state: 'ok', latencyMs: 5, json: {}, pin: 'NEW:FP' };
    const h = harness({ peers: [{ ...PEER, certFingerprint: null }] });
    await h.poller.pollAll();
    expect(h.pinned.get(PEER.id)).toBe('NEW:FP');
  });

  it('escalates once when a peer has been down past the sustained mark', async () => {
    probeResult.current = { ok: false, state: 'unreachable', latencyMs: 6000 };
    const h = harness({ peers: [PEER], unreachableMs: 6 * 60 * 1000 });
    await h.poller.pollAll();   // transition event
    await h.poller.pollAll();   // same state, past threshold -> sustained event

    expect(h.events.filter((e) => e.type === 'peer.unreachable_sustained')).toHaveLength(1);
  });

  it('skips disabled peers', async () => {
    probeResult.current = { ok: true, state: 'ok', latencyMs: 5, json: {} };
    const h = harness({ peers: [{ ...PEER, enabled: false }] });
    const out = await h.poller.pollAll();
    expect(out.polled).toBe(0);
    expect(h.metrics).toHaveLength(0);
  });

  it('is a no-op when no peers are configured', async () => {
    const h = harness({ peers: [] });
    expect(await h.poller.pollAll()).toEqual({ polled: 0 });
  });

  it('polls peers in parallel so one dead node cannot delay the rest', async () => {
    probeResult.current = { ok: true, state: 'ok', latencyMs: 5, json: {} };
    const many = Array.from({ length: 5 }, (_, i) => ({ ...PEER, id: i + 1, name: `n${i}` }));
    const h = harness({ peers: many });
    const out = await h.poller.pollAll();
    expect(out.polled).toBe(5);
    expect(out.ok).toBe(5);
    expect(h.metrics).toHaveLength(5);
  });
});

describe('metric catalog', () => {
  it('labels and groups the peer metric, and treats it as a status metric', async () => {
    const { describeMetric, isStatusMetric } = await import('../server/core/metric-catalog.js');
    const d = describeMetric('peer.rapi-02.up');
    expect(d.group).toBe('Nodes');
    expect(d.label).toContain('rapi-02');
    expect(isStatusMetric('peer.rapi-02.up')).toBe(true);
    // Existing keys must keep their groups.
    expect(describeMetric('temp.cpu').group).toBe('Thermal & power');
    expect(describeMetric('service.dns.up').group).toBe('Services');
  });
});
