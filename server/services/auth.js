/**
 * RaPiSys — local authentication service
 * --------------------------------------
 * Implements the two operating modes chosen in the setup wizard:
 *
 *   monitor  read-only dashboard (upstream behavior); endpoints that
 *            control the Pi are disabled outright
 *   full     Pi-control enabled, gated behind a LOCAL admin account
 *            with mandatory TOTP MFA (works fully offline)
 *
 * Storage and crypto choices:
 *  - password: scrypt (Node built-in), 32-byte salt, 64-byte hash
 *  - TOTP secret: AES-256-GCM encrypted with SECRET_KEY before it
 *    touches the database
 *  - browser sessions: 32-byte random cookie value; only its SHA-256
 *    is stored server-side; 30-day expiry, sliding on use
 *  - the ADMIN_TOKEN header remains valid in full mode for scripts
 *  - another RaPiSys node relaying a browser's request (unified node view)
 *    authenticates with this node's API key plus X-RaPiSys-Peer. That grants
 *    reads; writes additionally need `rapisys.peerControl` switched on here.
 */

import crypto from 'crypto';
import { encrypt, decrypt, hasSecretKey } from '../core/crypto.js';
import { generateSecret, totpStep, otpauthUri } from '../core/totp.js';

const SESSION_TTL_MS = 30 * 86400e3;
const COOKIE_NAME = 'rapisys_session';

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createAuth({ getDb, loadSettings, eventsRepo }) {
  // simple in-memory login rate limit: 10 attempts / 15 min / ip
  const attempts = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
    attempts.set(ip, list);
    return list.length >= 10;
  }
  const noteAttempt = (ip) => attempts.get(ip)?.push(Date.now()) ?? attempts.set(ip, [Date.now()]);

  // A code is good for one use: the step of the last accepted code is kept,
  // and a code from the same or an earlier step is refused. (In memory: after
  // a restart, at most one more use inside the ~90 s window.)
  let lastTotpStep = -1;
  function acceptTotp(admin, code) {
    const step = totpStep(decryptSecret(admin), code);
    if (step === null || step <= lastTotpStep) return false;
    lastTotpStep = step;
    return true;
  }

  // ---- account lifecycle ----------------------------------------------------
  function getAdmin() {
    return getDb().prepare(`SELECT * FROM admin_user WHERE id = 1`).get() || null;
  }

  /**
   * Create (or replace, during the wizard) the admin account.
   * MFA is the admin's choice: when enabled the account activates only
   * after one valid TOTP code; when disabled it is active immediately.
   */
  function register(username, password, { mfa = true } = {}) {
    if (mfa && !hasSecretKey()) throw new Error('SECRET_KEY not set — cannot store MFA secret securely');
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username || '')) {
      throw new Error('username must be 3-32 chars (letters, digits, _ . -)');
    }
    if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
    const salt = crypto.randomBytes(32);
    const hash = scryptHash(password, salt);
    let encJson = null, secret = null;
    if (mfa) {
      secret = generateSecret();
      const enc = encrypt(secret);
      encJson = JSON.stringify({
        ct: enc.ciphertext.toString('base64'), iv: enc.iv.toString('base64'), tag: enc.tag.toString('base64'),
      });
    }
    getDb().prepare(
      `INSERT INTO admin_user (id, username, pass_salt, pass_hash, totp_secret_enc, mfa_confirmed, mfa_enabled, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username=excluded.username, pass_salt=excluded.pass_salt,
         pass_hash=excluded.pass_hash, totp_secret_enc=excluded.totp_secret_enc,
         mfa_confirmed=excluded.mfa_confirmed, mfa_enabled=excluded.mfa_enabled,
         created_at=excluded.created_at`
    ).run(username, salt, hash, encJson, mfa ? 0 : 1, mfa ? 1 : 0, Date.now());
    return mfa ? { mfa: true, secret, otpauth: otpauthUri(secret, username) } : { mfa: false };
  }

  function decryptSecret(admin) {
    const j = JSON.parse(admin.totp_secret_enc);
    return decrypt({
      ciphertext: Buffer.from(j.ct, 'base64'), iv: Buffer.from(j.iv, 'base64'), tag: Buffer.from(j.tag, 'base64'),
    });
  }

  /** Confirm the authenticator is set up by accepting one valid code. */
  function confirmMfa(code) {
    const admin = getAdmin();
    if (!admin) throw new Error('no admin registered');
    if (!acceptTotp(admin, code)) return false;
    getDb().prepare(`UPDATE admin_user SET mfa_confirmed = 1 WHERE id = 1`).run();
    return true;
  }

  function checkPassword(admin, password) {
    const hash = scryptHash(password, admin.pass_salt);
    return crypto.timingSafeEqual(hash, Buffer.from(admin.pass_hash));
  }

  /**
   * Change the admin password — requires the current password. Every other
   * session is signed out (a stolen cookie stops working); the session
   * `keepToken` that made the change stays signed in.
   */
  function changePassword(currentPassword, newPassword, keepToken = null) {
    const admin = getAdmin();
    if (!admin) throw new Error('no admin registered');
    if (!checkPassword(admin, currentPassword)) throw new Error('current password is incorrect');
    if (String(newPassword || '').length < 8) throw new Error('new password must be at least 8 characters');
    const salt = crypto.randomBytes(32);
    const hash = scryptHash(newPassword, salt);
    getDb().prepare(`UPDATE admin_user SET pass_salt = ?, pass_hash = ? WHERE id = 1`).run(salt, hash);
    getDb().prepare(`DELETE FROM auth_sessions WHERE token_hash <> ?`).run(keepToken ? sha256(keepToken) : '');
    return { ok: true };
  }

  /** Disable 2FA — requires a current valid TOTP code to prove possession. */
  function disableMfa(code) {
    const admin = getAdmin();
    if (!admin) throw new Error('no admin registered');
    if (!admin.mfa_enabled) return { ok: true, mfaEnabled: false };
    if (!acceptTotp(admin, code)) throw new Error('invalid authenticator code');
    getDb().prepare(`UPDATE admin_user SET mfa_enabled = 0, mfa_confirmed = 0, totp_secret_enc = NULL WHERE id = 1`).run();
    return { ok: true, mfaEnabled: false };
  }

  /**
   * Begin enabling 2FA: generates a fresh secret, stores it (unconfirmed), and
   * returns the otpauth URI so the client can show a QR. Activation completes
   * via confirmMfa() with a valid code.
   */
  function beginEnableMfa() {
    const admin = getAdmin();
    if (!admin) throw new Error('no admin registered');
    if (!hasSecretKey()) throw new Error('SECRET_KEY not set — cannot store MFA secret securely');
    const secret = generateSecret();
    const enc = encrypt(secret);
    const encJson = JSON.stringify({
      ct: enc.ciphertext.toString('base64'), iv: enc.iv.toString('base64'), tag: enc.tag.toString('base64'),
    });
    getDb().prepare(`UPDATE admin_user SET totp_secret_enc = ?, mfa_enabled = 1, mfa_confirmed = 0 WHERE id = 1`).run(encJson);
    return { secret, otpauth: otpauthUri(secret, admin.username) };
  }

  // ---- sessions ---------------------------------------------------------------
  function createSession(ip, ua) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    getDb().prepare(
      `INSERT INTO auth_sessions (token_hash, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?)`
    ).run(sha256(token), now, now + SESSION_TTL_MS, String(ip || ''), String(ua || '').slice(0, 200));
    return token;
  }

  function validateSession(token) {
    if (!token) return false;
    const row = getDb().prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`).get(sha256(token));
    if (!row || row.expires_at < Date.now()) return false;
    // sliding expiry, refreshed at most daily
    if (row.expires_at - Date.now() < SESSION_TTL_MS - 86400e3) {
      getDb().prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?`)
        .run(Date.now() + SESSION_TTL_MS, row.token_hash);
    }
    return true;
  }

  function destroySession(token) {
    if (token) getDb().prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(sha256(token));
  }

  function purgeExpired() {
    getDb().prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(Date.now());
  }

  // ---- login -------------------------------------------------------------------
  function login(username, password, code, ip, ua) {
    if (rateLimited(ip)) throw new Error('too many attempts — try again in 15 minutes');
    noteAttempt(ip);
    const admin = getAdmin();
    const active = admin && (admin.mfa_enabled ? admin.mfa_confirmed : true);
    if (!active) throw new Error('no admin account configured');
    const userOk = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(username || '')).digest(),
      crypto.createHash('sha256').update(admin.username).digest());
    // Always hash the password, so a wrong username takes as long as a wrong
    // password (no timing hint about which one was wrong).
    const passOk = checkPassword(admin, password);
    if (!userOk || !passOk) {
      eventsRepo.add('auth.login_failed', 'warning', { ip, reason: 'credentials' });
      throw new Error('invalid username or password');
    }
    if (admin.mfa_enabled) {
      if (!acceptTotp(admin, code)) {
        eventsRepo.add('auth.login_failed', 'warning', { ip, reason: 'mfa' });
        throw new Error('invalid authentication code');
      }
    }
    eventsRepo.add('auth.login', 'info', { ip, username: admin.username });
    return createSession(ip, ua);
  }

  // ---- request helpers + middleware ----------------------------------------------
  function cookieToken(req) {
    const raw = req.headers.cookie || '';
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    return m ? m[1] : null;
  }

  function tokenHeaderValid(req) {
    const expected = process.env.ADMIN_TOKEN || '';
    const got = req.headers['x-admin-token'] || '';
    if (!expected || !got) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(got)));
    } catch { return false; }
  }

  async function getMode() {
    const s = await loadSettings();
    return s.rapisys?.mode === 'full' ? 'full' : 'monitor';
  }

  function isAuthenticated(req) {
    return tokenHeaderValid(req) || validateSession(cookieToken(req));
  }

  /**
   * What a relaying peer may do here: 'none' | 'view' | 'control'.
   *
   * Requires the X-RaPiSys-Peer marker AND this node's API key. The marker is
   * only a label (anyone holding the key could set it); the key is the actual
   * credential, and peerControl is the owner's explicit opt-in for writes. No
   * key configured means no peer access at all, never "open".
   */
  async function peerAccess(req) {
    if (!req.headers['x-rapisys-peer']) return 'none';
    if (peerDenied(req)) return 'denied';
    const key = req.headers['x-api-key'];
    if (!key) return 'none';
    const s = await loadSettings();
    const hash = s.api?.enabled ? s.api?.keyHash : null;
    if (!hash) return 'none';
    const a = Buffer.from(sha256(String(key)));
    const b = Buffer.from(String(hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'none';
    if (s.rapisys?.peerControl !== true) return 'view';
    // The relaying node caps the scope to what ITS user is allowed: a browser
    // that is not signed in over there must not gain control here.
    return req.headers['x-rapisys-peer-scope'] === 'control' ? 'control' : 'view';
  }

  const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';

  /**
   * Endpoints a peer never reaches, whatever peerControl says: sessions and
   * setup belong to whoever sits at this node, a relayed request must not hop
   * on to a third node, and federation itself (peer list, the peerControl
   * switch, the API key) can only be changed by someone signed in here.
   * NAS swap lives under /api/setup but is ordinary post-setup control.
   */
  function peerDenied(req) {
    const p = String(req.originalUrl || req.url || '').split('?')[0];
    if (p.startsWith('/api/auth')) return true;
    if (p.startsWith('/api/setup') && !p.startsWith('/api/setup/nas/')) return true;
    if (p.startsWith('/api/remote/ws')) return true;
    if (/^\/api\/nodes\/[^/]+\/proxy(\/|$)/.test(p)) return true;
    if (!isRead(req) && (p.startsWith('/api/nodes') || p.startsWith('/api/settings/api'))) return true;
    return false;
  }

  function peerLabel(req) {
    return String(req.headers['x-rapisys-peer'] || '').replace(/[^\w.-]/g, '').slice(0, 63) || 'peer';
  }

  function peerControlOff(res) {
    return res.status(403).json({
      error: 'Control from other nodes is off on this node. Turn it on in its Settings → Nodes.',
      auth: 'peer-control-off',
    });
  }

  function peerDeniedRes(res) {
    return res.status(403).json({ error: 'Not available through another node. Open this node directly.', auth: 'peer-denied' });
  }

  // Writes made through a peer leave a trail on the node they changed, since
  // the local session that authorized them lives on the other node.
  function auditPeerWrite(req) {
    if (isRead(req)) return;
    try { eventsRepo.add('peer.control', 'info', { peer: peerLabel(req), method: req.method, path: req.originalUrl.split('?')[0] }); } catch { /* audit is best-effort */ }
  }

  /**
   * Config-level auth (settings, alert rules, …):
   *  - monitor mode: open, matching upstream's tokenless behavior
   *  - full mode: session cookie or admin token required
   *  - peer: reads with the API key; writes only when peerControl is on
   */
  async function requireConfig(req, res, next) {
    if (await getMode() === 'monitor') return next();
    if (isAuthenticated(req)) return next();
    const peer = await peerAccess(req);
    if (peer === 'control' || (peer === 'view' && isRead(req))) { auditPeerWrite(req); return next(); }
    if (peer === 'view') return peerControlOff(res);
    if (peer === 'denied') return peerDeniedRes(res);
    return res.status(401).json({ error: 'Authentication required.', auth: 'login' });
  }

  /**
   * Pi-control auth (fan, NAS changes, updates, reboot):
   *  - monitor mode: always 403 — these features are disabled by choice
   *  - full mode: session cookie or admin token required
   *  - peer: only when peerControl is on
   */
  async function requireControl(req, res, next) {
    if (await getMode() === 'monitor') {
      return res.status(403).json({ error: 'This RaPiSys is in monitor-only mode. Control features are disabled.', auth: 'monitor' });
    }
    if (isAuthenticated(req)) return next();
    const peer = await peerAccess(req);
    if (peer === 'control') { auditPeerWrite(req); return next(); }
    if (peer === 'view') return peerControlOff(res);
    if (peer === 'denied') return peerDeniedRes(res);
    return res.status(401).json({ error: 'Authentication required.', auth: 'login' });
  }

  /** Wizard-only: create a session without credentials (bootstrap window). */
  function createSessionDirect(ip, ua) {
    eventsRepo.add('auth.wizard_session', 'info', { ip });
    return createSession(ip, ua);
  }

  return { getAdmin, register, confirmMfa, login, createSessionDirect, validateSession, destroySession,
    changePassword, disableMfa, beginEnableMfa,
    purgeExpired, cookieToken, requireConfig, requireControl, getMode, isAuthenticated, peerAccess,
    COOKIE_NAME };
}
