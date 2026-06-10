/**
 * RaPiSys — Host agent client
 * ---------------------------
 * Speaks newline-delimited JSON over a Unix socket to rapisys-agent (a host
 * systemd service). Every request is HMAC-signed with AGENT_SECRET; the agent
 * only executes a fixed allowlist of operations (see agent/rapisys-agent.js).
 *
 * The client degrades gracefully: if the socket/secret is absent (e.g. plain
 * `docker compose up` without running deploy.sh), agentAvailable() is false
 * and feature routes return 503 with a helpful message instead of crashing.
 */

import net from 'net';
import crypto from 'crypto';

const SOCKET = process.env.AGENT_SOCKET || '/run/rapisys/agent.sock';
const SECRET = process.env.AGENT_SECRET || '';
const TIMEOUT_MS = 15000;

export function agentConfigured() {
  return SECRET.length >= 32;
}

function sign(id, op, params, ts) {
  return crypto.createHmac('sha256', SECRET)
    .update(`${id}.${op}.${JSON.stringify(params)}.${ts}`)
    .digest('hex');
}

/**
 * Call an agent operation.
 * @param {string} op       e.g. 'fan.setMode'
 * @param {object} params
 * @param {function} [onLine] optional callback for streamed output lines
 * @returns {Promise<any>} the operation result
 */
export function agentCall(op, params = {}, onLine = null, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!agentConfigured()) {
      return reject(new Error('host agent not configured (run deploy.sh on the Pi)'));
    }
    const id = crypto.randomUUID();
    const ts = Date.now();
    const sock = net.createConnection(SOCKET);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`agent op '${op}' timed out`));
    }, timeoutMs);

    let buf = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id, op, params, ts, hmac: sign(id, op, params, ts) }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.stream !== undefined) { onLine?.(msg.stream); continue; }
        clearTimeout(timer);
        sock.end();
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || 'agent error'));
        return;
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`agent unreachable: ${err.message}`));
    });
  });
}

/** Quick availability probe used by /api/health/deep and the wizard. */
export async function agentAvailable() {
  if (!agentConfigured()) return false;
  try { await agentCall('ping', {}, null, 2000); return true; }
  catch { return false; }
}
