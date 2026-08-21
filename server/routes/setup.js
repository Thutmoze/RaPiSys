/**
 * RaPiSys — /api/setup: first-run wizard API
 * ------------------------------------------
 * Drives the initial configuration flow:
 *   1. Welcome / environment check (agent reachable? encryption key set?)
 *   2. External storage — mount a NAS (via host agent) and/or choose where
 *      the SQLite database lives. The DB is relocated live.
 *   3. Retention policy (7/30/90/180/365/custom days).
 *   4. SMTP for alert emails (password stored encrypted, write-only) + test.
 *   5. Complete.
 *
 * Until setup is completed these endpoints are open (the dashboard is
 * LAN-facing and there is nothing to protect yet). The moment setup is
 * completed every mutating endpoint here requires the admin token.
 */

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { agentCall, agentAvailable } from '../core/agent-client.js';
import { hasSecretKey } from '../core/crypto.js';
import { fsTypeOf } from '../core/db.js';

const RETENTION_PRESETS = [7, 30, 90, 180, 365];

/**
 * Build the mount option list for a share. Shared by the plain mount route and
 * the guided swap so the two can never drift into mounting the same share with
 * different options (a drift that previously only showed up as SQLite failing
 * on a share missing `nobrl`).
 */
export function buildMountOptions({ proto, smbVersion, nfsVersion, readOnly }) {
  const options = [];
  if (proto === 'cifs') {
    // Only accept known SMB dialects; never let an NFS value leak in.
    const SMB_VERS = ['1.0', '2.0', '2.1', '3.0', '3.1.1'];
    const v = SMB_VERS.includes(smbVersion) ? smbVersion : '3.0';
    // Files must belong to the CONTAINER user (uid 990) and the host
    // rapisys group, or the DB write-probe fails with EACCES.
    const gid = Number(process.env.RAPISYS_GID) || 990;
    // noperm: the client kernel must not enforce server-side ownership
    // against our container uid — the NAS already enforces the SMB
    // credentials. nounix (SMB1): old Samba negotiates unix extensions,
    // which would override our uid=/gid=/file_mode= mapping entirely.
    options.push(`vers=${v}`, 'iocharset=utf8', 'uid=990', `gid=${gid}`,
      'file_mode=0664', 'dir_mode=0775', 'soft', 'noserverino', 'noperm');
    if (v === '1.0') {
      // SMB1 / old Samba (WD My Book) can't honor POSIX byte-range
      // locks, so SQLite's lock attempts fail as "database is locked".
      // nobrl disables client byte-range locking; nounix stops the
      // unix-extensions uid override. Safe here: RaPiSys is the only
      // writer to its DB directory.
      options.push('nounix', 'nobrl');
    }
    // No forced sec= option: legacy NTLM was removed from the kernel
    // CIFS driver in Linux 6.7 (sec=ntlm => EINVAL on modern kernels).
    // The default NTLMSSP negotiation works against old Samba (WD My
    // Book World) when credentials are supplied.
  } else {
    // NFS has its own version space (WD EX2 Ultra speaks v3; default 4.1).
    const NFS_VERS = ['3', '4', '4.1', '4.2'];
    const v = NFS_VERS.includes(nfsVersion) ? nfsVersion : '4.1';
    options.push(`vers=${v}`, 'soft', 'timeo=100', 'retrans=2', 'noatime');
  }
  options.push(readOnly ? 'ro' : 'rw');
  return options;
}

/** Mountpoint for a share label, matching the agent's MOUNT_BASE contract. */
export function mountpointFor(label) {
  return `/mnt/rapisys/${String(label || 'nas').replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export function setupRouter({ loadSettings, saveSettings, withFileLock,
  secrets, mailer, telegram, reopenDb, dbMeta, fallbackDbPath, requireAuth, events }) {
  const r = express.Router();

  /** Gate: open until setup completed, admin-token protected afterwards. */
  async function gate(req, res, next) {
    if (req.method === 'GET') return next();
    const settings = await loadSettings();
    if (settings.rapisys?.setupCompleted) return requireAuth(req, res, next);
    return next();
  }
  r.use(gate);

  // -- status ----------------------------------------------------------------
  r.get('/status', async (req, res) => {
    const settings = await loadSettings();
    res.json({
      completed: !!settings.rapisys?.setupCompleted,
      agent: await agentAvailable(),
      encryption: hasSecretKey(),
      storage: (() => {
        const m = dbMeta();
        let sizeBytes = null;
        try { if (m.path) sizeBytes = fs.statSync(m.path).size; } catch { /* */ }
        return { ...m, sizeBytes, configuredPath: settings.rapisys?.storage?.dbPath || null };
      })(),
      retentionDays: settings.rapisys?.retention?.days || 90,
      archiveDays: settings.rapisys?.retention?.archiveDays || 365,
      smtpConfigured: !!settings.rapisys?.smtp?.host,
      smtp: settings.rapisys?.smtp ? {
        host: settings.rapisys.smtp.host, port: settings.rapisys.smtp.port,
        secure: !!settings.rapisys.smtp.secure, user: settings.rapisys.smtp.user,
        from: settings.rapisys.smtp.from, to: settings.rapisys.smtp.to,
      } : null,
      telegramConfigured: !!(settings.rapisys?.telegram?.chatId && secrets.has('telegram.token')),
      telegram: settings.rapisys?.telegram ? {
        enabled: !!settings.rapisys.telegram.enabled,
        chatId: settings.rapisys.telegram.chatId || '',
        hasToken: secrets.has('telegram.token'),
      } : null,
      mode: settings.rapisys?.mode === 'full' ? 'full' : 'monitor',
      nas: settings.rapisys?.nas || null,
      presets: RETENTION_PRESETS,
    });
  });

  // -- step 2a: mount a NAS through the host agent ----------------------------
  r.post('/nas/mount', async (req, res) => {
    const { label, proto, host, share, username, password, smbVersion, nfsVersion, readOnly } = req.body || {};
    try {
      const mountpoint = mountpointFor(label);
      const options = buildMountOptions({ proto, smbVersion, nfsVersion, readOnly });
      const result = await agentCall('nas.mount',
        { label, proto, host, share, mountpoint, options, username, password }, null, 60000);
      await withFileLock(async () => {
        const settings = await loadSettings();
        settings.rapisys = settings.rapisys || {};
        settings.rapisys.nas = { label, proto, host, share, mountpoint, smbVersion: smbVersion || null };
        await saveSettings(settings);
      });
      // Best-effort: the events table can live on the very share being
      // changed, so a failed write here must not turn a completed mount into
      // a reported error.
      try { events.add('nas.mounted', 'info', { label, proto, host, share, mountpoint }); }
      catch { /* DB unavailable mid-swap */ }
      res.json({ ok: true, mountpoint, ...result });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  r.get('/nas/status', async (req, res) => {
    const mountpoint = String(req.query.mountpoint || '');
    if (!mountpoint.startsWith('/mnt/rapisys/')) {
      return res.status(400).json({ error: 'mountpoint must be under /mnt/rapisys' });
    }
    try {
      res.json(await agentCall('nas.status', { mountpoint }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /**
   * Can this share be changed in place? Reports whether the live database sits
   * on the mountpoint (in which case the container holds it open and no
   * unmount can succeed) and which processes are holding it. The UI uses this
   * to offer the guided swap instead of walking into a doomed unmount.
   */
  r.get('/nas/preflight', async (req, res) => {
    const mountpoint = String(req.query.mountpoint || '');
    if (!mountpoint.startsWith('/mnt/rapisys/')) {
      return res.status(400).json({ error: 'mountpoint must be under /mnt/rapisys' });
    }
    const dbPath = dbMeta().path || '';
    const dbOnShare = dbPath.startsWith(mountpoint.replace(/\/$/, '') + '/');
    let mounted = null, holders = [];
    try {
      const st = await agentCall('nas.holders', { mountpoint }, null, 15000);
      mounted = st.mounted; holders = st.holders || [];
    } catch { /* agent down: fall back to the dbOnShare answer alone */ }
    res.json({ mountpoint, dbPath, dbOnShare, mounted, holders, localDbPath: fallbackDbPath });
  });

  // -- unmount a NAS share (Settings page) -------------------------------------
  // Ordering matters here. This used to delete the recorded share immediately
  // after the agent call and then write an event; when the agent wrongly
  // reported success and the event write failed against a read-only DB on the
  // share itself, the response was a 502 that looked like "nothing happened"
  // while the share had already been dropped from settings. The agent now
  // verifies the unmount, settings are only cleared once it has, and the event
  // write cannot affect the outcome.
  r.post('/nas/unmount', requireAuth, async (req, res) => {
    const mountpoint = String(req.body?.mountpoint || '');
    if (!mountpoint.startsWith('/mnt/rapisys/')) {
      return res.status(400).json({ error: 'mountpoint must be under /mnt/rapisys' });
    }
    const dbPath = dbMeta().path || '';
    if (dbPath.startsWith(mountpoint.replace(/\/$/, '') + '/') && !req.body?.force) {
      return res.status(409).json({
        error: `the database (${dbPath}) is on this share — move it to local storage first`,
        dbOnShare: true, dbPath,
      });
    }
    try {
      const result = await agentCall('nas.unmount', { mountpoint }, null, 45000);
      await withFileLock(async () => {
        const settings = await loadSettings();
        if (settings.rapisys?.nas?.mountpoint === mountpoint) { delete settings.rapisys.nas; await saveSettings(settings); }
      });
      try { events.add('nas.unmounted', 'info', { mountpoint }); } catch { /* DB may have lived there */ }
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // -- guided share swap -------------------------------------------------------
  // Two-part because EventSource cannot POST and a NAS password must not travel
  // in a URL: the credentials are handed over here and consumed once by the
  // stream below, keyed by a single-use job id.
  const swapJobs = new Map();
  const SWAP_TTL_MS = 120000;

  r.post('/nas/swap', requireAuth, async (req, res) => {
    const { label, proto, host, share, username, password, smbVersion, nfsVersion, readOnly } = req.body || {};
    if (!label || !host || !share) return res.status(400).json({ error: 'label, host and share are required' });
    const id = crypto.randomUUID();
    swapJobs.set(id, {
      job: { label, proto, host, share, username, password, smbVersion, nfsVersion, readOnly },
      expires: Date.now() + SWAP_TTL_MS,
    });
    setTimeout(() => swapJobs.delete(id), SWAP_TTL_MS).unref?.();
    res.json({ ok: true, job: id });
  });

  /**
   * Move the DB off the share, swap the share, move the DB back. Each step is
   * verified before the next begins, and a failure rewinds the steps already
   * taken: the agent restores the previous mount, and the database is put back
   * where it came from. The worst case leaves the DB on local storage with the
   * old share mounted — degraded but running and writable, never stranded.
   */
  r.get('/nas/swap/stream', requireAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const step = (index, state, note) => send('step', { index, state, note });

    const entry = swapJobs.get(String(req.query.job || ''));
    swapJobs.delete(String(req.query.job || ''));
    if (!entry || entry.expires < Date.now()) {
      send('failed', { message: 'swap request expired — start it again' });
      return res.end();
    }
    const j = entry.job;
    const mountpoint = mountpointFor(j.label);
    const options = buildMountOptions(j);
    const originalDbPath = dbMeta().path;
    const settingsBefore = (await loadSettings()).rapisys?.nas || null;
    send('start', { mountpoint });

    // -- 1. move the database to local storage -----------------------------
    step(0, 'run');
    try {
      reopenDb(fallbackDbPath);
      step(0, 'done', `now at ${fallbackDbPath}`);
    } catch (err) {
      step(0, 'fail', err.message);
      send('failed', { message: `could not move the database to local storage: ${err.message}` });
      return res.end();
    }

    // -- 2/3. swap the share (the agent rolls the mount back on failure) ----
    step(1, 'run');
    try {
      await agentCall('nas.swap', { ...j, mountpoint, options },
        (line) => send('line', { line }), 120000);
      step(1, 'done', `${j.proto}://${j.host}/${j.share}`);
    } catch (err) {
      step(1, 'fail', err.message);
      // The old share is back (or was never released) — put the DB with it.
      let restored = false;
      try { reopenDb(originalDbPath); restored = true; } catch { /* stays local */ }
      step(2, 'skip', 'not attempted');
      send('failed', {
        message: err.message,
        rolledBack: restored,
        dbPath: dbMeta().path,
        nas: settingsBefore,
      });
      return res.end();
    }

    // -- 4. move the database onto the new share ----------------------------
    step(2, 'run');
    const newDbPath = path.join(mountpoint, 'rapisys.db');
    try {
      reopenDb(newDbPath);
      step(2, 'done', `now at ${newDbPath}`);
    } catch (err) {
      // The share is good but the DB could not follow it. Leave the DB local
      // rather than half-moved and say so plainly.
      step(2, 'fail', err.message);
      send('failed', {
        message: `share replaced, but the database stayed on local storage: ${err.message}`,
        shareReplaced: true, dbPath: dbMeta().path,
      });
      return res.end();
    }

    await withFileLock(async () => {
      const settings = await loadSettings();
      settings.rapisys = settings.rapisys || {};
      settings.rapisys.nas = {
        label: j.label, proto: j.proto, host: j.host, share: j.share,
        mountpoint, smbVersion: j.smbVersion || null,
      };
      settings.rapisys.storage = { dbPath: newDbPath };
      await saveSettings(settings);
    });
    try { events.add('nas.swapped', 'info', { mountpoint, share: j.share, dbPath: newDbPath }); }
    catch { /* best effort */ }
    send('done', { mountpoint, dbPath: newDbPath });
    res.end();
  });

  // -- step 2b: relocate the database ------------------------------------------
  r.post('/storage', async (req, res) => {
    const dbDir = String(req.body?.dbDir || '');
    if (!path.isAbsolute(dbDir)) return res.status(400).json({ error: 'dbDir must be an absolute path' });
    // The container sees host NAS mounts under /mnt/rapisys (bind-mounted by
    // compose). Verify it is writable before committing to it.
    try {
      fs.mkdirSync(dbDir, { recursive: true });
      const probe = path.join(dbDir, `.rapisys-write-test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (err) {
      return res.status(400).json({ error: `directory not writable: ${err.message}` });
    }
    const dbPath = path.join(dbDir, 'rapisys.db');
    const fsType = fsTypeOf(dbDir);
    try {
      const meta = reopenDb(dbPath); // migrate + journal-mode selection happens inside
      await withFileLock(async () => {
        const settings = await loadSettings();
        settings.rapisys = settings.rapisys || {};
        settings.rapisys.storage = { dbPath };
        await saveSettings(settings);
      });
      events.add('storage.relocated', 'info', { dbPath, fsType });
      res.json({ ok: true, ...meta });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -- step 2: operating mode ----------------------------------------------------
  r.post('/mode', async (req, res) => {
    const mode = req.body?.mode === 'full' ? 'full' : 'monitor';
    await withFileLock(async () => {
      const settings = await loadSettings();
      settings.rapisys = settings.rapisys || {};
      settings.rapisys.mode = mode;
      await saveSettings(settings);
    });
    events.add('setup.mode', 'info', { mode });
    res.json({ ok: true, mode });
  });

  // -- step 3: retention -------------------------------------------------------
  r.post('/retention', async (req, res) => {
    const days = Number(req.body?.days);
    const archiveDays = Number(req.body?.archiveDays) || 365;
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: 'days must be 1–3650' });
    }
    await withFileLock(async () => {
      const settings = await loadSettings();
      settings.rapisys = settings.rapisys || {};
      settings.rapisys.retention = { days, archiveDays };
      await saveSettings(settings);
    });
    res.json({ ok: true, days, archiveDays });
  });

  // -- step 4: SMTP --------------------------------------------------------------
  r.post('/smtp', async (req, res) => {
    const { host, port, secure, user, from, to, password } = req.body || {};
    if (!host) return res.status(400).json({ error: 'host is required' });
    if (password && !hasSecretKey()) {
      return res.status(400).json({ error: 'SECRET_KEY not set — cannot store SMTP password securely. Run deploy.sh or set SECRET_KEY in .env.' });
    }
    await withFileLock(async () => {
      const settings = await loadSettings();
      settings.rapisys = settings.rapisys || {};
      settings.rapisys.smtp = {
        host: String(host).slice(0, 253),
        port: Number(port) || 587,
        secure: !!secure,
        user: String(user || '').slice(0, 254),
        from: String(from || user || '').slice(0, 254),
        to: String(to || '').slice(0, 254),
      };
      await saveSettings(settings);
    });
    if (password) secrets.set('smtp.password', String(password));
    res.json({ ok: true, passwordStored: !!password });
  });

  r.post('/smtp/test', async (req, res) => {
    try {
      await mailer.sendTest(req.body?.to);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  // -- Telegram notifications ----------------------------------------------------
  r.post('/telegram', async (req, res) => {
    const { token, chatId, enabled } = req.body || {};
    if (token && !hasSecretKey()) {
      return res.status(400).json({ error: 'SECRET_KEY not set — cannot store the bot token securely. Run deploy.sh or set SECRET_KEY in .env.' });
    }
    // if a new token was supplied, verify it before saving
    if (token) {
      try { await telegram.verifyToken(String(token)); }
      catch (err) { return res.status(400).json({ error: `Token rejected by Telegram: ${err.message}` }); }
    }
    await withFileLock(async () => {
      const settings = await loadSettings();
      settings.rapisys = settings.rapisys || {};
      const cur = settings.rapisys.telegram || {};
      settings.rapisys.telegram = {
        enabled: enabled != null ? !!enabled : (cur.enabled || false),
        chatId: chatId != null ? String(chatId).slice(0, 64) : (cur.chatId || ''),
      };
      await saveSettings(settings);
    });
    if (token) secrets.set('telegram.token', String(token));
    res.json({ ok: true, tokenStored: !!token });
  });

  // Auto-detect the chat id from recent messages sent to the bot.
  r.post('/telegram/detect', async (req, res) => {
    try {
      const chat = await telegram.getChatId();
      res.json({ ok: true, chatId: chat.id, name: chat.name });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  r.post('/telegram/test', async (req, res) => {
    try {
      await telegram.sendTest(req.body?.chatId);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  // -- step 5: done ---------------------------------------------------------------
  r.post('/complete', async (req, res) => {
    await withFileLock(async () => {
      const settings = await loadSettings();
      settings.rapisys = settings.rapisys || {};
      settings.rapisys.setupCompleted = true;
      settings.rapisys.setupCompletedAt = Date.now();
      await saveSettings(settings);
    });
    events.add('setup.completed', 'info', {});
    res.json({ ok: true });
  });

  return r;
}
