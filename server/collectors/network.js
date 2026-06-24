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
import dns from 'dns';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { agentCall, agentConfigured } from '../core/agent-client.js';
import { createPiholeClient } from './pihole.js';

const execFileAsync = promisify(execFile);
const reverse = promisify(dns.reverse);

// Bounded reverse-DNS cache so connection lists show hostnames, not raw IPs.
const rdnsCache = new Map();   // ip -> { name, at }
const RDNS_TTL = 10 * 60e3;
async function resolveHost(ip) {
  if (!ip || /^(127\.|::1|fe80|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null;
  const hit = rdnsCache.get(ip);
  if (hit && Date.now() - hit.at < RDNS_TTL) return hit.name;
  try {
    const names = await reverse(ip);
    const name = names?.[0] || null;
    rdnsCache.set(ip, { name, at: Date.now() });
    if (rdnsCache.size > 500) rdnsCache.delete(rdnsCache.keys().next().value);
    return name;
  } catch {
    rdnsCache.set(ip, { name: null, at: Date.now() });
    return null;
  }
}
const HOST_PROC = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';

// Loopback and container-internal veths are noise; everything else
// (including wg/tailscale VPN interfaces) is shown, tagged by kind.
const SKIP_IF = /^(lo|veth|cni|flannel)$|^(veth|cni)/;
const VIRTUAL_IF = /^(wg|tailscale|tun|tap|docker|br-|virbr)/;
function ifaceKind(name) {
  if (/^(eth|en)/.test(name)) return 'wired';
  if (/^(wlan|wlp|wifi)/.test(name)) return 'wifi';
  if (/^(wg|tailscale|tun|tap)/.test(name)) return 'vpn';
  if (/^(docker|br-|virbr)/.test(name)) return 'bridge';
  return 'other';
}

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

export function createNetworkCollector({ getPiholeConfig = () => null, getPiholePassword = () => null } = {}) {
  let prev = null;
  let prevAt = 0;

  // Pi-hole DNS analytics client (optional, configured via settings + secrets).
  const pihole = createPiholeClient({ getConfig: getPiholeConfig, getPassword: getPiholePassword });

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
        kind: ifaceKind(iface),
        virtual: VIRTUAL_IF.test(iface),
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

  /** Full connection list: proto, state, local port, peer, owning process. */
  async function connections() {
    const out = [];
    try {
      const { stdout } = await execFileAsync('ss', ['-tunp', 'state', 'established'], { timeout: 4000 });
      for (const line of stdout.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const proto = cols[0];                       // tcp|udp
        const local = cols[3], peer = cols[4];
        const lpMatch = local.match(/:(\d+)$/);
        const ppMatch = peer.match(/^(.*):(\d+)$/);
        const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        const lport = lpMatch ? Number(lpMatch[1]) : null;
        const rport = ppMatch ? Number(ppMatch[2]) : null;
        // classify by whichever side is a well-known service port
        const svc = WELL_KNOWN[lport] || WELL_KNOWN[rport] || (proto || 'other').toUpperCase();
        out.push({
          proto, service: svc,
          localPort: lport,
          peer: ppMatch ? ppMatch[1].replace(/^\[|\]$/g, '') : peer,
          peerPort: rport,
          comm: procMatch ? procMatch[1] : null,
          pid: procMatch ? Number(procMatch[2]) : null,
        });
      }
    } catch { /* ss unavailable */ }
    // best-effort reverse DNS for public peers (cached)
    await Promise.all(out.map(async (c) => { c.peerHost = await resolveHost(c.peer); }));
    return out;
  }

  /** Protocol distribution as % of established connections, with process map. */
  async function protocolShare() {
    const conns = await connections();
    const bySvc = {};
    for (const c of conns) {
      bySvc[c.service] = bySvc[c.service] || { service: c.service, count: 0, conns: [] };
      bySvc[c.service].count += 1;
      bySvc[c.service].conns.push(c);
    }
    const total = conns.length || 1;
    const shares = Object.values(bySvc)
      .map((s) => ({ service: s.service, count: s.count, pct: (s.count / total) * 100, conns: s.conns }))
      .sort((a, b) => b.count - a.count);
    return { total: conns.length, shares };
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
    // Prefer a configured Pi-hole — richest source (top domains, blocked,
    // categories, totals, blocking state).
    const piCfg = getPiholeConfig();
    if (piCfg && piCfg.enabled) {
      try {
        const snap = await pihole.snapshot(12);
        if (snap) return snap;
      } catch (e) {
        // Surface a configured-but-unreachable Pi-hole so the UI can show it.
        return { available: false, source: 'pihole', loggingEnabled: false, error: e.message };
      }
    }
    // Prefer dnsmasq query-log analytics (top domains) when enabled.
    if (agentConfigured()) {
      try {
        const top = await agentCall('dns.topDomains', { limit: 15 }, null, 6000);
        if (top.enabled) {
          return { available: true, source: 'dnsmasq', loggingEnabled: true,
            totalQueries: top.totalQueries, domains: top.domains };
        }
      } catch { /* fall through */ }
      // The Pi's own recent lookups — works without any logging config.
      try {
        const recent = await agentCall('dns.recent', { limit: 20 }, null, 6000);
        if (recent.domains?.length) {
          return { available: true, source: recent.source, loggingEnabled: false,
            domains: recent.domains, ownQueries: true, resolver: recent.resolver };
        }
        if (recent.resolver) {
          // No per-query data, but we can at least name the resolver.
          return { available: true, source: recent.source, loggingEnabled: false,
            domains: [], resolver: recent.resolver, ownQueries: true };
        }
      } catch { /* fall through to resolver stats */ }
    }
    try {
      const { stdout } = await execFileAsync('resolvectl', ['statistics'], { timeout: 4000 });
      const get = (re) => { const m = stdout.match(re); return m ? Number(m[1]) : null; };
      return {
        available: true, source: 'resolved', loggingEnabled: false,
        current: get(/Current Transactions:\s+(\d+)/),
        total: get(/Total Transactions:\s+(\d+)/),
        cacheHits: get(/Cache Hits:\s+(\d+)/),
        cacheMisses: get(/Cache Misses:\s+(\d+)/),
      };
    } catch {
      return { available: false, loggingEnabled: false };
    }
  }

  async function dnsSetLogging(enabled) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall(enabled ? 'dns.enableLogging' : 'dns.disableLogging', {}, null, 12000);
  }

  async function dnsForwarder(enable) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('dns.forwarder', { enable }, null, 140000);
  }

  // ---- Pi-hole DNS analytics + control -----------------------------------
  async function piholeSnapshot(limit = 12) { return pihole.snapshot(limit); }
  async function piholeTest() { return pihole.test(); }
  async function piholeSetBlocking(enabled, seconds) { return pihole.setBlocking(enabled, seconds); }
  function piholeResetSession() { pihole.resetSession(); }

  // Detect an existing Pi-hole (host or docker) via the agent.
  async function piholeDetect() {
    if (!agentConfigured()) return { installed: false, agent: false };
    try { return { agent: true, ...(await agentCall('pihole.detect', {}, null, 20000)) }; }
    catch (e) { return { installed: false, agent: true, error: e.message }; }
  }
  // One-click install (host or docker). Streams progress lines via onLine.
  async function piholeInstall(params, onLine) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('pihole.install', params, onLine, 900000);   // up to 15 min
  }
  // Check for a Pi-hole update (method-aware).
  async function piholeCheckUpdate() {
    if (!agentConfigured()) return { installed: false, updateAvailable: false, agent: false };
    try { return { agent: true, ...(await agentCall('pihole.checkUpdate', {}, null, 180000)) }; }
    catch (e) { return { installed: false, updateAvailable: false, agent: true, error: e.message }; }
  }
  // Apply a Pi-hole update (streamed).
  async function piholeUpdate(onLine) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('pihole.update', {}, onLine, 900000);
  }
  // Point this Pi's own resolver at Pi-hole (reversible, with fallback).
  async function piholeSetSystemResolver(enable, fallback) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('pihole.setSystemResolver', { enable, fallback }, null, 30000);
  }
  async function piholeSystemResolverStatus() {
    if (!agentConfigured()) return { enabled: false, agent: false };
    try { return { agent: true, ...(await agentCall('pihole.systemResolverStatus', {}, null, 10000)) }; }
    catch (e) { return { enabled: false, agent: true, error: e.message }; }
  }
  // Back up the Pi-hole DB to the NAS (streamed), and list existing backups.
  async function piholeBackupToNas(params, onLine) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('pihole.backupToNas', params, onLine, 600000);
  }
  async function piholeBackupStatus(mountpoint) {
    if (!agentConfigured()) return { backups: [], agent: false };
    try { return { agent: true, ...(await agentCall('pihole.backupStatus', { mountpoint }, null, 15000)) }; }
    catch (e) { return { backups: [], agent: true, error: e.message }; }
  }

  async function nethogsSample(seconds = 5) {
    if (!agentConfigured()) throw new Error('host agent required');
    return agentCall('nethogs.sample', { seconds }, null, (Number(seconds) + 130) * 1000);
  }

  async function snapshot() {
    const [vn, proto, procs, dnsStats] = await Promise.all([vnstat(), protocolShare(), topProcesses(), dns()]);
    return { throughput: throughput(), vnstat: vn, protocols: proto, processes: procs, dns: dnsStats, ts: Date.now() };
  }

  return { throughput, vnstat, protocols, protocolShare, connections, topProcesses, dns, dnsSetLogging, dnsForwarder, nethogsSample, snapshot,
    piholeSnapshot, piholeTest, piholeSetBlocking, piholeResetSession, piholeDetect, piholeInstall, piholeCheckUpdate, piholeUpdate,
    piholeSetSystemResolver, piholeSystemResolverStatus, piholeBackupToNas, piholeBackupStatus };
}

const WELL_KNOWN = {
  22: 'SSH', 53: 'DNS', 80: 'HTTP', 443: 'HTTPS', 3001: 'RaPiSys',
  5900: 'VNC', 5901: 'VNC', 51820: 'WireGuard', 8080: 'HTTP-alt',
  3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 1883: 'MQTT',
  445: 'SMB', 139: 'SMB', 2049: 'NFS', 123: 'NTP', 25: 'SMTP', 587: 'SMTP',
};
