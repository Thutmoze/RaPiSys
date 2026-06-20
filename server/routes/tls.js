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

export function tlsRouter({ tls, requireControl, getApp }) {
  const r = express.Router();

  r.get('/status', async (req, res) => {
    const cfg = await tls.getConfig();
    res.json({
      enabled: cfg.enabled, mode: cfg.mode, port: cfg.port,
      listening: tls.isListening(), certPresent: tls.certsExist(),
      notAfter: cfg.notAfter || null, dnsName: cfg.dnsName || null, provisionedAt: cfg.provisionedAt || null,
    });
  });

  r.get('/tailscale', async (req, res) => {
    res.json(await tls.tailscaleStatus());
  });

  // Enable HTTPS in the given mode: provision the cert, persist, start listener.
  r.post('/enable', requireControl, async (req, res) => {
    const mode = req.body?.mode === 'tailscale' ? 'tailscale' : 'selfsigned';
    try {
      const prov = await tls.provision(mode, { dnsName: req.body?.dnsName || null });
      await tls.setConfig({ enabled: true, mode });
      const started = await tls.start(getApp());
      res.json({ ok: true, mode, provision: prov, listener: started });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  r.post('/disable', requireControl, async (req, res) => {
    try { await tls.setConfig({ enabled: false }); await tls.stop(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
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
