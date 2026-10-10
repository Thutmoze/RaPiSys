/**
 * RaPiSys — host agent request dispatch: authentication, the op allowlist,
 * and parameter validation of root-privileged ops.
 *
 * Every invalid case here is rejected by the op's first checks, before it
 * runs anything on the host (no apt, systemctl, mount or openssl call).
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const SECRET = 'test-secret-not-used-for-any-real-hmac';
process.env.AGENT_SECRET = SECRET;
const { dispatch, verify, underMountBase, UNIT_NAME_RE, TLS_DIR, onConnection, MAX_REQUEST_BYTES } = require('../agent/rapisys-agent.cjs');

let n = 0;
function signed(op, params = {}, { ts = Date.now(), secret = SECRET } = {}) {
  const id = `t${++n}`;
  const hmac = crypto.createHmac('sha256', secret).update(`${id}.${op}.${JSON.stringify(params)}.${ts}`).digest('hex');
  return { id, op, params, ts, hmac };
}
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
};

describe('agent authentication', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(verify(signed('ping'))).toBe(true);
  });
  it('refuses a wrong signature, a stale timestamp, and a tampered parameter', async () => {
    quiet();
    expect((await dispatch(signed('ping', {}, { secret: 'other' }))).error).toBe('authentication failed');
    expect((await dispatch(signed('ping', {}, { ts: Date.now() - 60e3 }))).error).toBe('authentication failed');
    const req = signed('nas.status', { mountpoint: '/mnt/rapisys/a' });
    req.params.mountpoint = '/mnt/rapisys/b';
    expect((await dispatch(req)).error).toBe('authentication failed');
    expect((await dispatch(null)).ok).toBe(false);
  });
});

describe('agent op allowlist', () => {
  it('refuses unknown ops and inherited object keys', async () => {
    quiet();
    for (const op of ['shell.exec', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const out = await dispatch(signed(op));
      expect([op, out.ok, out.error]).toEqual([op, false, `operation not allowed: ${op}`]);
    }
  });
});

describe('agent parameter validation', () => {
  // [op, params, expected error] — each rejected before touching the host.
  const CASES = [
    ['nas.status', { mountpoint: '/mnt/rapisys/../../etc' }, /mountpoint must be under/],
    ['nas.status', { mountpoint: '/etc' }, /mountpoint must be under/],
    ['nas.holders', { mountpoint: '/mnt/rapisysX' }, /mountpoint must be under/],
    ['pihole.backupToNas', { mountpoint: '/mnt/rapisys/../../root' }, /mountpoint must be under/],
    ['pihole.backupStatus', { mountpoint: '/mnt/rapisys/x/../../../etc' }, /mountpoint must be under/],
    ['inventory.serviceControl', { name: '-Hroot@evil', action: 'stop' }, /invalid service/],
    ['inventory.serviceControl', { name: 'ssh', action: 'mask' }, /invalid action/],
    ['inventory.serviceDetail', { name: '--version' }, /invalid service name/],
    ['inventory.install', { name: '-oAPT::Update::Pre-Invoke::=x' }, /invalid package name/],
    ['inventory.remove', { name: 'curl', confirm: 'wget' }, /confirmation mismatch/],
    ['docker.removeContainer', { name: '--force' }, /invalid container name/],
    ['remote.installSshKey', { username: 'Bad User', pubkey: 'ssh-ed25519 AAAA' }, /invalid username/],
    ['remote.installSshKey', { username: 'root', pubkey: 'ssh-ed25519 AAAA' }, /does not log in as root/],
    ['remote.installSshKey', { username: 'pi', pubkey: 'ssh-ed25519 AAAA\nssh-rsa EVIL' }, /malformed public key/],
    ['nas.mount', { label: '../x', proto: 'cifs', host: 'nas', share: 's', mountpoint: '/mnt/rapisys/x' }, /invalid label/],
    ['disk.clean', { categories: [] }, /no categories selected/],
    ['tls.selfSigned', { dir: '/etc/ssl' }, /certificates are only written to/],
    ['tls.tailscaleCert', { dir: '/root/.ssh' }, /certificates are only written to/],
  ];
  for (const [op, params, err] of CASES) {
    it(`${op} refuses ${JSON.stringify(params).slice(0, 60)}`, async () => {
      quiet();
      const out = await dispatch(signed(op, params));
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(err);
    });
  }

  it('mountpoint and unit-name rules accept the normal forms', () => {
    expect(underMountBase('/mnt/rapisys/mybook')).toBe(true);
    expect(underMountBase('/mnt/rapisys//mybook')).toBe(false);   // not normalized
    expect(underMountBase('/mnt/rapisys')).toBe(false);
    expect(underMountBase(undefined)).toBe(false);
    for (const u of ['ssh', 'docker', 'getty@tty1', 'systemd-resolved', 'mnt-rapisys-my\\x2dbook']) expect(UNIT_NAME_RE.test(u)).toBe(true);
    for (const u of ['-H', '--now', '.hidden', '']) expect(UNIT_NAME_RE.test(u)).toBe(false);
    expect(TLS_DIR).toBe('/var/lib/rapisys/tls');
  });
});

describe('agent without a secret', () => {
  it('refuses to start, so nothing can be signed with an empty key', async () => {
    const { spawnSync } = await import('child_process');
    const agentPath = new URL('../agent/rapisys-agent.cjs', import.meta.url).pathname;
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(agentPath)})`], {
      env: { ...process.env, AGENT_SECRET: '' }, encoding: 'utf-8', timeout: 20000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/AGENT_SECRET missing/);
  });
});

describe('agent socket', () => {
  it('drops a connection that sends more than the request limit without a newline', async () => {
    const net = await import('net');
    const server = net.createServer(onConnection);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(server.address().port, '127.0.0.1');
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('end', () => resolve(got));
      c.on('error', reject);
      c.write('x'.repeat(MAX_REQUEST_BYTES + 10));
    });
    server.close();
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'request too large' });
  });
});
