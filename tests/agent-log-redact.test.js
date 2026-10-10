/** RaPiSys — the host agent never writes op credentials to the journal. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { redactParams } = require('../agent/rapisys-agent.cjs');

describe('agent op log redaction', () => {
  it('replaces credentials and keeps the rest', () => {
    const out = JSON.parse(redactParams({
      label: 'mybook', host: '10.0.0.9', username: 'me', password: 'hunter2',
    }));
    expect(out).toEqual({ label: 'mybook', host: '10.0.0.9', username: 'me', password: '[redacted]' });
  });

  it('covers every secret-bearing op param', () => {
    const line = redactParams({ authKey: 'tskey-auth-abc', webPassword: 'pw', token: 't', apiKey: 'k', clientSecret: 's' });
    for (const v of ['tskey-auth-abc', '"pw"', '"t"', '"k"', '"s"']) expect(line).not.toContain(v);
  });

  it('leaves empty values visible (nothing to hide) and handles no params', () => {
    expect(JSON.parse(redactParams({ authKey: '' }))).toEqual({ authKey: '' });
    expect(redactParams(undefined)).toBe('{}');
  });
});
