/**
 * RaPiSys — Pi 5 hardware collector
 * ---------------------------------
 * Reads the Raspberry Pi 5 active cooler, thermal state and PMIC power
 * telemetry. Pure "read → normalized object" — no SQL here.
 *
 * Sources (in priority order):
 *  - sysfs (works read-only from inside the container via /host/sys)
 *  - vcgencmd via the host agent (the binary isn't in the container)
 *  - local vcgencmd (when running directly on the Pi in dev)
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { agentCall, agentConfigured } from '../core/agent-client.js';

const execFileAsync = promisify(execFile);
const SYS = fs.existsSync('/host/sys') ? '/host/sys' : '/sys';

// Throttle flag bits from `vcgencmd get_throttled` (Pi documentation).
const THROTTLE_BITS = [
  [0x1, 'undervoltage'], [0x2, 'freq-capped'], [0x4, 'throttled'], [0x8, 'temp-limit'],
  [0x10000, 'undervoltage-occurred'], [0x20000, 'freq-capped-occurred'],
  [0x40000, 'throttled-occurred'], [0x80000, 'temp-limit-occurred'],
];

function findFanDir() {
  const base = path.join(SYS, 'devices/platform/cooling_fan/hwmon');
  try {
    for (const e of fs.readdirSync(base)) {
      if (fs.existsSync(path.join(base, e, 'fan1_input'))) return path.join(base, e);
    }
  } catch { /* no official cooler */ }
  return null;
}

const readNum = (file) => {
  try { return parseInt(fs.readFileSync(file, 'utf-8').trim(), 10); } catch { return null; }
};

/** Run a vcgencmd subcommand through agent → local binary → null. */
async function vc(cmd) {
  if (agentConfigured()) {
    try { return (await agentCall('vc.read', { cmd }, null, 4000)).output; } catch { /* fall through */ }
  }
  try {
    const [bin, ...args] = ['vcgencmd', ...cmd.split(' ')];
    const { stdout } = await execFileAsync(bin, args, { timeout: 2000 });
    return stdout.trim();
  } catch { return null; }
}

/** Parse `vcgencmd pmic_read_adc` into rails + computed total wattage. */
function parsePmic(output) {
  if (!output) return null;
  const volts = {}; const amps = {};
  for (const line of output.split('\n')) {
    let m = line.match(/^\s*(\w+)_V\s+volt.*=([\d.]+)V/);
    if (m) { volts[m[1]] = parseFloat(m[2]); continue; }
    m = line.match(/^\s*(\w+)_A\s+current.*=([\d.]+)A/);
    if (m) amps[m[1]] = parseFloat(m[2]);
  }
  let watts = 0;
  for (const rail of Object.keys(amps)) {
    if (volts[rail] !== undefined) watts += volts[rail] * amps[rail];
  }
  return {
    rails: Object.keys(volts).map((r) => ({ rail: r, volts: volts[r], amps: amps[r] ?? null })),
    coreVolts: volts.VDD_CORE ?? null,
    ext5v: volts.EXT5V ?? null,
    watts: Math.round(watts * 100) / 100 || null,
  };
}

export function createHardwareCollector() {
  let lastThrottleFlags = null;

  /** Full hardware snapshot for /api/hardware and the 10 s sampler. */
  async function snapshot() {
    const fanDir = findFanDir();
    const fan = fanDir ? {
      present: true,
      rpm: readNum(path.join(fanDir, 'fan1_input')) ?? 0,
      dutyPercent: Math.round(((readNum(path.join(fanDir, 'pwm1')) ?? 0) / 255) * 100),
      mode: { 0: 'off', 1: 'manual', 2: 'auto' }[readNum(path.join(fanDir, 'pwm1_enable'))] || 'unknown',
    } : { present: false };

    // Thermal zone 0 = SoC sensor (CPU; the Pi 5 GPU shares this die sensor).
    const tempMilli = readNum(path.join(SYS, 'class/thermal/thermal_zone0/temp'));
    const cpuTemp = tempMilli !== null ? Math.round(tempMilli / 100) / 10 : null;

    // CPU frequency from cpufreq (kHz).
    const freqKhz = readNum(path.join(SYS, 'devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'));

    const [throttledOut, pmicOut, voltsOut] = await Promise.all([
      vc('get_throttled'), vc('pmic_read_adc'), vc('measure_volts core'),
    ]);

    let throttle = { available: false, flags: 0, active: [], occurred: [] };
    const m = throttledOut?.match(/throttled=(0x[0-9a-fA-F]+)/);
    if (m) {
      const flags = parseInt(m[1], 16);
      throttle = {
        available: true, flags,
        active: THROTTLE_BITS.filter(([b]) => b <= 0x8 && (flags & b)).map(([, n]) => n),
        occurred: THROTTLE_BITS.filter(([b]) => b > 0x8 && (flags & b)).map(([, n]) => n),
      };
    }

    const pmic = parsePmic(pmicOut);
    const coreV = pmic?.coreVolts
      ?? (voltsOut ? parseFloat(voltsOut.match(/volt=([\d.]+)V/)?.[1]) || null : null);

    return {
      fan,
      thermal: {
        cpuTemp,
        gpuTemp: cpuTemp,           // Pi 5: shared SoC sensor — labeled in UI
        gpuSharesSensor: true,
        throttle,
      },
      power: {
        cpuFreqMhz: freqKhz !== null ? Math.round(freqKhz / 1000) : null,
        coreVolts: coreV,
        supply5v: pmic?.ext5v ?? null,
        watts: pmic?.watts ?? null,
        undervoltageNow: throttle.active.includes('undervoltage'),
        undervoltageOccurred: throttle.occurred.includes('undervoltage-occurred'),
        rails: pmic?.rails ?? [],
      },
      ts: Date.now(),
    };
  }

  /**
   * Detect throttle-state TRANSITIONS so undervoltage/throttling incidents
   * are logged as events with timestamps even when nobody is watching.
   * Returns a list of new events to record (or []).
   */
  function throttleTransitions(snap) {
    const flags = snap.thermal.throttle.flags & 0xF; // active bits only
    const out = [];
    if (lastThrottleFlags !== null && flags !== lastThrottleFlags) {
      for (const [bit, name] of THROTTLE_BITS.filter(([b]) => b <= 0x8)) {
        const was = (lastThrottleFlags & bit) !== 0;
        const is = (flags & bit) !== 0;
        if (!was && is) out.push({ type: `hw.${name}.start`, severity: name === 'undervoltage' ? 'critical' : 'warning' });
        if (was && !is) out.push({ type: `hw.${name}.end`, severity: 'info' });
      }
    }
    lastThrottleFlags = flags;
    return out;
  }

  return { snapshot, throttleTransitions };
}
