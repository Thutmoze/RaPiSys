/**
 * RaPiSys — mailer service
 * ------------------------
 * Authenticated SMTP via nodemailer. Configuration lives in settings.json
 * (host/port/secure/user/from) while the password is stored encrypted in
 * SQLite via the secrets repository and is WRITE-ONLY through the API.
 *
 * Provider notes shown in the UI (verified June 2026):
 *  - Brevo: 300 mails/day free, SMTP key as password    -> recommended
 *  - SMTP2GO: 1000/month free                            -> recommended
 *  - Gmail: requires 2FA + App Password
 *  - Outlook/M365: basic SMTP auth retired (Apr 2026)    -> unsupported
 */

import nodemailer from 'nodemailer';

export function createMailer({ getSmtpSettings, secrets, events }) {
  let lastDelivery = null; // { ts, ok, error, to, subject }

  async function buildTransport() {
    const cfg = await getSmtpSettings();
    if (!cfg || !cfg.host) throw new Error('SMTP is not configured');
    const password = secrets.get('smtp.password');
    return nodemailer.createTransport({
      host: cfg.host,
      port: Number(cfg.port) || 587,
      secure: !!cfg.secure,                  // true = implicit TLS (465)
      requireTLS: !cfg.secure,               // otherwise enforce STARTTLS
      auth: cfg.user ? { user: cfg.user, pass: password || '' } : undefined,
      connectionTimeout: 10000,
    });
  }

  async function send({ to, subject, text, html }) {
    const cfg = await getSmtpSettings();
    const transport = await buildTransport();
    try {
      const info = await transport.sendMail({
        from: cfg.from || cfg.user, to: to || cfg.to, subject, text, html,
      });
      lastDelivery = { ts: Date.now(), ok: true, to: to || cfg.to, subject };
      return info;
    } catch (err) {
      lastDelivery = { ts: Date.now(), ok: false, error: err.message, to: to || cfg.to, subject };
      events?.add('smtp.error', 'warning', { error: err.message });
      throw err;
    }
  }

  async function sendTest(to) {
    return send({
      to,
      subject: 'RaPiSys test notification ✅',
      text: 'This is a test email from your RaPiSys dashboard. SMTP is configured correctly.',
      html: '<div style="font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;padding:24px;border-radius:16px">'
        + '<h2 style="margin:0 0 8px"><span style="color:#00d4ff">Ra</span><span style="color:#a855f7">Pi</span>Sys</h2>'
        + '<p>This is a test email from your RaPiSys dashboard.<br>SMTP is configured correctly. 🎉</p></div>',
    });
  }

  return { send, sendTest, getLastDelivery: () => lastDelivery };
}
