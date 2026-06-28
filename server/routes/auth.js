/**
 * RaPiSys — /api/auth: registration (wizard-only), login, logout, whoami.
 * Registration and MFA confirmation are open ONLY while setup is incomplete
 * (the wizard bootstrap window); afterwards they return 403 forever.
 */

import express from 'express';
import QRCode from 'qrcode';

export function authRouter({ auth, loadSettings }) {
  const r = express.Router();

  async function setupOpen() {
    const s = await loadSettings();
    return !s.rapisys?.setupCompleted;
  }

  // Registration sends a password — refuse over plain HTTP so it is never
  // transported in clear text. Loopback is exempt (no network exposure, and the
  // dev/localhost case has no cert). Full-control setup therefore requires HTTPS.
  function connectionIsSecure(req) {
    if (req.secure || req.protocol === 'https') return true;
    const ip = (req.ip || '').replace('::ffff:', '');
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  }

  // Build the session cookie. Mark it Secure on a real HTTPS request so the
  // browser never sends it back over plain HTTP — closing the gap where a
  // session minted over HTTPS would still authenticate requests to the
  // insecure :3001 listener. Loopback/dev over HTTP gets a non-Secure cookie
  // (a Secure cookie set over HTTP is silently dropped), keeping localhost work.
  function sessionCookie(req, token, { clear = false } = {}) {
    let c = `${auth.COOKIE_NAME}=${clear ? '' : token}; HttpOnly; Path=/; `
      + `Max-Age=${clear ? 0 : 30 * 86400}; SameSite=Lax`;
    if (req.secure || req.protocol === 'https') c += '; Secure';
    return c;
  }

  // -- wizard: create the admin account, return QR for the authenticator app --
  r.post('/register', async (req, res) => {
    if (!await setupOpen()) return res.status(403).json({ error: 'setup already completed' });
    if (!connectionIsSecure(req)) {
      return res.status(426).json({ error: 'HTTPS required', code: 'https_required',
        detail: 'Enable HTTPS before creating an administrator account so the password is sent encrypted.' });
    }
    try {
      const { username, password, mfa } = req.body || {};
      const r = auth.register(username, password, { mfa: mfa !== false });
      if (!r.mfa) {
        // MFA declined: account active now — sign the wizard browser in.
        const token = auth.createSessionDirect(req.ip, req.headers['user-agent']);
        res.setHeader('Set-Cookie', sessionCookie(req, token));
        return res.json({ ok: true, mfa: false });
      }
      const qrDataUrl = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 220 });
      res.json({ ok: true, mfa: true, secret: r.secret, otpauth: r.otpauth, qrDataUrl });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // -- wizard: prove the authenticator works with one valid code --
  r.post('/verify-mfa', async (req, res) => {
    if (!await setupOpen()) return res.status(403).json({ error: 'setup already completed' });
    try {
      if (!auth.confirmMfa(req.body?.code)) {
        return res.status(400).json({ error: 'code did not match — check your authenticator app' });
      }
      // The wizard browser is the admin's: log it in immediately so the
      // rest of setup (and the dashboard afterwards) needs no extra login.
      const token = auth.createSessionDirect(req.ip, req.headers['user-agent']);
      res.setHeader('Set-Cookie', sessionCookie(req, token));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // -- login / logout / whoami --
  r.post('/login', async (req, res) => {
    // Login sends a password — refuse over plain HTTP (loopback exempt) so
    // credentials are never transmitted unencrypted.
    if (!connectionIsSecure(req)) {
      return res.status(426).json({ error: 'HTTPS required', code: 'https_required',
        detail: 'This connection is not encrypted. Enable HTTPS (or use the secure URL) before signing in.' });
    }
    try {
      const { username, password, code } = req.body || {};
      const token = auth.login(username, password, code, req.ip, req.headers['user-agent']);
      res.setHeader('Set-Cookie', sessionCookie(req, token));
      res.json({ ok: true });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  r.post('/logout', (req, res) => {
    auth.destroySession(auth.cookieToken(req));
    res.setHeader('Set-Cookie', sessionCookie(req, '', { clear: true }));
    res.json({ ok: true });
  });

  r.get('/me', async (req, res) => {
    res.json({
      mode: await auth.getMode(),
      authenticated: auth.isAuthenticated(req),
      adminConfigured: (() => { const ad = auth.getAdmin(); return !!ad && (ad.mfa_enabled ? !!ad.mfa_confirmed : true); })(),
      mfaEnabled: !!auth.getAdmin()?.mfa_enabled,
      username: auth.isAuthenticated(req) ? (auth.getAdmin()?.username || null) : null,
    });
  });

  // -- account: change password (requires current password) -----------------
  r.post('/account/password', auth.requireControl, async (req, res) => {
    if (!connectionIsSecure(req)) {
      return res.status(426).json({ error: 'HTTPS required', code: 'https_required',
        detail: 'Enable HTTPS before changing the password so it is sent encrypted.' });
    }
    try {
      const { currentPassword, newPassword } = req.body || {};
      auth.changePassword(currentPassword, newPassword);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // -- account: begin enabling 2FA — returns a fresh secret + QR -------------
  r.post('/account/mfa/begin', auth.requireControl, async (req, res) => {
    try {
      const r2 = auth.beginEnableMfa();
      const qrDataUrl = await QRCode.toDataURL(r2.otpauth, { margin: 1, width: 220 });
      res.json({ ok: true, secret: r2.secret, otpauth: r2.otpauth, qrDataUrl });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // -- account: confirm 2FA with a valid code (activates it) ----------------
  r.post('/account/mfa/confirm', auth.requireControl, async (req, res) => {
    try {
      if (!auth.confirmMfa(req.body?.code)) return res.status(400).json({ error: 'code did not match' });
      res.json({ ok: true, mfaEnabled: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // -- account: disable 2FA (requires a valid code) -------------------------
  r.post('/account/mfa/disable', auth.requireControl, async (req, res) => {
    try {
      const out = auth.disableMfa(req.body?.code);
      res.json(out);
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return r;
}
