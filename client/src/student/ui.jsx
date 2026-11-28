import BatteryIcon from '../components/BatteryIcon.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAutoRefresh } from '../clock';

// Students do not need the business-rule codes the API adds to its messages, for example "(BR-24)".
export const plain = message => String(message ?? '').replace(/\s*\((?:BR|NI|OD|UC)[-\d, /A-Z]*\)/g, '');

export function BackHeader({ title, onBack, step, steps }) {
  return <>
    <div className="stu-back">
      {onBack && <button type="button" onClick={onBack} aria-label="Back">‹</button>}
      <h1>{title}</h1>
    </div>
    {steps ? <div className="stu-steps" aria-label={`Step ${step} of ${steps}`}>{Array.from({ length: steps }, (_, i) => <i key={i} className={i < step ? 'on' : ''}/>)}</div> : null}
  </>;
}

export function Battery({ level, label = 'Battery', charging = false }) {
  return <div className="stu-battery"><div className="row"><span>{label}</span><BatteryIcon level={level} charging={charging} size="lg"/></div></div>;
}

// Vietnamese motorcycle plate (same rule as the server): 2 digits (11-99), 1-2 series letters, optional digit, then 000.01-999.99.
// Returns the plate as "59A-123.45", or null when the text is not a valid plate.
const VN_PLATE = /^(1[1-9]|[2-9]\d)-?([ABCDEFGHKLMNPRSTUVXYZ]{1,2})(\d)?[-\s]?(\d{3})\.?(\d{2})$/;
export function normalizeVnPlate(value) {
  const m = VN_PLATE.exec(String(value || '').trim().toUpperCase());
  return !m || m[4] + m[5] === '00000' ? null : `${m[1]}${m[2]}${m[3] || ''}-${m[4]}.${m[5]}`;
}

// Small green badge with the word HUB: the picture for a Hub in the lists where a student chooses one.
export const HubBadge = () => <span className="hub-badge">HUB</span>;

export const Choice = ({ icon, title, hint, right, chosen, disabled, onClick }) =>
  <button type="button" className={`choice ${chosen ? 'chosen' : ''}`} disabled={disabled} onClick={onClick}>
    {icon && <span className="ci" aria-hidden="true">{icon}</span>}
    <span className="ct"><b>{title}</b>{hint && <small>{hint}</small>}</span>
    {right && <span className="cr">{right}</span>}
  </button>;

export const Chips = ({ options, value, onChange }) =>
  <div className="chip-row">{options.map(o => <button type="button" key={o.value} className={`chip ${value === o.value ? 'chosen' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;

// Hour and minute typed as numbers (instead of fixed choices). Values are kept as text so typing feels natural;
// non-digits are dropped, and the value is limited to its maximum.
const digits = (value, max) => { const t = String(value).replace(/\D/g, '').slice(0, 2); return t !== '' && Number(t) > max ? String(max) : t; };
export const toInt = value => (value === '' || value == null ? NaN : Number(value));
export function TimeFields({ hour, minute, onHour, onMinute, maxHour = 23, hourLabel = 'hours', minuteLabel = 'minutes', clock = false }) {
  const pad = (value, set) => () => value !== '' && set(String(Number(value)).padStart(clock ? 2 : 1, '0'));
  return <div className="time-fields">
    <label><input inputMode="numeric" autoComplete="off" value={hour} placeholder={clock ? 'HH' : '0'} aria-label={hourLabel}
      onChange={e => onHour(digits(e.target.value, maxHour))} onBlur={pad(hour, onHour)} onFocus={e => e.target.select()}/><small>{hourLabel}</small></label>
    <span className="time-sep">{clock ? ':' : ''}</span>
    <label><input inputMode="numeric" autoComplete="off" value={minute} placeholder={clock ? 'MM' : '0'} aria-label={minuteLabel}
      onChange={e => onMinute(digits(e.target.value, 59))} onBlur={pad(minute, onMinute)} onFocus={e => e.target.select()}/><small>{minuteLabel}</small></label>
  </div>;
}
// Today at hour:minute on the (demo) clock, in the device's local time.
export const todayAt = (nowMs, hour, minute) => { const d = new Date(nowMs); d.setHours(hour, minute, 0, 0); return d.getTime(); };
export const clockText = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Runs `loader` now and again every `seconds` and after demo-clock changes. `loader(silent)` should return nothing.
export function useLoad(loader, seconds = 15) {
  const ref = useRef(loader);
  ref.current = loader;
  const run = useCallback(silent => ref.current(silent === true), []);
  useEffect(() => { run(); }, [run]);
  useAutoRefresh(run, seconds);
  return run;
}

// Small helper for a button action with a busy flag and an error message.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setErrorRaw] = useState('');
  const setError = message => setErrorRaw(plain(message));
  const run = async fn => {
    setBusy(true); setError('');
    try { return await fn(); }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export const hubHint = h => (h.open_now ? `Open until ${h.close_time}` : `Closed · opens ${h.open_time}`);
