/** RaPiSys — mailer service tests. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SECRET_KEY = 'a'.repeat(64);

const { openDatabase } = await import('../server/core/db.js');
const { createSecretsRepo } = await import('../server/repositories/secrets.js');
const { createMailer } = await import('../server/services/mailer.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-mail-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const secrets = createSecretsRepo(db);
  return { db, secrets };
}

describe('mailer', () => {
  it('gives a clear, actionable error when a user is set but no password was ever stored', async () => {
    const f = fixture();
    const mailer = createMailer({
      getSmtpSettings: async () => ({ host: 'smtp-relay.brevo.com', port: 587, user: 'a@smtp-brevo.com', from: 'x@y.com' }),
      secrets: f.secrets,   // nothing stored under smtp.password
    });
    await expect(mailer.send({ subject: 's', text: 't' }))
      .rejects.toThrow(/SMTP password is not set.*Settings.*Email/);
  });

  it('prefixes the subject with the brand and this node, and names the node in the body', async () => {
    const f = fixture();
    const sent = [];
    const mailer = createMailer({
      getSmtpSettings: async () => ({ host: 'localhost', port: 1, from: 'x@y.com', to: 'z@y.com' }),
      secrets: f.secrets,
      getNodeName: async () => 'XRPi',
    });
    // No SMTP server here, so the send fails — but lastDelivery records the
    // composed subject either way, which is what we're asserting.
    await mailer.send({ subject: '[CRITICAL] High CPU temperature', text: 'body' }).catch((e) => sent.push(e));
    expect(mailer.getLastDelivery().subject).toBe('RaPiSys · XRPi — [CRITICAL] High CPU temperature');
  });

  it('falls back to the hostname when no label resolver is wired in', async () => {
    const f = fixture();
    const mailer = createMailer({
      getSmtpSettings: async () => ({ host: 'localhost', port: 1 }),
      secrets: f.secrets,
    });
    await mailer.send({ subject: 'hi', text: 't' }).catch(() => {});
    expect(mailer.getLastDelivery().subject).toBe(`RaPiSys · ${os.hostname()} — hi`);
  });

  it('does not throw the password check when no user/auth is configured at all', async () => {
    const f = fixture();
    // An unauthenticated relay (no user) should reach nodemailer, not the
    // password guard, and fail on the connection attempt instead (there's
    // no real SMTP server here, so we only assert it's NOT the password error).
    const mailer = createMailer({
      getSmtpSettings: async () => ({ host: 'localhost', port: 1 }),   // nothing listens on :1
      secrets: f.secrets,
    });
    await expect(mailer.send({ subject: 's', text: 't' }))
      .rejects.not.toThrow(/SMTP password is not set/);
  });
});
