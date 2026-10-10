/**
 * RaPiSys — retention service
 * ---------------------------
 * Tiered downsampling:  raw 10s  → 1m after 48h → 10m after 30d → 1h after 90d
 * then hard purge after the configured retention period. Runs hourly.
 * The same period applies to events, closed login sessions, resolved alert
 * incidents and Update History rows (each optional, so tests can omit them).
 */

export function createRetention({ metricsRepo, eventsRepo, sessionsRepo, alertsRepo, updatesRepo, getRetentionDays }) {
  async function runOnce() {
    const now = Date.now();
    metricsRepo.downsample('10s', '1m', 60e3, now - 48 * 3600e3);
    metricsRepo.downsample('1m', '10m', 600e3, now - 30 * 86400e3);
    metricsRepo.downsample('10m', '1h', 3600e3, now - 90 * 86400e3);
    const days = await getRetentionDays();
    const cutoff = now - days * 86400e3;
    metricsRepo.purgeOlderThan(cutoff);
    eventsRepo.purgeOlderThan(cutoff);
    sessionsRepo?.purgeOlderThan(cutoff);
    alertsRepo?.purgeHistoryOlderThan(cutoff);
    updatesRepo?.purgeHistoryOlderThan(cutoff);
  }
  return { runOnce };
}
