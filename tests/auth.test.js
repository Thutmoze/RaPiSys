/** RaPiSys — auth service + TOTP tests. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);
delete process.env.ADMIN_TOKEN;

const { openDatabase } = await import('../server/core/db.js');
const { createEventsRepo } = await import('../server/repositories/events.js');
const { createAuth } = await import('../server/services/auth.js');
const { generateSecret, totpCode, verifyTotp, base32Decode, base32Encode } = await import('../server/core/totp.js');

function fixture(mode = 'full') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-auth-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const eventsRepo = createEventsRepo(db);
  const auth = createAuth({
    getDb: () => db,
    loadSettings: async () => ({ rapisys: { mode } }),
    eventsRepo,
  });
  return { db, auth };
}

describe('totp', () => {
  it('base32 round-trips', () => {
    const buf = Buffer.from('rapisys-totp-test');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
  it('verifies codes within the drift window and rejects others', () => {
    const s = generateSecret();
    expect(verifyTotp(s, totpCode(s))).toBe(true);
    expect(verifyTotp(s, totpCode(s, Date.now() - 30000))).toBe(true);   // previous step
    expect(verifyTotp(s, totpCode(s, Date.now() - 120000))).toBe(false); // too old
    expect(verifyTotp(s, '000000')).toBe(false);
    expect(verifyTotp(s, 'abcdef')).toBe(false);
  });
});

describe('auth service', () => {
  it('register -> confirm -> login lifecycle', () => {
    const { auth } = fixture();
    const { secret } = auth.register('akhenaten', 'longpassword');
    expect(auth.getAdmin().mfa_confirmed).toBe(0);
    expect(auth.confirmMfa('000000')).toBe(false);
    expect(auth.confirmMfa(totpCode(secret))).toBe(true);
    const token = auth.login('akhenaten', 'longpassword', totpCode(secret), '1.2.3.4', 'vitest');
    expect(auth.validateSession(token)).toBe(true);
    auth.destroySession(token);
    expect(auth.validateSession(token)).toBe(false);
  });
  it('register without MFA: active immediately, login needs no code', () => {
    const { auth } = fixture();
    const r = auth.register('nomfa_user', 'longpassword', { mfa: false });
    expect(r.mfa).toBe(false);
    const token = auth.login('nomfa_user', 'longpassword', undefined, 'ip', '');
    expect(auth.validateSession(token)).toBe(true);
    expect(() => auth.login('nomfa_user', 'WRONG', undefined, 'ip', '')).toThrow();
  });
  it('rejects bad credentials and bad codes', () => {
    const { auth } = fixture();
    const { secret } = auth.register('user_1', 'longpassword');
    auth.confirmMfa(totpCode(secret));
    expect(() => auth.login('user_1', 'WRONG', totpCode(secret), 'ip1', '')).toThrow(/invalid username or password/);
    expect(() => auth.login('user_1', 'longpassword', '111111', 'ip1', '')).toThrow(/invalid authentication code/);
  });
  it('enforces password and username policy', () => {
    const { auth } = fixture();
    expect(() => auth.register('x', 'longpassword')).toThrow(/username/);
    expect(() => auth.register('okuser', 'short')).toThrow(/password/);
  });
  it('rate-limits login attempts per ip', () => {
    const { auth } = fixture();
    const { secret } = auth.register('limituser', 'longpassword');
    auth.confirmMfa(totpCode(secret));
    for (let i = 0; i < 10; i++) {
      try { auth.login('limituser', 'WRONG', '111111', '9.9.9.9', ''); } catch { /* expected */ }
    }
    expect(() => auth.login('limituser', 'longpassword', totpCode(secret), '9.9.9.9', ''))
      .toThrow(/too many attempts/);
  });
  it('requireControl: 403 in monitor mode, 401 unauthenticated in full mode', async () => {
    const mk = () => {
      const res = { code: null, body: null,
        status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      return res;
    };
    const mon = fixture('monitor');
    let res = mk(); let called = false;
    await mon.auth.requireControl({ headers: {} }, res, () => { called = true; });
    expect(res.code).toBe(403); expect(called).toBe(false);

    const full = fixture('full');
    res = mk(); called = false;
    await full.auth.requireControl({ headers: {} }, res, () => { called = true; });
    expect(res.code).toBe(401);
    // with a valid session cookie it passes
    const { secret } = full.auth.register('ctl', 'longpassword');
    full.auth.confirmMfa(totpCode(secret));
    const token = full.auth.login('ctl', 'longpassword', totpCode(secret), 'ip', '');
    res = mk(); called = false;
    await full.auth.requireControl({ headers: { cookie: `rapisys_session=${token}` } }, res, () => { called = true; });
    expect(called).toBe(true);
  });
});

describe('account management', () => {
  it('changePassword requires the correct current password and re-logs in', () => {
    const { auth } = fixture();
    auth.register('pwuser', 'oldpassword', { mfa: false });
    expect(() => auth.changePassword('wrongpass', 'newpassword')).toThrow(/incorrect/);
    expect(() => auth.changePassword('oldpassword', 'short')).toThrow(/at least 8/);
    expect(auth.changePassword('oldpassword', 'newpassword').ok).toBe(true);
    // old password no longer works, new one does
    expect(() => auth.login('pwuser', 'oldpassword', null, 'ip', '')).toThrow();
    const token = auth.login('pwuser', 'newpassword', null, 'ip', '');
    expect(auth.validateSession(token)).toBe(true);
  });
  it('beginEnableMfa + confirm enables 2FA on a non-MFA account', () => {
    const { auth } = fixture();
    auth.register('mfauser', 'longpassword', { mfa: false });
    expect(auth.getAdmin().mfa_enabled).toBe(0);
    const { secret } = auth.beginEnableMfa();
    expect(auth.getAdmin().mfa_enabled).toBe(1);
    expect(auth.getAdmin().mfa_confirmed).toBe(0);
    expect(auth.confirmMfa(totpCode(secret))).toBe(true);
    expect(auth.getAdmin().mfa_confirmed).toBe(1);
  });
  it('disableMfa requires a valid code and clears the secret', () => {
    const { auth } = fixture();
    const { secret } = auth.register('mfauser2', 'longpassword');
    auth.confirmMfa(totpCode(secret));
    expect(() => auth.disableMfa('000000')).toThrow(/invalid/);
    expect(auth.disableMfa(totpCode(secret)).mfaEnabled).toBe(false);
    expect(auth.getAdmin().mfa_enabled).toBe(0);
    expect(auth.getAdmin().totp_secret_enc).toBe(null);
    // login no longer needs a code
    const token = auth.login('mfauser2', 'longpassword', null, 'ip', '');
    expect(auth.validateSession(token)).toBe(true);
  });
});
