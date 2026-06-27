/**
 * RaPiSys — TLS / HTTPS routes (admin-gated except read-only status).
 *
 *   GET  /api/tls/status            — current config + listener + cert info
 *   GET  /api/tls/tailscale         — tailscale availability + *.ts.net name
 *   POST /api/tls/enable            — { mode } provision + enable + start listener
 *   POST /api/tls/disable           — stop HTTPS, mark disabled
 *   POST /api/tls/provision         — re-issue/renew the cert for the active mode
 */
import express from 'express';

export function tlsRouter({ tls, requireControl, getApp, loadSettings }) {
  const r = express.Router();

  // During first-run setup (before completion) HTTPS must be enable-able so the
  // wizard can switch to a secure connection BEFORE the admin account exists —
  // otherwise the gates deadlock (no account without HTTPS, no HTTPS-via-
  // requireControl without an authenticated full-control session, no session
  // without an account). Mirrors the open bootstrap window in setup.js. Once
  // setup is completed this reverts to the normal requireControl gate.
  async function controlOrSetup(req, res, next) {
    try {
      const s = await loadSettings();
      if (!s.rapisys?.setupCompleted) return next();
    } catch { /* fall through to the strict gate */ }
    return requireControl(req, res, next);
  }

  r.get('/status', async (req, res) => {
    const cfg = await tls.getConfig();
    res.json({
      enabled: cfg.enabled, mode: cfg.mode, port: cfg.port, redirect: !!cfg.redirect,
      listening: tls.isListening(), certPresent: tls.certsExist(),
      notAfter: cfg.notAfter || null, dnsName: cfg.dnsName || null, provisionedAt: cfg.provisionedAt || null,
    });
  });

  r.get('/tailscale', async (req, res) => {
    res.json(await tls.tailscaleStatus());
  });

  // Enable HTTPS in the given mode: provision the cert, persist, start listener.
  r.post('/enable', controlOrSetup, async (req, res) => {
    const mode = req.body?.mode === 'tailscale' ? 'tailscale' : 'selfsigned';
    try {
      const prov = await tls.provision(mode, { dnsName: req.body?.dnsName || null });
      await tls.setConfig({ enabled: true, mode });
      const started = await tls.start(getApp());
      if (!started.listening) {
        // Cert provisioned but the listener didn't come up — surface the reason
        // so the UI doesn't show a misleading "enabled but not listening" state.
        return res.status(502).json({ error: `HTTPS could not start: ${started.reason || 'unknown'}`,
          code: 'tls_not_listening', provision: prov, listener: started });
      }
      res.json({ ok: true, mode, provision: prov, listener: started });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  r.post('/disable', requireControl, async (req, res) => {
    try { await tls.setConfig({ enabled: false }); await tls.stop(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Toggle HTTP→HTTPS redirect (only effective while HTTPS is listening).
  r.post('/redirect', requireControl, async (req, res) => {
    try {
      const on = req.body?.enabled === true;
      await tls.setConfig({ redirect: on });
      await tls.refreshRedirect();
      res.json({ ok: true, redirect: on });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Manual re-issue / renew for the active mode.
  r.post('/provision', requireControl, async (req, res) => {
    try {
      const cfg = await tls.getConfig();
      const prov = await tls.provision(cfg.mode, { dnsName: req.body?.dnsName || null });
      const started = await tls.start(getApp());
      res.json({ ok: true, provision: prov, listener: started });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  return r;
}
