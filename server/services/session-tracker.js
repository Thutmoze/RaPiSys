/**
 * RaPiSys — session tracker
 * -------------------------
 * Runs every 60 s: diffs the live session snapshot against open rows in
 * session_log, opening rows for new sessions and closing rows for ended
 * ones. This is what turns "who is on now" into login history and
 * duration analytics — even when no browser is open.
 */

export function createSessionTracker({ sessions, sessionsRepo, eventsRepo }) {
  async function trackOnce(now = Date.now()) {
    const snap = await sessions.snapshot();
    const live = [...snap.ssh, ...(snap.console || []), ...snap.vnc];
    // Tailscale peers count as "sessions" only while online.
    for (const p of snap.tailscale.peers || []) {
      if (p.online) live.push({ ...p, startedAt: null, meta: { os: p.os } });
    }

    const openRows = sessionsRepo.openRows();
    const openByKey = new Map(openRows.map((r) => {
      let key = null;
      try { key = JSON.parse(r.meta || '{}').key; } catch { /* legacy */ }
      return [key || `${r.kind}:${r.username}:${r.source}`, r];
    }));
    const liveKeys = new Set(live.map((s) => s.key));

    // New sessions → open a row.
    for (const s of live) {
      if (openByKey.has(s.key)) {
        sessionsRepo.touch(openByKey.get(s.key).id, now);
        continue;
      }
      sessionsRepo.open(s.kind, s.key, s.username, s.source, s.startedAt || now, s.meta || {});
      eventsRepo.add('session.start', 'info', { kind: s.kind, username: s.username, source: s.source });
    }
    // Ended sessions → close the row.
    for (const [key, row] of openByKey) {
      if (!liveKeys.has(key)) {
        sessionsRepo.close(row.id, now);
        eventsRepo.add('session.end', 'info', {
          kind: row.kind, username: row.username, source: row.source,
          durationMs: now - row.started_at,
        });
      }
    }
    return snap;
  }
  return { trackOnce };
}
