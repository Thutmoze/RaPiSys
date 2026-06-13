/** RaPiSys — /api/network: live throughput, vnStat history, protocols, DNS. */

import express from 'express';

export function networkRouter({ network, metricsRepo }) {
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

  return r;
}
