import { useState } from 'react';
import { useClockState, useNow, controlClock } from '../clock';

// Topbar chip: demo time + speed. Operators and Admins also get pause, speed and skip-ahead controls.
export default function DemoClockBar({ user }) {
  const clock = useClockState();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canControl = ['Operator', 'Admin'].includes(user.role);
  const act = async body => { setBusy(true); setError(''); try { await controlClock(body); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const nextCycle = clock.maintenance?.nextRunAt;

  return <div className="clock-wrap">
    <button className={`clock-chip ${clock.paused ? 'paused' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} title="Demo clock">
      <span aria-hidden="true">◷</span>
      <b>{new Date(now).toLocaleTimeString('en-GB')}</b>
      <small>{clock.paused ? 'paused' : `×${clock.speed}`}</small>
    </button>
    {open && <>
      <div className="menu-backdrop" onClick={() => setOpen(false)}/>
      <div className="clock-panel" role="dialog" aria-label="Demo clock">
        <strong>Demo clock</strong>
        <span className="helper-text">{new Date(now).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' })}</span>
        {nextCycle && <span className="helper-text">Next automatic check: {new Date(nextCycle).toLocaleTimeString('en-GB')}</span>}
        {canControl ? <>
          <div className="clock-row">
            <button className="button small secondary" disabled={busy} onClick={() => act({ paused: !clock.paused })}>{clock.paused ? '▶ Resume' : '⏸ Pause'}</button>
            {(clock.speeds || []).map(s => <button key={s} className={`button small ${clock.speed === s ? 'primary' : 'ghost'}`} disabled={busy} onClick={() => act({ speed: s })}>×{s}</button>)}
          </div>
          <div className="clock-row">
            {[5, 15, 60, 180].map(m => <button key={m} className="button small secondary" disabled={busy} onClick={() => act({ jumpMinutes: m })}>{m >= 60 ? `+${m / 60} h` : `+${m} min`}</button>)}
          </div>
          {error && <div className="feedback is-error">{error}</div>}
        </> : <span className="helper-text">Time moves at ×{clock.speed}. Operators control the demo clock.</span>}
      </div>
    </>}
  </div>;
}
