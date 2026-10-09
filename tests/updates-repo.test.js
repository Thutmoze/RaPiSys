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
    const [row] = r.recent(10).rows;
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
    const [row] = r.recent(10).rows;
    expect(row.kernel).toBe(1);
    expect(row.security).toBeNull();   // no sectag → null, not a false 0-vs-1 guess
  });

  it('gives Raspberry Pi firmware both the firmware and the raspberry pi tag', () => {
    const r = repo();
    r.record({ ts: 1, packageName: 'rpi-eeprom', fromV: '28.32-1', toV: '28.33-1', result: 'success', log: '', description: 'Raspberry Pi 4/5 boot EEPROM updater' });
    r.record({ ts: 2, packageName: 'firmware-brcm80211', fromV: '1', toV: '2', result: 'success', log: '', description: 'Binary firmware for Broadcom wireless cards (Raspberry Pi)' });
    const rows = Object.fromEntries(r.recent(10).rows.map((x) => [x.package, x]));
    expect(rows['rpi-eeprom']).toMatchObject({ firmware: 1, rpi: 1 });
    expect(rows['firmware-brcm80211']).toMatchObject({ firmware: 1, rpi: 0 });
  });

  it('tags Raspberry Pi kernels kernel + raspberry pi, and a Debian kernel kernel-only', () => {
    const r = repo();
    r.record({ ts: 1, packageName: 'linux-image-rpi-2712', fromV: '1:6.18.39-1+rpt1', toV: '1:6.18.50-1+rpt1', result: 'success', log: '' });
    r.record({ ts: 2, packageName: 'linux-kbuild-6.18.50+rpt', fromV: '', toV: '1:6.18.50-1+rpt1', result: 'success', log: '' });
    r.record({ ts: 3, packageName: 'linux-image-arm64', fromV: '6.12.1', toV: '6.12.2', result: 'success', log: '' });
    const rows = Object.fromEntries(r.recent(10).rows.map((x) => [x.package, x]));
    expect(rows['linux-image-rpi-2712']).toMatchObject({ kernel: 1, rpi: 1 });
    expect(rows['linux-kbuild-6.18.50+rpt']).toMatchObject({ kernel: 1, rpi: 1 });
    expect(rows['linux-image-arm64']).toMatchObject({ kernel: 1, rpi: 0 });
  });

  it('re-derives kernel and raspberry pi flags on rows stored under older rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-up-'));
    const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const r = createUpdatesRepo(db);
    r.record({ ts: 1, packageName: 'linux-image-rpi-2712', fromV: '1', toV: '2', result: 'success', log: '' });
    r.record({ ts: 2, packageName: 'linux-kbuild-6.18.50+rpt', fromV: '1', toV: '2', result: 'success', log: '' });
    r.record({ ts: 3, packageName: 'kernelshark', fromV: '1', toV: '2', result: 'success', log: '' });
    // As the old rules stored them: kernels never tagged Pi, kbuild not a kernel, "kernel" in a name was.
    db.prepare(`UPDATE update_history SET kernel = 1, rpi = 0 WHERE package = 'linux-image-rpi-2712'`).run();
    db.prepare(`UPDATE update_history SET kernel = 0, rpi = 0 WHERE package = 'linux-kbuild-6.18.50+rpt'`).run();
    db.prepare(`UPDATE update_history SET kernel = 1, rpi = 0 WHERE package = 'kernelshark'`).run();
    createUpdatesRepo(db);                                                                // next start
    const rows = Object.fromEntries(r.recent(10).rows.map((x) => [x.package, x]));
    expect(rows['linux-image-rpi-2712']).toMatchObject({ kernel: 1, rpi: 1 });
    expect(rows['linux-kbuild-6.18.50+rpt']).toMatchObject({ kernel: 1, rpi: 1 });
    expect(rows.kernelshark).toMatchObject({ kernel: 0, rpi: 0 });
  });

  it('tags by the recorded origin, like Available Updates', () => {
    const r = repo();
    const pi = 'archive.raspberrypi.com';
    r.record({ ts: 1, packageName: 'linux-libc-dev', fromV: '1:6.18.39-1+rpt1', toV: '1:6.18.50-1+rpt1', result: 'success', log: '', origin: pi });
    r.record({ ts: 2, packageName: 'libpisp1', fromV: '1.6.0-1', toV: '1.7.0-1', result: 'success', log: '', origin: pi });
    r.record({ ts: 3, packageName: 'firefox', fromV: '152.0-1+rpt1', toV: '153.0.4-1+rpt1', result: 'success', log: '', origin: pi });
    r.record({ ts: 4, packageName: 'poppler-utils', fromV: '25.03.0-5', toV: '25.03.0-5+deb13u4', result: 'success', log: '', origin: 'deb.debian.org' });
    const rows = Object.fromEntries(r.recent(10).rows.map((x) => [x.package, x]));
    expect(rows['linux-libc-dev']).toMatchObject({ kernel: 1, rpi: 1, origin: pi });   // kernel from the Pi archive
    expect(rows.libpisp1).toMatchObject({ rpi: 1 });                                     // Pi's own, no name hint
    expect(rows.firefox).toMatchObject({ rpi: 0 });                                      // +rpt1 rebuild of Debian's
    expect(rows['poppler-utils']).toMatchObject({ rpi: 0, origin: 'deb.debian.org' });
  });

  it('keeps origin-based tags when a later start re-derives the flags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-up-'));
    const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const r = createUpdatesRepo(db);
    r.record({ ts: 1, packageName: 'linux-libc-dev', fromV: '1', toV: '1:6.18.50-1+rpt1', result: 'success', log: '', origin: 'archive.raspberrypi.com' });
    r.record({ ts: 2, packageName: 'linux-libc-dev', fromV: '1', toV: '2', result: 'success', log: '' });   // older row, no origin
    createUpdatesRepo(db);
    const rows = r.recent(10).rows;
    expect(rows.find((x) => x.origin)).toMatchObject({ kernel: 1, rpi: 1 });
    expect(rows.find((x) => !x.origin)).toMatchObject({ kernel: 1, rpi: 0 });   // unknown origin: name only
  });

  it('fixes rpi-eeprom history rows recorded under the old rule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-up-'));
    const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
    const r = createUpdatesRepo(db);
    r.record({ ts: 1, packageName: 'rpi-eeprom', fromV: '1', toV: '2', result: 'success', log: '', description: 'Raspberry Pi 4/5 boot EEPROM updater' });
    db.prepare(`UPDATE update_history SET rpi = 0 WHERE package = 'rpi-eeprom'`).run();   // as the old rule stored it
    createUpdatesRepo(db);                                                                // next start
    expect(r.recent(10).rows[0]).toMatchObject({ package: 'rpi-eeprom', firmware: 1, rpi: 1 });
  });

  it('records null tags for an unknown, non-kernel package', () => {
    const r = repo();
    r.record({ ts: Date.now(), packageName: 'nano', fromV: '7', toV: '8', result: 'success', log: '' });
    const [row] = r.recent(10).rows;
    expect(row.security).toBeNull();
    expect(row.cves).toBeNull();
    expect(row.kernel).toBe(0);
  });

  it('backfills tags at read time for rows recorded before the tag existed', () => {
    const r = repo();
    // simulate an old row: recorded with no known tag (security/cves NULL)
    r.record({ ts: Date.now(), packageName: 'firefox', fromV: '151', toV: '152', result: 'success', log: '' });
    let [row] = r.recent(10).rows;
    expect(row.security).toBeNull();          // nothing known yet
    // the tag is learned later (e.g. a changelog scan)
    r.saveSecurityTag('firefox', { candidate: '152', security: true, cves: 39, urgency: 'high' });
    [row] = r.recent(10).rows;
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

  it('paginates with offset/limit and reports a total independent of the page size', () => {
    const r = repo();
    for (let i = 0; i < 5; i++) {
      r.record({ ts: 1000 + i, packageName: `pkg-${i}`, fromV: '1', toV: '2', result: 'success', log: '' });
    }
    const page1 = r.recent({ limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.rows.length).toBe(2);
    expect(page1.rows[0].package).toBe('pkg-4');   // newest first (ORDER BY ts DESC)
    const page2 = r.recent({ limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.rows.map((x) => x.package)).toEqual(['pkg-2', 'pkg-1']);
    const page3 = r.recent({ limit: 2, offset: 4 });
    expect(page3.rows.map((x) => x.package)).toEqual(['pkg-0']);   // last partial page
  });
});
