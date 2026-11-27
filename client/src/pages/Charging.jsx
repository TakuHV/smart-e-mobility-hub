import { useEffect, useState } from 'react';
import { api, isoToLocalInput, localInputToIso } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';
import RefreshButton from '../components/RefreshButton';
import { scrollTopOnPhone } from '../hooks';
import { virtualNow, useClockState, useAutoRefresh } from '../clock';
import { Countdown, ElapsedBar } from '../components/Timers';

const fmtTime = value => (value ? new Date(value).toLocaleTimeString() : '—');
const fmtDateTime = value => (value ? new Date(value).toLocaleString() : 'Not set');

export default function Charging({ user }) {
  const [hubs, setHubs] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [hubId, setHubId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [battery, setBattery] = useState(35);
  const [nextUse, setNextUse] = useState(isoToLocalInput(new Date(virtualNow() + 90 * 60000)));
  const [data, setData] = useState({ requests: [], chargers: [], moveRequests: [] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const isOperator = ['Operator', 'Admin'].includes(user.role);
  const isStudent = user.role === 'Student';
  // The owner of a personal vehicle moves it themselves, so they may start and confirm its Move Vehicle Requests.
  const myVehicleIds = new Set(isStudent ? vehicles.map(v => v.id) : []);

  const { limits } = useClockState();
  async function load(silent) {
    if (silent !== true) setError('');
    try {
      const [h, v, q] = await Promise.all([api('/hubs'), api('/vehicles?kind=personal'), api('/charging/queue')]);
      setHubs(h.hubs); setVehicles(v.vehicles); setData(q);
      setVehicleId(prev => prev || v.vehicles[0]?.id || '');
      setHubId(prev => prev || v.vehicles[0]?.hub_id || h.hubs[0]?.id || '');
    } catch (err) { if (silent !== true) setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  useAutoRefresh(load, 15);

  async function register(event) {
    event.preventDefault(); setError(''); setSuccess('');
    const nextRequiredUsageAt = localInputToIso(nextUse);
    if (!nextRequiredUsageAt) { setError('Enter a valid Next Required Usage Time.'); return; }
    try {
      await api('/charging/requests', { method: 'POST', body: { hubId, vehicleId, batteryLevel: Number(battery), nextRequiredUsageAt } });
      setSuccess('Charging request registered in the common queue. The Charging Scheduler evaluated the request.');
      await load(); scrollTopOnPhone();
    } catch (err) { setError(err.message); }
  }
  async function action(path, message) {
    setError(''); setSuccess('');
    try { await api(path, { method: 'POST', body: {} }); setSuccess(message); await load(); scrollTopOnPhone(); }
    catch (err) { setError(err.message); }
  }
  const runScheduler = () => action('/charging/run-scheduler', 'Scheduler cycle completed. Power limit and connector compatibility were checked.');
  async function updateUsage(req) {
    const suggestion = req.next_required_usage_at ? isoToLocalInput(req.next_required_usage_at) : isoToLocalInput(new Date(virtualNow() + 60 * 60000));
    const value = prompt('Enter the new Next Required Usage Time (local format YYYY-MM-DDTHH:mm)', suggestion);
    if (!value) return;
    const iso = localInputToIso(value);
    setError(''); setSuccess('');
    if (!iso) { setError('That is not a valid date and time.'); return; }
    try {
      await api(`/charging/requests/${req.id}/next-use`, { method: 'PATCH', body: { nextRequiredUsageAt: iso } });
      setSuccess('Next Required Usage Time updated. The Scheduler re-evaluated the queue.'); await load();
    } catch (err) { setError(err.message); }
  }

  return <>
    <SectionHeader eyebrow="UC-009 · UC-021 · UC-022" title="Smart Charging" description="One common charging area for shared and personal EVs. The backend manages queue order, charger assignments and Move Vehicle Requests." action={<RefreshButton onClick={load}/>}/>
    <Feedback error={error} success={success}/>
    <div className="charging-layout">
      <section className="card-surface padded request-panel">
        <div className="section-mini-head"><div><span className="eyebrow">UC-009</span><h3>{isStudent ? 'Register personal charging demand' : 'Charging controls'}</h3></div><span className="mini-icon">ϟ</span></div>
        {isStudent ? <form className="form-stack" onSubmit={register}>
          <label>Personal vehicle<select value={vehicleId} onChange={e => { setVehicleId(e.target.value); const next = vehicles.find(v => v.id === e.target.value); if (next?.hub_id) setHubId(next.hub_id); }} required><option value="">Choose vehicle</option>{vehicles.map(v => <option value={v.id} key={v.id}>{v.plate} · {v.connector_type} · {v.status}</option>)}</select></label>
          <label>Mobility Hub<select value={hubId} onChange={e => setHubId(e.target.value)}>{hubs.map(h => <option value={h.id} key={h.id}>{h.name}</option>)}</select></label>
          <label>Current battery (%)<input type="number" min="0" max="100" value={battery} onChange={e => setBattery(e.target.value)}/></label>
          <label>Next Required Usage Time<input type="datetime-local" value={nextUse} onChange={e => setNextUse(e.target.value)} required/></label>
          <button className="button primary full sticky-cta" disabled={!vehicleId}>Join charging queue <span>→</span></button>
          <p className="hint">The vehicle must be at the selected Hub, and the period must be inside its operating hours on the same day.</p>
        </form> : <div className="form-stack">
          <p className="muted-text">Run the Charging Scheduler on demand, move vehicles and adjust the Next Required Usage Time of shared vehicles. Personal charging requests are registered by students.</p>
          {isOperator && <button className="button primary full" onClick={runScheduler}>▶ Run scheduler now</button>}
        </div>}
        <div className="rule-callout"><strong>Scheduler criteria</strong><span>Battery Level · Next Required Usage Time · Waiting Duration · Hub Power Limit</span><small>Class H (very low battery or needed soon) is served before class L. The weights are proposed values from the Technical Design Document and have not been approved by the group.</small></div>
      </section>
      <section className="card-surface padded queue-panel">
        <div className="section-mini-head"><div><span className="eyebrow">UC-021 / UC-022</span><h3>Charging queue & assignments</h3></div>{isOperator && <button className="button small secondary" onClick={runScheduler}>▶ Run scheduler</button>}</div>
        <div className="queue-summary"><div><b>{data.requests.filter(r => r.status === 'Queued').length}</b><span>Queued</span></div><div><b>{data.requests.filter(r => r.status === 'Assigned').length}</b><span>Assigned</span></div><div><b>{data.requests.filter(r => r.status === 'Charging').length}</b><span>Charging</span></div><div><b>{data.chargers.filter(c => c.status === 'Available').length}</b><span>Free chargers</span></div></div>
        {data.requests.length === 0 ? <EmptyState title="No charging requests" description="A personal request or a low-battery shared vehicle will appear here."/> : <div className="table-wrap"><table className="responsive-table">
          <thead><tr><th>Vehicle</th><th>Hub</th><th className="num">Battery</th><th>Next use</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{data.requests.map(r => <tr key={r.id}>
            <td className="primary"><strong>{r.plate}</strong><small>{r.request_type === 'shared_automatic' ? 'Shared · automatic' : 'Personal'}{r.priority_class ? ` · class ${r.priority_class}` : ''} · score {Number(r.priority_score || 0).toFixed(1)}</small></td>
            <td data-label="Hub">{r.hub_name}</td><td className="num" data-label="Battery">{r.battery_level}%</td><td data-label="Next use">{fmtDateTime(r.next_required_usage_at)}</td>
            <td data-label="Status"><StatusBadge value={r.status}/><small>{r.charger_code || (r.estimated_start_at ? `Est. start ${fmtTime(r.estimated_start_at)}` : 'Estimate pending')}</small>
              {r.status === 'Assigned' && r.connect_deadline && r.request_type === 'personal' && <small><Countdown until={r.connect_deadline} label="Connect within" overLabel="expired"/></small>}
              {r.status === 'Queued' && r.estimated_start_at && <small><Countdown until={r.estimated_start_at} label="Est. start in" overLabel="due" warnSeconds={0}/></small>}
              {r.status === 'Charging' && r.charging_started_at && <ElapsedBar since={r.charging_started_at} limitMinutes={limits?.maxSessionMinutes || undefined} label={`Charging ${r.battery_level}% → ${limits?.targetBatteryPercent ?? 90}%`}/>}
              {r.overstay_flagged_at && <small className="countdown is-over">Still at charger — move it away</small>}</td>
            <td className="actions"><div className="button-row">
              {r.status === 'Assigned' && r.request_type === 'personal' && r.user_id === user.id && <button className="button small primary" onClick={() => action(`/charging/requests/${r.id}/connect`, 'Vehicle connected. Charging session started.')}>Connect vehicle</button>}
              {r.status === 'Charging' && (isOperator || r.user_id === user.id) && <button className="button small secondary" onClick={() => action(`/charging/requests/${r.id}/complete`, 'Charging completed. A Move Vehicle Request was created; the charger stays occupied until the removal is Done.')}>Complete</button>}
              {isOperator && r.kind === 'shared' && ['Queued', 'Assigned'].includes(r.status) && <button className="button small ghost" onClick={() => updateUsage(r)}>Next use</button>}
            </div></td></tr>)}</tbody>
        </table></div>}
      </section>
    </div>
    <div className="content-grid two-col section-gap">
      <section className="card-surface padded"><div className="subsection-title"><strong>Charger status</strong><span>Shared charging area per Hub</span></div>
        <div className="charger-list large">{data.chargers.map(c => <div className="charger-row" key={c.id}><div><strong>{c.code}</strong><small>{c.hub_name} · {c.power_kw} kW</small></div><span>{c.vehicle_plate || 'No vehicle'}</span><StatusBadge value={c.status}/></div>)}</div>
      </section>
      <section className="card-surface padded"><div className="subsection-title"><strong>Move Vehicle Requests</strong><span>A charger is released only when the removal is Done</span></div>
        {data.moveRequests.length === 0 ? <EmptyState title="No movement requests" description="Shared vehicle charger assignments and completed charging sessions create movement requests."/> : <div className="move-list">{data.moveRequests.map(m => {
          const canAct = isOperator || myVehicleIds.has(m.vehicle_id);
          return <div className="move-card" key={m.id}>
            <div className="move-card-head"><div><strong>{m.plate}</strong><small>{m.direction === 'TO_CHARGER' ? 'Move to charger' : 'Move away from charger'} · {m.charger_code}</small></div><StatusBadge value={m.status}/></div>
            <div className="move-card-foot"><span>{m.hub_name}</span>{canAct && <div className="button-row">
              {m.status === 'Requested' && <button className="button small ghost" onClick={() => action(`/charging/move-requests/${m.id}/start`, 'Move Vehicle Request is now In Progress.')}>Start</button>}
              {m.status === 'In Progress' && <button className="button small primary" onClick={() => action(`/charging/move-requests/${m.id}/done`, 'Movement confirmed. Charger state has been updated.')}>Confirm Done</button>}
              {isOperator && m.status === 'Requested' && m.direction === 'TO_CHARGER' && <button className="button small ghost" onClick={() => action(`/charging/move-requests/${m.id}/cancel`, 'Move request cancelled. The charging request returned to the queue.')}>Cancel</button>}
            </div>}</div>
          </div>;
        })}</div>}
      </section>
    </div>
  </>;
}
