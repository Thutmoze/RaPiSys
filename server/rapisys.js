/**
 * RaPiSys — module initialiser
 * ----------------------------
 * Wires the new subsystems (SQLite, scheduler, collectors, services, routes)
 * into the legacy Express app. Designed so a failure here NEVER takes down
 * the original dashboard: index.js catches init errors and continues.
 */

import fs from 'fs';
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
import { createReportsRepo } from './repositories/reports.js';
import { createReports } from './services/reports.js';
import { createInventoryCollector } from './collectors/inventory.js';
import { createInventoryRepo } from './repositories/inventory.js';
import { createLayoutsRepo } from './repositories/layouts.js';
import { createUpdatesCollector } from './collectors/updates.js';
import { createUpdatesRepo } from './repositories/updates.js';
import { createSampler } from './services/sampler.js';
import { createRetention } from './services/retention.js';
import { createMailer } from './services/mailer.js';
import { createTelegram } from './services/telegram.js';
import { createUpdateScheduler } from './services/update-scheduler.js';
import { createAlertEngine } from './services/alerting.js';
import { createSessionTracker } from './services/session-tracker.js';
import { createAuth } from './services/auth.js';
import { createRemoteAccess } from './services/remote-access.js';
import { historyRouter } from './routes/history.js';
import { deepHealthRouter } from './routes/health.js';
import { setupRouter } from './routes/setup.js';
import { hardwareRouter } from './routes/hardware.js';
import { alertsRouter } from './routes/alerts.js';
import { sessionsRouter } from './routes/sessions.js';
import { networkRouter } from './routes/network.js';
import { reportsRouter } from './routes/reports.js';
import { inventoryRouter } from './routes/inventory.js';
import { createTlsService } from './services/tls.js';
import { tlsRouter } from './routes/tls.js';
import { layoutsRouter } from './routes/layouts.js';
import { updatesRouter } from './routes/updates.js';
import { remoteRouter } from './routes/remote.js';
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
  let metricsRepo, eventsRepo, secrets, alertsRepo, sessionsRepo, reportsRepo, inventoryRepo, updatesRepo, layoutsRepo;
  function rebuildRepos() {
    metricsRepo = createMetricsRepo(getDb());
    eventsRepo = createEventsRepo(getDb());
    secrets = createSecretsRepo(getDb());
    alertsRepo = createAlertsRepo(getDb());
    sessionsRepo = createSessionsRepo(getDb());
    reportsRepo = createReportsRepo(getDb());
    inventoryRepo = createInventoryRepo(getDb());
    layoutsRepo = createLayoutsRepo(getDb());
    updatesRepo = createUpdatesRepo(getDb());
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
  const telegram = createTelegram({
    getTelegramSettings: async () => (await loadSettings()).rapisys?.telegram || null,
    secrets: secretsFacade,
    events: eventsFacade,
  });

  let remoteAccessRef = null;   // set once remote-access is constructed (below)
  const sessions = createSessionsCollector({ bridgeSessions: () => (remoteAccessRef ? remoteAccessRef.liveSessions() : []) });
  const network = createNetworkCollector();
  const reportsFacade = new Proxy({}, { get: (_, m) => (...a) => reportsRepo[m](...a) });
  const reports = createReports({
    metricsRepo: metricsFacade, eventsRepo: eventsFacade, reportsRepo: reportsFacade,
    getStorageInfo: () => { try { const st = fs.statfsSync ? fs.statfsSync('/app/data') : null;
      if (st) { const used = (st.blocks - st.bfree) / st.blocks * 100; return { percentUsed: used }; } } catch { /* */ } return null; },
  });
  reports.backfill(14);
  const inventory = createInventoryCollector();
  const inventoryRepoFacade = new Proxy({}, { get: (_, m) => (...a) => inventoryRepo[m](...a) });
  const layoutsRepoFacade = new Proxy({}, { get: (_, m) => (...a) => layoutsRepo[m](...a) });
  const updatesRepoFacade = new Proxy({}, { get: (_, m) => (...a) => updatesRepo[m](...a) });
  const updates = createUpdatesCollector({ updatesRepo: updatesRepoFacade });
  const updateScheduler = createUpdateScheduler({
    updates, mailer, telegram, loadSettings, saveSettings, withFileLock, events: eventsFacade,
  });
  const alertEngine = createAlertEngine({
    alertsRepo: alertsFacade, metricsRepo: metricsFacade,
    eventsRepo: eventsFacade, mailer, telegram, getSettings: loadSettings,
  });
  alertEngine.seedDefaults();
  const sessionTracker = createSessionTracker({
    sessions, sessionsRepo: sessionsRepoFacade, eventsRepo: eventsFacade,
  });

  // ---- authentication / operating mode ---------------------------------------
  const auth = createAuth({ getDb, loadSettings, eventsRepo: eventsFacade });

  // ---- in-browser remote access (SSH terminal + VNC desktop) -----------------
  const remoteAccess = createRemoteAccess({
    loadSettings, saveSettings, withFileLock,
    secrets: secretsFacade, auth, events: eventsFacade,
  });
  remoteAccessRef = remoteAccess;
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
  // Automatic update check (F8): ticks hourly, self-gates on the configured
  // intervalHours, and emails security updates when found.
  // Tick every 60s: the tick is cheap (bails in ~1ms when not due), so a 1-min
  // cadence lets a scheduled check fire within ~1 min of its target instead of
  // waiting up to the next 10-min boundary.
  scheduler.register('update-check', 60e3, () => updateScheduler.tick(), { runNow: true });
  scheduler.register('net-sampler', 10e3, () => {
    const t = network.throughput();
    const rows = [];
    for (const [iface, v] of Object.entries(t.interfaces)) {
      rows.push({ metric: `net.${iface}.rx`, value: v.rxRate });
      rows.push({ metric: `net.${iface}.tx`, value: v.txRate });
    }
    if (rows.length) metricsFacade.writeBatch(t.ts, rows);
  }, { runNow: true });
  // Background per-process bandwidth history: a short nethogs sample every
  // 5 min, recorded to the DB. Skipped automatically if nethogs isn't
  // installed (agent throws), so it never forces an install on its own.
  globalThis.__netPageActive = false;
  scheduler.register('net-proc-history', 300e3, async () => {
    if (globalThis.__netPageActive) return;   // live view already capturing
    try {
      const r = await network.nethogsSample(4);
      const now = Date.now();
      for (const p of (r.processes || []).slice(0, 5)) {
        eventsFacade.add('net.proc_sample', 'info',
          { comm: p.comm, pid: p.pid, recvKBs: p.recvKBs, sentKBs: p.sentKBs, ts: now });
      }
    } catch { /* nethogs absent or busy — skip silently */ }
  });
  scheduler.register('auth-session-purge', 6 * 3600e3, () => auth.purgeExpired());
  // Nightly report materialization (runs the previous day's summary).
  scheduler.register('reports-daily', 6 * 3600e3, () => { try { reports.materializeDay(); reports.backfill(7); } catch { /* */ } });
  // Refresh today's partial report every 10 min so the Reports page stays live.
  scheduler.register('reports-today', 600e3, () => { try { reports.materializeDay(Date.now()); } catch { /* */ } });
  scheduler.register('inventory-sync', 30 * 60e3, async () => {
    try {
      const items = await inventory.collectAll();
      inventoryRepoFacade.sync(items, ['package', 'service', 'container']);
      const recs = await inventory.recommendations();
      inventoryRepoFacade.saveRecommendations(recs);
    } catch { /* */ }
  }, { runNow: true });

  // Daily TLS certificate renewal. Acts only when HTTPS is enabled, and only
  // re-runs `tailscale cert` when the active mode is 'tailscale' (so the agent
  // never touches Tailscale unless the user turned that mode on). Self-signed
  // only regenerates within 30 days of expiry. Not runNow — start() handles boot.
  scheduler.register('tls-renew', 24 * 3600e3, async () => {
    try { await tls.renewIfNeeded(app); } catch (e) { console.error('[tls] renew failed:', e.message); }
  });

  // ---- routes ----------------------------------------------------------------------
  // requireConfig: open in monitor mode, auth-required in full mode.
  const rc = auth.requireConfig;
  app.use('/api/history', rc, historyRouter({ metricsRepo: metricsFacade, eventsRepo: eventsFacade }));
  app.use('/api/health/deep', deepHealthRouter({ dbMeta, scheduler, getDb }));
  app.use('/api/auth', authRouter({ auth, loadSettings }));
  // Mount-level auth on every data router: requireConfig is open in monitor mode
  // (upstream read-only behavior) but requires a session/admin token in full
  // mode — for reads AND writes. This closes the gap where individual GET routes
  // (inventory, network, reports, …) were unguarded and readable without login in
  // full mode. Mutating routes keep their stricter requireControl on top.
  app.use('/api/hardware', rc, hardwareRouter({ hardware, eventsRepo: eventsFacade, requireAuth: auth.requireControl }));
  app.use('/api/alerts', rc, alertsRouter({ alertsRepo: alertsFacade, metricsRepo: metricsFacade, requireAuth: auth.requireConfig }));
  app.use('/api/sessions', rc, sessionsRouter({ sessions, sessionsRepo: sessionsRepoFacade, requireAuth: auth.requireConfig, requireControl: auth.requireControl }));
  app.use('/api/network', rc, networkRouter({ network, metricsRepo: metricsFacade, requireControl: auth.requireControl }));
  app.use('/api/reports', rc, reportsRouter({ reports, reportsRepo: reportsFacade }));
  app.use('/api/inventory', rc, inventoryRouter({ inventory, inventoryRepo: inventoryRepoFacade, requireControl: auth.requireControl, events: eventsFacade }));
  app.use('/api/updates', rc, updatesRouter({ updates, updateScheduler, updatesRepo: updatesRepoFacade, requireControl: auth.requireControl, events: eventsFacade }));
  app.use('/api/remote', rc, remoteRouter({ remoteAccess, requireControl: auth.requireControl }));
  // TLS / HTTPS: self-signed or Tailscale certs, provisioned via the host agent.
  const tls = createTlsService({ loadSettings, saveSettings, withFileLock });
  app.use('/api/tls', rc, tlsRouter({ tls, requireControl: auth.requireControl, getApp: () => app }));
  app.use('/api/layouts', rc, layoutsRouter({ layoutsRepo: layoutsRepoFacade, requireControl: auth.requireControl, events: eventsFacade }));
  app.use('/api/setup', setupRouter({
    loadSettings, saveSettings, withFileLock,
    secrets: secretsFacade, mailer, telegram, reopenDb, dbMeta, requireAuth: auth.requireConfig, events: eventsFacade,
  }));

  console.log(`[rapisys] db=${handle.meta.path} engine=${handle.meta.engine} `
    + `journal=${handle.meta.journalMode} fs=${handle.meta.fsType}`
    + (handle.meta.degraded ? ' (DEGRADED: NAS unavailable, using local fallback)' : ''));

  return { scheduler, getDb, dbMeta,
    attachRemoteAccess: (server) => remoteAccess.attach(server),
    attachTls: () => tls.start(app) };
}
