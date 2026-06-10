/** RaPiSys — /api/history: read API for stored time-series and events. */

import express from 'express';

export function historyRouter({ metricsRepo, eventsRepo }) {
  const r = express.Router();

  // GET /api/history?metric=temp.cpu&range=24h   (or &from=&to= in unix ms)
  r.get('/', (req, res) => {
    const metric = String(req.query.metric || '');
    if (!metric) return res.status(400).json({ error: 'metric is required' });
    const now = Date.now();
    const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3,
      '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3, '365d': 365 * 86400e3 };
    const from = req.query.from ? Number(req.query.from) : now - (RANGES[req.query.range] || RANGES['24h']);
    const to = req.query.to ? Number(req.query.to) : now;
    const { res: usedRes, points } = metricsRepo.query(metric, from, to);
    res.json({ metric, from, to, res: usedRes, points });
  });

  r.get('/metrics', (req, res) => res.json({ metrics: metricsRepo.listMetrics() }));

  r.get('/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ events: eventsRepo.recent(limit, req.query.type || null) });
  });

  return r;
}
