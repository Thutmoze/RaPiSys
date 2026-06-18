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
    r.record({ ts: Date.now(), packageName: 'openssl', fromV: '3.0', toV: '3.1', result: 'success', log: 'Setting up openssl', description: 'Secure Sockets Layer toolkit' });
    const [row] = r.recent(10);
    expect(row.package).toBe('openssl');
    expect(row.security).toBe(1);
    expect(row.cves).toBe(4);
    expect(row.fromV).toBe('3.0');
    expect(row.toV).toBe('3.1');
    expect(row.description).toBe('Secure Sockets Layer toolkit');
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

  it('backfills tags at read time for rows recorded before the tag existed', () => {
    const r = repo();
    // simulate an old row: recorded with no known tag (security/cves NULL)
    r.record({ ts: Date.now(), packageName: 'firefox', fromV: '151', toV: '152', result: 'success', log: '' });
    let [row] = r.recent(10);
    expect(row.security).toBeNull();          // nothing known yet
    // the tag is learned later (e.g. a changelog scan)
    r.saveSecurityTag('firefox', { candidate: '152', security: true, cves: 39, urgency: 'high' });
    [row] = r.recent(10);
    expect(row.security).toBe(1);             // now surfaced on the old row
    expect(row.cves).toBe(39);
  });

  it('marks and reports packages with no obtainable changelog', () => {
    const r = repo();
    expect(r.getChangelog('linux-headers-rpi-2712', '1:6.18.34')).toBeNull();   // never fetched
    r.markNoChangelog('linux-headers-rpi-2712', '1:6.18.34');
    const got = r.getChangelog('linux-headers-rpi-2712', '1:6.18.34');
    expect(got).not.toBeNull();
    expect(got.none).toBe(true);             // sentinel, so callers don't re-download
    expect(got.changelog).toBe('');
  });

  it('a real changelog still reads back normally after a none-marker exists for another pkg', () => {
    const r = repo();
    r.markNoChangelog('linux-headers-rpi-2712', '1:6.18.34');
    r.saveChangelog('nano', '8.0', 'nano (8.0) bookworm; urgency=low');
    const got = r.getChangelog('nano', '8.0');
    expect(got.none).toBeUndefined();
    expect(got.changelog).toMatch(/nano/);
  });
});
