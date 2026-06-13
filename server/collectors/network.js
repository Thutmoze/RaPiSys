/**
 * RaPiSys — network analytics collector
 * -------------------------------------
 * Lightweight, daemon-light approach chosen for the Pi 5:
 *  - live throughput: /proc/net/dev byte-counter deltas (zero deps)
 *  - bandwidth history: vnStat (`vnstat --json`) — ~1MB kernel-counter
 *    daemon, already collecting; gives 5-min/hour/day/month per interface
 *  - protocol distribution: `ss -s` summary + /proc/net/{tcp,udp} state
 *  - top processes by bandwidth: `ss -tunp` socket→process deltas
 *  - DNS: resolver stats via `resolvectl statistics`, or a dnsmasq/Pi-hole
 *    log tail when present (never sniffs port 53)
 */

import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { agentCall, agentConfigured } from '../core/agent-client.js';

const execFileAsync = promisify(execFile);
const HOST_PROC = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';

// Skip virtual/loopback/container interfaces for "real" traffic views.
const SKIP_IF = /^(lo|docker|veth|br-|virbr|wg|tailscale|cni|flannel)/;

function readProcNetDev() {
  const out = {};
  try {
    const lines = fs.readFileSync(`${HOST_PROC}/net/dev`, 'utf-8').split('\n').slice(2);
    for (const line of lines) {
      const [namePart, rest] = line.split(':');
      if (!rest) continue;
      const iface = namePart.trim();
      const cols = rest.trim().split(/\s+/).map(Number);
      // rx bytes [0], rx packets [1]; tx bytes [8], tx packets [9]
      out[iface] = { rxBytes: cols[0], rxPackets: cols[1], txBytes: cols[8], txPackets: cols[9] };
    }
  } catch { /* /proc/net/dev unreadable */ }
  return out;
}

export function createNetworkCollector() {
  let prev = null;
  let prevAt = 0;

  /** Live per-interface throughput (bytes/sec) from counter deltas. */
  function throughput() {
    const now = Date.now();
    const cur = readProcNetDev();
    const dt = prevAt ? (now - prevAt) / 1000 : 0;
    const interfaces = {};
    for (const [iface, c] of Object.entries(cur)) {
      if (SKIP_IF.test(iface)) continue;
      const p = prev?.[iface];
      interfaces[iface] = {
        rxBytes: c.rxBytes, txBytes: c.txBytes,
        rxRate: p && dt > 0 ? Math.max(0, (c.rxBytes - p.rxBytes) / dt) : 0,
        txRate: p && dt > 0 ? Math.max(0, (c.txBytes - p.txBytes) / dt) : 0,
      };
    }
    prev = cur; prevAt = now;
    return { interfaces, ts: now };
  }

  /** vnStat history for an interface (or default). */
  async function vnstat(iface = null) {
    try {
      // vnstat lives on the HOST (not in the container image), so prefer
      // the agent; fall back to a local binary if one is ever present.
      let stdout;
      if (agentConfigured()) {
        const r = await agentCall('vnstat.json', { iface }, null, 9000);
        stdout = r.output;
      } else {
        const args = ['--json'];
        if (iface) args.push('-i', iface);
        ({ stdout } = await execFileAsync('vnstat', args, { timeout: 6000 }));
      }
      const data = JSON.parse(stdout);
      const ifaces = (data.interfaces || []).filter((i) => !SKIP_IF.test(i.name));
      return {
        available: true,
        interfaces: ifaces.map((i) => ({
          name: i.name,
          today: i.traffic?.day?.[i.traffic.day.length - 1] || null,
          hours: (i.traffic?.hour || []).slice(-24),
          days: (i.traffic?.day || []).slice(-30),
          months: (i.traffic?.month || []).slice(-12),
          total: i.traffic?.total || null,
        })),
      };
    } catch {
      return { available: false, interfaces: [] };
    }
  }

  /** Protocol / connection-state distribution from ss. */
  async function protocols() {
    const result = { tcp: 0, udp: 0, states: {}, byPort: {} };
    try {
      const { stdout: summary } = await execFileAsync('ss', ['-s'], { timeout: 4000 });
      const tcpM = summary.match(/TCP:\s+(\d+)/);
      const udpM = summary.match(/UDP:\s+(\d+)/);
      if (tcpM) result.tcp = Number(tcpM[1]);
      if (udpM) result.udp = Number(udpM[1]);
    } catch { /* ss unavailable */ }
    try {
      const { stdout } = await execFileAsync('ss', ['-tan'], { timeout: 4000 });
      for (const line of stdout.split('\n').slice(1)) {
        const state = line.trim().split(/\s+/)[0];
        if (state) result.states[state] = (result.states[state] || 0) + 1;
        // classify by well-known local port
        const m = line.match(/:(\d+)\s+\S+:\*?\d*\s*$/) || line.match(/:(\d+)\s/);
        if (m) {
          const port = Number(m[1]);
          const name = WELL_KNOWN[port];
          if (name) result.byPort[name] = (result.byPort[name] || 0) + 1;
        }
      }
    } catch { /* ss unavailable */ }
    return result;
  }

  /** Top processes by socket count (proxy for activity); rate needs sampling. */
  async function topProcesses() {
    try {
      const { stdout } = await execFileAsync('ss', ['-tunp'], { timeout: 4000 });
      const byProc = {};
      for (const line of stdout.split('\n').slice(1)) {
        const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        if (!m) continue;
        const key = m[1];
        byProc[key] = byProc[key] || { comm: m[1], pid: Number(m[2]), sockets: 0 };
        byProc[key].sockets += 1;
      }
      return Object.values(byProc).sort((a, b) => b.sockets - a.sockets).slice(0, 10);
    } catch { return []; }
  }

  /** DNS resolver stats (systemd-resolved), best-effort. */
  async function dns() {
    try {
      const { stdout } = await execFileAsync('resolvectl', ['statistics'], { timeout: 4000 });
      const get = (re) => { const m = stdout.match(re); return m ? Number(m[1]) : null; };
      return {
        available: true,
        current: get(/Current Transactions:\s+(\d+)/),
        total: get(/Total Transactions:\s+(\d+)/),
        cacheHits: get(/Cache Hits:\s+(\d+)/),
        cacheMisses: get(/Cache Misses:\s+(\d+)/),
      };
    } catch {
      return { available: false };
    }
  }

  async function snapshot() {
    const [vn, proto, procs, dnsStats] = await Promise.all([vnstat(), protocols(), topProcesses(), dns()]);
    return { throughput: throughput(), vnstat: vn, protocols: proto, processes: procs, dns: dnsStats, ts: Date.now() };
  }

  return { throughput, vnstat, protocols, topProcesses, dns, snapshot };
}

const WELL_KNOWN = {
  22: 'SSH', 53: 'DNS', 80: 'HTTP', 443: 'HTTPS', 3001: 'RaPiSys',
  5900: 'VNC', 5901: 'VNC', 51820: 'WireGuard', 8080: 'HTTP-alt',
  3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 1883: 'MQTT',
  445: 'SMB', 139: 'SMB', 2049: 'NFS', 123: 'NTP', 25: 'SMTP', 587: 'SMTP',
};
