/**
 * RaPiSys — daily reports are filed under the LOCAL date they cover.
 * Run under TZ=Africa/Cairo too: east of UTC, local midnight is the previous
 * UTC date, which used to file every day one date early.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { openDatabase } = await import('../server/core/db.js');
const { createMetricsRepo } = await import('../server/repositories/metrics.js');
const { createReportsRepo } = await import('../server/repositories/reports.js');
const { createReports } = await import('../server/services/reports.js');

const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapisys-rep-'));
  const { db } = openDatabase({ dbPath: path.join(dir, 't.db'), fallbackPath: path.join(dir, 'f.db') });
  const metricsRepo = createMetricsRepo(db);
  const reportsRepo = createReportsRepo(db);
  const reports = createReports({ metricsRepo, eventsRepo: { countByTypeBetween: () => ({}) }, reportsRepo });
  return { metricsRepo, reportsRepo, reports };
}

describe('daily report keys', () => {
  it('files today under today\'s local date, marked partial', () => {
    const { reports } = fixture();
    const s = reports.materializeDay(Date.now());
    expect(s.day).toBe(localYmd(new Date()));
    expect(s.partial).toBe(true);
  });

  it('files yesterday under yesterday\'s local date, complete', () => {
    const { reports } = fixture();
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
    const s = reports.materializeDay(y.getTime());
    expect(s.day).toBe(localYmd(y));
    expect(s.partial).toBe(false);
  });

  it('summarises the whole day, not its first hours', () => {
    const { metricsRepo, reports } = fixture();
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(0, 0, 0, 0);
    const start = y.getTime();
    // Raw samples all day (as on a fresh install): cool until 20:00, hot after.
    for (let t = start; t < start + 86400e3; t += 10e3) {
      const hot = t >= start + 20 * 3600e3;
      metricsRepo.writeBatch(t, [{ metric: 'temp.cpu', value: hot ? 80 : 40 }]);
    }
    const s = reports.materializeDay(start + 3600e3);
    expect(s.metrics['temp.cpu'].max).toBe(80);
    expect(s.metrics['temp.cpu'].peakHour).toBeGreaterThanOrEqual(20);
  });

  it('backfill finishes a past day that was last written while partial', () => {
    const { reports, reportsRepo } = fixture();
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
    reportsRepo.upsertDaily(localYmd(y), { day: localYmd(y), partial: true, metrics: {} });
    reports.backfill(2);
    expect(reportsRepo.getDaily(localYmd(y)).partial).toBe(false);
  });
});
