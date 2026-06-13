/**
 * RaPiSys — user session collector (SSH / VNC / Tailscale)
 * --------------------------------------------------------
 * Sources, all readable from the unprivileged container:
 *  - SSH:    /host/root/run/utmp (binary utmp records: user, tty, host,
 *            login time) + `ss -tn` on :22 for live source endpoints
 *            + idle time from the pts device mtime
 *  - VNC:    RealVNC / wayvnc process detection via /host/proc/<pid>/comm
 *            + established connections on :5900-5910
 *  - Tailscale: `tailscale status --json` via the host agent (the binary
 *            lives on the host); feature self-hides when not installed
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { agentCall, agentConfigured } from '../core/agent-client.js';

const execFileAsync = promisify(execFile);
const HOST_ROOT = fs.existsSync('/host/root') ? '/host/root' : '';
const HOST_PROC = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';

// ---------------------------------------------------------------------------
// utmp parsing (glibc x86_64/aarch64 layout: 384-byte records)
// ---------------------------------------------------------------------------
const UTMP_RECORD = 384;
const USER_PROCESS = 7;

function readCStr(buf, off, len) {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf-8');
}

export function parseUtmp(buf) {
  const sessions = [];
  for (let off = 0; off + UTMP_RECORD <= buf.length; off += UTMP_RECORD) {
    const type = buf.readInt16LE(off);
    if (type !== USER_PROCESS) continue;
    sessions.push({
      pid: buf.readInt32LE(off + 4),
      tty: readCStr(buf, off + 8, 32),
      user: readCStr(buf, off + 44, 32),
      host: readCStr(buf, off + 76, 256),
      loginAt: buf.readInt32LE(off + 340) * 1000,
    });
  }
  return sessions;
}

async function ssEstablished(portExpr) {
  try {
    const { stdout } = await execFileAsync('ss',
      ['-tn', 'state', 'established', `( sport = ${portExpr} )`], { timeout: 4000 });
    return stdout.split('\n').slice(1).map((l) => {
      const cols = l.trim().split(/\s+/);
      // Recv-Q Send-Q Local:Port Peer:Port
      const peer = cols[cols.length - 1] || '';
      const m = peer.match(/^(\[?[0-9a-fA-F:.]+\]?):(\d+)$/);
      return m ? { peerIp: m[1].replace(/^\[|\]$/g, ''), peerPort: Number(m[2]) } : null;
    }).filter(Boolean);
  } catch { return []; }
}

function idleMsOf(tty) {
  try {
    const st = fs.statSync(path.join(HOST_ROOT || '', '/dev', tty));
    return Math.max(0, Date.now() - st.mtimeMs);
  } catch { return null; }
}

// Fallback idle for SSH sessions that registered no tty with logind:
// read the leader process's controlling terminal from /proc/<pid>/stat.
function idleMsOfPid(pid) {
  try {
    const stat = fs.readFileSync(path.join(HOST_PROC, String(pid), 'stat'), 'utf-8');
    const ttyNr = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[4]);
    if (!ttyNr) return null;
    const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
    return idleMsOf(`pts/${minor}`);
  } catch { return null; }
}

// ---------------------------------------------------------------------------

export function createSessionsCollector() {

  async function ssh() {
    const conns = await ssEstablished(':22');

    // Primary source: systemd-logind via the host agent. Debian 13 (Trixie)
    // removed utmp entirely, so `who`-style parsing returns nothing there.
    if (agentConfigured()) {
      try {
        const { sessions } = await agentCall('sessions.list', {}, null, 8000);
        return sessions
          .filter((s) => s.type === 'tty' || s.remote)
          .map((s) => ({
            // Local logins (seat/tty without a remote host) are the physical
            // console, not SSH — label them so the UI can separate them.
            kind: s.remote ? 'ssh' : 'console',
            key: `${s.remote ? 'ssh' : 'console'}:${s.user}:${s.tty || s.id}`,
            username: s.user,
            source: s.remote ? (s.host || conns[0]?.peerIp || '') : 'local console',
            startedAt: s.startedAt,
            // idle from the pts/tty; for SSH sessions with no tty registered,
            // fall back to the leader process's controlling terminal.
            idleMs: s.tty ? idleMsOf(s.tty) : (s.pid ? idleMsOfPid(s.pid) : null),
            meta: { tty: s.tty, pid: s.pid, sessionId: s.id },
          }));
      } catch { /* fall back to utmp below */ }
    }

    // Fallback: classic utmp (Bookworm and older).
    let utmpSessions = [];
    for (const p of [`${HOST_ROOT}/run/utmp`, `${HOST_ROOT}/var/run/utmp`, '/run/utmp']) {
      try { utmpSessions = parseUtmp(fs.readFileSync(p)); break; } catch { /* next */ }
    }
    return utmpSessions
      .filter((s) => s.tty.startsWith('pts/') || s.tty.startsWith('tty'))
      .map((s) => ({
        kind: 'ssh',
        key: `ssh:${s.user}:${s.tty}`,
        username: s.user,
        source: s.host || conns[0]?.peerIp || 'local',
        startedAt: s.loginAt,
        idleMs: idleMsOf(s.tty),
        meta: { tty: s.tty, pid: s.pid },
      }));
  }

  async function vnc() {
    // Detect VNC server processes on the host.
    const VNC_NAMES = new Set(['vncserver-x11-core', 'vncserver-x11', 'wayvnc', 'Xvnc']);
    let serverRunning = null;
    try {
      for (const pid of fs.readdirSync(HOST_PROC)) {
        if (!/^\d+$/.test(pid)) continue;
        let comm = '';
        try { comm = fs.readFileSync(path.join(HOST_PROC, pid, 'comm'), 'utf-8').trim(); } catch { continue; }
        if (VNC_NAMES.has(comm)) { serverRunning = comm; break; }
      }
    } catch { /* proc unreadable */ }
    if (!serverRunning) return [];
    const conns = await ssEstablished(':5900-5910');
    return conns.map((c) => ({
      kind: 'vnc',
      key: `vnc:${c.peerIp}:${c.peerPort}`,
      username: serverRunning,
      source: c.peerIp,
      startedAt: null,                 // kernel doesn't expose connect time; tracker fills first-seen
      idleMs: null,
      meta: { server: serverRunning, peerPort: c.peerPort },
    }));
  }

  async function tailscale() {
    if (!agentConfigured()) return { installed: false, peers: [] };
    try {
      const { output } = await agentCall('ts.status', {}, null, 6000);
      const st = JSON.parse(output);
      const peers = Object.values(st.Peer || {}).map((p) => ({
        kind: 'tailscale',
        key: `ts:${p.ID}`,
        // Some clients (iOS) report HostName "localhost" — prefer the
        // tailnet DNS name's first label in that case.
        username: (p.HostName && p.HostName !== 'localhost')
          ? p.HostName : ((p.DNSName || '').split('.')[0] || p.HostName || 'peer'),
        source: (p.TailscaleIPs || [])[0] || '',
        online: !!p.Online,
        lastActive: p.LastSeen && p.LastSeen !== '0001-01-01T00:00:00Z' ? Date.parse(p.LastSeen) : null,
        os: p.OS || '',
        exitNode: !!p.ExitNode,
      }));
      return { installed: true, self: st.Self?.HostName || null, peers };
    } catch {
      return { installed: false, peers: [] };
    }
  }

  /** Full snapshot: active SSH + VNC sessions and the Tailscale peer table. */
  async function snapshot() {
    const [allLocal, vncSessions, ts] = await Promise.all([ssh(), vnc(), tailscale()]);
    // ssh() returns both remote (ssh) and physical (console) logins.
    const sshSessions = allLocal.filter((s) => s.kind === 'ssh');
    const consoleSessions = allLocal.filter((s) => s.kind === 'console');
    return { ssh: sshSessions, console: consoleSessions, vnc: vncSessions, tailscale: ts, ts: Date.now() };
  }

  return { snapshot };
}
