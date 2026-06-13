/** RaPiSys — /api/inventory: searchable, paginated software inventory. */

import express from 'express';

export function inventoryRouter({ inventory, inventoryRepo, requireControl, events }) {
  const r = express.Router();

  // Counts per kind + last sync time (for the page header chips).
  r.get('/summary', (req, res) => {
    res.json({ counts: inventoryRepo.counts(), facets: inventoryRepo.facets(), lastSync: inventoryRepo.lastSync() });
  });

  // Search/filter/paginate.
  r.get('/', (req, res) => {
    const { kind, q, sort, category, priority, section } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(inventoryRepo.search({ kind: kind || null, q: q || '', limit, offset, sort: sort || 'name',
      category: category || null, priority: priority || null, section: section || null }));
  });

  // Service detail (uptime, memory, enabled state).
  r.get('/service/:name', async (req, res) => {
    res.json(await inventory.serviceDetail(req.params.name));
  });

  // Preview a package removal (simulate; shows full cascade + protections).
  r.post('/package/simulate', requireControl, async (req, res) => {
    const name = String(req.body?.name || '');
    try { res.json(await inventory.removeSimulate(name)); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Perform a package removal (confirm must equal the package name).
  r.post('/package/remove', requireControl, async (req, res) => {
    const { name, confirm } = req.body || {};
    try {
      const out = await inventory.removePackage(String(name), String(confirm));
      events?.add('inventory.removed', 'warning', { name, removed: out.removed });
      const items = await inventory.collectAll();
      inventoryRepo.sync(items, ['package', 'service', 'container']);
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Service control: stop/start/restart/enable/disable.
  r.post('/service/control', requireControl, async (req, res) => {
    const { name, action } = req.body || {};
    try {
      const out = await inventory.serviceControl(String(name), String(action));
      events?.add('inventory.service', 'info', { name, action });
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Container removal (stop + rm).
  r.post('/container/remove', requireControl, async (req, res) => {
    const name = String(req.body?.name || '');
    try {
      const out = await inventory.removeContainer(name);
      events?.add('inventory.container_removed', 'warning', { name });
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
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
