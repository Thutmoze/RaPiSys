/**
 * RaPiSys — TLS / HTTPS service.
 *
 * Provides optional HTTPS for the dashboard using either:
 *   - a self-signed certificate (zero external dependency; browser warns once), or
 *   - a Tailscale-issued certificate for the node's *.ts.net name (trusted,
 *     auto-renewing as long as the renewal job re-runs `tailscale cert`).
 *
 * Certificates are provisioned on the HOST by the agent (it has the privileges
 * and host tools); the container reads the resulting cert/key files from a
 * bind-mounted directory and starts an https.Server alongside the plain-HTTP one.
 *
 * Security model: enabling HTTPS and provisioning certs is admin-gated. The
 * full-control wizard requires HTTPS before an admin password is ever accepted,
 * so the password is never transported in clear text.
 */
import fs from 'fs';
import https from 'https';
import { agentCall, agentConfigured } from '../core/agent-client.js';

const CERT_DIR = process.env.RAPISYS_TLS_DIR || '/var/lib/rapisys/tls';
const CRT = `${CERT_DIR}/server.crt`;
const KEY = `${CERT_DIR}/server.key`;

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'selfsigned',   // 'selfsigned' | 'tailscale'
  port: 3443,
  // populated after provisioning:
  notAfter: null, dnsName: null, provisionedAt: null,
};

export function createTlsService({ loadSettings, saveSettings, withFileLock }) {
  let httpsServer = null;

  async function getConfig() {
    const s = await loadSettings();
    return { ...DEFAULT_CONFIG, ...(s.tls || {}) };
  }

  async function setConfig(patch) {
    return withFileLock(async () => {
      const s = await loadSettings();
      s.tls = { ...DEFAULT_CONFIG, ...(s.tls || {}), ...patch };
      await saveSettings(s);
      return s.tls;
    });
  }

  function certsExist() {
    try { return fs.existsSync(CRT) && fs.existsSync(KEY); } catch { return false; }
  }

  /** Ask the host agent to (re)issue the cert for the current mode. */
  async function provision(mode, { dnsName = null, altNames = [] } = {}) {
    if (!agentConfigured()) throw new Error('host agent required to provision certificates');
    let res;
    if (mode === 'tailscale') {
      res = await agentCall('tls.tailscaleCert', { dir: CERT_DIR, dnsName }, null, 70000);
    } else {
      res = await agentCall('tls.selfSigned', { dir: CERT_DIR, altNames }, null, 35000);
    }
    await setConfig({ mode, notAfter: res.notAfter || null, dnsName: res.dnsName || null, provisionedAt: Date.now() });
    return res;
  }

  async function tailscaleStatus() {
    if (!agentConfigured()) return { available: false, reason: 'host agent required' };
    try { return await agentCall('tls.tailscaleStatus', {}, null, 9000); }
    catch (e) { return { available: false, reason: e.message }; }
  }

  /** Read cert+key for the https.Server (throws if missing). */
  function readCreds() {
    return { cert: fs.readFileSync(CRT), key: fs.readFileSync(KEY) };
  }

  /**
   * Start the HTTPS listener if enabled and certs are present. Returns a small
   * status object. Safe to call repeatedly (idempotent: closes any prior server).
   */
  async function start(app) {
    const cfg = await getConfig();
    await stop();
    if (!cfg.enabled) return { listening: false, reason: 'disabled' };
    if (!certsExist()) { console.warn('[tls] not starting: certificate files missing'); return { listening: false, reason: 'no certificate' }; }
    let creds;
    try { creds = readCreds(); }
    catch (e) {
      // Most commonly EACCES on the private key when the container user isn't in
      // the key's group — log loudly so it's diagnosable from `docker logs`.
      console.error(`[tls] not starting: cannot read certificate/key (${e.code || ''} ${e.message}). `
        + `Ensure ${KEY} is readable by the container's group.`);
      return { listening: false, reason: `cannot read key: ${e.message}` };
    }
    httpsServer = https.createServer(creds, app);
    return new Promise((resolve) => {
      httpsServer.once('error', (e) => { console.error('[tls] https listen error:', e.message); resolve({ listening: false, reason: e.message }); });
      httpsServer.listen(cfg.port, () => {
        console.log(`[tls] HTTPS listening on :${cfg.port} (${cfg.mode})`);
        resolve({ listening: true, port: cfg.port, mode: cfg.mode });
      });
    });
  }

  async function stop() {
    if (httpsServer) { await new Promise((r) => httpsServer.close(r)); httpsServer = null; }
  }

  function isListening() { return !!httpsServer && httpsServer.listening; }

  /**
   * Renewal tick — only acts for the active mode. Tailscale: re-run cert (only
   * actually fetches near expiry). Self-signed: regenerate if within 30 days of
   * expiry. Gated by the caller so the Tailscale path never runs unless the user
   * enabled that mode.
   */
  async function renewIfNeeded(app) {
    const cfg = await getConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };
    if (cfg.mode === 'tailscale') {
      const res = await provision('tailscale');
      await start(app);
      return { renewed: true, mode: 'tailscale', notAfter: res.notAfter };
    }
    // self-signed: only regenerate when close to expiry
    const soon = cfg.notAfter ? (new Date(cfg.notAfter).getTime() - Date.now() < 30 * 86400e3) : true;
    if (soon) { const res = await provision('selfsigned'); await start(app); return { renewed: true, mode: 'selfsigned', notAfter: res.notAfter }; }
    return { renewed: false };
  }

  return { getConfig, setConfig, provision, tailscaleStatus, certsExist, start, stop, isListening, renewIfNeeded, CERT_DIR, certPaths: { crt: CRT, key: KEY } };
}
