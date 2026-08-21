/**
 * RaPiSys — peer discovery (§14.4 multi-node federation).
 * ======================================================
 * Two jobs, both built on the same cheap probe:
 *
 *  1. resolveAddress() — turn what the operator typed into a usable base URL by
 *     probing rather than guessing. `192.168.10.6` becomes
 *     `https://192.168.10.6:3443` only after that port actually answers. This is
 *     the same probe-to-find-the-real-port approach `pihole.detect` already uses.
 *
 *  2. scanLan() — sweep the local /24 for other RaPiSys nodes, so a second Pi can
 *     be added without knowing its address at all. Possible because the container
 *     runs with network_mode: host.
 *
 * A host is identified as RaPiSys by /api/v1/node-summary, not by /api/health:
 * the health payload is generic enough that anything could return it, whereas
 * node-summary exists only here. An unauthenticated probe is enough to classify,
 * since a 401 is as identifying as a 200.
 */

import http from 'http';
import https from 'https';
import os from 'os';
import dns from 'dns';

const HTTPS_PORT = 3443;
const HTTP_PORT = 3001;
const PROBE_TIMEOUT = 1200;
const RESOLVE_TIMEOUT = 4000;
const SCAN_CONCURRENCY = 48;

/** One short GET. Resolves { status, json } or null when nothing answered. */
function probe(scheme, host, port, path, timeout) {
  return new Promise((resolve) => {
    const lib = scheme === 'https' ? https : http;
    const req = lib.request({
      host, port, path, method: 'GET', timeout,
      rejectUnauthorized: false,          // homelab self-signed certs
      headers: { Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 200_000) req.destroy(); });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));   // no-op once already resolved
    req.end();
  });
}

/**
 * Classify one host:port.
 *   ready    — a RaPiSys node exposing the peer endpoint (addable)
 *   outdated — RaPiSys, but too old to have /api/v1/node-summary
 *   null     — nothing there, or not RaPiSys
 *
 * Exported so the classification rules can be tested directly against fixture
 * servers on either scheme, independently of the HTTPS-only resolution policy.
 */
export async function classify(scheme, host, port, timeout = PROBE_TIMEOUT) {
  const summary = await probe(scheme, host, port, '/api/v1/node-summary', timeout);
  if (!summary) return null;
  // 200 (open API), 401/403 (key required) all prove the endpoint exists.
  if ([200, 401, 403].includes(summary.status)) {
    return { state: 'ready', scheme, host, port, needsKey: summary.status !== 200 };
  }
  if (summary.status === 404) {
    // Something answered on the right port but has no peer endpoint. Confirm
    // it is RaPiSys at all before reporting it as an upgradable node.
    const health = await probe(scheme, host, port, '/api/health', timeout);
    if (health && health.status === 200 && health.json?.status === 'ok') {
      return { state: 'outdated', scheme, host, port };
    }
  }
  return null;
}

/**
 * Resolve operator input to a base URL.
 *
 * Throws with an actionable message rather than returning a broken URL: a node
 * reachable only over plain HTTP is a real finding worth reporting precisely,
 * because the fix is one toggle on that node's Settings → TLS page.
 */
export async function resolveAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('address is required');
  if (/^http:\/\//i.test(raw)) {
    throw new Error('plain HTTP peers are not supported — enable TLS on that node (Settings → TLS)');
  }

  let url;
  try { url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new Error('could not parse that address'); }
  if (!url.hostname) throw new Error('could not parse that address');

  // An explicit port is an instruction, not a hint: use it as given.
  if (url.port) {
    const hit = await classify('https', url.hostname, Number(url.port), RESOLVE_TIMEOUT);
    if (hit?.state === 'ready') return `https://${url.hostname}:${url.port}`;
    if (hit?.state === 'outdated') throw new Error(`${url.hostname} is running an older RaPiSys without the peer endpoint — update that node first`);
    throw new Error(`nothing answered on https://${url.hostname}:${url.port}`);
  }

  const secure = await classify('https', url.hostname, HTTPS_PORT, RESOLVE_TIMEOUT);
  if (secure?.state === 'ready') return `https://${url.hostname}:${HTTPS_PORT}`;
  if (secure?.state === 'outdated') {
    throw new Error(`${url.hostname} is running an older RaPiSys without the peer endpoint — update that node first`);
  }

  // Fall back only to diagnose, never to connect.
  const plain = await classify('http', url.hostname, HTTP_PORT, RESOLVE_TIMEOUT);
  if (plain) {
    throw new Error(`${url.hostname} answered on :${HTTP_PORT} but has no HTTPS listener — enable TLS on that node (Settings → TLS), then add it here`);
  }
  throw new Error(`no RaPiSys node answered at ${url.hostname} on :${HTTPS_PORT} or :${HTTP_PORT}`);
}

/** Every /24 this host sits on, plus its own addresses (to skip itself). */
export function localSubnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  const own = new Set();
  for (const addrs of Object.values(nets || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      own.add(a.address);
      // Only /24 and narrower are swept; a /16 would be 65k probes.
      const maskOctets = String(a.netmask || '').split('.').map(Number);
      if (maskOctets.length !== 4 || maskOctets[0] !== 255 || maskOctets[1] !== 255 || maskOctets[2] !== 255) continue;
      const base = a.address.split('.').slice(0, 3).join('.');
      if (!subnets.includes(base)) subnets.push(base);
    }
  }
  return { subnets, own };
}

/** Run tasks with a bounded pool so a sweep doesn't open 500 sockets at once. */
async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const r = await fn(items[idx]);
      if (r) out.push(r);
    }
  }));
  return out;
}

/**
 * Reverse-resolve an IP to a name. Preferred over the raw address in results
 * because a peer pinned to an IP breaks the day its DHCP lease moves, and Pi OS
 * ships Avahi so `.local` names are usually available on the LAN.
 */
function reverseName(ip, timeout = 700) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    dns.reverse(ip, (err, names) => {
      if (done) return;
      done = true; clearTimeout(t);
      const name = !err && names && names.length ? names[0].replace(/\.$/, '') : null;
      resolve(name || null);
    });
  });
}

/**
 * Sweep the local /24(s) for RaPiSys nodes.
 * Returns candidates with the friendlier name first and the IP as a fallback.
 */
export async function scanLan({ knownBaseUrls = [], concurrency = SCAN_CONCURRENCY } = {}) {
  const { subnets, own } = localSubnets();
  if (!subnets.length) return { subnets: [], scanned: 0, nodes: [] };

  const targets = [];
  for (const base of subnets) {
    for (let h = 1; h <= 254; h += 1) {
      const ip = `${base}.${h}`;
      if (own.has(ip)) continue;
      targets.push(ip);
    }
  }

  const hits = await pool(targets, concurrency, async (ip) => {
    const secure = await classify('https', ip, HTTPS_PORT);
    if (secure) return secure;
    const plain = await classify('http', ip, HTTP_PORT);
    if (plain) return { ...plain, state: 'needs-tls' };
    return null;
  });

  const known = new Set(knownBaseUrls.map((u) => String(u).toLowerCase()));
  const nodes = await Promise.all(hits.map(async (h) => {
    const name = await reverseName(h.host);
    const baseUrl = `${h.scheme}://${h.host}:${h.port}`;
    // Suggest the resolvable name when one exists; fall back to the address.
    const address = name || h.host;
    return {
      address,
      ip: h.host,
      hostname: name,
      port: h.port,
      scheme: h.scheme,
      state: h.state,                       // ready | needs-tls | outdated
      needsKey: !!h.needsKey,
      alreadyAdded: known.has(baseUrl.toLowerCase()),
      suggestedName: (name ? name.split('.')[0] : h.host).slice(0, 63),
    };
  }));

  nodes.sort((a, b) => {
    const rank = (n) => (n.state === 'ready' ? 0 : n.state === 'outdated' ? 1 : 2);
    return rank(a) - rank(b) || a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });

  return { subnets, scanned: targets.length, nodes };
}
