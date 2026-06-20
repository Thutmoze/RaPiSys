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

  // "Recommended to remove": orphaned packages, failed/inactive services,
  // stopped containers, large-and-old packages — each with a reason. Served from
  // a stored snapshot; pass ?refresh=1 to re-analyze and persist.
  r.get('/recommendations', async (req, res) => {
    try {
      if (req.query.refresh !== '1') {
        const cached = inventoryRepo.getRecommendations();
        if (cached) return res.json({ ...cached, cached: true });
      }
      const fresh = await inventory.recommendations();
      inventoryRepo.saveRecommendations(fresh);
      res.json({ ...fresh, cached: false });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  // SSE-streamed package removal: relays apt output line-by-line so the UI can
  // show what's happening. GET (EventSource) — ?name=&confirm= ; the same
  // server-side guard re-runs in the agent, so this is no less safe than POST.
  r.get('/package/remove/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const name = String(req.query.name || '');
    const confirm = String(req.query.confirm || '');
    send('start', { name });
    try {
      const out = await inventory.removePackage(name, confirm, (line) => send('progress', { line }));
      events?.add('inventory.removed', 'warning', { name, removed: out.removed });
      inventoryRepo.recordHistory({ kind: 'package', name, action: 'uninstall', result: out.ok === false ? 'failed' : 'ok',
        detail: (out.removed && out.removed.length > 1) ? `with ${out.removed.length - 1} dependent package(s)` : null });
      const items = await inventory.collectAll();
      inventoryRepo.sync(items, ['package', 'service', 'container']);
      send('done', out);
    } catch (err) { inventoryRepo.recordHistory({ kind: 'package', name, action: 'uninstall', result: 'failed', detail: err.message }); send('failed', { message: err.message }); }
    res.end();
  });

  // Install (or reinstall) a package — used by the activity-history reinstall
  // action. SSE-streamed so the UI shows apt output. ?name=
  r.get('/package/install/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const name = String(req.query.name || '');
    send('start', { name });
    try {
      const out = await inventory.installPackage(name, (line) => send('progress', { line }));
      events?.add('inventory.installed', 'info', { name });
      inventoryRepo.recordHistory({ kind: 'package', name, action: 'install', result: out.ok === false ? 'failed' : 'ok' });
      const items = await inventory.collectAll();
      inventoryRepo.sync(items, ['package', 'service', 'container']);
      send('done', out);
    } catch (err) { inventoryRepo.recordHistory({ kind: 'package', name, action: 'install', result: 'failed', detail: err.message }); send('failed', { message: err.message }); }
    res.end();
  });

  // Activity history: install / uninstall events with reversible actions.
  r.get('/history', (req, res) => {
    res.json({ history: inventoryRepo.history(Number(req.query.limit) || 100) });
  });

  // Service control: stop/start/restart/enable/disable.
  r.post('/service/control', requireControl, async (req, res) => {
    const { name, action } = req.body || {};
    try {
      const out = await inventory.serviceControl(String(name), String(action));
      events?.add('inventory.service', 'info', { name, action });
      // stop/start are reversible; record so the activity tab can offer the inverse
      if (action === 'stop' || action === 'start') inventoryRepo.recordHistory({ kind: 'service', name, action: action === 'stop' ? 'stop' : 'start' });
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Container removal (stop + rm).
  r.post('/container/remove', requireControl, async (req, res) => {
    const name = String(req.body?.name || '');
    try {
      const out = await inventory.removeContainer(name);
      events?.add('inventory.container_removed', 'warning', { name });
      inventoryRepo.recordHistory({ kind: 'container', name, action: 'remove' });
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
