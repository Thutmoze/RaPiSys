/**
 * RaPiSys — Pi-hole DNS analytics client
 * --------------------------------------
 * Connects to a Pi-hole instance (default: this same Pi) and surfaces requested
 * domains, blocked domains, query categories, and totals — plus basic blocking
 * control (enable / temporarily disable).
 *
 * Two Pi-hole API generations are very different, so both are supported:
 *
 *   v6 (Pi-hole 6.x, FTL REST API, hosted at  http://host:port/api/* ):
 *     - session auth: POST /api/auth { password } -> { session: { sid, validity } }
 *       (skip when the web UI has no password — the API is then open)
 *     - the SID is sent as an `X-FTL-SID` header (also accepted as `sid`)
 *     - stats:   GET /api/stats/summary
 *                GET /api/stats/top_domains?count=N           (permitted)
 *                GET /api/stats/top_domains?blocked=true&count=N
 *                GET /api/stats/top_clients?count=N
 *     - control: POST /api/dns/blocking { blocking: bool, timer: sec|null }
 *
 *   v5 (Pi-hole 5.x, PHP API at  http://host/admin/api.php ):
 *     - token auth via `?auth=<APITOKEN>` query param (sha256 of the web pw)
 *     - stats:   ?summaryRaw  ?topItems=N  ?getQueryTypes
 *     - control: ?enable / ?disable=<sec>&auth=...
 *
 * The client auto-detects the version by probing the v6 endpoint first and
 * falling back to v5. All requests are short-timeout, read-mostly, and tolerate
 * a self-signed Pi-hole HTTPS cert (homelab).
 */

import http from 'http';
import https from 'https';

const DEFAULT_TIMEOUT = 6000;

/** Minimal fetch with timeout; tolerates self-signed certs on https. */
function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('bad URL')); }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      headers: { 'Accept': 'application/json', ...headers },
      timeout,
      // Pi-hole's self-signed cert is expected on a homelab box.
      rejectUnauthorized: false,
    };
    if (payload != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/**
 * Create a Pi-hole client bound to a config provider.
 *  getConfig() -> { enabled, host, port, scheme, version } | null
 *  getPassword() -> string | null   (decrypted app-password / v5 token)
 */
export function createPiholeClient({ getConfig, getPassword }) {
  // Cached v6 session so we don't re-auth on every poll.
  let sid = null;
  let sidExpiresAt = 0;
  let detectedVersion = null;   // 6 | 5 | null

  function base() {
    const c = getConfig() || {};
    const scheme = c.scheme || 'http';
    const host = c.host || '127.0.0.1';
    const port = c.port || (scheme === 'https' ? 443 : 80);
    return { url: `${scheme}://${host}:${port}`, host, port, scheme, version: c.version || 'auto' };
  }

  // ---- v6 -----------------------------------------------------------------

  async function v6Auth() {
    const pw = getPassword();
    const { url } = base();
    // No password configured -> try unauthenticated (valid when UI has no pw).
    if (!pw) { sid = null; sidExpiresAt = 0; return true; }
    if (sid && Date.now() < sidExpiresAt - 5000) return true;
    const r = await request(`${url}/api/auth`, { method: 'POST', body: { password: pw } });
    if (r.status === 200 && r.json?.session?.valid) {
      sid = r.json.session.sid;
      sidExpiresAt = Date.now() + (Number(r.json.session.validity || 300) * 1000);
      return true;
    }
    if (r.status === 401) throw new Error('Pi-hole authentication failed (wrong password)');
    throw new Error(`Pi-hole auth error (HTTP ${r.status})`);
  }

  async function v6Get(path) {
    const { url } = base();
    const headers = sid ? { 'X-FTL-SID': sid, 'sid': sid } : {};
    let r = await request(`${url}/api/${path}`, { headers });
    if (r.status === 401) {           // SID expired -> re-auth once
      sid = null; sidExpiresAt = 0;
      await v6Auth();
      const h2 = sid ? { 'X-FTL-SID': sid, 'sid': sid } : {};
      r = await request(`${url}/api/${path}`, { headers: h2 });
    }
    if (r.status !== 200) throw new Error(`Pi-hole API ${path} -> HTTP ${r.status}`);
    return r.json;
  }

  async function v6Snapshot(limit) {
    await v6Auth();
    const [summary, perm, blocked, clients] = await Promise.all([
      v6Get('stats/summary'),
      v6Get(`stats/top_domains?count=${limit}`),
      v6Get(`stats/top_domains?blocked=true&count=${limit}`),
      v6Get(`stats/top_clients?count=${limit}`).catch(() => null),
    ]);
    const q = summary?.queries || {};
    const norm = (arr) => (arr?.domains || arr?.top_domains || [])
      .map((d) => ({ domain: d.domain, count: d.count })).filter((d) => d.domain);
    return {
      available: true, source: 'pihole', apiVersion: 6, loggingEnabled: true, webPort: base().port,
      blocking: summary?.blocking ?? null,
      totals: {
        total: q.total ?? null,
        blocked: q.blocked ?? null,
        percentBlocked: q.percent_blocked ?? null,
        uniqueDomains: q.unique_domains ?? null,
        forwarded: q.forwarded ?? null,
        cached: q.cached ?? null,
      },
      // "categories": Pi-hole's status breakdown is the meaningful grouping.
      categories: buildCategories(q),
      // Real DNS record-type distribution (A, AAAA, HTTPS, PTR, …) and the
      // query-status breakdown (forwarded/cached/blocked/…) straight from FTL.
      queryTypes: normalizeMap(q.types),
      statusBreakdown: normalizeStatus(q.status, q.total),
      gravityDomains: summary?.gravity?.domains_being_blocked ?? null,
      clients: { active: summary?.clients?.active ?? null, total: summary?.clients?.total ?? null },
      topPermitted: norm(perm),
      topBlocked: norm(blocked),
      topClients: (clients?.clients || clients?.top_clients || [])
        .map((c) => ({ name: c.name || c.ip, ip: c.ip, count: c.count })).filter((c) => c.ip),
    };
  }

  async function v6SetBlocking(enabled, seconds) {
    await v6Auth();
    const { url } = base();
    const headers = sid ? { 'X-FTL-SID': sid, 'sid': sid } : {};
    const body = { blocking: !!enabled, timer: enabled ? null : (seconds || null) };
    const r = await request(`${url}/api/dns/blocking`, { method: 'POST', headers, body });
    if (r.status === 401) { sid = null; await v6Auth(); }
    if (r.status !== 200 && r.status !== 201) throw new Error(`Pi-hole blocking control -> HTTP ${r.status}`);
    return { ok: true, blocking: r.json?.blocking ?? !!enabled, timer: r.json?.timer ?? null };
  }

  // ---- v5 -----------------------------------------------------------------

  function v5Url(qs) {
    const { url } = base();
    const pw = getPassword();
    const auth = pw ? `&auth=${encodeURIComponent(pw)}` : '';
    return `${url}/admin/api.php?${qs}${auth}`;
  }

  async function v5Snapshot(limit) {
    const [summary, top, types] = await Promise.all([
      request(v5Url('summaryRaw')),
      request(v5Url(`topItems=${limit}`)),
      request(v5Url('getQueryTypes')).catch(() => null),
    ]);
    const s = summary.json || {};
    if (s == null || s.status === undefined && s.dns_queries_today === undefined) {
      // empty {} usually means auth required/failed for topItems
    }
    const t = top.json || {};
    const toArr = (obj) => Object.entries(obj || {}).map(([domain, count]) => ({ domain, count: Number(count) }));
    const total = Number(s.dns_queries_today ?? 0);
    const blocked = Number(s.ads_blocked_today ?? 0);
    return {
      available: true, source: 'pihole', apiVersion: 5, loggingEnabled: true, webPort: base().port,
      blocking: s.status === 'enabled' ? true : (s.status === 'disabled' ? false : null),
      totals: {
        total, blocked,
        percentBlocked: Number(s.ads_percentage_today ?? 0),
        uniqueDomains: Number(s.unique_domains ?? 0),
        forwarded: Number(s.queries_forwarded ?? 0),
        cached: Number(s.queries_cached ?? 0),
      },
      categories: buildCategories({
        total, blocked,
        forwarded: Number(s.queries_forwarded ?? 0),
        cached: Number(s.queries_cached ?? 0),
      }),
      gravityDomains: Number(s.domains_being_blocked ?? 0) || null,
      clients: { active: Number(s.unique_clients ?? 0) || null, total: Number(s.clients_ever_seen ?? 0) || null },
      topPermitted: toArr(t.top_queries),
      topBlocked: toArr(t.top_ads),
      topClients: [],
      queryTypes: types?.json?.querytypes || null,
    };
  }

  async function v5SetBlocking(enabled, seconds) {
    const qs = enabled ? 'enable' : `disable=${seconds || 0}`;
    const r = await request(v5Url(qs));
    const st = r.json?.status;
    if (!st) throw new Error('Pi-hole v5 blocking control failed (check API token)');
    return { ok: true, blocking: st === 'enabled', timer: enabled ? null : (seconds || null) };
  }

  // ---- shared -------------------------------------------------------------

  // Build a normalized "categories" breakdown (permitted/blocked/cached/forwarded)
  // with percentages — the meaningful categorization Pi-hole exposes.
  function buildCategories(q) {
    const total = Number(q.total ?? 0);
    const pct = (n) => (total > 0 ? Math.round((Number(n || 0) / total) * 1000) / 10 : 0);
    const blocked = Number(q.blocked ?? 0);
    const cached = Number(q.cached ?? 0);
    const forwarded = Number(q.forwarded ?? 0);
    const permitted = Math.max(0, total - blocked);
    return [
      { key: 'permitted', label: 'Permitted', count: permitted, percent: pct(permitted) },
      { key: 'blocked', label: 'Blocked', count: blocked, percent: pct(blocked) },
      { key: 'cached', label: 'Cached', count: cached, percent: pct(cached) },
      { key: 'forwarded', label: 'Forwarded', count: forwarded, percent: pct(forwarded) },
    ];
  }

  // Turn a { KEY: count } map (e.g. query types A/AAAA/HTTPS) into a sorted,
  // percentaged list of the most common entries.
  function normalizeMap(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const entries = Object.entries(obj).map(([k, v]) => ({ key: k, count: Number(v) || 0 }))
      .filter((e) => e.count > 0);
    const total = entries.reduce((a, e) => a + e.count, 0) || 1;
    return entries.sort((a, b) => b.count - a.count)
      .map((e) => ({ ...e, percent: Math.round((e.count / total) * 1000) / 10 }));
  }

  // FTL's status breakdown (GRAVITY, FORWARDED, CACHE, REGEX, DENYLIST, …) folded
  // into friendly, percentaged groups.
  function normalizeStatus(status, total) {
    if (!status || typeof status !== 'object') return [];
    const t = Number(total) || Object.values(status).reduce((a, v) => a + (Number(v) || 0), 0) || 1;
    const friendly = {
      FORWARDED: 'Forwarded', CACHE: 'Cached', GRAVITY: 'Blocked (gravity)',
      REGEX: 'Blocked (regex)', DENYLIST: 'Blocked (denylist)', UNKNOWN: 'Unknown',
      EXTERNAL_BLOCKED_IP: 'Blocked (external)', EXTERNAL_BLOCKED_NULL: 'Blocked (external)',
      EXTERNAL_BLOCKED_NXRA: 'Blocked (external)', SPECIAL_DOMAIN: 'Special', CACHE_STALE: 'Cached (stale)',
    };
    return Object.entries(status).map(([k, v]) => ({ key: k, label: friendly[k] || k, count: Number(v) || 0 }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((e) => ({ ...e, percent: Math.round((e.count / t) * 1000) / 10 }));
  }

  /** Probe which API version answers, caching the result. */
  async function detectVersion() {
    const cfg = getConfig() || {};
    if (cfg.version === '6') return 6;
    if (cfg.version === '5') return 5;
    if (detectedVersion) return detectedVersion;
    const { url } = base();
    // v6: /api/auth exists (returns 200 with no-pw, or 401 demanding a pw).
    try {
      const r = await request(`${url}/api/auth`, { timeout: 4000 });
      if (r.status === 200 || r.status === 401) { detectedVersion = 6; return 6; }
    } catch { /* try v5 */ }
    try {
      const r = await request(`${url}/admin/api.php?versions`, { timeout: 4000 });
      if (r.status === 200) { detectedVersion = 5; return 5; }
    } catch { /* neither */ }
    throw new Error('No Pi-hole API found at the configured address');
  }

  // ---- public API ---------------------------------------------------------

  async function snapshot(limit = 12) {
    const cfg = getConfig();
    if (!cfg || !cfg.enabled) return null;
    const v = await detectVersion();
    return v === 6 ? v6Snapshot(limit) : v5Snapshot(limit);
  }

  async function setBlocking(enabled, seconds = null) {
    const cfg = getConfig();
    if (!cfg || !cfg.enabled) throw new Error('Pi-hole is not configured');
    const v = await detectVersion();
    return v === 6 ? v6SetBlocking(enabled, seconds) : v5SetBlocking(enabled, seconds);
  }

  /** Test the connection with the given (or stored) config; never throws. */
  async function test() {
    try {
      const v = await detectVersion();
      detectedVersion = null;              // don't cache during an explicit test
      sid = null; sidExpiresAt = 0;
      const snap = await snapshot(5);
      return { ok: true, apiVersion: v, blocking: snap?.blocking ?? null,
        totalQueries: snap?.totals?.total ?? null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function resetSession() { sid = null; sidExpiresAt = 0; detectedVersion = null; }

  return { snapshot, setBlocking, test, detectVersion, resetSession };
}
