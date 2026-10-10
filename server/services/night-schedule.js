/**
 * RaPiSys — Pironman night-light schedule: what to do on each evaluation.
 *
 * `prev` is the in-memory "were we inside the off-window" from the last
 * evaluation (null right after a restart or when the schedule was off),
 * `want` whether we are inside it now, `hasSaved` whether a light state
 * snapshot from entering the window is still stored in settings.
 *
 *   'off'      entering the window: snapshot the lights, switch them off
 *   'restore'  leaving it: put the snapshot back (then drop it)
 *   'none'     nothing to change
 *
 * After a restart only a stored snapshot says the lights were switched off by
 * us: outside the window with no snapshot there is nothing to restore (every
 * deploy used to turn the lights back on), and inside it with a snapshot they
 * are already off (snapshotting again would save "off" as the state to restore).
 */
export function nightAction(prev, want, hasSaved) {
  if (prev === null) {
    if (want) return hasSaved ? 'none' : 'off';
    return hasSaved ? 'restore' : 'none';
  }
  if (want === prev) return 'none';
  return want ? 'off' : 'restore';
}
