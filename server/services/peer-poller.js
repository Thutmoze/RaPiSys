/**
 * RaPiSys — peer poller (§14.3 multi-node federation).
 * ===================================================
 * Polls every enabled peer on a fixed cadence, caches the result in
 * peer_health, and emits a `peer.<name>.up` metric.
 *
 * Emitting a metric rather than inventing a bespoke alert condition is the
 * whole trick: `peer.<name>.up` sits alongside `service.<name>.up` and
 * `docker.<name>.up`, so the existing rule engine already provides the sustain
 * window ("unreachable for 5 minutes"), cooldown, severity and channels with no
 * change to alerting.js. That is what makes the surviving node able to tell you
 * over Telegram or email that the other one died — the capability a dormant
 * standby structurally could not provide.
 *
 * Polling is server-side by design: the browser only ever calls its own node,
 * so there is no CORS surface and no cross-node session.
 */

import { probePeer } from './peer-client.js';

/** How long a peer must be gone before it is worth an event (not an alert). */
const EVENT_AFTER_MS = 5 * 60 * 1000;

export function createPeerPoller({ peersRepo, metricsRepo, eventsRepo }) {
  // Last state per peer id, so events fire on transitions rather than every cycle.
  const lastState = new Map();

  /** Poll one peer. Returns the recorded state. */
  async function pollOne(peer) {
    const probe = await probePeer({
      baseUrl: peer.baseUrl,
      apiKey: peersRepo.apiKeyFor(peer.id),
      expectedFingerprint: peer.certFingerprint || null,
    });

    // Trust on first use: pin only when nothing is pinned yet. A changed
    // fingerprint is never auto-accepted here — that requires an explicit
    // re-test from the operator, so a silent substitution cannot re-pin itself.
    if (probe.pin && !peer.certFingerprint) {
      peersRepo.pinFingerprint(peer.id, probe.pin);
    }

    const ts = Date.now();
    peersRepo.recordHealth({
      peerId: peer.id,
      ts,
      reachable: probe.ok,
      state: probe.state,
      latencyMs: probe.latencyMs ?? null,
      snapshot: probe.ok ? probe.json : null,
    });

    // The metric the alert rules watch. Written for reachable and unreachable
    // alike so a rule can evaluate continuously rather than on a gap.
    try {
      metricsRepo?.writeBatch?.(ts, [{ metric: `peer.${peer.name}.up`, value: probe.ok ? 1 : 0 }]);
    } catch { /* a metrics write must never break the poll loop */ }

    // Transition events, not per-cycle noise.
    const prev = lastState.get(peer.id);
    if (prev !== probe.state) {
      lastState.set(peer.id, probe.state);
      if (probe.state === 'cert-changed') {
        eventsRepo?.add?.('peer.cert_changed', 'critical',
          { name: peer.name, baseUrl: peer.baseUrl });
      } else if (probe.ok && prev && prev !== 'ok') {
        eventsRepo?.add?.('peer.reachable', 'info', { name: peer.name });
      } else if (!probe.ok && prev === 'ok') {
        eventsRepo?.add?.('peer.unreachable', 'warning',
          { name: peer.name, state: probe.state, error: probe.error || null });
      }
    } else if (!probe.ok && probe.state !== 'cert-changed') {
      // Still down: one escalation event once it crosses the "this is real" mark.
      const downFor = peersRepo.unreachableSince(peer.id);
      if (downFor >= EVENT_AFTER_MS && downFor < EVENT_AFTER_MS + 90_000) {
        eventsRepo?.add?.('peer.unreachable_sustained', 'critical',
          { name: peer.name, minutes: Math.round(downFor / 60000) });
      }
    }

    return probe.state;
  }

  /**
   * One poll cycle across all enabled peers, in parallel: a slow or dead peer
   * must not delay the others, and the whole set is bounded by the client's
   * own 6s timeout.
   */
  async function pollAll() {
    let peers = [];
    try { peers = peersRepo.list().filter((p) => p.enabled); }
    catch { return { polled: 0 }; }
    if (!peers.length) return { polled: 0 };

    const results = await Promise.all(peers.map(async (p) => {
      try { return await pollOne(p); }
      catch { return 'unreachable'; }
    }));

    return {
      polled: peers.length,
      ok: results.filter((s) => s === 'ok').length,
    };
  }

  /** Housekeeping: peer_health is a cache, so age it out rather than downsample. */
  function prune() {
    try { peersRepo.pruneHealth(); } catch { /* best effort */ }
  }

  return { pollOne, pollAll, prune };
}
