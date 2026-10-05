/** RaPiSys — /api/storage/backup: rapisys.db backups to the NAS (status, schedule, run now). */

import express from 'express';

// Gated like other settings (requireConfig), not like Pi control: backups run
// inside the container, so they work in monitor-only mode too.
export function dbBackupRouter({ dbBackup, requireAuth }) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try { res.json(await dbBackup.status()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Save schedule (enabled, frequency, retain).
  r.post('/config', requireAuth, async (req, res) => {
    try { res.json({ ok: true, config: await dbBackup.saveConfig(req.body || {}) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Run a backup now, streamed (SSE), same event names as the Pi-hole backup.
  r.get('/run/stream', requireAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('start', {});
    try { send('done', await dbBackup.run((line) => send('line', { line }))); }
    catch (err) { send('failed', { message: err.message }); }
    res.end();
  });

  return r;
}
