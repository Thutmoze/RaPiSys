/** RaPiSys — remote access (SSH/VNC) service tests. */
import { describe, it, expect, vi } from 'vitest';

process.env.SECRET_KEY = process.env.SECRET_KEY || 'a'.repeat(64);

const { createRemoteAccess } = await import('../server/services/remote-access.js');

function fixture() {
  let settings = { rapisys: {} };
  const store = {};
  const secrets = {
    set: (k, v) => { store[k] = v; },
    get: (k) => store[k] || null,
    has: (k) => k in store,
    remove: (k) => { delete store[k]; },
  };
  const ra = createRemoteAccess({
    loadSettings: async () => settings,
    saveSettings: async (s) => { settings = s; },
    withFileLock: async (fn) => fn(),
    secrets,
    auth: { cookieToken: () => 't', validateSession: () => true, getMode: () => 'admin' },
    events: { add: vi.fn() },
  });
  return { ra, secrets, get settings() { return settings; } };
}

describe('remote access', () => {
  it('defaults to fully disabled', async () => {
    const { ra } = fixture();
    const cfg = await ra.getConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.ssh.enabled).toBe(false);
    expect(cfg.vnc.enabled).toBe(false);
    expect(cfg.ssh.port).toBe(22);
    expect(cfg.vnc.port).toBe(5900);
    expect(cfg.sshKeyConfigured).toBe(false);
  });

  it('persists config changes through setConfig', async () => {
    const { ra } = fixture();
    const cfg = await ra.setConfig({ enabled: true, ssh: { enabled: true, username: 'pi', port: 2222 }, vnc: { enabled: true } });
    expect(cfg.enabled).toBe(true);
    expect(cfg.ssh.enabled).toBe(true);
    expect(cfg.ssh.username).toBe('pi');
    expect(cfg.ssh.port).toBe(2222);
    expect(cfg.vnc.enabled).toBe(true);
    expect(cfg.vnc.port).toBe(5900);    // untouched default preserved
  });

  it('generates an OpenSSH-format RSA public key and stores the private key encrypted', async () => {
    const { ra, secrets } = fixture();
    const { publicKey } = await ra.generateKey();
    expect(publicKey).toMatch(/^ssh-rsa AAAAB3NzaC1yc2E/);   // canonical OpenSSH RSA prefix
    expect(secrets.has('remote.ssh.privkey')).toBe(true);
    expect(secrets.get('remote.ssh.privkey')).toMatch(/BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY/);
    const cfg = await ra.getConfig();
    expect(cfg.sshKeyConfigured).toBe(true);
    expect(cfg.sshPublicKey).toBe(publicKey);
  });

  it('the generated key is parseable by ssh2 (valid for real auth)', async () => {
    const { ra, secrets } = fixture();
    await ra.generateKey();
    const ssh2 = (await import('ssh2')).default;
    const parsed = ssh2.utils.parseKey(secrets.get('remote.ssh.privkey'));
    expect(parsed instanceof Error).toBe(false);
    expect(parsed.type).toBe('ssh-rsa');
  });
});
