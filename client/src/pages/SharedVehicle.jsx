import { useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';

const fmtTime = value => (value ? new Date(value).toLocaleTimeString() : '—');
const fmtDateTime = value => (value ? new Date(value).toLocaleString() : '—');

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
      const [v, b, h, s] = await Promise.all([
        api('/vehicles?kind=shared'), api('/vehicles/bookings'), api('/hubs'), api('/parking/slots?slotType=Shared')
      ]);
      setVehicles(v.vehicles); setBookings(b.bookings); setHubs(h.hubs); setSlots(s.slots);
      setHubId(prev => prev || h.hubs[0]?.id || '');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  const isStudent = user.role === 'Student';
  const activeTrip = bookings.find(b => ['In Progress', 'Overdue'].includes(b.status));
  const hub = hubs.find(h => h.id === hubId);
  const available = vehicles.filter(v => v.status === 'Available' && v.battery_level >= 20 && (!hubId || v.hub_id === hubId));
  const returnSlots = slots.filter(s => s.status === 'Available');
  const tripMinutes = activeTrip?.started_at ? Math.round((Date.now() - Date.parse(activeTrip.started_at)) / 60000) : null;

  async function run(call, message) {
    setError(''); setSuccess('');
    try { const result = await call(); setSuccess(typeof message === 'function' ? message(result) : message); await load(); return result; }
    catch (err) { setError(err.message); return null; }
  }
  const book = () => run(() => api('/vehicles/bookings', { method: 'POST', body: { vehicleId: selectedVehicle } }),
    r => `Booking confirmed. Pick up the vehicle before ${fmtTime(r.booking.pickup_deadline)}.`).then(r => { if (r) setSelectedVehicle(''); });
  const pickup = id => run(() => api(`/vehicles/bookings/${id}/pickup`, { method: 'POST', body: {} }), 'Pickup recorded. The trip is now In Progress.');
  const cancel = id => run(() => api(`/vehicles/bookings/${id}/cancel`, { method: 'POST', body: {} }), 'Booking cancelled and vehicle released.');
  const returnVehicle = id => run(
    () => api(`/vehicles/bookings/${id}/return`, { method: 'POST', body: { returnSlotId, batteryLevel: Number(battery), reportProblem, problemNote } }),
    r => (r.incidentCreated ? 'Return completed. A problem report was opened and the vehicle is out of service.'
      : r.chargingQueued ? 'Return completed. Battery is below 20%, so an automatic charging request was queued.' : 'Return completed successfully.')
  ).then(r => { if (r) { setReturnSlotId(''); setReportProblem(false); setProblemNote(''); } });

  return <>
    <SectionHeader eyebrow="STUDENT WORKFLOW · UC-005 / UC-006 / UC-007" title="Shared Vehicle Lifecycle" description="Book an available shared EV, pick it up and return it to a free Shared slot." action={<button className="button secondary" onClick={load}>↻ Refresh</button>}/>
    <Feedback error={error} success={success}/>
    {!isStudent && <div className="feedback is-info">You are signed in as {user.role}. Booking, pickup and return are student actions; this page only shows them.</div>}
    <div className="content-grid two-col">
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">UC-005</span><h3>Book a shared vehicle</h3></div><span className="mini-icon">↗</span></div>
        <label>Pickup Hub<select value={hubId} onChange={e => { setHubId(e.target.value); setSelectedVehicle(''); }}>{hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        {hub && !hub.open_now && <div className="feedback is-warning section-gap-small">This Hub is closed. New bookings are accepted only during {hub.open_time}–{hub.close_time}.</div>}
        <div className="vehicle-grid">
          {available.length === 0 ? <EmptyState title="No bookable vehicles" description="Available vehicles require at least 20% battery."/> : available.map(v => <button type="button" key={v.id} className={`vehicle-card ${selectedVehicle === v.id ? 'chosen' : ''}`} onClick={() => setSelectedVehicle(v.id)}>
            <div className="vehicle-card-top"><span className="vehicle-symbol">EV</span><StatusBadge value={v.status}/></div>
            <strong>{v.plate}</strong><span>{v.vehicle_type} · {v.hub_name}</span>
            <div className="battery-line"><span>Battery</span><b>{v.battery_level}%</b></div><div className="battery-track"><i style={{ width: `${v.battery_level}%` }}/></div>
          </button>)}
        </div>
        <button className="button primary full" disabled={!selectedVehicle || !isStudent} onClick={book}>Confirm booking <span>→</span></button>
        <p className="helper-text">Battery must be at least 20%, the vehicle is held for 15 minutes, and you can hold one active booking. Suspended students cannot book.</p>
      </section>
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">UC-006 / UC-007</span><h3>Active trip & return</h3></div><span className="mini-icon">⌁</span></div>
        {activeTrip ? <div className="active-trip">
          <div className="active-trip-head"><div><span className="hub-code">{activeTrip.id.slice(0, 14)}</span><h4>{activeTrip.plate}</h4><span>{activeTrip.hub_name}{tripMinutes != null ? ` · started ${tripMinutes} min ago` : ''}</span></div><StatusBadge value={activeTrip.status}/></div>
          {tripMinutes != null && tripMinutes >= 150 && <div className="feedback is-warning">The trip is close to the 3-hour limit. A longer trip records one violation point.</div>}
          <div className="trip-form">
            <label>Return to free Shared slot<select value={returnSlotId} onChange={e => setReturnSlotId(e.target.value)}><option value="">Choose a Shared slot</option>{returnSlots.map(s => <option key={s.id} value={s.id}>{s.hub_name} · {s.code}</option>)}</select></label>
            <label>Battery level on return (%)<input type="number" min="0" max="100" value={battery} onChange={e => setBattery(e.target.value)}/></label>
            <label className="checkbox-label"><input type="checkbox" checked={reportProblem} onChange={e => setReportProblem(e.target.checked)}/> Report a vehicle problem</label>
            {reportProblem && <label>Problem details<textarea rows="2" value={problemNote} onChange={e => setProblemNote(e.target.value)} placeholder="Describe the reported issue"/></label>}
            <button className="button primary full" disabled={!returnSlotId || !isStudent} onClick={() => returnVehicle(activeTrip.id)}>Complete vehicle return</button>
          </div>
          <p className="helper-text">The vehicle must be returned to a free Shared slot; otherwise the trip stays open. Battery below 20% joins the charging queue automatically.</p>
        </div> : <EmptyState title="No active trip" description="Pick up a confirmed booking to start a trip, then return the vehicle here."/>}
      </section>
    </div>
    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>My bookings & trip history</strong><span>{bookings.length} {bookings.length === 1 ? 'record' : 'records'}</span></div>
      {bookings.length === 0 ? <EmptyState title="No bookings yet" description="Your shared-vehicle bookings will appear here."/> : <div className="table-wrap"><table>
        <thead><tr><th>Vehicle</th><th>Hub</th><th>Status</th><th>Pickup deadline</th><th>Action</th></tr></thead>
        <tbody>{bookings.map(b => <tr key={b.id}><td><strong>{b.plate}</strong><small>{b.id.slice(0, 12)}</small></td><td>{b.hub_name}</td><td><StatusBadge value={b.status}/></td><td>{fmtDateTime(b.pickup_deadline)}</td><td>
          {b.status === 'Confirmed' && isStudent ? <div className="button-row"><button className="button small primary" onClick={() => pickup(b.id)}>Pick up</button><button className="button small ghost" onClick={() => cancel(b.id)}>Cancel</button></div> : '—'}
        </td></tr>)}</tbody>
      </table></div>}
    </section>
  </>;
}
