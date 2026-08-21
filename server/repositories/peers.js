/**
 * RaPiSys — peers repository (§14 multi-node federation).
 * ======================================================
 * Connection records for other RaPiSys nodes, plus a rolling cache of the last
 * poll results. Deliberately narrow: no peer metrics history is stored here,
 * because each node keeps its own complete history in its own database.
 *
 * API keys never touch this table. They are written to the encrypted `secrets`
 * table via the injected secrets repo, so peer credentials get exactly the same
 * AES-256-GCM at-rest treatment as the SMTP password.
 */

/** Poll outcomes. `cert-changed` halts polling until the operator re-confirms. */
export const PEER_STATES = ['ok', 'unreachable', 'auth-failed', 'cert-changed'];

/** How long poll snapshots are kept. They are a cache, not history. */
const HEALTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secretKeyFor = (id) => `peer.${id}.apikey`;

export function createPeersRepo(db, { secrets } = {}) {
  const rowToPeer = (r) => r && ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    certFingerprint: r.cert_fingerprint || null,
    enabled: !!r.enabled,
    createdAt: r.created_at,
  });

  function list() {
    return db.prepare('SELECT * FROM peers ORDER BY name').all().map(rowToPeer);
  }

  function get(id) {
    return rowToPeer(db.prepare('SELECT * FROM peers WHERE id = ?').get(Number(id)));
  }

  function getByName(name) {
    return rowToPeer(db.prepare('SELECT * FROM peers WHERE name = ?').get(String(name)));
  }

  /** Insert a peer and stash its API key in `secrets`. Returns the new peer. */
  function add({ name, baseUrl, apiKey = null }) {
    const info = db.prepare(
      'INSERT INTO peers (name, base_url, enabled, created_at) VALUES (?, ?, 1, ?)',
    ).run(String(name), String(baseUrl), Date.now());
    // better-sqlite3 exposes lastInsertRowid; node:sqlite uses lastInsertRowid too.
    const id = Number(info.lastInsertRowid);
    if (apiKey && secrets) secrets.set(secretKeyFor(id), String(apiKey));
    return get(id);
  }

  /** Patch mutable fields. Passing apiKey rotates the stored secret. */
  function update(id, { name, baseUrl, enabled, apiKey } = {}) {
    const cur = get(id);
    if (!cur) return null;
    db.prepare('UPDATE peers SET name = ?, base_url = ?, enabled = ? WHERE id = ?').run(
      name === undefined ? cur.name : String(name),
      baseUrl === undefined ? cur.baseUrl : String(baseUrl),
      enabled === undefined ? (cur.enabled ? 1 : 0) : (enabled ? 1 : 0),
      Number(id),
    );
    if (apiKey && secrets) secrets.set(secretKeyFor(id), String(apiKey));
    return get(id);
  }

  /** Remove the peer, its cached health rows, and its stored key together. */
  function remove(id) {
    const n = Number(id);
    db.prepare('DELETE FROM peer_health WHERE peer_id = ?').run(n);
    db.prepare('DELETE FROM peers WHERE id = ?').run(n);
    if (secrets) secrets.remove(secretKeyFor(n));
  }

  function apiKeyFor(id) {
    if (!secrets) return null;
    try { return secrets.get(secretKeyFor(Number(id))); } catch { return null; }
  }

  function hasApiKey(id) {
    if (!secrets) return false;
    try { return !!secrets.has(secretKeyFor(Number(id))); } catch { return false; }
  }

  /**
   * Pin the cert fingerprint. First observation wins (trust on first use);
   * afterwards the poller compares rather than overwriting, so a silent
   * substitution cannot re-pin itself.
   */
  function pinFingerprint(id, fingerprint) {
    db.prepare('UPDATE peers SET cert_fingerprint = ? WHERE id = ?')
      .run(fingerprint ? String(fingerprint) : null, Number(id));
  }

  function recordHealth({ peerId, ts = Date.now(), reachable, state, latencyMs = null, snapshot = null }) {
    db.prepare(
      'INSERT OR REPLACE INTO peer_health (peer_id, ts, reachable, state, latency_ms, snapshot) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      Number(peerId), Number(ts), reachable ? 1 : 0,
      state || (reachable ? 'ok' : 'unreachable'),
      latencyMs == null ? null : Number(latencyMs),
      snapshot == null ? null : JSON.stringify(snapshot),
    );
  }

  const parseHealth = (r) => r && ({
    peerId: r.peer_id,
    ts: r.ts,
    reachable: !!r.reachable,
    state: r.state,
    latencyMs: r.latency_ms,
    snapshot: (() => { try { return r.snapshot ? JSON.parse(r.snapshot) : null; } catch { return null; } })(),
  });

  function latestHealth(peerId) {
    return parseHealth(db.prepare(
      'SELECT * FROM peer_health WHERE peer_id = ? ORDER BY ts DESC LIMIT 1',
    ).get(Number(peerId)));
  }

  /** Latest row for every peer, keyed by peer id — one query, not N. */
  function latestHealthAll() {
    const rows = db.prepare(`
      SELECT ph.* FROM peer_health ph
      JOIN (SELECT peer_id, MAX(ts) AS ts FROM peer_health GROUP BY peer_id) m
        ON m.peer_id = ph.peer_id AND m.ts = ph.ts
    `).all();
    const out = {};
    for (const r of rows) out[r.peer_id] = parseHealth(r);
    return out;
  }

  /**
   * How long a peer has been continuously unreachable, in ms, or 0 if it is
   * currently reachable / unknown. Drives the peer-unreachable alert condition.
   */
  function unreachableSince(peerId) {
    const latest = latestHealth(peerId);
    if (!latest || latest.reachable) return 0;
    const lastOk = db.prepare(
      'SELECT ts FROM peer_health WHERE peer_id = ? AND reachable = 1 ORDER BY ts DESC LIMIT 1',
    ).get(Number(peerId));
    const firstBad = db.prepare(
      'SELECT MIN(ts) AS ts FROM peer_health WHERE peer_id = ? AND ts > ?',
    ).get(Number(peerId), lastOk ? lastOk.ts : 0);
    return firstBad?.ts ? Date.now() - firstBad.ts : 0;
  }

  function pruneHealth(ttlMs = HEALTH_TTL_MS) {
    db.prepare('DELETE FROM peer_health WHERE ts < ?').run(Date.now() - ttlMs);
  }

  return {
    list, get, getByName, add, update, remove,
    apiKeyFor, hasApiKey, pinFingerprint,
    recordHealth, latestHealth, latestHealthAll, unreachableSince, pruneHealth,
  };
}
