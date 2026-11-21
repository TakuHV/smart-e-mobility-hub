import { useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';

export default function SharedVehicle({ user }) {
  const [vehicles, setVehicles] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [slots, setSlots] = useState([]);
  const [hubId, setHubId] = useState('');
  const [hubs, setHubs] = useState([]);
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [returnSlotId, setReturnSlotId] = useState('');
  const [battery, setBattery] = useState(68);
  const [reportProblem, setReportProblem] = useState(false);
  const [problemNote, setProblemNote] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function load() {
    setError('');
    try {
      const [v,b,h,s] = await Promise.all([
        api('/vehicles?kind=shared'), api('/vehicles/bookings'), api('/hubs'), api('/parking/slots?slotType=Shared')
      ]);
      setVehicles(v.vehicles); setBookings(b.bookings); setHubs(h.hubs); setSlots(s.slots);
      if (!hubId && h.hubs[0]) setHubId(h.hubs[0].id);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  const activeTrip = bookings.find(b=>['In Progress','Overdue'].includes(b.status));
  const available = vehicles.filter(v=>v.status==='Available' && v.battery_level>=20 && (!hubId || v.hub_id===hubId));
  const returnSlots = slots.filter(s=>s.status==='Available');

  async function book() {
    setError(''); setSuccess('');
    try { const result = await api('/vehicles/bookings',{method:'POST',body:{vehicleId:selectedVehicle}});
      setSuccess(`Booking ${result.booking.id} confirmed. Pickup deadline: ${new Date(result.booking.pickup_deadline).toLocaleTimeString()}.`); await load();
    } catch(err){setError(err.message);}
  }
  async function pickup(id) {
    setError(''); setSuccess('');
    try { await api(`/vehicles/bookings/${id}/pickup`,{method:'POST',body:{}}); setSuccess('Pickup recorded. The trip is now In Progress.'); await load(); }
    catch(err){setError(err.message);}
  }
  async function cancel(id) {
    setError(''); setSuccess('');
    try { await api(`/vehicles/bookings/${id}/cancel`,{method:'POST',body:{}}); setSuccess('Booking cancelled and vehicle released.'); await load(); }
    catch(err){setError(err.message);}
  }
  async function returnVehicle(id) {
    setError(''); setSuccess('');
    try {
      const result = await api(`/vehicles/bookings/${id}/return`,{method:'POST',body:{returnSlotId,batteryLevel:Number(battery),reportProblem,problemNote}});
      setSuccess(result.chargingQueued ? 'Return completed. Vehicle battery is below 20%; an automatic charging request was queued.' : 'Return completed successfully.');
      await load();
    } catch(err){setError(err.message);}
  }

  return <>
    <SectionHeader eyebrow="STUDENT WORKFLOW · UC-005 / UC-006 / UC-007" title="Shared Vehicle Lifecycle" description="Book an available shared EV, pick it up and return it to a free Shared slot." action={<button className="button secondary" onClick={load}>↻ Refresh</button>}/>
    <Feedback error={error} success={success}/>
    {user.role !== 'Student' && <div className="feedback is-info">You are signed in as {user.role}. This page is designed primarily for the Student booking workflow.</div>}
    <div className="content-grid two-col">
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">UC-005</span><h3>Book a shared vehicle</h3></div><span className="mini-icon">↗</span></div>
        <label>Pickup Hub<select value={hubId} onChange={e=>setHubId(e.target.value)}>{hubs.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <div className="vehicle-grid">
          {available.length===0 ? <EmptyState title="No bookable vehicles" description="Available vehicles require at least 20% battery."/> : available.map(v=><button key={v.id} className={`vehicle-card ${selectedVehicle===v.id?'chosen':''}`} onClick={()=>setSelectedVehicle(v.id)}>
            <div className="vehicle-card-top"><span className="vehicle-symbol">EV</span><StatusBadge value={v.status}/></div>
            <strong>{v.plate}</strong><span>{v.vehicle_type} · {v.hub_name}</span>
            <div className="battery-line"><span>Battery</span><b>{v.battery_level}%</b></div><div className="battery-track"><i style={{width:`${v.battery_level}%`}}/></div>
          </button>)}
        </div>
        <button className="button primary full" disabled={!selectedVehicle} onClick={book}>Confirm booking <span>→</span></button>
        <p className="helper-text">BR-10: battery ≥20%. BR-11: 15-minute pickup hold. Suspended students cannot book.</p>
      </section>
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">UC-006 / UC-007</span><h3>Active trip & return</h3></div><span className="mini-icon">⌁</span></div>
        {activeTrip ? <div className="active-trip">
          <div className="active-trip-head"><div><span className="hub-code">{activeTrip.id.slice(0,14)}</span><h4>{activeTrip.plate}</h4><span>{activeTrip.hub_name}</span></div><StatusBadge value={activeTrip.status}/></div>
          <div className="trip-form">
            <label>Return to free Shared slot<select value={returnSlotId} onChange={e=>setReturnSlotId(e.target.value)}><option value="">Choose a Shared slot</option>{returnSlots.map(s=><option key={s.id} value={s.id}>{s.hub_name} · {s.code}</option>)}</select></label>
            <label>Battery level on return (%)<input type="number" min="0" max="100" value={battery} onChange={e=>setBattery(e.target.value)}/></label>
            <label className="checkbox-label"><input type="checkbox" checked={reportProblem} onChange={e=>setReportProblem(e.target.checked)}/> Report a vehicle problem</label>
            {reportProblem && <label>Problem details<textarea rows="2" value={problemNote} onChange={e=>setProblemNote(e.target.value)} placeholder="Describe the reported issue"/></label>}
            <button className="button primary full" disabled={!returnSlotId} onClick={()=>returnVehicle(activeTrip.id)}>Complete vehicle return</button>
          </div>
          <p className="helper-text">A return to a Shared slot is required. Battery below 20% automatically joins the Charging Scheduler queue.</p>
        </div> : <EmptyState title="No active trip" description="Pick up a confirmed booking to start a trip, then return the vehicle here."/>}
      </section>
    </div>
    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>My bookings & trip history</strong><span>{bookings.length} records</span></div>
      {bookings.length===0 ? <EmptyState title="No bookings yet" description="Your shared-vehicle bookings will appear here."/> : <div className="table-wrap"><table>
        <thead><tr><th>Vehicle</th><th>Hub</th><th>Status</th><th>Pickup deadline</th><th>Action</th></tr></thead>
        <tbody>{bookings.map(b=><tr key={b.id}><td><strong>{b.plate}</strong><small>{b.id.slice(0,12)}</small></td><td>{b.hub_name}</td><td><StatusBadge value={b.status}/></td><td>{new Date(b.pickup_deadline).toLocaleString()}</td><td>
          {b.status==='Confirmed' ? <div className="button-row"><button className="button small primary" onClick={()=>pickup(b.id)}>Pick up</button><button className="button small ghost" onClick={()=>cancel(b.id)}>Cancel</button></div> : '—'}
        </td></tr>)}</tbody>
      </table></div>}
    </section>
  </>;
}
