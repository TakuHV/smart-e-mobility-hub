import { useEffect, useMemo, useState } from 'react';
import { api, isoToLocalInput } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';

function defaultDate(offsetMinutes) {
  return isoToLocalInput(new Date(Date.now() + offsetMinutes * 60000));
}

export default function Parking({ user }) {
  const [hubs, setHubs] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [slots, setSlots] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [hubId, setHubId] = useState('hub-central');
  const [vehicleId, setVehicleId] = useState('');
  const [slotId, setSlotId] = useState('');
  const [startAt, setStartAt] = useState(defaultDate(30));
  const [endAt, setEndAt] = useState(defaultDate(150));
  const [newPlate, setNewPlate] = useState('');
  const [newVehicleType, setNewVehicleType] = useState('Car');
  const [newConnector, setNewConnector] = useState('Type2');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function load() {
    setError('');
    try {
      const [h,v,r,s] = await Promise.all([
        api('/hubs'), api('/vehicles?kind=personal'), api('/parking/reservations'), api('/parking/slots?slotType=Personal')
      ]);
      setHubs(h.hubs); setVehicles(v.vehicles); setReservations(r.reservations); setSlots(s.slots);
      if (!hubId && h.hubs[0]) setHubId(h.hubs[0].id);
      if (!vehicleId && v.vehicles[0]) setVehicleId(v.vehicles[0].id);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  const availableSlots = useMemo(() => slots.filter(s=>s.hub_id===hubId && s.status==='Available'), [slots,hubId]);

  async function addVehicle(event) {
    event.preventDefault(); setError(''); setSuccess('');
    try {
      const result = await api('/vehicles/personal',{method:'POST',body:{plate:newPlate,vehicleType:newVehicleType,connectorType:newConnector,hubId:hubId || 'hub-central'}});
      setVehicles(old=>[...old,result.vehicle]); setVehicleId(result.vehicle.id); setNewPlate(''); setSuccess('Personal vehicle registered.');
    } catch(err){setError(err.message);}
  }
  async function reserve(event) {
    event.preventDefault(); setError(''); setSuccess('');
    try {
      const result = await api('/parking/reservations',{method:'POST',body:{vehicleId,hubId,slotId,startAt:new Date(startAt).toISOString(),endAt:new Date(endAt).toISOString()}});
      setSuccess(`Reservation ${result.reservation.id} confirmed. Arrival hold expires at ${new Date(result.reservation.expires_at).toLocaleTimeString()}.`);
      setSlotId(''); await load();
    } catch(err){setError(err.message);}
  }
  async function action(id, name) {
    setError(''); setSuccess('');
    try {
      await api(`/parking/reservations/${id}/${name}`,{method:'POST',body:{}});
      setSuccess(name==='arrive'?'Arrival recorded. Parking spot is now Occupied.':name==='complete'?'Vehicle departure recorded. Slot released.':'Reservation cancelled.');
      await load();
    } catch(err){setError(err.message);}
  }

  return <>
    <SectionHeader eyebrow="STUDENT WORKFLOW · UC-008" title="Personal Parking" description="Register a personal EV and reserve a compatible Personal slot for a selected time period." action={<button className="button secondary" onClick={load}>↻ Refresh</button>}/>
    <Feedback error={error} success={success}/>
    <div className="content-grid two-col">
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">VEHICLE PROFILE</span><h3>Personal vehicle</h3></div><span className="mini-icon">▣</span></div>
        <label>Saved vehicle<select value={vehicleId} onChange={e=>setVehicleId(e.target.value)}><option value="">Choose a personal vehicle</option>{vehicles.map(v=><option key={v.id} value={v.id}>{v.plate} · {v.vehicle_type} · {v.connector_type}</option>)}</select></label>
        <div className="divider-label"><span>or register a vehicle</span></div>
        <form className="form-grid" onSubmit={addVehicle}>
          <label className="span-2">License plate<input value={newPlate} onChange={e=>setNewPlate(e.target.value)} placeholder="51A-123.45" required/></label>
          <label>Vehicle type<select value={newVehicleType} onChange={e=>setNewVehicleType(e.target.value)}><option>Car</option><option>Motorcycle</option></select></label>
          <label>Connector type<select value={newConnector} onChange={e=>setNewConnector(e.target.value)}><option>Type2</option><option>GB/T</option></select></label>
          <button className="button secondary span-2" type="submit">＋ Add personal vehicle</button>
        </form>
      </section>
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">UC-008 · BR-12 / BR-16 / BR-24</span><h3>Reserve a parking spot</h3></div><span className="mini-icon">▤</span></div>
        <form className="form-stack" onSubmit={reserve}>
          <label>Mobility Hub<select value={hubId} onChange={e=>{setHubId(e.target.value);setSlotId('');}}>{hubs.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
          <label>Available Personal slot<select value={slotId} onChange={e=>setSlotId(e.target.value)} required><option value="">Choose a free slot</option>{availableSlots.map(s=><option key={s.id} value={s.id}>{s.code} · {s.hub_name}</option>)}</select></label>
          <div className="form-grid">
            <label>Start time<input type="datetime-local" value={startAt} onChange={e=>setStartAt(e.target.value)} required/></label>
            <label>End time<input type="datetime-local" value={endAt} onChange={e=>setEndAt(e.target.value)} required/></label>
          </div>
          <button className="button primary full" type="submit" disabled={!vehicleId || !slotId}>Confirm parking reservation <span>→</span></button>
        </form>
        <p className="helper-text">Personal vehicles use Personal slots only. The arrival hold is 15 minutes after the reservation start. Parking periods cannot overlap active charging periods for the same vehicle.</p>
      </section>
    </div>
    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Parking reservations</strong><span>{reservations.length} records</span></div>
      {reservations.length===0 ? <EmptyState title="No parking reservations" description="Your confirmed, active and completed reservations will appear here."/> : <div className="table-wrap"><table>
        <thead><tr><th>Vehicle</th><th>Hub / Slot</th><th>Period</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{reservations.map(r=><tr key={r.id}><td><strong>{r.plate}</strong><small>{r.vehicle_type}</small></td><td>{r.hub_name}<small>{r.slot_code}</small></td><td>{new Date(r.start_at).toLocaleString()}<small>to {new Date(r.end_at).toLocaleTimeString()}</small></td><td><StatusBadge value={r.status}/></td><td>
          <div className="button-row">{r.status==='Confirmed' && <><button className="button small primary" onClick={()=>action(r.id,'arrive')}>Arrived</button><button className="button small ghost" onClick={()=>action(r.id,'cancel')}>Cancel</button></>}{r.status==='In Progress' && <button className="button small secondary" onClick={()=>action(r.id,'complete')}>Vehicle departed</button>}</div>
        </td></tr>)}</tbody>
      </table></div>}
    </section>
  </>;
}
