/*
 * Demo clock. Everything the server does with time (hold expiry, reminders, charging progress, the Charging Scheduler)
 * reads "now" from here, so the Operator can run the demo faster than real time. At speed x1 it equals the real clock.
 * Virtual time only moves forward: the controls are speed, pause and "skip ahead".
 */
export const SPEEDS = [1, 10, 60, 300];
export const MAX_JUMP_MINUTES = 24 * 60;

let anchorReal = Date.now();
let anchorVirtual = anchorReal;
let speed = 1;
let paused = false;

export function now() {
  return paused ? anchorVirtual : anchorVirtual + (Date.now() - anchorReal) * speed;
}

export function nowIso() {
  return new Date(Math.round(now())).toISOString();
}

// Re-anchor before any change so that the time already elapsed keeps its old speed.
function reanchor() {
  anchorVirtual = now();
  anchorReal = Date.now();
}

export function setSpeed(value) {
  if (!SPEEDS.includes(value)) throw new RangeError(`speed must be one of ${SPEEDS.join(', ')}`);
  reanchor();
  speed = value;
}

export function setPaused(flag) {
  reanchor();
  paused = Boolean(flag);
}

export function jump(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_JUMP_MINUTES) {
    throw new RangeError(`minutes must be above 0 and at most ${MAX_JUMP_MINUTES}`);
  }
  reanchor();
  anchorVirtual += minutes * 60000;
}

// Back to real time at speed x1 (used by the demo data reset).
export function resetClock() {
  anchorReal = Date.now();
  anchorVirtual = anchorReal;
  speed = 1;
  paused = false;
}

export function clockStatus() {
  return { now: nowIso(), speed, paused, speeds: SPEEDS };
}
