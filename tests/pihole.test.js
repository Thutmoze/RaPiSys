/** RaPiSys — Pi-hole client tests against a mock FTL/v5 HTTP server. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

const { createPiholeClient } = await import('../server/collectors/pihole.js');

// A tiny stand-in for Pi-hole that can speak either the v6 or the v5 API,
// letting us exercise auth, snapshot normalization, and blocking control.
function startMockPihole(mode) {
  const state = { blocking: true, sid: 'TEST-SID', authed: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (mode === 'v6') {
      if (url.pathname === '/api/auth' && req.method === 'POST') {
        return send(200, { session: { valid: true, sid: state.sid, validity: 300 } });
      }
      if (url.pathname === '/api/auth' && req.method === 'GET') return send(200, { session: { valid: false } });
      if (url.pathname === '/api/stats/summary') {
        return send(200, { queries: { total: 1000, blocked: 250, percent_blocked: 25, unique_domains: 120, forwarded: 600, cached: 150 },
          clients: { active: 4, total: 6 }, gravity: { domains_being_blocked: 450000 }, blocking: state.blocking });
      }
      if (url.pathname === '/api/stats/top_domains') {
        const blocked = url.searchParams.get('blocked') === 'true';
        return send(200, { domains: blocked
          ? [{ domain: 'ads.example.com', count: 90 }, { domain: 'track.example.net', count: 40 }]
          : [{ domain: 'github.com', count: 300 }, { domain: 'api.foo.dev', count: 120 }] });
      }
      if (url.pathname === '/api/stats/top_clients') return send(200, { clients: [{ name: 'laptop', ip: '10.0.0.5', count: 500 }] });
      if (url.pathname === '/api/dns/blocking' && req.method === 'POST') {
        let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
          const b = JSON.parse(body || '{}'); state.blocking = !!b.blocking;
          send(200, { blocking: state.blocking, timer: b.timer ?? null });
        }); return;
      }
      return send(404, { error: 'not found' });
    }

    // v5
    if (url.pathname === '/admin/api.php') {
      if (url.searchParams.has('versions')) return send(200, { core_current: 'v5.18' });
      if (url.searchParams.has('summaryRaw')) {
        return send(200, { dns_queries_today: 800, ads_blocked_today: 200, ads_percentage_today: 25,
          unique_domains: 100, queries_forwarded: 500, queries_cached: 100, domains_being_blocked: 200000,
          unique_clients: 3, clients_ever_seen: 5, status: state.blocking ? 'enabled' : 'disabled' });
      }
      if (url.searchParams.has('topItems')) {
        return send(200, { top_queries: { 'github.com': 200, 'foo.dev': 80 }, top_ads: { 'ads.bad.com': 60 } });
      }
      if (url.searchParams.has('getQueryTypes')) return send(200, { querytypes: { A: 70, AAAA: 30 } });
      if (url.searchParams.has('enable')) { state.blocking = true; return send(200, { status: 'enabled' }); }
      if (url.searchParams.has('disable')) { state.blocking = false; return send(200, { status: 'disabled' }); }
      return send(200, {});
    }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

describe('pihole client — v6', () => {
  let mock, client;
  beforeAll(async () => {
    mock = await startMockPihole('v6');
    client = createPiholeClient({
      getConfig: () => ({ enabled: true, host: '127.0.0.1', port: mock.port, scheme: 'http', version: 'auto' }),
      getPassword: () => 'secret',
    });
  });
  afterAll(() => mock.server.close());

  it('detects v6', async () => { expect(await client.detectVersion()).toBe(6); });

  it('returns a normalized snapshot with totals, categories, and top lists', async () => {
    const s = await client.snapshot(5);
    expect(s.source).toBe('pihole');
    expect(s.apiVersion).toBe(6);
    expect(s.totals.total).toBe(1000);
    expect(s.totals.blocked).toBe(250);
    expect(s.topPermitted[0].domain).toBe('github.com');
    expect(s.topBlocked[0].domain).toBe('ads.example.com');
    expect(s.webPort).toBe(mock.port);
    const blockedCat = s.categories.find((c) => c.key === 'blocked');
    expect(blockedCat.count).toBe(250);
    expect(blockedCat.percent).toBe(25);
  });

  it('toggles blocking', async () => {
    const off = await client.setBlocking(false, 300);
    expect(off.blocking).toBe(false);
    const on = await client.setBlocking(true);
    expect(on.blocking).toBe(true);
  });

  it('test() reports ok with version', async () => {
    const r = await client.test();
    expect(r.ok).toBe(true);
    expect(r.apiVersion).toBe(6);
  });
});

describe('pihole client — v5 fallback', () => {
  let mock, client;
  beforeAll(async () => {
    mock = await startMockPihole('v5');
    client = createPiholeClient({
      getConfig: () => ({ enabled: true, host: '127.0.0.1', port: mock.port, scheme: 'http', version: '5' }),
      getPassword: () => 'token',
    });
  });
  afterAll(() => mock.server.close());

  it('uses v5 when configured', async () => { expect(await client.detectVersion()).toBe(5); });

  it('normalizes the v5 summary the same shape as v6', async () => {
    const s = await client.snapshot(5);
    expect(s.apiVersion).toBe(5);
    expect(s.totals.total).toBe(800);
    expect(s.totals.blocked).toBe(200);
    expect(s.topPermitted[0].domain).toBe('github.com');
    expect(s.topBlocked[0].domain).toBe('ads.bad.com');
  });

  it('disabled config returns null snapshot', async () => {
    const off = createPiholeClient({ getConfig: () => ({ enabled: false }), getPassword: () => null });
    expect(await off.snapshot()).toBe(null);
  });
});

// Pure logic checks mirroring the agent's pihole.checkUpdate decision-making.
// (The agent op itself shells out to docker/pihole; here we lock in the rules.)
describe('pihole update-availability logic', () => {
  // docker: compare local RepoDigest against the registry's latest digest.
  function dockerUpdateAvailable(localRepoDigest, remoteSha) {
    if (localRepoDigest && remoteSha) return !localRepoDigest.includes(remoteSha);
    return false;
  }
  it('flags an update when digests differ', () => {
    expect(dockerUpdateAvailable('pihole/pihole@sha256:aaa', 'sha256:bbb')).toBe(true);
  });
  it('reports up-to-date when digests match', () => {
    expect(dockerUpdateAvailable('pihole/pihole@sha256:aaa', 'sha256:aaa')).toBe(false);
  });
  it('is conservative (no false positive) when data is missing', () => {
    expect(dockerUpdateAvailable('', 'sha256:bbb')).toBe(false);
    expect(dockerUpdateAvailable('pihole/pihole@sha256:aaa', '')).toBe(false);
  });

  // host: compare per-component current vs latest from /etc/pihole/versions.
  function hostUpdateAvailable(cur, lat) {
    return Object.keys(lat).some((k) => lat[k] && cur[k] && lat[k] !== cur[k]);
  }
  it('flags a host update when any component differs', () => {
    expect(hostUpdateAvailable({ CORE: '6.0', FTL: '6.0' }, { CORE: '6.1', FTL: '6.0' })).toBe(true);
  });
  it('reports up-to-date when all components match', () => {
    expect(hostUpdateAvailable({ CORE: '6.1', FTL: '6.0' }, { CORE: '6.1', FTL: '6.0' })).toBe(false);
  });
});
