/**
 * RaPiSys — peer proxy (unified node view, §14.7).
 * ================================================
 * Relays one browser request to a peer's /api/* so a single dashboard can show
 * any node in place. The browser still only talks to the node it opened; that
 * node calls the peer over HTTPS with the stored API key, exactly like the
 * poller does.
 *
 * Stricter than the poller in one respect: the certificate fingerprint is
 * checked BEFORE anything is written to the socket. Request headers go out
 * with the first write, so a substituted peer never sees the API key or a
 * request body. An unpinned peer is refused rather than pinned here; pinning
 * stays the job of the add/poll path where the operator sees it happen.
 *
 * Responses stream straight through (SSE upgrade logs, CSV exports), minus
 * Set-Cookie: the peer's sessions have no meaning in this origin.
 */

import https from 'https';

const CONNECT_TIMEOUT = 8000;
// Some reads (apt simulate, inventory scans) take a while before the first
// byte. Streams are unaffected: the timer stops once headers arrive.
const RESPONSE_TIMEOUT = 300000;

const PASS_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'x-accel-buffering', 'last-modified', 'etag'];

function fingerprintOf(socket) {
  try { return socket.getPeerCertificate()?.fingerprint256 || null; } catch { return null; }
}

/** Header-safe form of this node's name, for the peer's audit trail. */
export function peerHeaderName(name) {
  return String(name || '').replace(/[^\w.-]/g, '').slice(0, 63) || 'peer';
}

/**
 * Proxy `req` to `<peer.baseUrl>/api/<subPath>` and write the result to `res`.
 * Never throws; failures become a 502 JSON body naming the peer, so the
 * browser's 401 handling (the login modal) only ever fires for THIS node.
 */
export function proxyToPeer({ peer, apiKey, selfName, scope = 'view', req, res, subPath }) {
  const fail = (status, state, error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.status(status).json({ error, state, node: peer.name });
  };

  if (!peer.certFingerprint) {
    return fail(502, 'unpinned', `${peer.name} has no pinned certificate yet. Wait for the next poll or re-add it in Settings → Nodes.`);
  }

  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  let url;
  try { url = new URL(`${peer.baseUrl}/api/${subPath}${qs}`); } catch { return fail(502, 'unreachable', 'bad peer URL'); }

  const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body !== undefined
    && !(typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length === 0 && !req.headers['content-length']);
  const body = hasBody ? Buffer.from(JSON.stringify(req.body)) : null;

  const headers = {
    Accept: req.headers.accept || 'application/json',
    'X-RaPiSys-Peer': peerHeaderName(selfName),
    'X-RaPiSys-Peer-Scope': scope === 'control' ? 'control' : 'view',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
  };

  let settled = false;
  const upstream = https.request(url, {
    method: req.method,
    headers,
    // Self-signed homelab certs: identity comes from the pinned fingerprint
    // below, checked before the request is sent. A fresh connection per
    // request keeps that check on every socket.
    rejectUnauthorized: false,
    agent: false,
  }, (up) => {
    settled = true;
    clearTimeout(responseTimer);
    upstream.setTimeout(0);

    // The peer rejecting OUR key is a federation problem, not a reason to
    // show this node's login modal.
    if (up.statusCode === 401) {
      up.resume();
      return fail(502, 'auth-failed', `${peer.name} rejected this node's API key. Update it in Settings → Nodes.`);
    }

    res.status(up.statusCode);
    for (const h of PASS_HEADERS) if (up.headers[h]) res.setHeader(h, up.headers[h]);
    if (String(up.headers['content-type'] || '').includes('text/event-stream')) res.flushHeaders();
    up.pipe(res);
    up.on('error', () => res.destroy());
  });

  const responseTimer = setTimeout(() => {
    if (!settled) upstream.destroy(new Error('timeout'));
  }, RESPONSE_TIMEOUT);

  upstream.setTimeout(CONNECT_TIMEOUT, () => { if (!settled) upstream.destroy(new Error('connect-timeout')); });

  upstream.on('socket', (socket) => {
    socket.once('secureConnect', () => {
      const fp = fingerprintOf(socket);
      if (fp !== peer.certFingerprint) {
        upstream.destroy(new Error('cert-changed'));
        return;
      }
      // Past the handshake: the connect timeout no longer applies.
      upstream.setTimeout(0);
      if (body) upstream.write(body);
      upstream.end();
    });
  });

  upstream.on('error', (e) => {
    clearTimeout(responseTimer);
    if (settled && res.headersSent) { res.destroy(); return; }
    settled = true;
    if (e.message === 'cert-changed') {
      return fail(502, 'cert-changed', `The TLS certificate for ${peer.name} changed since it was added. Nothing was sent.`);
    }
    if (e.message === 'timeout' || e.message === 'connect-timeout') {
      return fail(504, 'unreachable', `${peer.name} did not respond in time.`);
    }
    return fail(502, 'unreachable', `${peer.name} is unreachable (${e.code || e.message}).`);
  });

  // Browser went away (navigated, switched node, closed an SSE log): stop the
  // upstream request too instead of letting it run to completion unseen.
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); clearTimeout(responseTimer); });
}
