/** RaPiSys — /api/network: live throughput, vnStat history, protocols, DNS. */

import express from 'express';

export function networkRouter({ network, metricsRepo, requireControl, loadSettings, saveSettings, withFileLock, secrets, refreshPiholeConfig }) {
  const r = express.Router();

  // Live snapshot (everything in one call for the page's first paint).
  r.get('/', async (req, res) => {
    try { res.json(await network.snapshot()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Throughput only — cheap, for the live poll.
  r.get('/throughput', (req, res) => {
    try { res.json(network.throughput()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // vnStat history for charts.
  r.get('/history', async (req, res) => {
    try { res.json(await network.vnstat(req.query.iface || null)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Server-sampled per-interface rate history from the metrics table.
  r.get('/rate-history', (req, res) => {
    const iface = String(req.query.iface || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const hours = Math.min(Number(req.query.hours) || 6, 168);
    const since = Date.now() - hours * 3600e3;
    res.json({
      rx: metricsRepo.query({ metric: `net.${iface}.rx`, since }),
      tx: metricsRepo.query({ metric: `net.${iface}.tx`, since }),
    });
  });

  // Protocol share (% of connections) with the connection list per service.
  r.get('/protocols', async (req, res) => {
    try { res.json(await network.protocolShare()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Full connection list (proc, port, peer) for the click-through.
  r.get('/connections', async (req, res) => {
    try { res.json({ connections: await network.connections() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Opt-in DNS query logging (modifies dnsmasq config -> Pi control).
  r.post('/dns/logging', requireControl, async (req, res) => {
    try { res.json(await network.dnsSetLogging(!!req.body?.enabled)); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Opt-in DNS logging forwarder in front of MagicDNS (installs dnsmasq).
  r.post('/dns/forwarder', requireControl, async (req, res) => {
    try { res.json(await network.dnsForwarder(!!req.body?.enable)); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // ---- Pi-hole DNS analytics ---------------------------------------------

  // Current Pi-hole config (password is never returned — write-only).
  r.get('/dns/pihole/config', async (req, res) => {
    try {
      const c = (await loadSettings()).rapisys?.pihole || {};
      res.json({
        enabled: !!c.enabled,
        host: c.host || '127.0.0.1',
        port: c.port || 80,
        scheme: c.scheme || 'http',
        version: c.version || 'auto',
        hasPassword: secrets.has('pihole.password'),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Live Pi-hole snapshot (domains, blocked, categories, totals, blocking state).
  r.get('/dns/pihole/status', async (req, res) => {
    try {
      const snap = await network.piholeSnapshot(Number(req.query.limit) || 12);
      if (!snap) return res.json({ configured: false });
      res.json({ configured: true, ...snap });
    } catch (err) { res.status(502).json({ configured: true, available: false, error: err.message }); }
  });

  // Save Pi-hole config (host/port/scheme/version/enabled + optional password).
  r.post('/dns/pihole/config', requireControl, async (req, res) => {
    const b = req.body || {};
    const host = String(b.host || '127.0.0.1').trim().replace(/[^a-zA-Z0-9.\-:]/g, '').slice(0, 100);
    const port = Math.min(Math.max(parseInt(b.port, 10) || 80, 1), 65535);
    const scheme = b.scheme === 'https' ? 'https' : 'http';
    const version = ['5', '6', 'auto'].includes(String(b.version)) ? String(b.version) : 'auto';
    const enabled = !!b.enabled;
    try {
      await withFileLock(async () => {
        const s = await loadSettings();
        s.rapisys = s.rapisys || {};
        s.rapisys.pihole = { enabled, host, port, scheme, version };
        await saveSettings(s);
      });
      // Password: write-only. Empty string clears it; undefined leaves it intact.
      if (typeof b.password === 'string') {
        if (b.password === '') secrets.remove('pihole.password');
        else if (secrets.encryptionAvailable()) secrets.set('pihole.password', b.password);
        else return res.status(400).json({ error: 'SECRET_KEY not set — cannot store the Pi-hole password securely' });
      }
      await refreshPiholeConfig();
      network.piholeResetSession();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Test the Pi-hole connection with the stored config.
  r.post('/dns/pihole/test', requireControl, async (req, res) => {
    try { await refreshPiholeConfig(); network.piholeResetSession(); res.json(await network.piholeTest()); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Enable / temporarily disable Pi-hole blocking.
  r.post('/dns/pihole/blocking', requireControl, async (req, res) => {
    const enabled = !!req.body?.enabled;
    const seconds = req.body?.seconds != null ? Math.max(0, parseInt(req.body.seconds, 10) || 0) : null;
    try { res.json(await network.piholeSetBlocking(enabled, seconds)); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Opt-in per-process bandwidth sample via nethogs (installs on first use).
  r.post('/nethogs', requireControl, async (req, res) => {
    try { res.json(await network.nethogsSample(Number(req.body?.seconds) || 5)); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  return r;
}
