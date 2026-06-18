/**
 * RaPiSys — in-browser remote access (SSH terminal + VNC desktop).
 *
 * Two WebSocket bridges, both attached to the existing HTTP server and gated by
 * the same admin session cookie used everywhere else:
 *
 *   /api/remote/ws/ssh  — an ssh2 client connects to the host's sshd (default
 *                         localhost:22) using a dashboard-managed key, opens a
 *                         PTY shell, and pipes it to xterm.js in the browser.
 *   /api/remote/ws/vnc  — a raw TCP socket to the host's VNC server (default
 *                         localhost:5900) is bridged byte-for-byte to noVNC in
 *                         the browser (the classic websockify pattern).
 *
 * SECURITY: disabled by default. Each bridge independently requires its sub-
 * feature to be enabled in settings AND a valid admin session. SSH uses key
 * auth only (no passwords stored); the private key lives encrypted in the
 * secrets table, and the public key is shown so the user can authorize it in
 * ~/.ssh/authorized_keys on the Pi.
 */

import crypto from 'crypto';
import net from 'net';

export function createRemoteAccess({ loadSettings, saveSettings, withFileLock, secrets, auth, events }) {
  const SSH_KEY_SECRET = 'remote.ssh.privkey';
  const VNC_PW_SECRET = 'remote.vnc.password';

  // ---- config ---------------------------------------------------------------
  function defaults() {
    return {
      enabled: false,
      ssh: { enabled: false, host: '127.0.0.1', port: 22, username: '' },
      vnc: { enabled: false, host: '127.0.0.1', port: 5900, username: '', auth: 'auto' },
    };
  }
  async function getConfig() {
    const s = await loadSettings();
    const cfg = (s.rapisys && s.rapisys.remoteAccess) || {};
    const d = defaults();
    return {
      enabled: !!cfg.enabled,
      ssh: { ...d.ssh, ...(cfg.ssh || {}) },
      vnc: { ...d.vnc, ...(cfg.vnc || {}) },
      sshKeyConfigured: !!secrets.has(SSH_KEY_SECRET),
      sshPublicKey: (cfg.ssh && cfg.ssh.pubkey) || null,
      vncPasswordConfigured: !!secrets.has(VNC_PW_SECRET),
    };
  }
  async function setConfig(patch) {
    // VNC password is write-only: store it encrypted and strip from settings.
    if (patch.vnc && typeof patch.vnc.password === 'string') {
      if (patch.vnc.password) secrets.set(VNC_PW_SECRET, patch.vnc.password);
      const { password, ...vncRest } = patch.vnc;
      patch = { ...patch, vnc: vncRest };
    }
    return withFileLock(async () => {
      const s = await loadSettings();
      s.rapisys = s.rapisys || {};
      const cur = s.rapisys.remoteAccess || {};
      const next = {
        ...cur,
        enabled: patch.enabled != null ? !!patch.enabled : !!cur.enabled,
        ssh: { ...(cur.ssh || {}), ...(patch.ssh || {}) },
        vnc: { ...(cur.vnc || {}), ...(patch.vnc || {}) },
      };
      // never let the client overwrite the stored public key via this path
      if (cur.ssh && cur.ssh.pubkey) next.ssh.pubkey = cur.ssh.pubkey;
      s.rapisys.remoteAccess = next;
      await saveSettings(s);
      return getConfig();
    });
  }

  // ---- SSH key management ----------------------------------------------------
  // Generate an RSA-3072 keypair (Node exports it in a PEM format ssh2 can parse;
  // ed25519 would need OpenSSH-format export which Node's crypto can't produce).
  // Store the private key encrypted and the OpenSSH public key for the user to
  // install in ~/.ssh/authorized_keys.
  async function generateKey() {
    const ssh2 = (await import('ssh2')).default;
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs1' },
    });
    const parsed = ssh2.utils.parseKey(privateKey);
    if (parsed instanceof Error) throw new Error('key generation failed: ' + parsed.message);
    const openssh = `${parsed.type} ${parsed.getPublicSSH().toString('base64')} rapisys@dashboard`;
    secrets.set(SSH_KEY_SECRET, privateKey);
    await withFileLock(async () => {
      const s = await loadSettings();
      s.rapisys = s.rapisys || {};
      s.rapisys.remoteAccess = s.rapisys.remoteAccess || defaults();
      s.rapisys.remoteAccess.ssh = s.rapisys.remoteAccess.ssh || {};
      s.rapisys.remoteAccess.ssh.pubkey = openssh;
      await saveSettings(s);
    });
    events?.add?.('remote.key.generated', 'info', {});
    return { publicKey: openssh };
  }

  function getPrivateKey() {
    return secrets.get(SSH_KEY_SECRET);
  }

  // ---- auth on WS upgrade ----------------------------------------------------
  // Reuse the same admin session cookie that protects the REST API. Control-mode
  // is required (read-only/monitor sessions cannot open a shell or desktop).
  function upgradeAuthorized(req) {
    try {
      const token = auth.cookieToken({ headers: req.headers });
      if (!auth.validateSession(token)) return false;
      // monitor-only deployments must not get interactive control
      if (typeof auth.getMode === 'function' && auth.getMode() === 'monitor') return false;
      return true;
    } catch { return false; }
  }

  // ---- WebSocket bridges -----------------------------------------------------
  let WebSocketServer, SSHClient;
  async function attach(server) {
    // lazy-load so a missing optional dep can't crash boot
    ({ WebSocketServer } = await import('ws'));
    SSHClient = (await import('ssh2')).default.Client;

    const wssSsh = new WebSocketServer({ noServer: true });
    const wssVnc = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = req.url || ''; }
      if (pathname !== '/api/remote/ws/ssh' && pathname !== '/api/remote/ws/vnc') return; // not ours
      if (!upgradeAuthorized(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      if (pathname === '/api/remote/ws/ssh') {
        wssSsh.handleUpgrade(req, socket, head, (ws) => bridgeSsh(ws));
      } else {
        wssVnc.handleUpgrade(req, socket, head, (ws) => bridgeVnc(ws));
      }
    });
  }

  // SSH: ssh2 client → PTY shell → WebSocket (binary frames both ways).
  async function bridgeSsh(ws) {
    const cfg = await getConfig().catch(() => null);
    const fail = (msg) => { try { ws.send(`\r\n\x1b[31m${msg}\x1b[0m\r\n`); } catch { /* */ } try { ws.close(); } catch { /* */ } };
    if (!cfg || !cfg.enabled || !cfg.ssh.enabled) return fail('Remote SSH is disabled.');
    const key = getPrivateKey();
    if (!key) return fail('No SSH key configured. Generate one in Settings → Remote Access.');
    if (!cfg.ssh.username) return fail('No SSH username configured.');

    const conn = new SSHClient();
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; try { conn.end(); } catch { /* */ } try { ws.close(); } catch { /* */ } };

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) { fail('Shell error: ' + err.message); return cleanup(); }
        events?.add?.('remote.ssh.open', 'info', { user: cfg.ssh.username });
        stream.on('data', (d) => { try { ws.send(d); } catch { /* */ } });
        stream.stderr.on('data', (d) => { try { ws.send(d); } catch { /* */ } });
        stream.on('close', cleanup);
        ws.on('message', (m, isBinary) => {
          // control frames arrive as JSON text (resize); data is binary/text keystrokes
          if (!isBinary) {
            const str = m.toString();
            if (str.startsWith('{')) {
              try { const j = JSON.parse(str); if (j.type === 'resize') { stream.setWindow(j.rows, j.cols, 0, 0); return; } } catch { /* treat as data */ }
            }
            stream.write(str); return;
          }
          stream.write(m);
        });
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      });
    });
    conn.on('error', (err) => fail('SSH connection failed: ' + err.message));
    conn.on('close', cleanup);

    try {
      conn.connect({
        host: cfg.ssh.host || '127.0.0.1',
        port: Number(cfg.ssh.port) || 22,
        username: cfg.ssh.username,
        privateKey: key,
        readyTimeout: 15000,
        keepaliveInterval: 20000,
      });
    } catch (err) { fail('SSH connect error: ' + err.message); }
  }

  // VNC: bridge the WebSocket to the host VNC server. wayvnc (and RealVNC)
  // typically require VeNCrypt/TLS which the browser can't do, so we terminate
  // it here via the proxy. For a plain no-auth server, 'raw' mode just pipes.
  async function bridgeVnc(ws) {
    const cfg = await getConfig().catch(() => null);
    const close = () => { try { ws.close(); } catch { /* */ } };
    if (!cfg || !cfg.enabled || !cfg.vnc.enabled) { close(); return; }

    const auth = cfg.vnc.auth || 'auto';
    if (auth === 'raw') {
      // transparent TCP bridge (no-auth / standard-VNC server noVNC handles itself)
      const tcp = net.connect({ host: cfg.vnc.host || '127.0.0.1', port: Number(cfg.vnc.port) || 5900 });
      let closed = false;
      const cleanup = () => { if (closed) return; closed = true; try { tcp.destroy(); } catch { /* */ } try { ws.close(); } catch { /* */ } };
      tcp.on('connect', () => events?.add?.('remote.vnc.open', 'info', { mode: 'raw' }));
      tcp.on('data', (d) => { try { ws.send(d); } catch { /* */ } });
      tcp.on('error', cleanup); tcp.on('close', cleanup);
      ws.on('message', (m) => { try { tcp.write(m); } catch { /* */ } });
      ws.on('close', cleanup); ws.on('error', cleanup);
      return;
    }

    // VeNCrypt/TLS termination (default 'auto'). Uses stored PAM credentials.
    const { vncVencryptProxy } = await import('./vnc-proxy.js');
    const password = secrets.get(VNC_PW_SECRET) || '';
    vncVencryptProxy(ws, {
      host: cfg.vnc.host || '127.0.0.1',
      port: Number(cfg.vnc.port) || 5900,
      username: cfg.vnc.username || '',
      password,
      debug: true,   // log handshake steps to the container log for on-device debugging
      onEvent: (ev, msg) => {
        if (ev === 'ready') events?.add?.('remote.vnc.open', 'info', { mode: 'vencrypt' });
        if (ev === 'error') events?.add?.('remote.vnc.error', 'warning', { error: msg });
      },
    }).catch((err) => { events?.add?.('remote.vnc.error', 'warning', { error: err.message }); try { ws.close(); } catch { /* */ } });
  }

  return { getConfig, setConfig, generateKey, attach };
}
