/**
 * RaPiSys — mailer service
 * ------------------------
 * Authenticated SMTP via nodemailer. Configuration lives in settings.json
 * (host/port/secure/user/from) while the password is stored encrypted in
 * SQLite via the secrets repository and is WRITE-ONLY through the API.
 *
 * Every subject is prefixed with the brand and this node's name
 * ("RaPiSys · XRPi — ..."), composed in core/node-identity.js. Call sites pass
 * only the meaningful part of the subject: with two nodes running identical
 * alert rules, an unlabelled email cannot be traced back to a machine.
 *
 * Provider notes shown in the UI (verified June 2026):
 *  - Brevo: 300 mails/day free, SMTP key as password    -> recommended
 *  - SMTP2GO: 1000/month free                            -> recommended
 *  - Gmail: requires 2FA + App Password
 *  - Outlook/M365: basic SMTP auth retired (Apr 2026)    -> unsupported
 */

import nodemailer from 'nodemailer';
import { emailSubject, resolveNodeName } from '../core/node-identity.js';

export function createMailer({ getSmtpSettings, secrets, events, getNodeName }) {
  let lastDelivery = null; // { ts, ok, error, to, subject }

  async function buildTransport() {
    const cfg = await getSmtpSettings();
    if (!cfg || !cfg.host) throw new Error('SMTP is not configured');
    const password = secrets.get('smtp.password');
    // nodemailer's own error here is a cryptic 'Missing credentials for
    // "PLAIN"' — this happened in practice because the password field is
    // write-only and simply wasn't (re-)saved, and the send silently kept
    // failing with no clue why. Fail fast with a message that says what to
    // actually do about it.
    if (cfg.user && !password) {
      throw new Error('SMTP password is not set — open Settings → Email, re-enter the password/SMTP key, and save.');
    }
    return nodemailer.createTransport({
      host: cfg.host,
      port: Number(cfg.port) || 587,
      secure: !!cfg.secure,                  // true = implicit TLS (465)
      requireTLS: !cfg.secure,               // otherwise enforce STARTTLS
      auth: cfg.user ? { user: cfg.user, pass: password || '' } : undefined,
      connectionTimeout: 10000,
      // nodemailer's defaults are 30 s for the greeting and 10 min of socket
      // inactivity: a stalled server would hold the alert pass that long.
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }

  async function nodeName() {
    try { return getNodeName ? await getNodeName() : resolveNodeName(null); }
    catch { return resolveNodeName(null); }
  }

  async function send({ to, subject, text, html }) {
    const cfg = await getSmtpSettings();
    const node = await nodeName();
    const fullSubject = emailSubject(node, subject);
    // Also in the body: a forwarded mail or one read in a threaded client can
    // lose the subject line, and the body is what gets screenshotted.
    const fullText = `Node: ${node}\n\n${text || ''}`;
    const fullHtml = html ? withNodeFooter(html, node) : undefined;
    const transport = await buildTransport();
    try {
      const info = await transport.sendMail({
        from: cfg.from || cfg.user, to: to || cfg.to, subject: fullSubject, text: fullText, html: fullHtml,
      });
      lastDelivery = { ts: Date.now(), ok: true, to: to || cfg.to, subject: fullSubject };
      return info;
    } catch (err) {
      lastDelivery = { ts: Date.now(), ok: false, error: err.message, to: to || cfg.to, subject: fullSubject };
      events?.add('smtp.error', 'warning', { error: err.message });
      throw err;
    }
  }

  /** Append the sending node to an HTML body, matching the dashboard's tokens. */
  function withNodeFooter(html, node) {
    const safe = String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${html}<div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);`
      + `font-family:Inter,sans-serif;font-size:12px;color:rgba(255,255,255,0.4)">Sent by RaPiSys on ${safe}</div>`;
  }

  async function sendTest(to) {
    return send({
      to,
      subject: 'Test notification ✅',
      text: 'This is a test email from your RaPiSys dashboard. SMTP is configured correctly.',
      html: '<div style="font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;padding:24px;border-radius:16px">'
        + '<h2 style="margin:0 0 8px"><span style="color:#00d4ff">Ra</span><span style="color:#a855f7">Pi</span>Sys</h2>'
        + '<p>This is a test email from your RaPiSys dashboard.<br>SMTP is configured correctly. 🎉</p></div>',
    });
  }

  return { send, sendTest, getLastDelivery: () => lastDelivery };
}
