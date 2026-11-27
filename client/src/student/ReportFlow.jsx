import { useState } from 'react';
import { api } from '../api';
import { BackHeader, Choice, useLoad, useAction } from './ui';

const KINDS = [
  { category: 'Vehicle fault', severity: 'Medium', icon: '🛵', title: 'A vehicle problem', hint: 'Broken, damaged or will not start' },
  { category: 'Charger fault', severity: 'Medium', icon: '🔌', title: 'A charger problem', hint: 'Charger does not work' },
  { category: 'Slot blocked', severity: 'Low', icon: '🚧', title: 'A blocked parking spot', hint: 'Someone is in the way' },
  { category: 'Safety', severity: 'High', icon: '⚠️', title: 'A safety problem', hint: 'Someone may be in danger' }
];

export default function ReportFlow({ onClose }) {
  const [hubs, setHubs] = useState([]);
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState(null);
  const [hubId, setHubId] = useState('');
  const [summary, setSummary] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, setError, run } = useAction();
  useLoad(async () => { try { setHubs((await api('/hubs')).hubs); } catch { /* optional */ } }, 60);

  if (sent) return <>
    <div className="trip-big"><div className="emoji">🙏</div><h1>Thank you</h1><p>We received your report and the Hub team will look at it.</p></div>
    <button className="stu-btn" onClick={onClose}>Back to home</button>
  </>;

  const send = async () => {
    const r = await run(() => api('/incidents', { method: 'POST', body: { category: kind.category, severity: kind.severity, hubId: hubId || null, summary } }));
    if (r) setSent(true);
  };
  return <>
    <BackHeader title={step === 1 ? 'What happened?' : 'Tell us more'} onBack={() => (step === 1 ? onClose() : setStep(1))} step={step} steps={2}/>
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {step === 1 && <div className="choice-list">{KINDS.map(k => <Choice key={k.category} icon={k.icon} title={k.title} hint={k.hint} onClick={() => { setKind(k); setStep(2); }}/>)}</div>}
    {step === 2 && <>
      <div className="stu-card">
        <label>Where? (optional)<select value={hubId} onChange={e => setHubId(e.target.value)}><option value="">I am not sure</option>{hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <label>Please describe it in a few words<textarea rows="3" value={summary} onChange={e => setSummary(e.target.value)} placeholder="For example: the front light is broken"/></label>
      </div>
      <button className="stu-btn" disabled={busy || summary.trim().length < 5} onClick={send}>Send report</button>
    </>}
  </>;
}
