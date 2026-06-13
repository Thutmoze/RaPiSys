/** RaPiSys — /api/inventory: searchable, paginated software inventory. */

import express from 'express';

export function inventoryRouter({ inventory, inventoryRepo }) {
  const r = express.Router();

  // Counts per kind + last sync time (for the page header chips).
  r.get('/summary', (req, res) => {
    res.json({ counts: inventoryRepo.counts(), lastSync: inventoryRepo.lastSync() });
  });

  // Search/filter/paginate.
  r.get('/', (req, res) => {
    const { kind, q, sort } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(inventoryRepo.search({ kind: kind || null, q: q || '', limit, offset, sort: sort || 'name' }));
  });

  // Service detail (uptime, memory, enabled state).
  r.get('/service/:name', async (req, res) => {
    res.json(await inventory.serviceDetail(req.params.name));
  });

  // Force a re-sync now.
  r.post('/sync', async (req, res) => {
    try {
      const items = await inventory.collectAll();
      inventoryRepo.sync(items, ['package', 'service', 'container']);
      res.json({ ok: true, synced: items.length, counts: inventoryRepo.counts() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
}
