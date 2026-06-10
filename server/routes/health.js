/** RaPiSys — /api/health/deep: dependency-aware health for deploy gates. */

import express from 'express';
import fs from 'fs';
import { agentAvailable } from '../core/agent-client.js';

export function deepHealthRouter({ dbMeta, scheduler, getDb }) {
  const r = express.Router();
  r.get('/', async (req, res) => {
    const checks = {};
    try {
      getDb().prepare('SELECT 1 AS ok').get();
      checks.database = { ok: true, ...dbMeta() };
    } catch (err) {
      checks.database = { ok: false, error: err.message };
    }
    checks.agent = { ok: await agentAvailable() };
    const jobs = scheduler.status();
    checks.scheduler = {
      ok: jobs.every((j) => j.failures < 5),
      jobs,
    };
    try {
      const stat = fs.statfsSync('/app/data');
      checks.disk = { ok: stat.bavail * stat.bsize > 100 * 1024 * 1024,
        freeBytes: stat.bavail * stat.bsize };
    } catch { checks.disk = { ok: true }; }
    const ok = checks.database.ok && checks.scheduler.ok; // agent optional
    res.status(ok ? 200 : 503).json({ ok, checks, ts: Date.now() });
  });
  return r;
}
