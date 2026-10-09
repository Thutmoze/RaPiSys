/**
 * RaPiSys — scheduled Pi-hole DB backup to the NAS
 * ------------------------------------------------
 * Hourly tick; backs up when the newest backup ON THE NAS is older than the
 * configured interval. Deciding from the files (like rapisys-db-backup) rather
 * than an in-memory "last run" means a dashboard restart never adds a backup:
 * that used to happen on every deploy, and with retain=14 a busy deploy day
 * pushed two weeks of daily backups out.
 */

const RETRY_AFTER_FAIL_MS = 6 * 3600e3;
const SLACK_MS = 3600e3;

/** Is a backup due? newestMtime: newest backup on the NAS (ms) or null for none. */
export function piholeBackupDue({ now, intervalMs, newestMtime, lastFailAt = 0 }) {
  if (lastFailAt && now - lastFailAt < RETRY_AFTER_FAIL_MS) return false;
  if (!newestMtime) return true;
  return now - newestMtime >= intervalMs - SLACK_MS;
}

export function createPiholeBackupJob({ loadSettings, network, events, now = () => Date.now() }) {
  let lastFailAt = 0;

  async function tick() {
    let s; try { s = await loadSettings(); } catch { return null; }
    const cfg = s.rapisys?.piholeBackup;
    const nas = s.rapisys?.nas;
    if (!cfg?.enabled || !nas?.mountpoint) return null;
    const intervalMs = cfg.frequency === 'weekly' ? 7 * 24 * 3600e3 : 24 * 3600e3;
    // If the NAS can't be listed, skip: the backup would fail too, and an
    // unreadable listing must not read as "no backups yet".
    const st = await network.piholeBackupStatus(nas.mountpoint);
    if (st.error || st.agent === false) return null;
    const newestMtime = Math.max(0, ...(st.backups || []).map((b) => b.mtime || 0)) || null;
    if (!piholeBackupDue({ now: now(), intervalMs, newestMtime, lastFailAt })) return null;
    try {
      const res = await network.piholeBackupToNas({ mountpoint: nas.mountpoint, retain: cfg.retain || 14 });
      lastFailAt = 0;
      events.add('pihole.backup.ok', 'info', { file: res.file, size: res.size });
      return res;
    } catch (e) {
      lastFailAt = now();
      events.add('pihole.backup.failed', 'warning', { error: e.message });
      return null;
    }
  }

  return { tick };
}
