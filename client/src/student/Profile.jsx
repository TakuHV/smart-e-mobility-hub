import { useState } from 'react';
import { api } from '../api';
import { useNow, useClockState } from '../clock';
import { useLoad } from './ui';

export default function Profile({ user, onLogout, bigText, setBigText, onSwitchRole }) {
  const now = useNow();
  const clock = useClockState();
  const [points, setPoints] = useState(null);   // the student's violation points (BR-52); only a Student has them
  useLoad(async () => { if (user.role === 'Student') { try { setPoints((await api('/auth/me/violations')).summary); } catch { /* the card simply stays hidden */ } } }, 30);
  return <>
    <h1>My profile</h1>
    <div className="stu-card" style={{ alignItems: 'center', textAlign: 'center' }}>
      <div className="avatar" style={{ width: 84, height: 84, fontSize: 36 }}>{user.full_name?.slice(0, 1)?.toUpperCase() || 'U'}</div>
      <h2>{user.full_name}</h2>
      <p>{user.role} · demo account</p>
    </div>
    {user.full_name === 'Demo' && onSwitchRole && <div className="stu-card">
      <b>Open as</b>
      <div className="chip-row">{['Student', 'Operator', 'Simulation Operator', 'Admin'].map(r => <button key={r} className={`chip ${user.role === r ? 'chosen' : ''}`} onClick={() => onSwitchRole(r)}>{r}</button>)}</div>
    </div>}
    {points && <div className={`stu-card ${points.isSuspended ? 'warn' : ''}`}>
      <b>Violation points</b>
      <div className="points-row"><span className={`points-number ${points.activePoints >= points.threshold ? 'bad' : points.activePoints > 0 ? 'some' : ''}`}>{points.activePoints}</span><span>of {points.threshold} allowed</span></div>
      {points.isSuspended
        ? <div className="stu-error">You have reached {points.threshold} points. You cannot create new charging requests until points expire.</div>
        : points.activePoints === 0
          ? <p>No violations. Thank you for using the Hubs well.</p>
          : <p>At {points.threshold} points you cannot create new charging requests. Each point expires after 14 days.</p>}
      {points.violations.map(v => <div className="violation-item" key={v.id}>
        <b>+{v.points} · {v.reason}</b>
        <small>{new Date(v.recorded_at).toLocaleString('en-GB')} · expires {new Date(v.expires_at).toLocaleDateString('en-GB')}</small>
      </div>)}
    </div>}
    <div className="stu-card">
      <b>Text size</b>
      <div className="chip-row">
        <button className={`chip ${!bigText ? 'chosen' : ''}`} onClick={() => setBigText(false)}>Normal</button>
        <button className={`chip ${bigText ? 'chosen' : ''}`} onClick={() => setBigText(true)}>Larger</button>
      </div>
    </div>
    <div className="stu-card">
      <b>Demo time</b>
      <p>{new Date(now).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' })}{clock.paused ? ' (paused)' : clock.speed > 1 ? ` (×${clock.speed} speed)` : ''}</p>
    </div>
    <button className="stu-btn danger" onClick={onLogout}>Sign out</button>
  </>;
}
