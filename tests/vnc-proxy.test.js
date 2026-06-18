/** RaPiSys — VNC proxy byte-reader + downstream handshake tests. */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

const { createReader, vncVencryptProxy } = await import('../server/services/vnc-proxy.js');

describe('vnc-proxy reader', () => {
  it('awaits exactly N bytes across chunk boundaries', async () => {
    const r = createReader();
    const p = r.read(5);
    r.feed(Buffer.from([1, 2]));
    r.feed(Buffer.from([3, 4, 5, 6]));
    const out = await p;
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    // leftover (6) stays buffered for the next read
    const p2 = r.read(1);
    expect([...(await p2)]).toEqual([6]);
  });

  it('resolves immediately when enough is already buffered', async () => {
    const r = createReader();
    r.feed(Buffer.from([9, 8, 7]));
    expect([...(await r.read(2))]).toEqual([9, 8]);
  });

  it('drain returns unconsumed bytes', async () => {
    const r = createReader();
    r.feed(Buffer.from([1, 2, 3, 4]));
    await r.read(1);
    expect([...r.drain()]).toEqual([2, 3, 4]);
  });
});

// Mock WebSocket that records sent frames and lets the test feed messages.
class MockWs extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(b) { this.sent.push(Buffer.from(b)); }
  close() { this.closed = true; this.emit('close'); }
  feed(b) { this.emit('message', Buffer.from(b), true); }
}

describe('vnc-proxy downstream handshake (noVNC side)', () => {
  it('performs the None-auth server handshake with noVNC before dialing upstream', async () => {
    const ws = new MockWs();
    // point at a dead port so the upstream connect fails AFTER the downstream
    // handshake — we only assert the downstream bytes here.
    const errors = [];
    const done = vncVencryptProxy(ws, {
      host: '127.0.0.1', port: 1,   // unlikely to be open
      username: 'pi', password: 'x', debug: false,
      onEvent: (ev, msg) => { if (ev === 'error') errors.push(msg); },
    });

    // 1) bridge should immediately send its ProtocolVersion
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(1));
    expect(ws.sent[0].toString()).toBe('RFB 003.008\n');

    // 2) we (noVNC) reply with our version
    ws.feed(Buffer.from('RFB 003.008\n'));
    // 3) bridge offers security types: [count=1, None=1]
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(2));
    expect([...ws.sent[1]]).toEqual([1, 1]);

    // 4) we select None(1)
    ws.feed(Buffer.from([1]));
    // 5) bridge sends SecurityResult OK (4 zero bytes)
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(3));
    expect([...ws.sent[2]]).toEqual([0, 0, 0, 0]);

    // 6) we send ClientInit (shared flag) → bridge now dials upstream (which
    //    fails on the dead port and closes). The downstream contract held.
    ws.feed(Buffer.from([1]));
    await done.catch(() => {});
    await vi.waitFor(() => expect(ws.closed).toBe(true));
  });
});
