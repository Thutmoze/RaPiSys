/**
 * RaPiSys — /api/disk
 * ===================
 * Storage usage, the cleanup scan, the streamed clean/purge run, and the
 * auto-clean schedule. Reads are open at the mount-level requireConfig gate;
 * the clean run and schedule writes additionally require requireControl. The
 * client only ever sends category IDs — the agent maps those to fixed
 * operations, so no path ever crosses this boundary.
 */
import express from 'express';

const VALID_CATS = new Set(['apt-cache', 'journal', 'logs-rotated', 'tmp-stale',
  'apt-autoremove', 'docker-prune', 'crash-dumps', 'user-cache', 'user-old-files']);

const DEFAULT_SCHEDULE = {
  enabled: false, frequency: 'weekly', time: '03:00', dayOfWeek: 0, dayOfMonth: 1,
  mode: 'clean', categories: ['apt-cache', 'journal', 'logs-rotated', 'tmp-stale', 'docker-prune'],
  journalTargetMB: 200, lastRunAt: 0,
};

function sanitizeSchedule(b = {}) {
  return {
    enabled: !!b.enabled,
    frequency: ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'weekly',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : '03:00',
    dayOfWeek: Math.min(6, Math.max(0, Number(b.dayOfWeek) || 0)),
    dayOfMonth: Math.min(28, Math.max(1, Number(b.dayOfMonth) || 1)),
    mode: b.mode === 'scan' ? 'scan' : 'clean',
    categories: Array.isArray(b.categories) ? b.categories.filter((c) => VALID_CATS.has(c)) : DEFAULT_SCHEDULE.categories,
    journalTargetMB: Math.min(2000, Math.max(50, Number(b.journalTargetMB) || 200)),
    lastRunAt: Number(b.lastRunAt) || 0,
  };
}

export function diskRouter({ disk, requireControl, loadSettings, saveSettings, withFileLock, events }) {
  const r = express.Router();

  // Filesystem usage (df) for the storage card.
  r.get('/usage', async (req, res) => {
    try { res.json(await disk.usage()); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Read-only cleanup scan. journalTargetMB tunes the journal category estimate.
  r.get('/scan', async (req, res) => {
    const target = Math.min(2000, Math.max(50, Number(req.query.journalTargetMB) || 200));
    try { res.json(await disk.scan(target)); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Cleanup, streamed (SSE — EventSource is GET-only). categories=comma list;
  // purgeAll=1 requires confirm=PURGE (re-checked in the agent).
  r.get('/clean/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const categories = String(req.query.categories || '').split(',').map((s) => s.trim()).filter((c) => VALID_CATS.has(c));
    const journalTargetMB = Math.min(2000, Math.max(50, Number(req.query.journalTargetMB) || 200));
    const purgeAll = req.query.purgeAll === '1' || req.query.purgeAll === 'true';
    const confirm = String(req.query.confirm || '');
    if (!categories.length) { send('error', { message: 'no categories selected' }); return res.end(); }
    send('start', { categories, mode: purgeAll ? 'purge' : 'clean' });
    try {
      const out = await disk.clean({ categories, journalTargetMB, purgeAll, confirm }, (line) => send('progress', { line }));
      events.add('disk.clean', 'info', { categories: out.cleaned || categories, reclaimedBytes: out.reclaimedBytes || 0, purgeAll });
      send('done', { cleaned: out.cleaned || [], reclaimedBytes: out.reclaimedBytes || 0 });
    } catch (err) {
      events.add('disk.clean.failed', 'warning', { error: err.message });
      send('error', { message: err.message });
    }
    res.end();
  });

  // Auto-clean schedule.
  r.get('/schedule', async (req, res) => {
    const s = (await loadSettings()).rapisys?.diskClean;
    res.json({ ...DEFAULT_SCHEDULE, ...(s || {}) });
  });

  r.post('/schedule', requireControl, async (req, res) => {
    const next = sanitizeSchedule(req.body || {});
    try {
      await withFileLock(async () => {
        const s = await loadSettings();
        s.rapisys = s.rapisys || {};
        next.lastRunAt = s.rapisys.diskClean?.lastRunAt || 0;   // preserve run history
        s.rapisys.diskClean = next;
        await saveSettings(s);
      });
      res.json({ ok: true, schedule: next });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
}
