/**
 * RaPiSys — module initialiser
 * ----------------------------
 * Wires the new subsystems (SQLite, scheduler, collectors, services, routes)
 * into the legacy Express app. Designed so a failure here NEVER takes down
 * the original dashboard: index.js catches init errors and continues.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from './core/db.js';
import { createScheduler } from './core/scheduler.js';
import { createMetricsRepo } from './repositories/metrics.js';
import { createEventsRepo } from './repositories/events.js';
import { createSecretsRepo } from './repositories/secrets.js';
import { createHardwareCollector } from './collectors/hardware.js';
import { createSampler } from './services/sampler.js';
import { createRetention } from './services/retention.js';
import { createMailer } from './services/mailer.js';
import { historyRouter } from './routes/history.js';
import { deepHealthRouter } from './routes/health.js';
import { setupRouter } from './routes/setup.js';
import { hardwareRouter } from './routes/hardware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initRapisys({ app, loadSettings, saveSettings, withFileLock, requireAuth }) {
  // ---- storage -------------------------------------------------------------
  const settings = await loadSettings();
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const fallbackPath = path.join(dataDir, 'rapisys.db');
  const configuredPath = settings.rapisys?.storage?.dbPath || fallbackPath;

  let handle = openDatabase({ dbPath: configuredPath, fallbackPath });
  const getDb = () => handle.db;
  const dbMeta = () => handle.meta;

  /** Relocate the database live (used by the setup wizard). */
  function reopenDb(newPath) {
    const next = openDatabase({ dbPath: newPath, fallbackPath });
    try { handle.db.close(); } catch { /* old handle */ }
    handle = next;
    rebuildRepos();
    return handle.meta;
  }

  // ---- repositories (rebuilt when the DB is relocated) -----------------------
  let metricsRepo, eventsRepo, secrets;
  function rebuildRepos() {
    metricsRepo = createMetricsRepo(getDb());
    eventsRepo = createEventsRepo(getDb());
    secrets = createSecretsRepo(getDb());
  }
  rebuildRepos();

  if (handle.meta.degraded) {
    eventsRepo.add('storage.degraded', 'warning', { error: handle.meta.error, using: handle.meta.path });
  }

  // Stable facades so routes/services always hit the current repos.
  const metricsFacade = {
    writeBatch: (...a) => metricsRepo.writeBatch(...a),
    query: (...a) => metricsRepo.query(...a),
    listMetrics: (...a) => metricsRepo.listMetrics(...a),
    downsample: (...a) => metricsRepo.downsample(...a),
    purgeOlderThan: (...a) => metricsRepo.purgeOlderThan(...a),
  };
  const eventsFacade = {
    add: (...a) => eventsRepo.add(...a),
    recent: (...a) => eventsRepo.recent(...a),
    countSince: (...a) => eventsRepo.countSince(...a),
    purgeOlderThan: (...a) => eventsRepo.purgeOlderThan(...a),
  };
  const secretsFacade = {
    set: (...a) => secrets.set(...a),
    get: (...a) => secrets.get(...a),
    has: (...a) => secrets.has(...a),
    remove: (...a) => secrets.remove(...a),
  };

  // ---- collectors & services -------------------------------------------------
  const hardware = createHardwareCollector();
  const sampler = createSampler({ metricsRepo: metricsFacade, eventsRepo: eventsFacade, hardware });
  const retention = createRetention({
    metricsRepo: metricsFacade,
    eventsRepo: eventsFacade,
    getRetentionDays: async () => (await loadSettings()).rapisys?.retention?.days || 90,
  });
  const mailer = createMailer({
    getSmtpSettings: async () => (await loadSettings()).rapisys?.smtp || null,
    secrets: secretsFacade,
    events: eventsFacade,
  });

  // ---- scheduler ----------------------------------------------------------------
  const scheduler = createScheduler();
  const sampleMs = (Number(process.env.SAMPLE_INTERVAL_S) || 10) * 1000;
  scheduler.register('metrics-sampler', sampleMs, () => sampler.sampleOnce(), { runNow: true });
  scheduler.register('retention', 3600e3, () => retention.runOnce());

  // ---- routes ----------------------------------------------------------------------
  app.use('/api/history', historyRouter({ metricsRepo: metricsFacade, eventsRepo: eventsFacade }));
  app.use('/api/health/deep', deepHealthRouter({ dbMeta, scheduler, getDb }));
  app.use('/api/hardware', hardwareRouter({ hardware, eventsRepo: eventsFacade, requireAuth }));
  app.use('/api/setup', setupRouter({
    loadSettings, saveSettings, withFileLock,
    secrets: secretsFacade, mailer, reopenDb, dbMeta, requireAuth, events: eventsFacade,
  }));

  console.log(`[rapisys] db=${handle.meta.path} engine=${handle.meta.engine} `
    + `journal=${handle.meta.journalMode} fs=${handle.meta.fsType}`
    + (handle.meta.degraded ? ' (DEGRADED: NAS unavailable, using local fallback)' : ''));

  return { scheduler, getDb, dbMeta };
}
