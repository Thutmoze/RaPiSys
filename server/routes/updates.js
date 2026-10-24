/**
 * RaPiSys — /api/updates (F8)
 * Update detection, changelog, history, and SSE-streamed upgrades.
 */

import express from 'express';

export function updatesRouter({ updates, updateScheduler, updatesRepo, requireControl, events, rebootStatus }) {
  const r = express.Router();

  // -- automatic update check schedule (read public, write requires control) --
  r.get('/schedule', async (req, res) => {
    const cfg = await updateScheduler.getConfig();
    res.json({ ...cfg, _running: updateScheduler.isRunning?.() || { running: false } });
  });
  r.put('/schedule', requireControl, async (req, res) => {
    try { res.json(await updateScheduler.setConfig(req.body || {})); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  // Run a scheduled check immediately (and email per the saved config).
  r.post('/schedule/run', requireControl, async (req, res) => {
    try { res.json(await updateScheduler.runOnce()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

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
      // apt itself failed (dpkg lock, etc.) — out.updates is absent, not just
      // empty. Report it as a failure, not as "0 updates found", so a manual
      // check can't silently look identical to a genuinely clean result.
      if (out.ok === false) send('error', { message: out.error || 'update check failed' });
      else send('done', { count: out.updates?.length || 0, checkedAt: out.checkedAt, unscanned: out.unscanned || [] });
    } catch (err) { send('error', { message: err.message }); }
    res.end();
  });

  // Non-streaming refresh (kept for scripts/automation).
  r.post('/refresh', requireControl, async (req, res) => {
    try {
      const out = await updates.refresh();
      if (out.ok === false) return res.status(502).json({ error: out.error || 'update check failed' });
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Full-download security scan for the large packages the quick scan skipped.
  // Streams overall progress (pkg N/M) plus per-package download %.
  r.get('/scan-large/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pkgs = String(req.query.packages || '').split(',').filter(Boolean);
    send('start', { total: pkgs.length });
    let i = 0;
    for (const pkg of pkgs) {
      i++;
      send('pkg', { pkg, index: i, total: pkgs.length });
      try {
        const out = await updates.changelogFull(pkg, (p) => send('progress', { pkg, index: i, total: pkgs.length, ...p }));
        if (out.changelog) {
          const tag = updates.tagSecurityFromChangelog(pkg, out.candidateVersion, out.changelog, installedOf(pkg));
          send('tagged', { pkg, security: tag.security, cves: tag.cves, urgency: tag.urgency });
        }
      } catch (err) { send('pkgerror', { pkg, message: err.message }); }
    }
    send('done', {});
    res.end();
  });

  // Firmware (rpi-eeprom) status.
  r.get('/firmware', async (req, res) => {
    res.json(await updates.firmware());
  });

  // Changelog for a package.
  const installedOf = (pkg) => {
    try { const c = updates.cached(); const u = (c.updates || []).find((x) => x.package === pkg); return u ? u.installed : null; }
    catch { return null; }
  };

  // "About" panel: what a package is and why it is installed (read-only).
  r.get('/about/:pkg', async (req, res) => {
    const pkg = req.params.pkg;
    if (!/^[a-z0-9][a-z0-9+.:~-]*$/.test(pkg)) return res.status(400).json({ error: 'invalid package name' });
    try {
      const out = await updates.about(pkg);
      if (!out) return res.status(404).json({ error: 'package not found in apt' });
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  r.get('/changelog/:pkg', async (req, res) => {
    // candidate=1 (default) extracts the NEW version's notes (range-fetch).
    const candidate = req.query.candidate !== '0';
    const out = await updates.changelog(req.params.pkg, candidate);
    if (out.source === 'candidate' && out.changelog) {
      try {
        const tag = updates.tagSecurityFromChangelog(req.params.pkg, out.candidateVersion, out.changelog, installedOf(req.params.pkg));
        out.security = tag.security; out.cves = tag.cves; out.urgency = tag.urgency;
      } catch { /* */ }
    }
    res.json(out);
  });

  // SSE changelog with download progress — used when the quick fetch returned
  // only the installed-version changelog (big package: docs past the budget).
  r.get('/changelog/:pkg/full/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pkg = req.params.pkg;
    send('start', { pkg });
    try {
      const out = await updates.changelogFull(pkg, (p) => send('progress', p));
      if ((out.source === 'candidate' || out.source === 'source') && out.changelog) {
        try { const tag = updates.tagSecurityFromChangelog(pkg, out.candidateVersion, out.changelog, installedOf(pkg)); out.security = tag.security; out.cves = tag.cves; out.urgency = tag.urgency; } catch { /* */ }
      }
      send('done', out);
    } catch (err) { send('error', { message: err.message }); }
    res.end();
  });

  // What is waiting on a reboot (cached ~5 min; ?force=1 re-reads the host).
  r.get('/reboot-status', async (req, res) => {
    if (!rebootStatus) return res.json({ level: 'none', reasons: [], libs: { count: 0, packages: [], procs: [] } });
    try { res.json(await rebootStatus.get({ force: req.query.force === '1' })); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Reboot the Pi to finish installing updates.
  r.post('/reboot', requireControl, async (req, res) => {
    if (!rebootStatus) return res.status(503).json({ error: 'host agent not available' });
    try {
      events?.add('updates.reboot', 'info', {});
      res.json(await rebootStatus.reboot());
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Update history.
  r.get('/history', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const { rows, total } = updatesRepo.recent({ limit, offset });
    res.json({ history: rows, total });
  });

  // Simulate an upgrade (dry run) — returns the apt plan as text.
  r.post('/simulate', requireControl, async (req, res) => {
    const { packages, full } = req.body || {};
    let out = '';
    try {
      await updates.upgrade({ packages: packages || null, full: !!full, simulate: true }, (line) => { out += line + '\n'; });
      // `details`: per-package summary, versions and "required by", for the
      // expandable rows on the confirm card. `plan` stays for older clients.
      const details = await updates.planDetails(out, Array.isArray(packages) ? packages : []);
      res.json({ ok: true, plan: out, details });
    } catch (err) { res.status(502).json({ error: err.message, plan: out }); }
  });

  // Snapshot of the upgradable list before a run: apt pulls in dependencies
  // beyond the requested packages, so the diff against the list afterwards is
  // what actually got upgraded, with each package's from-version and summary.
  const upgradableMap = () => {
    const m = {};
    try { for (const u of (updates.cached?.()?.updates || [])) m[u.package] = u; } catch { /* best-effort */ }
    return m;
  };

  // History, cache and event for a finished run. Shared by the live stream and
  // by the recovery path for a run whose stream died with the container.
  async function recordRun({ packages, full, beforeMap, code, logBuf }) {
    const ok = code === 0;

    // Re-list upgradable packages (cheap: no apt-get update) to learn the true
    // post-upgrade state. Anything that was upgradable before and is now gone
    // (or moved to a newer installed version) actually got upgraded — this
    // captures dependencies, not just the explicitly requested packages.
    // Re-listed on failure too: a failed or interrupted run can still have
    // installed some packages, and the cached list would keep showing them.
    let afterMap = {};
    try {
      const after = await updates.list();
      if (after.available) {
        for (const u of (after.updates || [])) afterMap[u.package] = u;
        // persist the fresh list as the cache so the UI drops upgraded packages
        updatesRepo.saveCache(after.updates || []);
      }
    } catch { /* if re-list fails, fall back to requested-package history */ }

    // Build history entries from the real diff when we have it, else fall back
    // to the requested package list.
    let entries;
    if (ok && Object.keys(beforeMap).length) {
      const changed = Object.values(beforeMap).filter((b) => {
        const a = afterMap[b.package];
        return !a || a.installed !== b.installed;   // gone, or installed version advanced
      });
      const list = changed.length ? changed : (full ? [] : (packages || []).map((p) => beforeMap[p]).filter(Boolean));
      entries = list.map((b) => ({
        ts: Date.now(), packageName: b.package,
        fromV: b.installed || null, toV: b.candidate || null,
        description: b.description || null, origin: b.origin || null,
        result: 'success', log: logBuf.slice(0, 4000),
      }));
      if (!entries.length) {
        entries = full
          ? [{ ts: Date.now(), packageName: 'dist-upgrade', result: 'success', log: logBuf }]
          : (packages || []).map((p) => ({ ts: Date.now(), packageName: p, result: 'success', log: logBuf.slice(0, 4000) }));
      }
    } else {
      entries = full
        ? [{ ts: Date.now(), packageName: 'dist-upgrade', result: ok ? 'success' : 'failed', log: logBuf }]
        : (packages || []).map((p) => {
            const b = beforeMap[p];
            return { ts: Date.now(), packageName: p, fromV: b?.installed || null, toV: b?.candidate || null,
                     description: b?.description || null, origin: b?.origin || null,
                     result: ok ? 'success' : 'failed', log: logBuf.slice(0, 4000) };
          });
    }
    updatesRepo.recordBatch(entries);
    events?.add('updates.applied', ok ? 'info' : 'warning', { full, packages, ok });
    // Re-read the host so the page can say right away whether this install
    // left something waiting on a reboot. A failure here never fails the run.
    return rebootStatus ? await rebootStatus.get({ force: true }).catch(() => null) : null;
  }

  // Run ids this process is streaming or has recorded. The recovery path
  // records a run only when its id is absent: then the process that streamed
  // it is gone (the container restarted) and nobody else will.
  const runsSeen = new Map();
  const RUN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
  const markRun = (id, state) => {
    if (!id) return;
    runsSeen.set(id, state);
    if (runsSeen.size > 100) runsSeen.delete(runsSeen.keys().next().value);
  };

  // SSE-streamed upgrade. Query: ?full=1 or ?packages=a,b,c, plus ?run=<id>
  // (the page's id for this run, used to recover the result if the stream drops).
  r.get('/stream', requireControl, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const full = req.query.full === '1';
    const packages = req.query.packages ? String(req.query.packages).split(',').filter(Boolean) : null;
    const runId = RUN_ID_RE.test(String(req.query.run || '')) ? String(req.query.run) : null;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!full && (!packages || !packages.length)) {
      send('failed', { message: 'no packages specified' });
      return res.end();
    }

    const startTs = Date.now();
    let logBuf = '';
    markRun(runId, 'live');
    send('start', { full, packages, ts: startTs });
    try {
      const beforeMap = upgradableMap();
      const result = await updates.upgrade({ packages, full, runId }, (line) => {
        logBuf += line + '\n';
        send('line', { line });
      });
      const reboot = await recordRun({ packages, full, beforeMap, code: result.code, logBuf });
      markRun(runId, 'recorded');
      send('done', { ok: result.code === 0, code: result.code, reboot });
    } catch (err) {
      markRun(runId, 'recorded');
      // Refused because another upgrade is running: nothing ran, nothing to record.
      if (!/already running/.test(err.message)) {
        updatesRepo.record({ ts: Date.now(), packageName: full ? 'dist-upgrade' : (packages || []).join(','), result: 'error', log: logBuf + '\n' + err.message });
        // The run may have died part-way (agent restart, killed dpkg) after
        // installing something; resync the cached list with the host.
        try {
          const after = await updates.list();
          if (after.available) updatesRepo.saveCache(after.updates || []);
        } catch { /* best-effort */ }
      }
      send('failed', { message: err.message });
    }
    res.end();
  });

  // State of an upgrade run whose stream dropped, and the output after line
  // `after`. When it finished and no live stream recorded it (the container
  // restarted mid-run, e.g. upgrading docker-ce), its History is written here.
  r.get('/run/:id', requireControl, async (req, res) => {
    const runId = String(req.params.id);
    if (!RUN_ID_RE.test(runId)) return res.status(400).json({ error: 'invalid run id' });
    const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
    let st;
    try { st = await updates.upgradeStatus(runId, after); }
    catch (err) { return res.status(502).json({ error: err.message }); }
    if (!st?.found || st.running || runsSeen.has(runId)) return res.json(st || { found: false });
    markRun(runId, 'recorded');
    // The whole retained output for History, not just the part this page missed.
    let full = st;
    if (after > 0) { try { full = await updates.upgradeStatus(runId, 0); } catch { /* use what we have */ } }
    const code = st.code ?? 1;
    const reboot = await recordRun({ packages: st.packages, full: st.full, beforeMap: upgradableMap(),
      code, logBuf: (full.lines || []).join('\n') + '\n' }).catch(() => null);
    res.json({ ...st, recorded: true, reboot });
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
      const reboot = rebootStatus ? await rebootStatus.get({ force: true }).catch(() => null) : null;
      send('done', { ok: result.code === 0, note: result.note, reboot });
    } catch (err) { send('error', { message: err.message }); }
    res.end();
  });

  return r;
}
