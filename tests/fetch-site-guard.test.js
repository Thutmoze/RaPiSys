import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFetchSiteGuard } from '../server/core/fetch-site-guard.js';

function app(allowedOrigins = []) {
  const a = express();
  a.use(createFetchSiteGuard({ allowedOrigins }));
  a.get('/api/updates/stream', (req, res) => res.json({ ran: true }));
  a.post('/api/settings', (req, res) => res.json({ ran: true }));
  a.get('/api/health', (req, res) => res.json({ ok: true }));
  a.get('/api/health/deep', (req, res) => res.json({ ok: true }));
  return a;
}

describe('cross-site request guard', () => {
  it('refuses a cross-site top-level GET to a privileged stream', async () => {
    const r = await request(app()).get('/api/updates/stream?full=1').set('Sec-Fetch-Site', 'cross-site');
    expect(r.status).toBe(403);
    expect(r.body.auth).toBe('cross-site');
  });

  it('refuses same-site requests (another app on the same Pi, different port)', async () => {
    const r = await request(app()).post('/api/settings').set('Sec-Fetch-Site', 'same-site').send({});
    expect(r.status).toBe(403);
  });

  it('allows the dashboard itself, typed URLs and non-browser clients', async () => {
    expect((await request(app()).get('/api/updates/stream').set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    expect((await request(app()).get('/api/updates/stream').set('Sec-Fetch-Site', 'none')).status).toBe(200);
    expect((await request(app()).get('/api/updates/stream')).status).toBe(200);
  });

  it('allows origins listed in CORS_ORIGINS, but not via a wildcard', async () => {
    const dev = 'http://localhost:5173';
    const ok = await request(app([dev])).post('/api/settings')
      .set('Sec-Fetch-Site', 'same-site').set('Origin', dev).send({});
    expect(ok.status).toBe(200);
    const star = await request(app(['*'])).post('/api/settings')
      .set('Sec-Fetch-Site', 'cross-site').set('Origin', 'https://evil.example').send({});
    expect(star.status).toBe(403);
  });

  it('leaves health checks readable cross-site', async () => {
    expect((await request(app()).get('/api/health').set('Sec-Fetch-Site', 'cross-site')).status).toBe(200);
    expect((await request(app()).get('/api/health/deep').set('Sec-Fetch-Site', 'cross-site')).status).toBe(200);
  });
});
