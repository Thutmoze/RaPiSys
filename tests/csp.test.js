/** RaPiSys — Content Security Policy header and the violation report endpoint. */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { cspHeader, cspReportRouter } from '../server/core/csp.js';

describe('CSP header', () => {
  it('runs only same-origin scripts and allows the dashboard\'s own sockets', () => {
    const h = cspHeader('192.168.1.5:3443');
    expect(h).toMatch(/script-src 'self'(;|$)/);
    expect(h).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(h).toMatch(/connect-src 'self' ws:\/\/192\.168\.1\.5:3443 wss:\/\/192\.168\.1\.5:3443/);
    expect(h).toMatch(/frame-ancestors 'none'/);
    expect(h).toMatch(/object-src 'none'/);
  });
  it('never reflects a malformed Host into the policy', () => {
    const h = cspHeader("evil.example; script-src 'unsafe-inline'");
    expect(h).toMatch(/connect-src 'self';/);
    expect(h).not.toContain('evil.example');
  });
});

describe('CSP report endpoint', () => {
  function app(t = { now: 0 }) {
    const events = [];
    const a = express();
    a.use('/api/csp-report', cspReportRouter({ events: { add: (type, sev, p) => events.push({ type, p }) }, now: () => t.now }));
    return { a, events, t };
  }
  const report = { 'csp-report': {
    'document-uri': 'https://pi:3443/?pop=terminal', 'effective-directive': 'script-src-elem',
    'blocked-uri': 'inline', 'source-file': 'https://pi:3443/assets/index.js', 'line-number': 12 } };

  it('records a violation once, with the page path and no query string', async () => {
    const { a, events } = app();
    for (let i = 0; i < 3; i++) {
      const r = await request(a).post('/api/csp-report').set('Content-Type', 'application/csp-report').send(JSON.stringify(report));
      expect(r.status).toBe(204);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'csp.violation', p: { directive: 'script-src-elem', blocked: 'inline', page: '/' } });
  });

  it('caps reports per source address', async () => {
    const { a, events } = app();
    for (let i = 0; i < 40; i++) {
      const r = { 'csp-report': { ...report['csp-report'], 'blocked-uri': `https://x${i}.example` } };
      await request(a).post('/api/csp-report').set('Content-Type', 'application/csp-report').send(JSON.stringify(r));
    }
    expect(events.length).toBe(30);
  });
});
