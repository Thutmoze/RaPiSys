/** RaPiSys — host agent out-of-date detection (/api/health/agent banner). */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { AGENT_SHA256 } = require('../agent/rapisys-agent.cjs');
const { agentSyncState, expectedAgentSha } = await import('../server/core/agent-client.js');

const fileSha = crypto.createHash('sha256').update(fs.readFileSync(new URL('../agent/rapisys-agent.cjs', import.meta.url))).digest('hex');

describe('agent code hash', () => {
  it('the agent reports the hash of the file it started from', () => {
    expect(AGENT_SHA256).toBe(fileSha);
  });
  it('the dashboard expects the hash of the agent it ships', () => {
    expect(expectedAgentSha()).toBe(fileSha);
  });
});

describe('agentSyncState', () => {
  const expected = 'a'.repeat(64);
  it('is ok when the running agent matches', () => {
    expect(agentSyncState({ configured: true, ping: { sha256: expected }, expected })).toBe('ok');
  });
  it('is stale when the agent runs other code', () => {
    expect(agentSyncState({ configured: true, ping: { sha256: 'b'.repeat(64) }, expected })).toBe('stale');
  });
  it('is stale for an agent too old to report a hash', () => {
    expect(agentSyncState({ configured: true, ping: { pong: true, version: '1.0.0' }, expected })).toBe('stale');
  });
  it('is down when the agent does not answer', () => {
    expect(agentSyncState({ configured: true, ping: null, expected })).toBe('down');
  });
  it('is absent without an agent (manual install, by design: no banner)', () => {
    expect(agentSyncState({ configured: false, ping: null, expected })).toBe('absent');
  });
  it('is unknown without a reference hash (no banner rather than a false alarm)', () => {
    expect(agentSyncState({ configured: true, ping: { sha256: expected }, expected: null })).toBe('unknown');
  });
});
