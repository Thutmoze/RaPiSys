/**
 * RaPiSys — Telegram notification service
 * ---------------------------------------
 * Sends alerts/notifications via the Telegram Bot API. Mirrors mailer.js:
 * configuration (chat id, enabled) lives in settings.json while the bot token
 * is stored encrypted in SQLite via the secrets repository and is WRITE-ONLY
 * through the API.
 *
 * Setup (one-time, user side):
 *   1. Message @BotFather → /newbot → receive a bot token.
 *   2. Send any message to the new bot, then use getChatId() (or @userinfobot)
 *      to obtain the numeric chat id.
 *
 * No SMTP, no domain, no verification — a single HTTPS POST to api.telegram.org.
 * Node 22 provides global fetch, so there is no extra dependency.
 */

const API_BASE = 'https://api.telegram.org';

export function createTelegram({ getTelegramSettings, secrets, events }) {
  let lastDelivery = null; // { ts, ok, error, chatId }

  function token() {
    const t = secrets.get('telegram.token');
    if (!t) throw new Error('Telegram bot token is not configured');
    return t;
  }

  // Low-level Bot API call with a timeout.
  async function call(method, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}/bot${token()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const desc = data.description || `HTTP ${res.status}`;
        throw new Error(desc);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a message. `text` supports a small subset of HTML (b/i/code/a) since
   * we call with parse_mode HTML. Falls back to the configured chat id.
   */
  async function send({ text, chatId, parseMode = 'HTML' }) {
    const cfg = await getTelegramSettings();
    const target = chatId || cfg?.chatId;
    if (!target) throw new Error('No Telegram chat id configured');
    try {
      const result = await call('sendMessage', {
        chat_id: target,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });
      lastDelivery = { ts: Date.now(), ok: true, chatId: String(target) };
      return result;
    } catch (err) {
      lastDelivery = { ts: Date.now(), ok: false, error: err.message, chatId: String(target) };
      events?.add('telegram.error', 'warning', { error: err.message });
      throw err;
    }
  }

  async function sendTest(chatId) {
    return send({
      chatId,
      text: '<b>RaPiSys</b> ✅\nThis is a test message from your RaPiSys dashboard. '
        + 'Telegram notifications are configured correctly. 🎉',
    });
  }

  /**
   * Auto-detect the chat id: reads recent updates the bot has received and
   * returns the most recent private chat id, so the user doesn't have to look
   * it up manually. They must have messaged the bot at least once first.
   */
  async function getChatId() {
    const updates = await call('getUpdates', { limit: 10, timeout: 0 });
    const chats = [];
    for (const u of (updates || [])) {
      const msg = u.message || u.edited_message || u.channel_post;
      if (msg?.chat?.id) chats.push({ id: msg.chat.id, name: msg.chat.first_name || msg.chat.title || msg.chat.username || '' });
    }
    if (!chats.length) {
      throw new Error('No messages found — send a message to your bot first, then try again.');
    }
    return chats[chats.length - 1];   // most recent
  }

  /** Verify a token works without storing it, by calling getMe. */
  async function verifyToken(rawToken) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}/bot${rawToken}/getMe`, { signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.description || `HTTP ${res.status}`);
      return data.result;   // { id, username, first_name, ... }
    } finally {
      clearTimeout(timer);
    }
  }

  return { send, sendTest, getChatId, verifyToken, getLastDelivery: () => lastDelivery };
}
