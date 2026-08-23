/** RaPiSys — node identity + notification labelling tests. */
import { describe, it, expect } from 'vitest';
import os from 'os';

const {
  normalizeNodeLabel, resolveNodeName, emailSubject, telegramPrefix, hostName,
} = await import('../server/core/node-identity.js');

describe('node identity', () => {
  it('prefers an operator label over the hostname', () => {
    expect(resolveNodeName({ rapisys: { nodeLabel: 'Living room Pi' } })).toBe('Living room Pi');
  });

  it('falls back to the hostname when no label is set', () => {
    expect(resolveNodeName({ rapisys: {} })).toBe(os.hostname());
    expect(resolveNodeName(null)).toBe(os.hostname());
  });

  it('treats a blank or whitespace label as not set', () => {
    expect(resolveNodeName({ rapisys: { nodeLabel: '   ' } })).toBe(hostName());
    expect(normalizeNodeLabel('  ')).toBe('');
  });

  it('strips control characters so a label cannot break the message layout', () => {
    // A newline here would split the Telegram prefix into a stray second line
    // and mangle the subject header.
    expect(normalizeNodeLabel('XR\nPi')).toBe('XR Pi');
    expect(normalizeNodeLabel('a'.repeat(80))).toHaveLength(40);
  });

  it('composes the email subject with brand and node, once', () => {
    expect(emailSubject('XRPi', '[CRITICAL] High CPU temperature'))
      .toBe('RaPiSys · XRPi — [CRITICAL] High CPU temperature');
  });

  it('puts the node on its own bold first line for Telegram', () => {
    expect(telegramPrefix('XRPi', '🔴 <b>alert</b>')).toBe('<b>XRPi</b>\n🔴 <b>alert</b>');
  });

  it('escapes a label containing HTML before it reaches Telegram parse_mode', () => {
    expect(telegramPrefix('<b>x</b>', 'body')).toBe('<b>&lt;b&gt;x&lt;/b&gt;</b>\nbody');
  });
});
