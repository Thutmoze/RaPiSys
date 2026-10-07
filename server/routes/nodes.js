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
import { hostName, normalizeNodeLabel, resolveNodeName } from '../core/node-identity.js';
import { probePeer } from '../services/peer-client.js';
import { resolveAddress, scanLan } from '../services/peer-scan.js';
import { proxyToPeer } from '../services/peer-proxy.js';

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

export function nodesRouter({ peersRepo, requireControl, events, loadSettings, saveSettings, withFileLock, auth }) {
  const r = express.Router();

  // Peer list with each one's most recent poll result, plus this node's own
  // identity. The client cannot derive the latter: location.hostname is
  // whatever the operator typed in the address bar, so a dashboard opened by
  // IP would label itself with the IP. The container runs network_mode: host,
  // so os.hostname() here is the Pi's real hostname.
  //
  // `label` is the operator's optional override and `hostname` the machine's
  // own name; `name` is the resolved one actually used in notifications, so the
  // Settings card can show both without repeating the resolution rule.
  r.get('/', async (req, res) => {
    try {
      const health = peersRepo.latestHealthAll();
      let settings = null;
      try { settings = loadSettings ? await loadSettings() : null; } catch { /* fall back to hostname */ }
      res.json({
        self: {
          name: resolveNodeName(settings),
          hostname: hostName(),
          label: normalizeNodeLabel(settings?.rapisys?.nodeLabel),
          peerControl: settings?.rapisys?.peerControl === true,
          apiKeySet: !!(settings?.api?.enabled && settings?.api?.keyHash),
        },
        nodes: peersRepo.list().map((p) => toPublic(p, health[p.id], peersRepo.hasApiKey(p.id))),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Set (or clear) this node's label. An empty value falls back to the
  // hostname rather than storing a blank name, so notifications always carry
  // something identifiable.
  r.put('/self', requireControl, async (req, res) => {
    if (!loadSettings || !saveSettings || !withFileLock) {
      return res.status(500).json({ error: 'settings storage is unavailable' });
    }
    const label = normalizeNodeLabel(req.body?.label);
    try {
      await withFileLock(async () => {
        const s = await loadSettings();
        s.rapisys = s.rapisys || {};
        if (label) s.rapisys.nodeLabel = label; else delete s.rapisys.nodeLabel;
        await saveSettings(s);
      });
      const settings = await loadSettings();
      events?.add?.('node.label.changed', 'info', { label: label || null, name: resolveNodeName(settings) });
      res.json({ ok: true, self: { name: resolveNodeName(settings), hostname: hostName(), label } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Let other nodes make changes here through the unified view. Reads only
  // need the API key; this is the owner's opt-in for writes. A peer can never
  // flip it (auth denies relayed writes under /api/nodes).
  r.put('/peer-control', requireControl, async (req, res) => {
    if (!loadSettings || !saveSettings || !withFileLock) {
      return res.status(500).json({ error: 'settings storage is unavailable' });
    }
    const allow = req.body?.allow === true;
    try {
      await withFileLock(async () => {
        const s = await loadSettings();
        s.rapisys = s.rapisys || {};
        s.rapisys.peerControl = allow;
        await saveSettings(s);
      });
      events?.add?.('node.peer_control.changed', allow ? 'warning' : 'info', { allow });
      res.json({ ok: true, peerControl: allow });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Unified node view: relay any /api/* call to a peer. Reads pass the
  // mount-level gate; writes need control HERE as well as on the peer, so the
  // login modal appears for this node's session, as it would for a local
  // change. Requests that arrived from a peer are refused: no multi-hop.
  async function relay(req, res) {
    if (req.headers['x-rapisys-peer']) {
      return res.status(403).json({ error: 'Not available through another node.', auth: 'peer-denied' });
    }
    const peer = peersRepo.get(req.params.id);
    if (!peer) return res.status(404).json({ error: 'no such peer' });
    if (!peer.enabled) return res.status(409).json({ error: `${peer.name} is disabled in Settings → Nodes.`, state: 'disabled', node: peer.name });
    let settings = null;
    try { settings = loadSettings ? await loadSettings() : null; } catch { /* name falls back to hostname */ }
    let scope = 'view';
    try { if (auth && await auth.getMode() === 'full' && auth.isAuthenticated(req)) scope = 'control'; } catch { /* stay view */ }
    const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
    proxyToPeer({
      peer, apiKey: peersRepo.apiKeyFor(peer.id), selfName: resolveNodeName(settings), scope,
      req, res, subPath: rest.split('/').map(encodeURIComponent).join('/'),
    });
  }
  const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';
  r.all('/:id/proxy/*rest', (req, res, next) => (isRead(req) ? next() : requireControl(req, res, next)), relay);

  // Try an address + key without saving anything. Used by the Add form.
  r.post('/test', requireControl, async (req, res) => {
    try {
      const baseUrl = await resolveAddress(req.body?.address);
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
      let name = String(req.body?.name || '').trim();
      if (name && !NAME_RE.test(name)) {
        return res.status(400).json({ error: 'name must be 1-63 chars: letters, digits, dot, dash, underscore' });
      }
      if (name && peersRepo.getByName(name)) return res.status(409).json({ error: `a peer named "${name}" already exists` });

      const baseUrl = await resolveAddress(req.body?.address);
      const apiKey = req.body?.apiKey ? String(req.body.apiKey) : null;
      const probe = await probePeer({ baseUrl, apiKey });
      if (!probe.ok) {
        return res.status(502).json({ error: probe.error || 'peer did not respond', state: probe.state });
      }

      // No name given: use what the peer calls itself. The probe response
      // already carries its hostname, so adding by bare IP no longer produces
      // a peer permanently labelled with an address.
      if (!name) {
        const reported = String(probe.json?.node?.name || probe.json?.node?.hostname || '').trim();
        if (NAME_RE.test(reported)) name = reported;
        if (!name) return res.status(400).json({ error: 'that node did not report a usable hostname — enter a name yourself' });
        if (peersRepo.getByName(name)) return res.status(409).json({ error: `a peer named "${name}" already exists` });
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
        patch.baseUrl = await resolveAddress(req.body.address);
        // A new address is a new host: drop the old pin so TOFU runs again.
        if (patch.baseUrl !== peer.baseUrl) peersRepo.pinFingerprint(peer.id, null);
      }
      if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
      if (req.body?.apiKey) patch.apiKey = String(req.body.apiKey);

      const updated = peersRepo.update(peer.id, patch);
      res.json({ node: toPublic(updated, peersRepo.latestHealth(peer.id), peersRepo.hasApiKey(peer.id)) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Sweep the local /24 for other RaPiSys nodes. Only possible because the
  // container runs network_mode: host. Results are advisory: nothing is added
  // and no credentials are sent — the probe is unauthenticated.
  r.post('/scan', requireControl, async (req, res) => {
    try {
      const known = peersRepo.list().map((p) => p.baseUrl);
      const out = await scanLan({ knownBaseUrls: known });
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
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
