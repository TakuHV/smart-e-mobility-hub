import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import RefreshButton from '../components/RefreshButton';
import { EmptyState, Feedback } from '../components/Feedback';
import { useAutoRefresh } from '../clock';

// UC-019 Handle Incident. Students report and follow their own problems; Operators and Admins handle all of them.
export default function Incidents({ user }) {
  const isOps = ['Operator', 'Admin'].includes(user.role);
  const [data, setData] = useState({ incidents: [], categories: [], severities: [] });
  const [attention, setAttention] = useState([]);
  const [hubs, setHubs] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ category: 'Vehicle fault', severity: 'Medium', hubId: '', summary: '' });
  const [notes, setNotes] = useState({});

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      const [i, h] = await Promise.all([api('/incidents'), api('/hubs')]);
      setData(i); setHubs(h.hubs);
      if (isOps) setAttention((await api('/incidents/attention')).items);
    } catch (e) { if (!silent) setError(e.message); }
  }, [isOps]);
  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, 20);

  async function run(call, message) {
    setError(''); setSuccess('');
    try { await call(); setSuccess(message); await load(true); return true; } catch (e) { setError(e.message); return false; }
  }
  const report = async () => {
    const ok = await run(() => api('/incidents', { method: 'POST', body: { ...form, hubId: form.hubId || null } }), 'Problem reported. Thank you.');
    if (ok) setForm(f => ({ ...f, summary: '' }));
  };
  const open = data.incidents.filter(i => i.status !== 'Resolved');
  const resolved = data.incidents.filter(i => i.status === 'Resolved');

  return <>
    <SectionHeader eyebrow={isOps ? 'OPERATOR WORKFLOW · UC-019' : 'STUDENT · UC-019'} title={isOps ? 'Incident Handling' : 'Report a Problem'} description={isOps ? 'Acknowledge, fix and resolve problems. Resolving can restore the affected vehicle, slot or charger.' : 'Tell the Hub team about a faulty vehicle, charger or blocked slot.'} action={<RefreshButton onClick={() => load()}/>}/>
    <Feedback error={error} success={success}/>

    {isOps && <section className="card-surface padded">
      <div className="subsection-title"><strong>Needs attention now</strong><span>{attention.length}</span></div>
      {attention.length === 0 ? <EmptyState title="All clear" description="No overdue trips, blocked chargers, overstays or stale Hubs."/> : attention.map((a, idx) =>
        <div key={idx} className={`attention-item ${a.severity}`}><div><strong>{a.title}</strong><span>{a.detail}</span></div><small>{new Date(a.since).toLocaleTimeString('en-GB')}</small></div>)}
    </section>}

    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Report a problem</strong></div>
      <div className="form-grid">
        <label>Category<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{data.categories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Severity<select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}>{data.severities.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Hub<select value={form.hubId} onChange={e => setForm({ ...form, hubId: e.target.value })}><option value="">Not sure</option>{hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      </div>
      <label>What happened?<textarea rows="2" value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} placeholder="At least 5 characters"/></label>
      <button className="button primary" disabled={form.summary.trim().length < 5} onClick={report}>Send report</button>
    </section>

    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>{isOps ? 'Open incidents' : 'My open reports'}</strong><span>{open.length}</span></div>
      {open.length === 0 ? <EmptyState title="Nothing open" description="Reported problems appear here until they are resolved."/> : open.map(i => <div className="attention-item" key={i.id}>
        <div>
          <strong>{i.category} <StatusBadge value={i.status}/> <StatusBadge value={i.severity}/></strong>
          <span>{i.summary}</span>
          <span>{[i.hub_name, i.plate, i.charger_code, i.slot_code].filter(Boolean).join(' · ')}{isOps && i.reporter_name ? ` · by ${i.reporter_name}` : ''} · {new Date(i.created_at).toLocaleString('en-GB')}</span>
          {isOps && <label>Resolution note<input value={notes[i.id] || ''} onChange={e => setNotes({ ...notes, [i.id]: e.target.value })} placeholder="What was done?"/></label>}
        </div>
        {isOps && <div className="inline-actions">
          {i.status === 'Open' && <button className="button small secondary" onClick={() => run(() => api(`/incidents/${i.id}/acknowledge`, { method: 'POST', body: {} }), 'Incident acknowledged.')}>Acknowledge</button>}
          <button className="button small primary" onClick={() => run(() => api(`/incidents/${i.id}/resolve`, { method: 'POST', body: { note: notes[i.id] || '', restore: true } }), 'Resolved and restored.')}>Resolve + restore</button>
          <button className="button small ghost" onClick={() => run(() => api(`/incidents/${i.id}/resolve`, { method: 'POST', body: { note: notes[i.id] || '', restore: false } }), 'Resolved. The asset stays out of service.')}>Resolve only</button>
        </div>}
      </div>)}
    </section>
    {resolved.length > 0 && <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Resolved</strong><span>{resolved.length}</span></div>
      <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Problem</th><th>Where</th><th>Status</th></tr></thead>
        <tbody>{resolved.map(i => <tr key={i.id}><td className="primary"><strong>{i.category}</strong><small>{i.summary}</small></td><td data-label="Where">{[i.hub_name, i.plate, i.charger_code].filter(Boolean).join(' · ') || '—'}</td><td data-label="Status"><StatusBadge value={i.status}/></td></tr>)}</tbody></table></div>
    </section>}
  </>;
}
