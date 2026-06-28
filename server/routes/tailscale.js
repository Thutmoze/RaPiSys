/**
 * RaPiSys — Tailscale routes
 * --------------------------
 * Reachable surface for the Settings → Remote Access → Tailscale card. The
 * `tailscale` binary lives on the host, so every operation is a host-agent op
 * (read-only detect/update-check, or streamed install/up/uninstall/update over
 * SSE). Mutating routes are requireControl-gated. Connecting Tailscale unlocks
 * the "Tailscale (trusted *.ts.net)" certificate mode in the HTTPS/TLS card.
 */

import express from 'express';
import { agentCall, agentConfigured } from '../core/agent-client.js';

export function tailscaleRouter({ requireControl }) {
  const r = express.Router();

  // ---- read surface --------------------------------------------------------

  // Presence / version / daemon / backend state / prefs. Never throws on a
  // missing agent — the card degrades to a "host agent unavailable" note.
  r.get('/detect', async (req, res) => {
    try {
      if (!agentConfigured()) return res.json({ installed: false, agent: false });
      const det = await agentCall('tailscale.detect', {}, null, 20000);
      res.json({ ...det, agent: true });
    } catch (err) { res.status(500).json({ installed: false, agent: true, error: err.message }); }
  });

  // Is a newer Tailscale available?
  r.get('/update-check', async (req, res) => {
    try {
      if (!agentConfigured()) return res.status(503).json({ error: 'host agent not configured' });
      res.json(await agentCall('tailscale.checkUpdate', {}, null, 40000));
    } catch (err) { res.status(500).json({ installed: false, error: err.message }); }
  });

  // ---- write surface (requireControl) -------------------------------------

  // Disconnect from the tailnet but stay logged in (reconnect needs no re-auth).
  r.post('/down', requireControl, async (req, res) => {
    try {
      if (!agentConfigured()) return res.status(503).json({ error: 'host agent not configured' });
      res.json(await agentCall('tailscale.down', {}, null, 30000));
    } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
  });

  // Log out entirely (next connect requires re-authentication).
  r.post('/logout', requireControl, async (req, res) => {
    try {
      if (!agentConfigured()) return res.status(503).json({ error: 'host agent not configured' });
      res.json(await agentCall('tailscale.logout', {}, null, 40000));
    } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
  });

  // ---- streamed (SSE) install / up / uninstall / update -------------------

  function sse(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // When `tailscale up` runs without an auth key it prints a login URL; pull it
  // out of the stream and emit it as its own event so the UI can render a
  // prominent "Open login page" button.
  const LOGIN_RE = /(https:\/\/login\.tailscale\.com\/\S+)/;

  // Install the binary only (does not join a tailnet). 'failed' (never 'error')
  // avoids the EventSource native-error event-name collision.
  r.get('/install/stream', requireControl, async (req, res) => {
    const send = sse(res);
    try {
      if (!agentConfigured()) throw new Error('host agent not configured (run deploy.sh on the Pi)');
      send('line', { line: 'Starting Tailscale install…' });
      const result = await agentCall('tailscale.install', {}, (line) => send('line', { line }), 600_000);
      send('done', result);
    } catch (err) { send('failed', { error: err.message }); }
    res.end();
  });

  // Join / re-configure the tailnet. Params arrive as query string (consistent
  // with the Pi-hole install stream). authKey is optional; when absent, the
  // 'loginurl' event carries the browser authorization link.
  r.get('/up/stream', requireControl, async (req, res) => {
    const send = sse(res);
    const params = {
      authKey: String(req.query.authKey || ''),
      ssh: String(req.query.ssh || '') === '1',
      hostname: String(req.query.hostname || ''),
      acceptRoutes: String(req.query.acceptRoutes || '') === '1',
      acceptDns: String(req.query.acceptDns ?? '1') === '1',
      advertiseRoutes: String(req.query.advertiseRoutes || ''),
    };
    try {
      if (!agentConfigured()) throw new Error('host agent not configured');
      send('line', { line: params.authKey ? 'Connecting with auth key…' : 'Starting login…' });
      const result = await agentCall('tailscale.up', params, (line) => {
        send('line', { line });
        const m = line.match(LOGIN_RE);
        if (m) send('loginurl', { url: m[1] });
      }, 360_000);
      send('done', result);
    } catch (err) { send('failed', { error: err.message }); }
    res.end();
  });

  // Remove Tailscale from the host (typed confirmation enforced agent-side).
  r.get('/uninstall/stream', requireControl, async (req, res) => {
    const send = sse(res);
    try {
      if (!agentConfigured()) throw new Error('host agent not configured');
      send('line', { line: 'Starting Tailscale uninstall…' });
      const result = await agentCall('tailscale.uninstall', { confirm: 'UNINSTALL' },
        (line) => send('line', { line }), 300_000);
      send('done', result);
    } catch (err) { send('failed', { error: err.message }); }
    res.end();
  });

  // Apply the available update (streamed).
  r.get('/update/stream', requireControl, async (req, res) => {
    const send = sse(res);
    try {
      if (!agentConfigured()) throw new Error('host agent not configured');
      send('line', { line: 'Updating Tailscale…' });
      const result = await agentCall('tailscale.update', {}, (line) => send('line', { line }), 600_000);
      send('done', result);
    } catch (err) { send('failed', { error: err.message }); }
    res.end();
  });

  return r;
}
