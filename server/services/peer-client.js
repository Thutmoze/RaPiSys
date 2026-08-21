/**
 * RaPiSys — peer client (§14 multi-node federation).
 * =================================================
 * The only thing that talks to another node. It performs exactly one kind of
 * request: an authenticated GET of that node's /api/v1/node-summary.
 *
 * Two deliberate constraints:
 *
 *  1. HTTPS only. A peer API key would otherwise cross a plain LAN in cleartext
 *     every poll cycle. Self-signed certs are tolerated — the same homelab
 *     accommodation the Pi-hole collector already makes — but the certificate
 *     fingerprint is returned to the caller so it can be pinned on first use
 *     and compared thereafter.
 *
 *  2. No privileged surface. The host agent stays on its local Unix socket and
 *     is not reachable from a peer; this client cannot reach it either.
 */

import https from 'https';

const DEFAULT_TIMEOUT = 6000;
const DEFAULT_PORT = 3443;

/**
 * Normalize operator input into a base URL.
 *
 * Accepts `192.168.10.6`, `rapi-02.local`, `rapi-02.local:3443`, or a full URL.
 * Bare input becomes https://<host>:3443. Plain http:// is rejected rather than
 * silently downgraded — see the HTTPS-only note above. Probe-based port
 * discovery and LAN scanning arrive with the next patch in this series.
 */
export function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('address is required');
  if (/^http:\/\//i.test(raw)) {
    throw new Error('plain HTTP peers are not supported — enable TLS on that node (Settings → TLS)');
  }
  const withScheme = /^https:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error('could not parse that address'); }
  if (!url.hostname) throw new Error('could not parse that address');
  if (!url.port) url.port = String(DEFAULT_PORT);
  return `https://${url.hostname}:${url.port}`;
}

/** sha256 fingerprint of the peer's leaf cert, colon-hex, or null. */
function fingerprintOf(socket) {
  try {
    const cert = socket?.getPeerCertificate?.();
    return cert && cert.fingerprint256 ? cert.fingerprint256 : null;
  } catch { return null; }
}

/**
 * GET <baseUrl>/api/v1/node-summary.
 * Resolves { ok, status, state, json, fingerprint, latencyMs, error }.
 * Never throws for network conditions — an unreachable peer is a normal state,
 * not an exception.
 */
export function fetchNodeSummary(baseUrl, apiKey, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let url;
    try { url = new URL(`${baseUrl}/api/v1/node-summary`); }
    catch { return resolve({ ok: false, state: 'unreachable', error: 'bad URL', latencyMs: 0 }); }

    const req = https.request(url, {
      method: 'GET',
      timeout,
      // Homelab nodes use self-signed certs; the fingerprint pin below is what
      // actually establishes peer identity, not the CA chain.
      rejectUnauthorized: false,
      headers: { Accept: 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    }, (res) => {
      const fingerprint = fingerprintOf(res.socket);
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
      res.on('end', () => {
        const latencyMs = Date.now() - started;
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        if (res.statusCode === 401 || res.statusCode === 403) {
          return resolve({ ok: false, status: res.statusCode, state: 'auth-failed', fingerprint, latencyMs, error: json?.error || 'authentication rejected' });
        }
        if (res.statusCode !== 200 || !json) {
          return resolve({ ok: false, status: res.statusCode, state: 'unreachable', fingerprint, latencyMs, error: json?.error || `HTTP ${res.statusCode}` });
        }
        resolve({ ok: true, status: 200, state: 'ok', json, fingerprint, latencyMs });
      });
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({
      ok: false, state: 'unreachable', latencyMs: Date.now() - started,
      error: e.message === 'timeout' ? 'no response within 6s' : e.message,
    }));
    req.end();
  });
}

/**
 * Probe a peer and apply trust-on-first-use.
 *
 * - No pin yet  → the observed fingerprint is returned as `pin` for the caller
 *                 to store.
 * - Pin matches → normal result.
 * - Pin differs → `cert-changed`, regardless of whether the request succeeded.
 *                 Polling is expected to stop until an operator re-confirms.
 */
export async function probePeer({ baseUrl, apiKey, expectedFingerprint = null, timeout }) {
  const res = await fetchNodeSummary(baseUrl, apiKey, { timeout });
  if (res.fingerprint && expectedFingerprint && res.fingerprint !== expectedFingerprint) {
    return {
      ...res, ok: false, state: 'cert-changed',
      error: 'the TLS certificate for this peer changed since it was added',
    };
  }
  if (res.fingerprint && !expectedFingerprint) return { ...res, pin: res.fingerprint };
  return res;
}
