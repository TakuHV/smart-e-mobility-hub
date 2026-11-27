import { useNow, useClockState } from '../clock';

export default function Profile({ user, onLogout, bigText, setBigText, onSwitchRole }) {
  const now = useNow();
  const clock = useClockState();
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
