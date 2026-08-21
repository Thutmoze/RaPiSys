/**
 * RaPiSys — /api/nodes (§14 multi-node federation).
 * ================================================
 * Peer CRUD plus a connection test. Reads sit at the mount-level gate; every
 * mutation additionally requires requireControl, matching the convention used
 * by /api/disk and /api/network.
 *
 * The browser only ever calls this node. It never talks to a peer directly, so
 * there is no CORS surface and no cross-node session to reason about.
 */
import express from 'express';
import { normalizeBaseUrl, probePeer } from '../services/peer-client.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

/** Never return a stored key, not even masked-with-length. */
function toPublic(peer, health, hasKey) {
  return {
    id: peer.id,
    name: peer.name,
    baseUrl: peer.baseUrl,
    enabled: peer.enabled,
    createdAt: peer.createdAt,
    hasApiKey: !!hasKey,
    certPinned: !!peer.certFingerprint,
    state: health?.state || 'unknown',
    reachable: health ? health.reachable : null,
    latencyMs: health?.latencyMs ?? null,
    lastSeen: health?.reachable ? health.ts : null,
    checkedAt: health?.ts || null,
    summary: health?.snapshot || null,
  };
}

export function nodesRouter({ peersRepo, requireControl, events }) {
  const r = express.Router();

  // Peer list with each one's most recent poll result.
  r.get('/', (req, res) => {
    try {
      const health = peersRepo.latestHealthAll();
      res.json({
        nodes: peersRepo.list().map((p) => toPublic(p, health[p.id], peersRepo.hasApiKey(p.id))),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Try an address + key without saving anything. Used by the Add form.
  r.post('/test', requireControl, async (req, res) => {
    try {
      const baseUrl = normalizeBaseUrl(req.body?.address);
      const out = await probePeer({ baseUrl, apiKey: req.body?.apiKey || null });
      res.json({
        baseUrl,
        ok: out.ok,
        state: out.state,
        latencyMs: out.latencyMs ?? null,
        error: out.ok ? null : out.error,
        node: out.ok ? { name: out.json?.node?.name, hostname: out.json?.node?.hostname } : null,
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Add a peer. The probe runs first: a peer that cannot be reached and
  // authenticated is a configuration mistake, not a row worth persisting.
  r.post('/', requireControl, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!NAME_RE.test(name)) {
        return res.status(400).json({ error: 'name must be 1-63 chars: letters, digits, dot, dash, underscore' });
      }
      if (peersRepo.getByName(name)) return res.status(409).json({ error: `a peer named "${name}" already exists` });

      const baseUrl = normalizeBaseUrl(req.body?.address);
      const apiKey = req.body?.apiKey ? String(req.body.apiKey) : null;
      const probe = await probePeer({ baseUrl, apiKey });
      if (!probe.ok) {
        return res.status(502).json({ error: probe.error || 'peer did not respond', state: probe.state });
      }

      const peer = peersRepo.add({ name, baseUrl, apiKey });
      if (probe.pin) peersRepo.pinFingerprint(peer.id, probe.pin);
      peersRepo.recordHealth({
        peerId: peer.id, reachable: true, state: 'ok',
        latencyMs: probe.latencyMs, snapshot: probe.json,
      });
      events?.add?.('peer.added', 'info', { name, baseUrl });

      const fresh = peersRepo.get(peer.id);
      res.status(201).json({ node: toPublic(fresh, peersRepo.latestHealth(peer.id), true) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Re-test a saved peer. Also the path an operator uses to accept a changed
  // cert: POST ?confirmCert=1 re-pins whatever is presented now.
  r.post('/:id/test', requireControl, async (req, res) => {
    try {
      const peer = peersRepo.get(req.params.id);
      if (!peer) return res.status(404).json({ error: 'no such peer' });

      const confirmCert = req.query.confirmCert === '1' || req.body?.confirmCert === true;
      const probe = await probePeer({
        baseUrl: peer.baseUrl,
        apiKey: peersRepo.apiKeyFor(peer.id),
        expectedFingerprint: confirmCert ? null : peer.certFingerprint,
      });
      if (probe.fingerprint && (confirmCert || !peer.certFingerprint)) {
        peersRepo.pinFingerprint(peer.id, probe.fingerprint);
      }
      peersRepo.recordHealth({
        peerId: peer.id, reachable: probe.ok, state: probe.state,
        latencyMs: probe.latencyMs, snapshot: probe.ok ? probe.json : null,
      });
      res.json({ ok: probe.ok, state: probe.state, latencyMs: probe.latencyMs ?? null, error: probe.ok ? null : probe.error });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Rename, re-address, rotate the key, or enable/disable polling.
  r.patch('/:id', requireControl, async (req, res) => {
    try {
      const peer = peersRepo.get(req.params.id);
      if (!peer) return res.status(404).json({ error: 'no such peer' });

      const patch = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!NAME_RE.test(name)) return res.status(400).json({ error: 'invalid name' });
        const clash = peersRepo.getByName(name);
        if (clash && clash.id !== peer.id) return res.status(409).json({ error: `a peer named "${name}" already exists` });
        patch.name = name;
      }
      if (req.body?.address !== undefined) {
        patch.baseUrl = normalizeBaseUrl(req.body.address);
        // A new address is a new host: drop the old pin so TOFU runs again.
        if (patch.baseUrl !== peer.baseUrl) peersRepo.pinFingerprint(peer.id, null);
      }
      if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
      if (req.body?.apiKey) patch.apiKey = String(req.body.apiKey);

      const updated = peersRepo.update(peer.id, patch);
      res.json({ node: toPublic(updated, peersRepo.latestHealth(peer.id), peersRepo.hasApiKey(peer.id)) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  r.delete('/:id', requireControl, (req, res) => {
    try {
      const peer = peersRepo.get(req.params.id);
      if (!peer) return res.status(404).json({ error: 'no such peer' });
      peersRepo.remove(peer.id);
      events?.add?.('peer.removed', 'info', { name: peer.name });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
}
