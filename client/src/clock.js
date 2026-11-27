import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, getStoredUser } from './api';

/*
 * Demo clock on the client. The server owns the demo time; the client polls GET /api/clock and extrapolates between
 * polls, so countdowns tick every second without extra requests. Pages use virtualNow() instead of Date.now().
 */
let state = { now: Date.now(), speed: 1, paused: false, limits: null, maintenance: null, scheduler: null, speeds: [1, 10, 60, 300], maxJumpMinutes: 1440, sensorFeedEnabled: false, loaded: false };
let syncedAt = Date.now();
let listeners = new Set();
let version = 0;
let timer = null;
let tick = null;

const emit = () => { version += 1; listeners.forEach(l => l()); };

export function virtualNow() {
  if (state.paused) return state.now;
  return state.now + (Date.now() - syncedAt) * state.speed;
}

export async function refreshClock() {
  if (!getStoredUser()) return;
  try {
    const data = await api('/clock');
    state = { ...state, ...data, now: Date.parse(data.now), loaded: true };
    syncedAt = Date.now();
    emit();
  } catch { /* the offline banner covers an unreachable server */ }
}

export async function controlClock(body) {
  const data = await api('/clock', { method: 'POST', body });
  state = { ...state, ...data, now: Date.parse(data.now), loaded: true };
  syncedAt = Date.now();
  emit();
  window.dispatchEvent(new Event('smh:clock-changed'));
  return data;
}

function start() {
  if (timer) return;
  refreshClock();
  timer = setInterval(refreshClock, 15000);
  tick = setInterval(emit, 1000);
}
function stop() { clearInterval(timer); clearInterval(tick); timer = tick = null; }

const subscribe = listener => { listeners.add(listener); if (listeners.size === 1) start(); return () => { listeners.delete(listener); if (!listeners.size) stop(); }; };

// Re-renders every second. Returns the demo time in ms.
export function useNow() {
  useSyncExternalStore(subscribe, () => version);
  return virtualNow();
}
export function useClockState() {
  useSyncExternalStore(subscribe, () => version);
  return state;
}

// Calls `load` every `seconds` (real time) and whenever the demo clock was changed or the demo cycle ran, without a loading flash.
export function useAutoRefresh(load, seconds = 20) {
  useEffect(() => {
    const run = () => { if (!document.hidden) load(true); };
    const id = setInterval(run, seconds * 1000);
    window.addEventListener('smh:clock-changed', run);
    return () => { clearInterval(id); window.removeEventListener('smh:clock-changed', run); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);
}

export function useTicker() { const [, set] = useState(0); useEffect(() => { const id = setInterval(() => set(n => n + 1), 1000); return () => clearInterval(id); }, []); }

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
