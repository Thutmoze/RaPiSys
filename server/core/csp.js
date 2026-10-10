/**
 * RaPiSys — Content Security Policy.
 *
 * Scripts run only from the dashboard's own files: an injected <script>,
 * inline event handler or javascript: URL does not execute, so an XSS that
 * slipped past escaping cannot act as the admin. Styles may be inline
 * (GridStack, xterm and many templates set them). Images and fonts also come
 * from data: URIs (favicon, QR codes, the VNC cursor). Connections stay on
 * this host, WebSockets (terminal, desktop) included; the ws/wss sources are
 * spelled out for browsers whose 'self' does not cover them.
 *
 * Violations are reported to /api/csp-report and land in the event log, so a
 * page this policy breaks shows up there instead of failing silently.
 */
import express from 'express';

const HOST_RE = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

export function cspHeader(host) {
  const h = HOST_RE.test(String(host || '')) ? host : null;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${h ? ` ws://${h} wss://${h}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'report-uri /api/csp-report',
  ].join('; ');
}

/**
 * POST /api/csp-report: browsers send violation reports here (no session).
 * Each distinct violation is recorded once per hour, and a source address
 * gets at most 30 reports a minute, so the endpoint cannot flood the log.
 */
export function cspReportRouter({ events, now = () => Date.now() }) {
  const r = express.Router();
  const seen = new Map();      // key -> last recorded ts
  const perIp = new Map();     // ip -> [ts...]
  r.post('/', express.json({ type: ['application/csp-report', 'application/json', 'application/reports+json'], limit: '8kb' }), (req, res) => {
    const t = now();
    const ip = req.ip || '';
    const recent = (perIp.get(ip) || []).filter((x) => t - x < 60e3);
    recent.push(t);
    perIp.set(ip, recent);
    if (recent.length > 30) return res.status(204).end();
    const body = req.body || {};
    const rep = body['csp-report'] || (Array.isArray(body) ? body[0]?.body : body.body) || body;
    const clip = (v) => String(v ?? '').slice(0, 200);
    const v = {
      directive: clip(rep['effective-directive'] || rep['violated-directive'] || rep.effectiveDirective),
      blocked: clip(rep['blocked-uri'] || rep.blockedURL),
      page: clip(String(rep['document-uri'] || rep.documentURL || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0]),
      source: clip(rep['source-file'] || rep.sourceFile),
      line: Number(rep['line-number'] || rep.lineNumber) || null,
    };
    const key = `${v.directive}|${v.blocked}|${v.page}`;
    const last = seen.get(key);
    if (last === undefined || t - last > 3600e3) {
      seen.set(key, t);
      if (seen.size > 500) seen.delete(seen.keys().next().value);
      console.warn(`[csp] blocked ${v.directive} ${v.blocked} on ${v.page}`);
      try { events?.add('csp.violation', 'warning', v); } catch { /* best effort */ }
    }
    res.status(204).end();
  });
  return r;
}
