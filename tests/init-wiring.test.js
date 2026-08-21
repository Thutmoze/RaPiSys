/**
 * RaPiSys — init wiring smoke test.
 *
 * Every other suite constructs routers directly with explicit dependencies,
 * which means a bad identifier in the composition root goes unnoticed: patch
 * 0292 passed 154 tests while shipping `fallbackDbPath` as a bare reference to
 * a variable that does not exist in `initRapisys`. The resulting ReferenceError
 * aborted the whole init — no scheduler, no TLS listener, no modules — and was
 * swallowed by the "legacy dashboard still works" catch, so the process kept
 * serving HTTP and looked healthy.
 *
 * This boots the real composition root against temporary storage and fails if
 * init throws, which is the cheapest guard against that class of mistake.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-init-'));
  process.env.DATA_DIR = dir;
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const { initRapisys } = await import('../server/rapisys.js');

/** Minimal host application, matching what server/index.js provides. */
function deps() {
  const settings = { rapisys: {} };
  return {
    app: express(),
    loadSettings: async () => settings,
    saveSettings: async () => {},
    withFileLock: async (fn) => fn(),
    requireAuth: (req, res, next) => next(),
    requireApiKey: (req, res, next) => next(),
    loadServices: async () => [],
    checkService: async () => ({ status: 'up' }),
  };
}

describe('composition root', () => {
  it('initialises without throwing', async () => {
    // A ReferenceError here means a dependency name in the wiring does not
    // match the variable it is meant to reference.
    await expect(initRapisys(deps())).resolves.toBeDefined();
  });

  it('mounts the setup router with a usable fallback database path', async () => {
    const d = deps();
    await initRapisys(d);
    const request = (await import('supertest')).default;
    const r = await request(d.app).get('/api/setup/nas/preflight?mountpoint=/mnt/rapisys/mybook');
    expect(r.status).toBe(200);
    // The guided swap relies on this to know where to park the database; an
    // undefined value would silently break the relocate step at runtime.
    expect(typeof r.body.localDbPath).toBe('string');
    expect(r.body.localDbPath).toMatch(/rapisys\.db$/);
  });
});
