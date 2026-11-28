import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import StatCard from '../components/StatCard';
import RefreshButton from '../components/RefreshButton';
import { EmptyState, Feedback } from '../components/Feedback';
import { useAutoRefresh } from '../clock';

// UC-018 Coordinate Vehicle Redistribution (Operator / Admin).
export default function Dispatch() {
  const [data, setData] = useState({ hubs: [], suggestions: [], handoffs: [], tasks: [] });
  const [users, setUsers] = useState({ hubs: [], suggestions: [], active: [], ended: [] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [toHubId, setToHubId] = useState('');
  const [reason, setReason] = useState('');
  const [uFrom, setUFrom] = useState('');
  const [uTo, setUTo] = useState('');
  const [uReason, setUReason] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try { const [d, u] = await Promise.all([api('/redistribution/overview'), api('/redistribution/user-redirects')]); setData(d); setUsers(u); } catch (e) { if (!silent) setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, 20);

  async function run(call, message) {
    setError(''); setSuccess('');
    try { await call(); setSuccess(message); await load(true); } catch (e) { setError(e.message); }
  }
  const create = (body, msg = 'Redistribution task created.') => run(() => api('/redistribution/tasks', { method: 'POST', body }), msg);
  const step = (id, action, msg) => run(() => api(`/redistribution/tasks/${id}/${action}`, { method: 'POST', body: {} }), msg);

  const redirect = (body, msg = 'Students have been asked to use the other Hub.') => run(() => api('/redistribution/user-redirects', { method: 'POST', body }), msg);
  const allVehicles = data.hubs.flatMap(h => h.bookableVehicles.map(v => ({ ...v, hubId: h.id, hubName: h.name })));
  const open = data.tasks.filter(t => ['Requested', 'In Progress'].includes(t.status));
  const closed = data.tasks.filter(t => !['Requested', 'In Progress'].includes(t.status));

  return <>
    <SectionHeader eyebrow="OPERATOR WORKFLOW · UC-018" title="Vehicle & User Redistribution" description="Balance shared vehicles between Hubs. The vehicle is held while it is moved and becomes available again at the destination." action={<RefreshButton onClick={() => load()}/>}/>
    <Feedback error={error} success={success}/>
    <div className="stat-grid compact-stats">
      {data.hubs.map(h => <StatCard key={h.id} icon="▦" label={h.name} value={`${h.available} bookable`} detail={`${h.freeSharedSlots}/${h.sharedSlotsTotal} free slots · +${h.incoming} in · −${h.outgoing} out`}/>)}
    </div>

    {data.handoffs.length > 0 && <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Recommendations from What-if Simulation</strong><span>{data.handoffs.length}</span></div>
      {data.handoffs.map(h => <div className="attention-item" key={h.id}><div><strong>{h.title}</strong><span>Sent {new Date(h.created_at).toLocaleString('en-GB')}</span></div>
        <button className="button small primary" onClick={() => run(() => api(`/redistribution/handoffs/${h.id}/plan`, { method: 'POST', body: {} }), 'Tasks created from the recommendation.')}>Plan tasks</button></div>)}
    </section>}

    <div className="content-grid two-col section-gap">
      <section className="card-surface padded">
        <div className="subsection-title"><strong>Suggested moves</strong><span>{data.suggestions.length}</span></div>
        {data.suggestions.length === 0 ? <EmptyState title="Hubs are balanced" description="No Hub has two or more bookable vehicles above another."/> : data.suggestions.map(s =>
          <div className="attention-item" key={s.vehicleId}><div><strong>{s.plate} · {s.fromHubName} → {s.toHubName}</strong><span>{s.reason}</span></div>
            <button className="button small primary" onClick={() => create({ vehicleId: s.vehicleId, toHubId: s.toHubId, reason: s.reason })}>Create task</button></div>)}
      </section>
      <section className="card-surface padded">
        <div className="subsection-title"><strong>Manual move</strong></div>
        <div className="trip-form">
          <label>Vehicle<select value={vehicleId} onChange={e => setVehicleId(e.target.value)}><option value="">Choose a vehicle</option>{allVehicles.map(v => <option key={v.id} value={v.id}>{v.plate} · {v.hubName} · {v.battery}%</option>)}</select></label>
          <label>Destination Hub<select value={toHubId} onChange={e => setToHubId(e.target.value)}><option value="">Choose a Hub</option>{data.hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
          <label>Reason<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional"/></label>
          <button className="button primary full" disabled={!vehicleId || !toHubId} onClick={() => create({ vehicleId, toHubId, reason }).then(() => { setVehicleId(''); setReason(''); })}>Create task</button>
        </div>
      </section>
    </div>

    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>User redistribution</strong><span>{users.active.length} active</span></div>
      <p className="hint">When a Hub is busy, ask students to use another Hub. Nothing is moved: students see a notice and get a notification.</p>
      {users.suggestions.map(s => <div className="attention-item" key={s.fromHubId}><div><strong>{s.fromHubName} → {s.toHubName}</strong><span>{s.reason}</span></div>
        <button className="button small primary" onClick={() => redirect({ fromHubId: s.fromHubId, toHubId: s.toHubId, reason: s.reason })}>Redirect users</button></div>)}
      {users.active.map(r => <div className="attention-item" key={r.id}><div><strong>{r.from_hub_name} → {r.to_hub_name}</strong><span>{r.reason}</span></div>
        <button className="button small ghost" onClick={() => run(() => api(`/redistribution/user-redirects/${r.id}/end`, { method: 'POST', body: {} }), 'Redirection ended.')}>End</button></div>)}
      {users.suggestions.length === 0 && users.active.length === 0 && <EmptyState title="No Hub needs a redirection" description="A suggestion appears when a Hub has no bookable vehicle or no free Shared slot."/>}
      <div className="trip-form">
        <label>Busy Hub<select value={uFrom} onChange={e => setUFrom(e.target.value)}><option value="">Choose a Hub</option>{users.hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <label>Send students to<select value={uTo} onChange={e => setUTo(e.target.value)}><option value="">Choose a Hub</option>{users.hubs.filter(h => h.id !== uFrom).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <label>Reason<input value={uReason} onChange={e => setUReason(e.target.value)} placeholder="Optional"/></label>
        <button className="button primary full" disabled={!uFrom || !uTo} onClick={() => redirect({ fromHubId: uFrom, toHubId: uTo, reason: uReason }).then(() => { setUFrom(''); setUTo(''); setUReason(''); })}>Redirect users</button>
      </div>
    </section>

    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Open tasks</strong><span>{open.length}</span></div>
      {open.length === 0 ? <EmptyState title="No open tasks" description="Created tasks appear here until the vehicle arrives."/> : <div className="table-wrap"><table className="responsive-table">
        <thead><tr><th>Vehicle</th><th>Route</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{open.map(t => <tr key={t.id}><td className="primary"><strong>{t.plate}</strong><small>{t.battery_level}%</small></td>
          <td data-label="Route">{t.from_hub_name} → {t.to_hub_name}{t.to_slot_code ? ` (${t.to_slot_code})` : ''}</td>
          <td data-label="Status"><StatusBadge value={t.status}/></td>
          <td className="actions"><div className="button-row">
            {t.status === 'Requested' && <button className="button small primary" onClick={() => step(t.id, 'start', 'Move started.')}>Start</button>}
            {t.status === 'In Progress' && <button className="button small primary" onClick={() => step(t.id, 'done', 'Vehicle delivered.')}>Delivered</button>}
            <button className="button small ghost" onClick={() => step(t.id, 'cancel', 'Task cancelled.')}>Cancel</button>
          </div></td></tr>)}</tbody>
      </table></div>}
    </section>
    {closed.length > 0 && <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>History</strong><span>{closed.length}</span></div>
      <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Vehicle</th><th>Route</th><th>Status</th></tr></thead>
        <tbody>{closed.map(t => <tr key={t.id}><td className="primary"><strong>{t.plate}</strong></td><td data-label="Route">{t.from_hub_name} → {t.to_hub_name}</td><td data-label="Status"><StatusBadge value={t.status}/></td></tr>)}</tbody></table></div>
    </section>}
  </>;
}
