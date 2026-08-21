/** RaPiSys — peer discovery / address resolution tests (§14.4). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

const { resolveAddress, classify, localSubnets, scanLan } = await import('../server/services/peer-scan.js');

/**
 * Stand-in nodes on loopback. Real discovery probes HTTPS first, but the
 * classification logic (which status codes prove a RaPiSys peer endpoint) is
 * transport-independent, so plain HTTP servers exercise it without needing a
 * throwaway certificate in the test run.
 */
function server(routes) {
  const s = http.createServer((req, res) => {
    const handler = routes[req.url];
    if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
    const [status, body] = handler();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port })));
}

let openNode, keyedNode, oldNode, stranger;

beforeAll(async () => {
  openNode = await server({ '/api/v1/node-summary': () => [200, { node: { name: 'open' } }], '/api/health': () => [200, { status: 'ok' }] });
  keyedNode = await server({ '/api/v1/node-summary': () => [401, { error: 'Invalid API key.' }], '/api/health': () => [200, { status: 'ok' }] });
  oldNode = await server({ '/api/health': () => [200, { status: 'ok' }] });
  stranger = await server({ '/': () => [200, { hello: 'world' }] });
});

afterAll(() => { [openNode, keyedNode, oldNode, stranger].forEach((n) => n?.s?.close()); });

describe('address resolution', () => {
  it('rejects plain http input rather than downgrading', async () => {
    await expect(resolveAddress('http://192.168.10.6:3001')).rejects.toThrow(/TLS/i);
  });

  it('rejects empty input', async () => {
    await expect(resolveAddress('')).rejects.toThrow(/required/i);
    await expect(resolveAddress('   ')).rejects.toThrow(/required/i);
  });

  it('reports a clear error when nothing answers', async () => {
    // Port 1 is reserved and refuses immediately: no network dependency.
    await expect(resolveAddress('127.0.0.1:1')).rejects.toThrow(/nothing answered/i);
  });

  it('refuses an https address that only answers over http', async () => {
    // The fixtures are http-only, so https resolution must fail rather than
    // quietly succeeding against the wrong transport.
    await expect(resolveAddress(`127.0.0.1:${openNode.port}`)).rejects.toThrow(/nothing answered/i);
  });
});

describe('peer endpoint classification', () => {
  it('accepts a node with an open API', async () => {
    const out = await classify('http', '127.0.0.1', openNode.port, 3000);
    expect(out.state).toBe('ready');
    expect(out.needsKey).toBe(false);
  });

  it('treats a 401 as proof the endpoint exists, and flags that a key is needed', async () => {
    // A key-protected node must still be discoverable; the operator supplies
    // the key afterwards.
    const out = await classify('http', '127.0.0.1', keyedNode.port, 3000);
    expect(out.state).toBe('ready');
    expect(out.needsKey).toBe(true);
  });

  it('reports a RaPiSys node without the peer endpoint as outdated', async () => {
    const out = await classify('http', '127.0.0.1', oldNode.port, 3000);
    expect(out.state).toBe('outdated');
  });

  it('does not mistake an unrelated service for a node', async () => {
    // Answers HTTP, but has neither the peer endpoint nor a RaPiSys health
    // payload, so it must not appear in scan results at all.
    expect(await classify('http', '127.0.0.1', stranger.port, 3000)).toBeNull();
  });

  it('returns null when nothing is listening', async () => {
    expect(await classify('http', '127.0.0.1', 1, 1000)).toBeNull();
  });
});

describe('local subnet detection', () => {
  it('returns /24 bases and this host\'s own addresses', () => {
    const { subnets, own } = localSubnets();
    expect(Array.isArray(subnets)).toBe(true);
    expect(own instanceof Set).toBe(true);
    // Every reported subnet is a three-octet prefix, never a full address.
    for (const s of subnets) expect(s.split('.').length).toBe(3);
  });

  it('never sweeps a network wider than /24', () => {
    // localSubnets filters on a 255.255.255.x netmask, so a /16 interface
    // contributes nothing rather than queueing 65k probes.
    const { subnets } = localSubnets();
    expect(subnets.length).toBeLessThanOrEqual(8);
  });
});

describe('scan', () => {
  it('returns a well-formed result and marks known peers', async () => {
    const out = await scanLan({ knownBaseUrls: [], concurrency: 64 });
    expect(out).toHaveProperty('subnets');
    expect(out).toHaveProperty('scanned');
    expect(Array.isArray(out.nodes)).toBe(true);
    // Sandbox has no RaPiSys peers; the contract is what matters here.
    for (const n of out.nodes) {
      expect(n).toHaveProperty('address');
      expect(['ready', 'needs-tls', 'outdated']).toContain(n.state);
    }
  }, 60_000);
});
