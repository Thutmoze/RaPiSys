/**
 * RaPiSys — /api/updates (F8)
 * Update detection, changelog, history, and SSE-streamed upgrades.
 */

import express from 'express';

export function updatesRouter({ updates, updatesRepo, requireControl, events }) {
  const r = express.Router();

  // Cached list (instant) — does NOT trigger a scan. Use /refresh to re-check.
  r.get('/', (req, res) => {
    res.json(updates.cached());
  });

  // apt-get update + fresh list + security scan, streamed (SSE) with progress.
  r.get('/refresh/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const out = await updates.refresh((p) => send('progress', p));
      send('done', { count: out.updates?.length || 0, checkedAt: out.checkedAt });
    } catch (err) { send('error', { message: err.message }); }
    res.end();
  });

  // Non-streaming refresh (kept for scripts/automation).
  r.post('/refresh', requireControl, async (req, res) => {
    try { res.json(await updates.refresh()); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Firmware (rpi-eeprom) status.
  r.get('/firmware', async (req, res) => {
    res.json(await updates.firmware());
  });

  // Changelog for a package.
  r.get('/changelog/:pkg', async (req, res) => {
    // candidate=1 (default) extracts the NEW version's notes from its .deb
    const candidate = req.query.candidate !== '0';
    res.json(await updates.changelog(req.params.pkg, candidate));
  });

  // Update history.
  r.get('/history', (req, res) => {
    res.json({ history: updatesRepo.recent(Number(req.query.limit) || 50) });
  });

  // Simulate an upgrade (dry run) — returns the apt plan as text.
  r.post('/simulate', requireControl, async (req, res) => {
    const { packages, full } = req.body || {};
    let out = '';
    try {
      await updates.upgrade({ packages: packages || null, full: !!full, simulate: true }, (line) => { out += line + '\n'; });
      res.json({ ok: true, plan: out });
    } catch (err) { res.status(502).json({ error: err.message, plan: out }); }
  });

  // SSE-streamed upgrade. Query: ?full=1 or ?packages=a,b,c
  r.get('/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const full = req.query.full === '1';
    const packages = req.query.packages ? String(req.query.packages).split(',').filter(Boolean) : null;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!full && (!packages || !packages.length)) {
      send('error', { message: 'no packages specified' });
      return res.end();
    }

    const startTs = Date.now();
    let logBuf = '';
    send('start', { full, packages, ts: startTs });
    try {
      const result = await updates.upgrade({ packages, full }, (line) => {
        logBuf += line + '\n';
        send('line', { line });
      });
      const ok = result.code === 0;
      // record history (one row for full, one per package otherwise)
      const entries = full
        ? [{ ts: Date.now(), packageName: 'dist-upgrade', result: ok ? 'success' : 'failed', log: logBuf }]
        : packages.map((p) => ({ ts: Date.now(), packageName: p, result: ok ? 'success' : 'failed', log: logBuf.slice(0, 4000) }));
      updatesRepo.recordBatch(entries);
      events?.add('updates.applied', ok ? 'info' : 'warning', { full, packages, ok });
      send('done', { ok, code: result.code });
    } catch (err) {
      updatesRepo.record({ ts: Date.now(), packageName: full ? 'dist-upgrade' : (packages || []).join(','), result: 'error', log: logBuf + '\n' + err.message });
      send('error', { message: err.message });
    }
    res.end();
  });

  // Firmware update (SSE).
  r.get('/firmware/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('start', {});
    try {
      const result = await updates.firmwareUpdate((line) => send('line', { line }));
      events?.add('updates.firmware', 'info', {});
      send('done', { ok: result.code === 0, note: result.note });
    } catch (err) { send('error', { message: err.message }); }
    res.end();
  });

  return r;
}
