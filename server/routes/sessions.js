/** RaPiSys — /api/sessions: live sessions + login history. */

import express from 'express';
import { agentCall } from '../core/agent-client.js';

export function sessionsRouter({ sessions, sessionsRepo, requireAuth, requireControl }) {
  const r = express.Router();

  // Who is logged in, from which IP, on which device — sensitive data.
  // In full-control mode this requires the admin session (in monitor
  // mode, where no account exists, it stays LAN-open like the rest).
  r.use(requireAuth);

  r.get('/', async (req, res) => {
    try { res.json(await sessions.snapshot()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/history', (req, res) => {
    const now = Date.now();
    const RANGES = { '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
    const from = Number(req.query.from) || now - (RANGES[req.query.range] || RANGES['7d']);
    res.json({
      history: sessionsRepo.history({ from, to: Number(req.query.to) || now, kind: req.query.kind || null }),
      perDay: sessionsRepo.loginsPerDay(30),
    });
  });

  // Disconnecting a user is Pi control: 403 in monitor mode, admin in full.
  r.post('/:id/terminate', requireControl, async (req, res) => {
    try {
      const out = await agentCall('sessions.terminate', { id: req.params.id }, null, 6000);
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
}
