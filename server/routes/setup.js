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
      smtp: settings.rapisys?.smtp ? {
        host: settings.rapisys.smtp.host, port: settings.rapisys.smtp.port,
        secure: !!settings.rapisys.smtp.secure, user: settings.rapisys.smtp.user,
        from: settings.rapisys.smtp.from, to: settings.rapisys.smtp.to,
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
      const mountpoint = `/mnt/rapisys/${String(label || 'nas').replace(/[^A-Za-z0-9_-]/g, '')}`;
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
        options.push(`vers=${v}`, 'iocharset=utf8', `uid=990`, `gid=${gid}`,
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
      const result = await agentCall('nas.mount',
        { label, proto, host, share, mountpoint, options, username, password }, null, 60000);
      await withFileLock(async () => {
        const settings = await loadSettings();
        settings.rapisys = settings.rapisys || {};
        settings.rapisys.nas = { label, proto, host, share, mountpoint, smbVersion: smbVersion || null };
        await saveSettings(settings);
      });
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

  // -- unmount a NAS share (Settings page) -------------------------------------
  r.post('/nas/unmount', requireAuth, async (req, res) => {
    const mountpoint = String(req.body?.mountpoint || '');
    if (!mountpoint.startsWith('/mnt/rapisys/')) {
      return res.status(400).json({ error: 'mountpoint must be under /mnt/rapisys' });
    }
    try {
      const result = await agentCall('nas.unmount', { mountpoint }, null, 30000);
      await withFileLock(async () => {
        const settings = await loadSettings();
        if (settings.rapisys?.nas?.mountpoint === mountpoint) { delete settings.rapisys.nas; await saveSettings(settings); }
      });
      events.add('nas.unmounted', 'info', { mountpoint });
      res.json({ ok: true, ...result });
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
