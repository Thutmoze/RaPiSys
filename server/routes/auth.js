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

  // -- wizard: create the admin account, return QR for the authenticator app --
  r.post('/register', async (req, res) => {
    if (!await setupOpen()) return res.status(403).json({ error: 'setup already completed' });
    try {
      const { username, password, mfa } = req.body || {};
      const r = auth.register(username, password, { mfa: mfa !== false });
      if (!r.mfa) {
        // MFA declined: account active now — sign the wizard browser in.
        const token = auth.createSessionDirect(req.ip, req.headers['user-agent']);
        res.setHeader('Set-Cookie',
          `${auth.COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
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
      res.setHeader('Set-Cookie',
        `${auth.COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // -- login / logout / whoami --
  r.post('/login', async (req, res) => {
    try {
      const { username, password, code } = req.body || {};
      const token = auth.login(username, password, code, req.ip, req.headers['user-agent']);
      res.setHeader('Set-Cookie',
        `${auth.COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
      res.json({ ok: true });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  r.post('/logout', (req, res) => {
    auth.destroySession(auth.cookieToken(req));
    res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
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
