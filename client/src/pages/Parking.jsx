import { useEffect, useMemo, useState } from 'react';
import { api, query, isoToLocalInput, localInputToIso } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';
import RefreshButton from '../components/RefreshButton';
import { scrollTopOnPhone } from '../hooks';

const defaultDate = offsetMinutes => isoToLocalInput(new Date(Date.now() + offsetMinutes * 60000));
const fmtTime = value => (value ? new Date(value).toLocaleTimeString() : '—');

export default function Parking({ user }) {
  const [hubs, setHubs] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [slots, setSlots] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [hubId, setHubId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [slotId, setSlotId] = useState('');
  const [startAt, setStartAt] = useState(defaultDate(30));
  const [endAt, setEndAt] = useState(defaultDate(150));
  const [newPlate, setNewPlate] = useState('');
  const [newVehicleType, setNewVehicleType] = useState('Car');
  const [newConnector, setNewConnector] = useState('Type2');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const isStudent = user.role === 'Student';
  const vehicle = vehicles.find(v => v.id === vehicleId);

  async function load() {
    setError('');
    try {
      const [h, v, r] = await Promise.all([api('/hubs'), api('/vehicles?kind=personal'), api('/parking/reservations')]);
      setHubs(h.hubs); setVehicles(v.vehicles); setReservations(r.reservations);
      setHubId(prev => prev || v.vehicles[0]?.hub_id || h.hubs[0]?.id || '');
      setVehicleId(prev => prev || v.vehicles[0]?.id || '');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  // UC-008 step 4: ask the server for the Personal slots that fit the vehicle and are free for the chosen period.
  async function loadSlots() {
    if (!hubId) return;
    const from = localInputToIso(startAt);
    const to = localInputToIso(endAt);
    const periodOk = from && to && to > from;
    try {
      const result = await api(`/parking/slots${query({ slotType: 'Personal', hubId, vehicleType: vehicle?.vehicle_type, ...(periodOk ? { startAt: from, endAt: to } : {}) })}`);
      setSlots(result.slots);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { loadSlots(); }, [hubId, vehicleId, startAt, endAt, vehicles.length]);

  const availableSlots = useMemo(
    () => slots.filter(s => s.status === 'Available' && s.available_for_period !== false && s.fits_vehicle !== false),
    [slots]
  );
  useEffect(() => { if (slotId && !availableSlots.some(s => s.id === slotId)) setSlotId(''); }, [availableSlots]);

  async function addVehicle(event) {
    event.preventDefault(); setError(''); setSuccess('');
    try {
      const result = await api('/vehicles/personal', { method: 'POST', body: { plate: newPlate, vehicleType: newVehicleType, connectorType: newConnector, hubId: hubId || 'hub-central' } });
      setVehicles(old => [...old, result.vehicle]); setVehicleId(result.vehicle.id); setNewPlate(''); setSuccess('Personal vehicle registered.');
    } catch (err) { setError(err.message); }
  }
  async function reserve(event) {
    event.preventDefault(); setError(''); setSuccess('');
    try {
      const { reservation } = await api('/parking/reservations', { method: 'POST', body: { vehicleId, hubId, slotId, startAt: localInputToIso(startAt), endAt: localInputToIso(endAt) } });
      setSuccess(`Reservation confirmed. Arrive before ${fmtTime(reservation.expires_at)} and leave by ${fmtTime(reservation.must_leave_by)}.`);
      setSlotId(''); await load(); await loadSlots(); scrollTopOnPhone();
    } catch (err) { setError(err.message); }
  }
  async function action(id, name) {
    setError(''); setSuccess('');
    try {
      const result = await api(`/parking/reservations/${id}/${name}`, { method: 'POST', body: {} });
      setSuccess(name === 'arrive' ? 'Arrival recorded. Parking spot is now Occupied.'
        : name === 'complete' ? (result.lateMinutes > 15 ? `Departure recorded, ${Math.round(result.lateMinutes)} minutes after the end time (overstay). Slot released.` : 'Vehicle departure recorded. Slot released.')
        : 'Reservation cancelled.');
      await load(); await loadSlots(); scrollTopOnPhone();
    } catch (err) { setError(err.message); }
  }

  const now = Date.now();
  return <>
    <SectionHeader eyebrow="STUDENT WORKFLOW · UC-008" title="Personal Parking" description="Register a personal EV and reserve a compatible Personal slot for a selected time period." action={<RefreshButton onClick={() => { load(); loadSlots(); }}/>}/>
    <Feedback error={error} success={success}/>
    {!isStudent && <div className="feedback is-info">You are signed in as {user.role}. Operations staff can record arrivals and departures; reservations are created by students.</div>}
    <div className="content-grid two-col">
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">VEHICLE PROFILE</span><h3>Personal vehicle</h3></div><span className="mini-icon">▣</span></div>
        <label>Saved vehicle<select value={vehicleId} onChange={e => { setVehicleId(e.target.value); const next = vehicles.find(v => v.id === e.target.value); if (next?.hub_id) setHubId(next.hub_id); }}><option value="">Choose a personal vehicle</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.plate} · {v.vehicle_type} · {v.connector_type}</option>)}</select></label>
        {isStudent && <>
          <div className="divider-label"><span>or register a vehicle</span></div>
          <form className="form-grid" onSubmit={addVehicle}>
            <label className="span-2">License plate<input value={newPlate} onChange={e => setNewPlate(e.target.value)} placeholder="51A-123.45" required/></label>
            <label>Vehicle type<select value={newVehicleType} onChange={e => setNewVehicleType(e.target.value)}><option>Car</option><option>Motorcycle</option></select></label>
            <label>Connector type<select value={newConnector} onChange={e => setNewConnector(e.target.value)}><option>Type2</option><option>GB/T</option></select></label>
            <button className="button secondary span-2" type="submit">＋ Add personal vehicle</button>
          </form>
        </>}
      </section>
      <section className="card-surface padded">
        <div className="section-mini-head"><div><span className="eyebrow">UC-008</span><h3>Reserve a parking spot</h3></div><span className="mini-icon">▤</span></div>
        <form className="form-stack" onSubmit={reserve}>
          <label>Mobility Hub<select value={hubId} onChange={e => { setHubId(e.target.value); setSlotId(''); }}>{hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
          <div className="form-grid">
            <label>Start time<input type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)} required/></label>
            <label>End time<input type="datetime-local" value={endAt} onChange={e => setEndAt(e.target.value)} required/></label>
          </div>
          <label>Free Personal slot for this period<select value={slotId} onChange={e => setSlotId(e.target.value)} required><option value="">{availableSlots.length ? 'Choose a free slot' : 'No compatible slot is free'}</option>{availableSlots.map(s => <option key={s.id} value={s.id}>{s.code} · {s.hub_name}</option>)}</select></label>
          <button className="button primary full sticky-cta" type="submit" disabled={!isStudent || !vehicleId || !slotId}>Confirm parking reservation <span>→</span></button>
        </form>
        <p className="helper-text">Only slots that fit your vehicle type and are free for the whole period are listed. The reservation is held for 15 minutes after the start time, and you may leave up to 15 minutes after the end time. It cannot overlap an active charging request of the same vehicle.</p>
      </section>
    </div>
    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Parking reservations</strong><span>{reservations.length} {reservations.length === 1 ? 'record' : 'records'}</span></div>
      {reservations.length === 0 ? <EmptyState title="No parking reservations" description="Your confirmed, active and completed reservations will appear here."/> : <div className="table-wrap"><table className="responsive-table">
        <thead><tr><th>Vehicle</th><th>Hub / Slot</th><th>Period</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{reservations.map(r => {
          const started = now >= Date.parse(r.start_at);
          return <tr key={r.id}><td className="primary"><strong>{r.plate}</strong><small>{r.vehicle_type}</small></td><td data-label="Hub / slot">{r.hub_name}<small>{r.slot_code}</small></td><td data-label="Period">{new Date(r.start_at).toLocaleString()}<small>to {fmtTime(r.end_at)}</small></td><td data-label="Status"><StatusBadge value={r.status}/></td><td className={`actions ${['Confirmed', 'In Progress'].includes(r.status) ? '' : 'empty'}`}>
            {r.status === 'Confirmed' && started ? <button className="button small primary" onClick={() => action(r.id, 'arrive')}>Arrived</button>
              : r.status === 'Confirmed' ? <button className="button small ghost" onClick={() => action(r.id, 'cancel')}>Cancel</button>
              : r.status === 'In Progress' ? <button className="button small secondary" onClick={() => action(r.id, 'complete')}>Vehicle departed</button>
              : '—'}
          </td></tr>;
        })}</tbody>
      </table></div>}
    </section>
  </>;
}
