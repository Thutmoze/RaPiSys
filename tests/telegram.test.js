/** RaPiSys — Telegram notification service tests. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createTelegram } = await import('../server/services/telegram.js');

function fixture({ token = 'TESTTOKEN', chatId = '999', enabled = true } = {}) {
  const events = { add: vi.fn() };
  const secretsStore = { 'telegram.token': token };
  const secrets = { get: (k) => secretsStore[k], has: (k) => !!secretsStore[k] };
  const tg = createTelegram({
    getTelegramSettings: async () => ({ enabled, chatId }),
    secrets, events,
  });
  return { tg, events };
}

// Helper to stub global fetch with a canned Telegram API response.
function stubFetch(impl) {
  global.fetch = vi.fn(impl);
}

beforeEach(() => { /* fresh per test */ });
afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

describe('telegram service', () => {
  it('sends a message to the configured chat id', async () => {
    const calls = [];
    stubFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    });
    const { tg } = fixture({ chatId: '12345' });
    await tg.send({ text: 'hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/botTESTTOKEN/sendMessage');
    expect(calls[0].body.chat_id).toBe('12345');
    expect(calls[0].body.text).toBe('hello');
    expect(calls[0].body.parse_mode).toBe('HTML');
  });

  it('throws and records an event when the API returns an error', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: 'chat not found' }) }));
    const { tg, events } = fixture();
    await expect(tg.send({ text: 'x' })).rejects.toThrow(/chat not found/);
    expect(events.add).toHaveBeenCalledWith('telegram.error', 'warning', expect.objectContaining({ error: expect.stringMatching(/chat not found/) }));
  });

  it('throws when no chat id is available', async () => {
    const secrets = { get: () => 'TOK', has: () => true };
    const tg = createTelegram({ getTelegramSettings: async () => ({ enabled: true, chatId: '' }), secrets, events: { add: vi.fn() } });
    await expect(tg.send({ text: 'x' })).rejects.toThrow(/chat id/i);
  });

  it('throws when the bot token is missing', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }));
    const secrets = { get: () => undefined, has: () => false };
    const tg = createTelegram({ getTelegramSettings: async () => ({ enabled: true, chatId: '1' }), secrets, events: { add: vi.fn() } });
    await expect(tg.send({ text: 'x' })).rejects.toThrow(/token is not configured/i);
  });

  it('getChatId returns the most recent private chat from getUpdates', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ok: true, result: [
      { message: { chat: { id: 111, first_name: 'Old' } } },
      { message: { chat: { id: 222, first_name: 'New' } } },
    ] }) }));
    const { tg } = fixture();
    const chat = await tg.getChatId();
    expect(chat.id).toBe(222);
    expect(chat.name).toBe('New');
  });

  it('getChatId throws a helpful error when no messages exist', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }));
    const { tg } = fixture();
    await expect(tg.getChatId()).rejects.toThrow(/send a message to your bot first/i);
  });

  it('verifyToken calls getMe with the raw token and returns the bot info', async () => {
    let calledUrl = '';
    stubFetch(async (url) => { calledUrl = url; return { ok: true, json: async () => ({ ok: true, result: { id: 7, username: 'mybot' } }) }; });
    const { tg } = fixture();
    const info = await tg.verifyToken('RAWTOKEN');
    expect(calledUrl).toContain('/botRAWTOKEN/getMe');
    expect(info.username).toBe('mybot');
  });
});
