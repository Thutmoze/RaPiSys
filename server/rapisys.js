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
import { createAlertsRepo } from './repositories/alerts.js';
import { createSessionsRepo } from './repositories/sessions.js';
import { createHardwareCollector } from './collectors/hardware.js';
import { createSessionsCollector } from './collectors/sessions.js';
import { createNetworkCollector } from './collectors/network.js';
import { createSampler } from './services/sampler.js';
import { createRetention } from './services/retention.js';
import { createMailer } from './services/mailer.js';
import { createAlertEngine } from './services/alerting.js';
import { createSessionTracker } from './services/session-tracker.js';
import { createAuth } from './services/auth.js';
import { historyRouter } from './routes/history.js';
import { deepHealthRouter } from './routes/health.js';
import { setupRouter } from './routes/setup.js';
import { hardwareRouter } from './routes/hardware.js';
import { alertsRouter } from './routes/alerts.js';
import { sessionsRouter } from './routes/sessions.js';
import { networkRouter } from './routes/network.js';
import { authRouter } from './routes/auth.js';

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
  let metricsRepo, eventsRepo, secrets, alertsRepo, sessionsRepo;
  function rebuildRepos() {
    metricsRepo = createMetricsRepo(getDb());
    eventsRepo = createEventsRepo(getDb());
    secrets = createSecretsRepo(getDb());
    alertsRepo = createAlertsRepo(getDb());
    sessionsRepo = createSessionsRepo(getDb());
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
    latestValues: (...a) => metricsRepo.latestValues(...a),
  };
  const alertsFacade = new Proxy({}, { get: (_, m) => (...a) => alertsRepo[m](...a) });
  const sessionsRepoFacade = new Proxy({}, { get: (_, m) => (...a) => sessionsRepo[m](...a) });
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

  const sessions = createSessionsCollector();
  const network = createNetworkCollector();
  const alertEngine = createAlertEngine({
    alertsRepo: alertsFacade, metricsRepo: metricsFacade,
    eventsRepo: eventsFacade, mailer, getSettings: loadSettings,
  });
  alertEngine.seedDefaults();
  const sessionTracker = createSessionTracker({
    sessions, sessionsRepo: sessionsRepoFacade, eventsRepo: eventsFacade,
  });

  // ---- authentication / operating mode ---------------------------------------
  const auth = createAuth({ getDb, loadSettings, eventsRepo: eventsFacade });
  // Take over the LEGACY requireAuth as well: in full mode the session
  // cookie (or admin token) authenticates the original settings endpoints;
  // in monitor mode they stay open like stock pi-dashboard.
  globalThis.__rapisysAuth = auth.requireConfig;

  // ---- scheduler ----------------------------------------------------------------
  const scheduler = createScheduler();
  const sampleMs = (Number(process.env.SAMPLE_INTERVAL_S) || 10) * 1000;
  scheduler.register('metrics-sampler', sampleMs, () => sampler.sampleOnce(), { runNow: true });
  scheduler.register('retention', 3600e3, () => retention.runOnce());
  scheduler.register('alert-engine', 30e3, () => alertEngine.evaluateOnce());
  scheduler.register('session-tracker', 60e3, () => sessionTracker.trackOnce(), { runNow: true });
  scheduler.register('net-sampler', 10e3, () => {
    const t = network.throughput();
    const rows = [];
    for (const [iface, v] of Object.entries(t.interfaces)) {
      rows.push({ metric: `net.${iface}.rx`, value: v.rxRate });
      rows.push({ metric: `net.${iface}.tx`, value: v.txRate });
    }
    if (rows.length) metricsFacade.writeBatch(t.ts, rows);
  }, { runNow: true });
  scheduler.register('auth-session-purge', 6 * 3600e3, () => auth.purgeExpired());

  // ---- routes ----------------------------------------------------------------------
  app.use('/api/history', historyRouter({ metricsRepo: metricsFacade, eventsRepo: eventsFacade }));
  app.use('/api/health/deep', deepHealthRouter({ dbMeta, scheduler, getDb }));
  app.use('/api/hardware', hardwareRouter({ hardware, eventsRepo: eventsFacade, requireAuth: auth.requireControl }));
  app.use('/api/auth', authRouter({ auth, loadSettings }));
  app.use('/api/alerts', alertsRouter({ alertsRepo: alertsFacade, metricsRepo: metricsFacade, requireAuth: auth.requireConfig }));
  app.use('/api/sessions', sessionsRouter({ sessions, sessionsRepo: sessionsRepoFacade, requireAuth: auth.requireConfig, requireControl: auth.requireControl }));
  app.use('/api/network', networkRouter({ network, metricsRepo: metricsFacade }));
  app.use('/api/setup', setupRouter({
    loadSettings, saveSettings, withFileLock,
    secrets: secretsFacade, mailer, reopenDb, dbMeta, requireAuth: auth.requireConfig, events: eventsFacade,
  }));

  console.log(`[rapisys] db=${handle.meta.path} engine=${handle.meta.engine} `
    + `journal=${handle.meta.journalMode} fs=${handle.meta.fsType}`
    + (handle.meta.degraded ? ' (DEGRADED: NAS unavailable, using local fallback)' : ''));

  return { scheduler, getDb, dbMeta };
}
