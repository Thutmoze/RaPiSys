/** RaPiSys — TLS service config/persistence tests (no agent needed). */
import { describe, it, expect } from 'vitest';

const { createTlsService } = await import('../server/services/tls.js');

function mk(initial = {}) {
  let settings = initial;
  return createTlsService({
    loadSettings: async () => settings,
    saveSettings: async (s) => { settings = s; },
    withFileLock: async (fn) => fn(),
  });
}

describe('tls service', () => {
  it('returns sane defaults when nothing is configured', async () => {
    const tls = mk({});
    const cfg = await tls.getConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('selfsigned');
    expect(cfg.port).toBe(3443);
  });

  it('persists config patches and merges with defaults', async () => {
    const tls = mk({});
    await tls.setConfig({ enabled: true, mode: 'tailscale', notAfter: 'Jan 1 2027' });
    const cfg = await tls.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe('tailscale');
    expect(cfg.notAfter).toBe('Jan 1 2027');
    expect(cfg.port).toBe(3443); // default preserved
  });

  it('renewIfNeeded does nothing when disabled', async () => {
    const tls = mk({ tls: { enabled: false } });
    const r = await tls.renewIfNeeded(null);
    expect(r.skipped).toBe('disabled');
  });

  it('is not listening before start', () => {
    const tls = mk({});
    expect(tls.isListening()).toBe(false);
  });
});
