/** RaPiSys — update_history security-tag capture tests. */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createUpdatesRepo } = await import('../server/repositories/updates.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-up-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  return createUpdatesRepo(db);
}

describe('update history security tags', () => {
  it('captures the package security/cve flags from update_sectags at record time', () => {
    const r = repo();
    // a known security package with CVEs
    r.saveSecurityTag('openssl', { candidate: '3.1', security: true, cves: 4, urgency: 'high' });
    r.record({ ts: Date.now(), packageName: 'openssl', fromV: '3.0', toV: '3.1', result: 'success', log: 'Setting up openssl' });
    const [row] = r.recent(10);
    expect(row.package).toBe('openssl');
    expect(row.security).toBe(1);
    expect(row.cves).toBe(4);
  });

  it('flags kernel packages by name even without a security tag', () => {
    const r = repo();
    r.record({ ts: Date.now(), packageName: 'linux-image-6.6', fromV: '6.5', toV: '6.6', result: 'success', log: '' });
    const [row] = r.recent(10);
    expect(row.kernel).toBe(1);
    expect(row.security).toBeNull();   // no sectag → null, not a false 0-vs-1 guess
  });

  it('records null tags for an unknown, non-kernel package', () => {
    const r = repo();
    r.record({ ts: Date.now(), packageName: 'nano', fromV: '7', toV: '8', result: 'success', log: '' });
    const [row] = r.recent(10);
    expect(row.security).toBeNull();
    expect(row.cves).toBeNull();
    expect(row.kernel).toBe(0);
  });
});
