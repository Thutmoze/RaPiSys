/** RaPiSys — the agent's read-only Docker API socket.
 *
 * The dashboard container no longer mounts /var/run/docker.sock (full Docker
 * control = root on the host). The agent forwards only the GETs the dashboard
 * makes; these tests pin that allowlist.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { dockerReadRoute, redactInspect } = require('../agent/rapisys-agent.cjs');

describe('dockerReadRoute', () => {
  it('allows the container list, with and without stopped containers', () => {
    expect(dockerReadRoute('GET', '/containers/json')).toBe('list');
    expect(dockerReadRoute('GET', '/containers/json?all=1')).toBe('list');
  });

  it('allows inspect by full id or name', () => {
    expect(dockerReadRoute('GET', `/containers/${'a1'.repeat(32)}/json`)).toBe('inspect');
    expect(dockerReadRoute('GET', '/containers/pihole/json')).toBe('inspect');
  });

  it('refuses every write, whatever the path', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
      expect(dockerReadRoute(m, '/containers/json')).toBeNull();
    }
    expect(dockerReadRoute('POST', '/containers/create')).toBeNull();
    expect(dockerReadRoute('POST', '/containers/pihole/stop')).toBeNull();
    expect(dockerReadRoute('DELETE', '/containers/pihole')).toBeNull();
  });

  it('refuses reads outside the allowlist', () => {
    for (const u of [
      '/images/json', '/info', '/version', '/_ping', '/secrets', '/events',
      '/v1.47/containers/json', '/containers/json?all=1&filters={}',
      '/containers/pihole/logs', '/containers/pihole/archive?path=/etc',
      '/containers/pihole/json?size=1', '/containers/../images/json',
      '/containers/%2e%2e/json', '/containers/-x/json', '/containers//json',
    ]) expect(dockerReadRoute('GET', u)).toBeNull();
  });
});

describe('redactInspect', () => {
  it('drops the container environment and keeps what the dashboard reads', () => {
    const out = redactInspect({
      Name: '/pihole', RestartCount: 2,
      State: { Status: 'running', Pid: 42, Health: { Status: 'healthy' } },
      Config: { Image: 'pihole/pihole:latest', Env: ['FTLCONF_webserver_api_password=hunter2'] },
    });
    expect(out.Config.Env).toBeUndefined();
    expect(out.Config.Image).toBe('pihole/pihole:latest');
    expect(out.State.Pid).toBe(42);
    expect(out.RestartCount).toBe(2);
  });

  it('tolerates inspect data without Config', () => {
    expect(redactInspect({ Name: '/x' })).toEqual({ Name: '/x' });
  });
});
