/**
 * RaPiSys — Pironman 5 Mini routes
 * --------------------------------
 * Reachable surface for the Settings → Pironman tab and the gated Overview /
 * Hardware cards. Reads go through the pm_dashboard proxy client; install /
 * update / restart are host-agent ops (streamed over SSE). Mutating routes are
 * requireControl-gated; connection settings (enable + host/port) persist to
 * settings.json under rapisys.pironman.
 */

import express from 'express';
import { agentCall, agentConfigured } from '../core/agent-client.js';

export function pironmanRouter({ pironman, requireControl, loadSettings, saveSettings, withFileLock, refreshPironmanConfig }) {
  const r = express.Router();

  // ---- read surface --------------------------------------------------------

  // Normalised snapshot: presence/version + fan/rgb/display (for the cards).
  r.get('/status', async (req, res) => {
    try { res.json(await pironman.snapshot()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Agent detect: install / service / version / api reachability / config path.
  r.get('/detect', async (req, res) => {
    try { res.json((await pironman.detect()) || { installed: false }); }
    catch (err) { res.status(500).json({ installed: false, error: err.message }); }
  });

  // Live device config (API first, agent file fallback).
  r.get('/config', async (req, res) => {
    try { res.json(await pironman.readConfig()); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Saved connection settings (enable + host/port).
  r.get('/settings', async (req, res) => {
    try {
      const s = await loadSettings();
      res.json(s.rapisys?.pironman || { enabled: false, host: '127.0.0.1', port: 34001 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- write surface (requireControl) -------------------------------------

  // Persist enable + host/port to settings.json.
  r.post('/settings', requireControl, async (req, res) => {
    try {
      const body = req.body || {};
      await withFileLock(async () => {
        const s = await loadSettings();
        s.rapisys = s.rapisys || {};
        const cur = s.rapisys.pironman || {};
        s.rapisys.pironman = {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : (cur.enabled ?? false),
          host: body.host ? String(body.host).slice(0, 253) : (cur.host || '127.0.0.1'),
          port: body.port ? Math.min(Math.max(parseInt(body.port, 10) || 34001, 1), 65535) : (cur.port || 34001),
        };
        await saveSettings(s);
      });
      await refreshPironmanConfig?.();
      const s = await loadSettings();
      res.json({ ok: true, pironman: s.rapisys?.pironman || null });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Apply a device-config patch (fan/rgb/display). Live via pm_dashboard
  // setters, or the agent file write + restart when the API is down.
  r.post('/config', requireControl, async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const patch = (body.system && typeof body.system === 'object') ? body.system : body;
      res.json(await pironman.setConfig(patch));
    } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
  });

  // Connectivity test for the Settings "Test" button.
  r.post('/test', requireControl, async (req, res) => {
    try { await refreshPironmanConfig?.(); res.json(await pironman.test()); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Is a newer Pironman version published upstream?
  r.get('/update-check', async (req, res) => {
    try {
      if (!agentConfigured()) return res.status(503).json({ error: 'host agent not configured' });
      res.json(await agentCall('pironman.checkUpdate', {}, null, 20000));
    } catch (err) { res.status(500).json({ installed: false, error: err.message }); }
  });

  // Restart the pironman service (agent).
  r.post('/restart', requireControl, async (req, res) => {
    try {
      if (!agentConfigured()) return res.status(503).json({ error: 'host agent not configured' });
      res.json(await agentCall('pironman.restart', {}, null, 40000));
    } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
  });

  // ---- streamed (SSE) install / update ------------------------------------

  function sse(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // One-click install, streamed. slim=1 (or disableDashboard=1) installs without
  // pm_dashboard/InfluxDB. Admin-token gated. 'failed' event on error.
  r.get('/install/stream', requireControl, async (req, res) => {
    const send = sse(res);
    const slim = String(req.query.slim || req.query.disableDashboard || '') === '1';
    try {
      if (!agentConfigured()) throw new Error('host agent not configured (run deploy.sh on the Pi)');
      send('line', { line: `Starting Pironman 5 Mini install${slim ? ' (slim)' : ''}…` });
      const result = await agentCall('pironman.install', { disableDashboard: slim },
        (line) => send('line', { line }), 1_800_000);
      await refreshPironmanConfig?.();
      send('done', result); // includes rebootRequired:true
    } catch (err) {
      send('failed', { error: err.message });
    }
    res.end();
  });

  // Apply an update, streamed. Admin-token gated. 'failed' event on error.
  r.get('/update/stream', requireControl, async (req, res) => {
    const send = sse(res);
    try {
      if (!agentConfigured()) throw new Error('host agent not configured');
      send('line', { line: 'Updating Pironman 5 Mini…' });
      const result = await agentCall('pironman.update', {}, (line) => send('line', { line }), 1_800_000);
      await refreshPironmanConfig?.();
      send('done', result);
    } catch (err) {
      send('failed', { error: err.message });
    }
    res.end();
  });

  return r;
}
