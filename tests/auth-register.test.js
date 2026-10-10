/** RaPiSys — first-run admin registration cannot be taken over once an admin is active. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

process.env.SECRET_KEY = 'a'.repeat(64);
delete process.env.ADMIN_TOKEN;

const { openDatabase } = await import('../server/core/db.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createAuth } = await import('../server/services/auth.js');
const { authRouter } = await import('../server/routes/auth.js');

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-reg-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const settings = { rapisys: { mode: 'full' } };   // setup not completed: the wizard is open
  const auth = createAuth({ getDb: () => db, loadSettings: async () => settings, eventsRepo: createEventsRepo(db) });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter({ auth, loadSettings: async () => settings }));
  return { app, auth };
}
const cookieOf = (res) => (res.headers['set-cookie'] || [])[0]?.split(';')[0];

describe('admin registration during setup', () => {
  it('lets the wizard create the admin, and go back to change it while signed in', async () => {
    const { app, auth } = harness();
    const first = await request(app).post('/api/auth/register').send({ username: 'owner', password: 'correct horse', mfa: false });
    expect(first.status).toBe(200);
    const again = await request(app).post('/api/auth/register').set('Cookie', cookieOf(first))
      .send({ username: 'owner2', password: 'correct horse', mfa: false });
    expect(again.status).toBe(200);
    expect(auth.getAdmin().username).toBe('owner2');
  });

  it('refuses a second, signed-out caller once an admin is active', async () => {
    const { app, auth } = harness();
    await request(app).post('/api/auth/register').send({ username: 'owner', password: 'correct horse', mfa: false });
    const taker = await request(app).post('/api/auth/register').send({ username: 'mallory', password: 'hunter2hunter2', mfa: false });
    expect(taker.status).toBe(403);
    expect(taker.headers['set-cookie']).toBeUndefined();
    expect(auth.getAdmin().username).toBe('owner');
  });

  it('still allows restarting enrolment while MFA is not yet confirmed', async () => {
    const { app } = harness();
    const first = await request(app).post('/api/auth/register').send({ username: 'owner', password: 'correct horse', mfa: true });
    expect(first.status).toBe(200);
    expect(first.body.mfa).toBe(true);
    const retry = await request(app).post('/api/auth/register').send({ username: 'owner', password: 'correct horse', mfa: true });
    expect(retry.status).toBe(200);
  });
});
