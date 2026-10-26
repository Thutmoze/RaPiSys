/**
 * Real progress for an apt-get upgrade, read from its own output.
 *
 * apt prints its plan ("N upgraded, M newly installed, K to remove ...")
 * before doing anything. From there, download is the first 30% (one Get:N
 * per package) and each Unpacking, Setting up and Removing line is one step
 * of the remaining 70%. Trigger processing at the end holds at 99% until
 * apt exits. Before the plan line is seen, pct is null: the caller keeps
 * its own soft estimate and shows no percent.
 */
const DOWNLOAD_SHARE = 30;

export function createAptProgress() {
  let plan = null;                 // { pkgs, rm }
  let got = 0, unpacked = 0, configured = 0, removed = 0;
  let pct = null, phase = null;

  // Feed one output line; returns { pct, phase, done, of } (done/of only
  // for phases that count packages).
  function line(raw) {
    const l = String(raw).trim();
    let m;
    if (!plan && (m = l.match(/^(\d+) upgraded, (\d+) newly installed, (\d+) to remove/))) {
      plan = { pkgs: +m[1] + +m[2], rm: +m[3] };
      if (plan.pkgs + plan.rm === 0) plan = null;   // nothing to do: no bar to drive
      else { pct = 0; phase = 'Preparing'; }
    }
    if (!plan) return state();
    if ((m = l.match(/^Get:(\d+) /))) { got = Math.max(got, +m[1]); phase = 'Downloading'; }
    else if (/^Unpacking /.test(l)) { unpacked++; phase = 'Unpacking'; }
    else if (/^Setting up /.test(l)) { configured++; phase = 'Configuring'; }
    else if (/^Removing /.test(l)) { removed++; phase = 'Removing'; }
    else if (/^Processing triggers /.test(l)) phase = 'Finishing up';
    const steps = unpacked + configured + removed;
    const all = 2 * plan.pkgs + plan.rm;
    const next = steps
      ? DOWNLOAD_SHARE + (100 - DOWNLOAD_SHARE) * steps / all
      : DOWNLOAD_SHARE * Math.min(got, plan.pkgs) / Math.max(1, plan.pkgs);
    pct = Math.min(99, Math.max(pct, next));      // never moves backwards
    return state();
  }

  function state() {
    const counts = {
      Downloading: [Math.min(got, plan?.pkgs ?? 0), plan?.pkgs],
      Unpacking: [Math.min(unpacked, plan?.pkgs ?? 0), plan?.pkgs],
      Configuring: [Math.min(configured, plan?.pkgs ?? 0), plan?.pkgs],
      Removing: [Math.min(removed, plan?.rm ?? 0), plan?.rm],
    }[phase];
    return { pct: pct == null ? null : Math.floor(pct), phase, done: counts?.[0] ?? null, of: counts?.[1] ?? null };
  }

  return { line, state };
}
