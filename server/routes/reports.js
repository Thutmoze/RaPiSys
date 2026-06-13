/** RaPiSys — /api/reports: daily/weekly/monthly views + CSV/JSON export. */

import express from 'express';

export function reportsRouter({ reports, reportsRepo }) {
  const r = express.Router();

  // Daily list (last n days of materialized summaries).
  r.get('/daily', (req, res) => {
    const n = Math.min(Number(req.query.days) || 30, 90);
    res.json({ days: reportsRepo.recentDays(n) });
  });

  // Weekly / monthly aggregation.
  r.get('/weekly', (req, res) => res.json(reports.aggregate('week')));
  r.get('/monthly', (req, res) => res.json(reports.aggregate('month')));

  // Force-(re)build today/yesterday + backfill, for the "refresh" button.
  r.post('/rebuild', (req, res) => {
    reports.materializeDay();          // yesterday
    const filled = reports.backfill(14);
    res.json({ ok: true, rebuilt: filled.length + 1 });
  });

  // Export: JSON or CSV of the daily summaries.
  r.get('/export.:fmt', (req, res) => {
    const fmt = req.params.fmt === 'csv' ? 'csv' : 'json';
    const days = reportsRepo.recentDays(Math.min(Number(req.query.days) || 30, 90));
    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="rapisys-report.json"');
      return res.send(JSON.stringify(days, null, 2));
    }
    // CSV: one row per day per metric (fmt === 'csv')
    const rows = [['day', 'metric', 'min', 'avg', 'max', 'p95', 'peakHour']];
    for (const d of days) {
      for (const [m, s] of Object.entries(d.metrics || {})) {
        rows.push([d.day, m, fix(s.min), fix(s.avg), fix(s.max), fix(s.p95), s.peakHour ?? '']);
      }
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rapisys-report.csv"');
    res.send(rows.map((r) => r.join(',')).join('\n'));
  });

  return r;
}

const fix = (v) => (v == null ? '' : Math.round(v * 100) / 100);
