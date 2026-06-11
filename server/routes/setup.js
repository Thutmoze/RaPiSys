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
import fs from 'fs';
import path from 'path';
import { agentCall, agentAvailable } from '../core/agent-client.js';
import { hasSecretKey } from '../core/crypto.js';
import { fsTypeOf } from '../core/db.js';

const RETENTION_PRESETS = [7, 30, 90, 180, 365];

export function setupRouter({ loadSettings, saveSettings, withFileLock,
  secrets, mailer, reopenDb, dbMeta, requireAuth, events }) {
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
      storage: { ...dbMeta(), configuredPath: settings.rapisys?.storage?.dbPath || null },
      retentionDays: settings.rapisys?.retention?.days || 90,
      archiveDays: settings.rapisys?.retention?.archiveDays || 365,
      smtpConfigured: !!settings.rapisys?.smtp?.host,
      presets: RETENTION_PRESETS,
    });
  });

  // -- step 2a: mount a NAS through the host agent ----------------------------
  r.post('/nas/mount', async (req, res) => {
    const { label, proto, host, share, username, password, smbVersion, nfsVersion, readOnly } = req.body || {};
    try {
      const mountpoint = `/mnt/rapisys/${String(label || 'nas').replace(/[^A-Za-z0-9_-]/g, '')}`;
      const options = [];
      if (proto === 'cifs') {
        // Only accept known SMB dialects; never let an NFS value leak in.
        const SMB_VERS = ['1.0', '2.0', '2.1', '3.0', '3.1.1'];
        const v = SMB_VERS.includes(smbVersion) ? smbVersion : '3.0';
        options.push(`vers=${v}`, 'iocharset=utf8', 'uid=1000', 'gid=1000', 'soft');
      } else {
        // NFS has its own version space (WD EX2 Ultra speaks v3; default 4.1).
        const NFS_VERS = ['3', '4', '4.1', '4.2'];
        const v = NFS_VERS.includes(nfsVersion) ? nfsVersion : '4.1';
        options.push(`vers=${v}`, 'soft', 'timeo=100', 'retrans=2', 'noatime');
      }
      options.push(readOnly ? 'ro' : 'rw');
      const result = await agentCall('nas.mount',
        { label, proto, host, share, mountpoint, options, username, password }, null, 60000);
      events.add('nas.mounted', 'info', { label, proto, host, share, mountpoint });
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
