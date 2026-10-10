/**
 * RaPiSys — every legacy route in server/index.js names its auth.
 *
 * index.js starts the HTTP server on import, so it cannot be mounted under
 * supertest. Its routes are declared one per line, which makes a source check
 * a cheap guard: a route that drops requireAuth (requireConfig once RaPiSys is
 * up: open in monitor mode, signed-in in full mode) fails here. Process
 * command lines, service probes and settings were readable without a session
 * in full mode before this was enforced.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf-8');
const routes = [...src.matchAll(/^app\.(get|put|post|delete)\('([^']+)',\s*([^\n]*)$/gm)]
  .map(([, method, path, rest]) => ({ method, path, rest }));

// Deliberately public: the liveness probe the Docker healthcheck calls.
const PUBLIC = new Set(['get /api/health']);

describe('legacy routes in server/index.js', () => {
  it('are found by the parser', () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.map((r) => r.path)).toContain('/api/stats');
  });

  it('all require auth (or the API key) except the health probe', () => {
    const open = routes
      .filter((r) => !PUBLIC.has(`${r.method} ${r.path}`))
      .filter((r) => !/^(requireAuth|requireApiKey),/.test(r.rest))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(open).toEqual([]);
  });
});
