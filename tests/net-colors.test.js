/**
 * RaPiSys — Network page interface colours: automatic assignment (no repeats
 * among visible interfaces, stable order) and the per-node saved choices.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { autoNetColors, NET_PALETTE } from '../src/modules/net-colors.js';
import { networkRouter } from '../server/routes/network.js';

// XRPi on 2026-11-21: 4 visible interfaces + 5 bridges (9 > the old 8 colours).
const XRPI = [
  { name: 'eth0', kind: 'wired' }, { name: 'mirror0', kind: 'other' },
  { name: 'wlan0', kind: 'wifi' }, { name: 'tailscale0', kind: 'vpn' },
  { name: 'br-1a', kind: 'bridge' }, { name: 'br-2b', kind: 'bridge' }, { name: 'br-3c', kind: 'bridge' },
  { name: 'docker0', kind: 'bridge' }, { name: 'virbr0', kind: 'bridge' },
];

describe('autoNetColors', () => {
  it('gives visible interfaces distinct colours, in name order, before bridges', () => {
    const c = autoNetColors(XRPI);
    expect(c.eth0).toBe(NET_PALETTE[0]);
    expect(c.mirror0).toBe(NET_PALETTE[1]);
    expect(c.tailscale0).toBe(NET_PALETTE[2]);
    expect(c.wlan0).toBe(NET_PALETTE[3]);
    expect(c['br-1a']).toBe(NET_PALETTE[4]);
    expect(new Set(Object.values(c)).size).toBe(XRPI.length);
  });

  it('does not depend on the order interfaces arrive in (traffic sort)', () => {
    expect(autoNetColors([...XRPI].reverse())).toEqual(autoNetColors(XRPI));
  });

  it('leaves out interfaces with a custom colour and skips colours already picked', () => {
    const c = autoNetColors(XRPI, { wlan0: NET_PALETTE[0] });
    expect(c.wlan0).toBeUndefined();
    expect(c.eth0).toBe(NET_PALETTE[1]);
    expect(Object.values(c)).not.toContain(NET_PALETTE[0]);
  });

  it('wraps around once the palette is exhausted', () => {
    const many = Array.from({ length: NET_PALETTE.length + 2 }, (_, i) => ({ name: `if${String(i).padStart(2, '0')}`, kind: 'other' }));
    const c = autoNetColors(many);
    expect(c[`if${NET_PALETTE.length}`]).toBe(NET_PALETTE[0]);
  });
});

describe('/api/network/iface-colors', () => {
  function app({ control = true } = {}) {
    let settings = { rapisys: { pihole: { enabled: true } } };
    const deps = {
      network: {}, metricsRepo: {}, secrets: {}, refreshPiholeConfig: async () => {},
      requireControl: (q, s, n) => (control ? n() : s.status(403).json({ error: 'forbidden' })),
      loadSettings: async () => structuredClone(settings),
      saveSettings: async (s) => { settings = structuredClone(s); },
      withFileLock: (fn) => fn(),
    };
    const a = express();
    a.use(express.json());
    a.use('/api/network', networkRouter(deps));
    return { a, get: () => settings };
  }

  it('starts empty, saves a colour, and keeps other settings', async () => {
    const { a, get } = app();
    expect((await request(a).get('/api/network/iface-colors')).body).toEqual({ colors: {} });
    const r = await request(a).put('/api/network/iface-colors').send({ iface: 'mirror0', color: '#F97316' });
    expect(r.status).toBe(200);
    expect(r.body.colors).toEqual({ mirror0: '#f97316' });
    expect(get().rapisys.network.ifaceColors).toEqual({ mirror0: '#f97316' });
    expect(get().rapisys.pihole).toEqual({ enabled: true });
    expect((await request(a).get('/api/network/iface-colors')).body.colors).toEqual({ mirror0: '#f97316' });
  });

  it('clears a colour with color: null', async () => {
    const { a, get } = app();
    await request(a).put('/api/network/iface-colors').send({ iface: 'eth0', color: '#10b981' });
    const r = await request(a).put('/api/network/iface-colors').send({ iface: 'eth0', color: null });
    expect(r.body.colors).toEqual({});
    expect(get().rapisys.network.ifaceColors).toEqual({});
  });

  it('rejects bad names and colours', async () => {
    const { a } = app();
    expect((await request(a).put('/api/network/iface-colors').send({ iface: 'eth0;rm', color: '#000000' })).status).toBe(400);
    expect((await request(a).put('/api/network/iface-colors').send({ iface: 'eth0', color: 'red' })).status).toBe(400);
    expect((await request(a).put('/api/network/iface-colors').send({ iface: 'eth0', color: '#fff' })).status).toBe(400);
  });

  it('requires control to save', async () => {
    const { a } = app({ control: false });
    expect((await request(a).put('/api/network/iface-colors').send({ iface: 'eth0', color: '#000000' })).status).toBe(403);
  });
});
