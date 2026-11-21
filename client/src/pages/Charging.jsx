import { useEffect, useState } from 'react';
import { api, isoToLocalInput } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';

export default function Charging({ user }) {
  const [hubs, setHubs] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [hubId, setHubId] = useState('hub-central');
  const [vehicleId, setVehicleId] = useState('');
  const [battery, setBattery] = useState(35);
  const [nextUse, setNextUse] = useState(isoToLocalInput(new Date(Date.now()+4*3600000)));
  const [data, setData] = useState({requests:[],chargers:[],moveRequests:[]});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const isOperator = ['Operator','Admin'].includes(user.role);

  async function load() {
    setError('');
    try {
      const [h,v,q] = await Promise.all([api('/hubs'),api('/vehicles?kind=personal'),api('/charging/queue')]);
      setHubs(h.hubs); setVehicles(v.vehicles); setData(q);
      if (!hubId && h.hubs[0]) setHubId(h.hubs[0].id);
      if (!vehicleId && v.vehicles[0]) setVehicleId(v.vehicles[0].id);
    } catch(err){setError(err.message);}
  }
  useEffect(()=>{load();},[]);

  async function register(event) {
    event.preventDefault();setError('');setSuccess('');
    try {
      await api('/charging/requests',{method:'POST',body:{hubId,vehicleId,batteryLevel:Number(battery),nextRequiredUsageAt:new Date(nextUse).toISOString()}});
      setSuccess('Charging request registered in the common queue. The Charging Scheduler evaluated the request.');
      await load();
    } catch(err){setError(err.message);}
  }
  async function action(path, message) {
    setError('');setSuccess('');
    try { await api(path,{method:'POST',body:{}});setSuccess(message);await load(); }
    catch(err){setError(err.message);}
  }
  async function runScheduler() { await action('/charging/run-scheduler','Scheduler cycle completed. Power limit and connector compatibility were checked.'); }
  async function updateUsage(req) {
    const val = prompt('Enter new Next Required Usage Time (local format YYYY-MM-DDTHH:mm)', isoToLocalInput(req.next_required_usage_at));
    if (!val) return;
    setError('');setSuccess('');
    try { await api(`/charging/requests/${req.id}/next-use`,{method:'PATCH',body:{nextRequiredUsageAt:new Date(val).toISOString()}}); setSuccess('Next Required Usage Time updated. Scheduler re-evaluated the queue.'); await load(); }
    catch(err){setError(err.message);}
  }

  return <>
    <SectionHeader eyebrow="UC-009 · UC-021 · UC-022 · BR-19 TO BR-47" title="Smart Charging" description="One common charging area for shared and personal EVs. The backend manages queue order, charger assignments and Move Vehicle Requests." action={<button className="button secondary" onClick={load}>↻ Refresh</button>}/>
    <Feedback error={error} success={success}/>
    <div className="charging-layout">
      <section className="card-surface padded request-panel">
        <div className="section-mini-head"><div><span className="eyebrow">UC-009</span><h3>Register personal charging demand</h3></div><span className="mini-icon">ϟ</span></div>
        <form className="form-stack" onSubmit={register}>
          <label>Mobility Hub<select value={hubId} onChange={e=>setHubId(e.target.value)}>{hubs.map(h=><option value={h.id} key={h.id}>{h.name}</option>)}</select></label>
          <label>Personal vehicle<select value={vehicleId} onChange={e=>setVehicleId(e.target.value)} required><option value="">Choose vehicle</option>{vehicles.map(v=><option value={v.id} key={v.id}>{v.plate} · {v.connector_type} · {v.status}</option>)}</select></label>
          <label>Current battery (%)<input type="number" min="0" max="100" value={battery} onChange={e=>setBattery(e.target.value)}/></label>
          <label>Next Required Usage Time<input type="datetime-local" value={nextUse} onChange={e=>setNextUse(e.target.value)} required/></label>
          <button className="button primary full" disabled={!vehicleId}>Join charging queue <span>→</span></button>
        </form>
        <div className="rule-callout"><strong>Scheduler criteria</strong><span>Battery Level · Next Required Usage Time · Waiting Duration · Hub Power Limit</span><small>Weights are configurable placeholders in this demo and have not been approved by the group.</small></div>
      </section>
      <section className="card-surface padded queue-panel">
        <div className="section-mini-head"><div><span className="eyebrow">UC-021 / UC-022</span><h3>Charging queue & assignments</h3></div>{isOperator && <button className="button small secondary" onClick={runScheduler}>▶ Run scheduler</button>}</div>
        <div className="queue-summary"><div><b>{data.requests.filter(r=>r.status==='Queued').length}</b><span>Queued</span></div><div><b>{data.requests.filter(r=>r.status==='Assigned').length}</b><span>Assigned</span></div><div><b>{data.requests.filter(r=>r.status==='Charging').length}</b><span>Charging</span></div><div><b>{data.chargers.filter(c=>c.status==='Available').length}</b><span>Free chargers</span></div></div>
        {data.requests.length===0 ? <EmptyState title="No charging requests" description="A personal request or a low-battery shared vehicle will appear here."/> : <div className="table-wrap"><table>
          <thead><tr><th>Queue / Vehicle</th><th>Hub</th><th>Battery</th><th>Next use</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{data.requests.map(r=><tr key={r.id}><td><strong>{r.plate}</strong><small>{r.request_type==='shared_automatic'?'Shared · automatic':'Personal'} · score {Number(r.priority_score||0).toFixed(2)}</small></td><td>{r.hub_name}</td><td>{r.battery_level}%</td><td>{new Date(r.next_required_usage_at).toLocaleString()}</td><td><StatusBadge value={r.status}/><small>{r.charger_code || (r.estimated_start_at ? `Est. ${new Date(r.estimated_start_at).toLocaleTimeString()}` : 'Estimate pending')}</small></td><td><div className="button-row">
            {r.status==='Assigned' && r.request_type==='personal' && r.user_id===user.id && <button className="button small primary" onClick={()=>action(`/charging/requests/${r.id}/connect`,'Vehicle connected. Charging session started.')}>Connect vehicle</button>}
            {r.status==='Charging' && (isOperator || r.user_id===user.id) && <button className="button small secondary" onClick={()=>action(`/charging/requests/${r.id}/complete`,'Charging completed. A Move Vehicle Request was created; the charger remains occupied until removal is Done.')}>Complete</button>}
            {isOperator && r.kind==='shared' && ['Queued','Assigned'].includes(r.status) && <button className="button small ghost" onClick={()=>updateUsage(r)}>Next use</button>}
          </div></td></tr>)}</tbody>
        </table></div>}
      </section>
    </div>
    <div className="content-grid two-col section-gap">
      <section className="card-surface padded"><div className="subsection-title"><strong>Charger status</strong><span>Shared charging area per Hub</span></div>
        <div className="charger-list large">{data.chargers.map(c=><div className="charger-row" key={c.id}><div><strong>{c.code}</strong><small>{c.hub_name} · {c.power_kw} kW</small></div><span>{c.vehicle_plate || 'No vehicle'}</span><StatusBadge value={c.status}/></div>)}</div>
      </section>
      <section className="card-surface padded"><div className="subsection-title"><strong>Move Vehicle Requests</strong><span>BR-46 · Charger release requires Done</span></div>
        {data.moveRequests.length===0 ? <EmptyState title="No movement requests" description="Shared vehicle charger assignments and completed charging sessions create movement requests."/> : <div className="move-list">{data.moveRequests.map(m=><div className="move-card" key={m.id}>
          <div className="move-card-head"><div><strong>{m.plate}</strong><small>{m.direction==='TO_CHARGER'?'Move to charger':'Move away from charger'} · {m.charger_code}</small></div><StatusBadge value={m.status}/></div>
          <div className="move-card-foot"><span>{m.hub_name}</span>{isOperator && <div className="button-row">{m.status==='Requested' && <button className="button small ghost" onClick={()=>action(`/charging/move-requests/${m.id}/start`,'Move Vehicle Request is now In Progress.')}>Start</button>}{['Requested','In Progress'].includes(m.status) && <button className="button small primary" onClick={()=>action(`/charging/move-requests/${m.id}/done`,'Movement confirmed. Charger state has been updated.')}>Confirm Done</button>}</div>}</div>
        </div>)}</div>}
      </section>
    </div>
  </>;
}
