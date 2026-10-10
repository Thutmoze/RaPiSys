/**
 * RaPiSys — every privileged route of the REAL routers refuses a request
 * without a session (full mode, setup completed).
 *
 * Earlier auth tests mount stub routes behind the middleware; they prove the
 * middleware, not that each route uses it. This boots the real composition
 * root, lists every mutating route (and every GET event stream, which run
 * upgrades and installs) from the router sources and their mounts, and calls
 * each one anonymously. A route that loses its guard fails here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);
delete process.env.ADMIN_TOKEN;

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-authm-'));
  process.env.DATA_DIR = dir;
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const { initRapisys } = await import('../server/rapisys.js');

const SERVER = new URL('../server/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SERVER), 'utf-8');

/** { routerFactoryName: mountPath } from app.use('/api/...', ..., xRouter( in rapisys.js. */
function mounts() {
  const out = {};
  for (const m of read('rapisys.js').matchAll(/app\.use\('(\/api\/[^']+)',[^\n]*?\b(\w+Router)\(/g)) out[m[2]] = m[1];
  return out;
}

/** Every mutating route, plus GET .../stream routes, as { method, path }. */
function privilegedRoutes() {
  const mountOf = mounts();
  const routes = [];
  for (const file of fs.readdirSync(new URL('routes/', SERVER))) {
    const src = read(`routes/${file}`);
    const factories = [...src.matchAll(/export function (\w+Router)\(/g)].map((m) => m[1]);
    // One router per file carries the routes below (health.js has two, both read-only).
    const mount = factories.map((f) => mountOf[f]).find(Boolean);
    if (!mount) continue;
    for (const m of src.matchAll(/^\s*r\.(get|post|put|delete|patch)\(\s*'([^']+)'/gm)) {
      const [, method, p] = m;
      if (method === 'get' && !/\/stream$/.test(p)) continue;
      routes.push({ method, path: mount + (p === '/' ? '' : p) });
    }
  }
  return routes;
}

// Open by design, each for a stated reason.
const OPEN = new Map([
  ['post /api/auth/login', 'the sign-in itself'],
  ['post /api/auth/logout', 'ends the caller\'s own session only'],
]);

const concrete = (p) => p.replace(/\{?\*\w*\}?/g, 'x').replace(/:\w+/g, 'x');

describe('auth matrix over the real routers (full mode, no session)', () => {
  let app;
  beforeAll(async () => {
    app = express();
    app.use(express.json());
    const settings = { rapisys: { mode: 'full', setupCompleted: true }, api: { enabled: false } };
    await initRapisys({
      app,
      loadSettings: async () => structuredClone(settings),
      saveSettings: async () => {},
      withFileLock: async (fn) => fn(),
      requireAuth: (req, res, next) => next(),
      requireApiKey: (req, res, next) => res.status(403).end(),
      loadServices: async () => [],
      checkService: async () => ({ status: 'up' }),
    });
  });

  it('finds the routes to check', () => {
    const routes = privilegedRoutes();
    expect(routes.length).toBeGreaterThan(80);
    expect(routes).toContainEqual({ method: 'get', path: '/api/updates/stream' });
    expect(routes).toContainEqual({ method: 'post', path: '/api/setup/mode' });
  });

  it('refuses every privileged route without a session', async () => {
    const open = [];
    for (const r of privilegedRoutes()) {
      const key = `${r.method} ${r.path}`;
      if (OPEN.has(key)) continue;
      const res = await request(app)[r.method](concrete(r.path)).send({});
      if (res.status !== 401 && res.status !== 403) open.push(`${key} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  }, 30000);
});
