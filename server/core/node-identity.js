/**
 * RaPiSys — node identity
 * =======================
 * One answer to "what is this node called", used everywhere this node names
 * itself: alert emails, Telegram messages, the header node switcher, and the
 * name a peer suggests when it adds this node (§14).
 *
 * Two nodes run the same stack with the same alert rules, so an unlabelled
 * notification is genuinely ambiguous — two identical emails arrive and neither
 * says which Pi is hot. That is the whole reason this module exists.
 *
 * Resolution order:
 *   1. settings.rapisys.nodeLabel — an operator-chosen friendly name
 *   2. os.hostname()              — the Pi's real hostname (the container runs
 *                                   network_mode: host, so this is the host's)
 *   3. 'rapisys'                  — last resort; never return an empty string
 *
 * The composition helpers live here rather than in mailer/telegram so the
 * format is asserted once by tests without needing a live SMTP or Bot API.
 */

import os from 'os';

/** Labels are display-only; keep them short and free of control characters. */
export const NODE_LABEL_MAX = 40;

/**
 * Normalize an operator-supplied label. Returns '' for anything that should be
 * treated as "not set" (which falls back to the hostname).
 */
export function normalizeNodeLabel(raw) {
  if (typeof raw !== 'string') return '';
  // Strip control characters (a newline here would break the Telegram prefix
  // into a second line and split the subject header).
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NODE_LABEL_MAX);
}

/** Resolve the display name from a loaded settings object. */
export function resolveNodeName(settings) {
  const label = normalizeNodeLabel(settings?.rapisys?.nodeLabel);
  if (label) return label;
  let host = '';
  try { host = String(os.hostname() || '').trim(); } catch { /* container without a hostname */ }
  return host || 'rapisys';
}

/** The raw hostname, shown next to the label so the operator sees both. */
export function hostName() {
  try { return String(os.hostname() || '').trim() || 'rapisys'; } catch { return 'rapisys'; }
}

/**
 * Email subject. The brand prefix lives here rather than at each call site:
 * every sender used to paste its own "RaPiSys" in, which is exactly why adding
 * the node name at five call sites would have drifted apart again.
 */
export function emailSubject(node, subject) {
  return `RaPiSys · ${node} — ${String(subject || '').trim()}`;
}

/**
 * Telegram prefix — the node on its own bold first line. It goes first because
 * the lock-screen preview truncates, and the node is the part you need before
 * deciding whether to unlock the phone.
 */
export function telegramPrefix(node, text) {
  const esc = String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<b>${esc}</b>\n${text}`;
}
