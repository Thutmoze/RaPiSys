// HTTP(S) service health check.
//
// A port that only speaks TLS (uvicorn or Node with a self-signed cert, for
// example) never answers a plain HTTP request: the server drops the
// connection on the first bytes. An 'http' check therefore retries over HTTPS
// when the plain request fails with anything other than "nothing listening"
// or a timeout, so such a service shows online instead of offline. An
// 'https' check goes straight to TLS. Certificates are not verified: homelab
// services use self-signed certs, and this only asks "is it answering".

import http from 'http';
import https from 'https';

const TIMEOUT_MS = 3000;

// Failures that mean the port is not serving at all, so retrying over TLS
// would only double the wait.
const NO_RETRY = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'TIMEOUT']);

function probe(service, scheme, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    const lib = scheme === 'https' ? https : http;
    const req = lib.request({
      hostname: service.host || 'localhost',
      port: service.port,
      path: service.path || '/',
      method: 'HEAD',
      timeout: timeoutMs,
      ...(scheme === 'https' ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      res.resume();
      finish({ ok: true, statusCode: res.statusCode, latency: Date.now() - start });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: 'TIMEOUT' });
    }, timeoutMs);
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, code: 'TIMEOUT' });
    });
    req.on('error', (err) => finish({ ok: false, code: err.code || 'ERROR' }));
    req.end();
  });
}

export async function checkHttpService(service, { timeoutMs = TIMEOUT_MS } = {}) {
  const tlsOnly = service.checkType === 'https';
  let r = await probe(service, tlsOnly ? 'https' : 'http', timeoutMs);
  if (!r.ok && !tlsOnly && !NO_RETRY.has(r.code)) {
    r = await probe(service, 'https', timeoutMs);
  }
  if (!r.ok) return { ...service, status: 'offline', latency: null };
  return {
    ...service,
    status: r.statusCode < 500 ? 'online' : 'error',
    latency: r.latency,
    statusCode: r.statusCode,
  };
}
