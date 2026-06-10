/** RaPiSys — /api/hardware: Pi 5 hardware snapshot + fan control. */

import express from 'express';
import { agentCall, agentConfigured } from '../core/agent-client.js';

export function hardwareRouter({ hardware, eventsRepo, requireAuth }) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      res.json(await hardware.snapshot());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/events', (req, res) => {
    const all = eventsRepo.recent(200);
    res.json({ events: all.filter((e) => e.type.startsWith('hw.')) });
  });

  // Fan control goes through the host agent (sysfs is read-only in-container).
  r.post('/fan', requireAuth, async (req, res) => {
    if (!agentConfigured()) {
      return res.status(503).json({ error: 'Fan control requires the host agent. Run deploy.sh on your Pi.' });
    }
    const { mode, dutyPercent } = req.body || {};
    try {
      let result;
      if (mode === 'auto') {
        result = await agentCall('fan.setMode', { mode: 'auto' });
        eventsRepo.add('hw.fan.mode', 'info', { mode: 'auto' });
      } else if (dutyPercent !== undefined) {
        result = await agentCall('fan.setDuty', { percent: Number(dutyPercent) });
        eventsRepo.add('hw.fan.duty', 'info', { dutyPercent: Number(dutyPercent) });
      } else {
        return res.status(400).json({ error: "send { mode: 'auto' } or { dutyPercent: 0–100 }" });
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return r;
}
