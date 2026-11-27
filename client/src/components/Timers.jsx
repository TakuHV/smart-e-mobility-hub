import { useNow, formatDuration } from '../clock';

// Counts down to `until` (ISO text) on the demo clock. Turns amber under `warnSeconds` and red when over.
export function Countdown({ until, label = '', warnSeconds = 300, overLabel = 'overdue' }) {
  const now = useNow();
  if (!until) return null;
  const left = Date.parse(until) - now;
  const cls = left <= 0 ? 'is-over' : left <= warnSeconds * 1000 ? 'is-warn' : '';
  return <span className={`countdown ${cls}`} title={new Date(until).toLocaleString()}>
    {left > 0 ? <>{label && <small>{label}</small>}<b>{formatDuration(left)}</b></> : <>{label && <small>{label}</small>}<b>{overLabel} {formatDuration(-left)}</b></>}
  </span>;
}

// Elapsed time since `since` with a bar towards `limitMinutes`.
export function ElapsedBar({ since, limitMinutes, warnAtMinutes, label = 'Elapsed' }) {
  const now = useNow();
  if (!since) return null;
  const elapsed = Math.max(0, now - Date.parse(since));
  const pct = limitMinutes ? Math.min(100, (elapsed / (limitMinutes * 60000)) * 100) : 0;
  const mins = elapsed / 60000;
  const cls = limitMinutes && mins >= limitMinutes ? 'red' : warnAtMinutes && mins >= warnAtMinutes ? 'amber' : '';
  return <div className="timer-bar">
    <div className="timer-bar-head"><span>{label}</span><b>{formatDuration(elapsed)}{limitMinutes ? ` / ${formatDuration(limitMinutes * 60000)}` : ''}</b></div>
    {limitMinutes ? <div className="battery-track"><i className={cls} style={{ width: `${pct}%` }}/></div> : null}
  </div>;
}

// Progress between two timestamps (for example a charging session from start to expected end).
export function ProgressBar({ from, to, label, right }) {
  const now = useNow();
  if (!from || !to) return null;
  const pct = Math.max(0, Math.min(100, ((now - Date.parse(from)) / (Date.parse(to) - Date.parse(from))) * 100));
  return <div className="timer-bar">
    <div className="timer-bar-head"><span>{label}</span><b>{right ?? `${Math.round(pct)}%`}</b></div>
    <div className="battery-track"><i style={{ width: `${pct}%` }}/></div>
  </div>;
}

export function Clock({ className = '' }) {
  const now = useNow();
  return <span className={className}>{new Date(now).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })}</span>;
}
