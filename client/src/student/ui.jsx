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

export function Battery({ level, label = 'Battery' }) {
  const cls = level < 20 ? 'low' : level < 40 ? 'mid' : '';
  return <div className="stu-battery"><div className="row"><span>{label}</span><span>{Math.round(level)}%</span></div><div className="bar"><i className={cls} style={{ width: `${Math.max(0, Math.min(100, level))}%` }}/></div></div>;
}

export const Choice = ({ icon, title, hint, right, chosen, disabled, onClick }) =>
  <button type="button" className={`choice ${chosen ? 'chosen' : ''}`} disabled={disabled} onClick={onClick}>
    {icon && <span className="ci" aria-hidden="true">{icon}</span>}
    <span className="ct"><b>{title}</b>{hint && <small>{hint}</small>}</span>
    {right && <span className="cr">{right}</span>}
  </button>;

export const Chips = ({ options, value, onChange }) =>
  <div className="chip-row">{options.map(o => <button type="button" key={o.value} className={`chip ${value === o.value ? 'chosen' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;

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
