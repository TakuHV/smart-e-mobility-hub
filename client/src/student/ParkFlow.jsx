import { useEffect, useState } from 'react';
import { api, query } from '../api';
import { virtualNow, useNow } from '../clock';
import { Countdown } from '../components/Timers';
import { BackHeader, Choice, Chips, useLoad, useAction, hubHint } from './ui';

const START = [{ value: 2, label: 'Now' }, { value: 30, label: 'In 30 min' }, { value: 60, label: 'In 1 hour' }];
const LENGTH = [{ value: 60, label: '1 hour' }, { value: 120, label: '2 hours' }, { value: 180, label: '3 hours' }, { value: 240, label: '4 hours' }];
const fmt = v => new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function ParkFlow({ onClose }) {
  const now = useNow();
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState(1);
  const [vehicleId, setVehicleId] = useState('');
  const [hubId, setHubId] = useState('');
  const [startIn, setStartIn] = useState(2);
  const [length, setLength] = useState(120);
  const [slot, setSlot] = useState(null);
  const [fixed, setFixed] = useState(null); // the chosen period, fixed when the student moves to the last step
  const [plate, setPlate] = useState('');
  const [vType, setVType] = useState('Motorcycle');
  const [connector, setConnector] = useState('Type2');
  const [message, setMessage] = useState('');
  const { busy, error, setError, run } = useAction();

  const load = useLoad(async () => {
    try {
      const [h, v, r] = await Promise.all([api('/hubs'), api('/vehicles?kind=personal'), api('/parking/reservations')]);
      setData({ hubs: h.hubs, vehicles: v.vehicles, reservations: r.reservations });
    } catch (e) { setError(e.message); }
  }, 10);

  const vehicle = data?.vehicles.find(v => v.id === vehicleId);
  const period = () => { const s = virtualNow() + startIn * 60000; return { startAt: new Date(s).toISOString(), endAt: new Date(s + length * 60000).toISOString() }; };

  // Step 4: find a free Personal slot for the chosen period.
  useEffect(() => {
    if (step !== 4 || !vehicle || !hubId || !fixed) return;
    setSlot(null);
    api(`/parking/slots${query({ slotType: 'Personal', hubId, vehicleType: vehicle.vehicle_type, ...fixed })}`)
      .then(r => setSlot(r.slots.find(s => s.status === 'Available' && s.available_for_period !== false && s.fits_vehicle !== false) || false))
      .catch(e => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (!data) return <><BackHeader title="Park my vehicle" onBack={onClose}/>{error ? <div className="stu-error">{error}</div> : <p>Loading…</p>}</>;
  const hubName = id => data.hubs.find(h => h.id === id)?.name || '';
  const active = data.reservations.filter(r => ['Confirmed', 'In Progress'].includes(r.status));

  const reset = () => { setWizard(false); setStep(1); setVehicleId(''); setHubId(''); setSlot(null); };
  const act = (id, name, text) => run(async () => { await api(`/parking/reservations/${id}/${name}`, { method: 'POST', body: {} }); setMessage(text); await load(); });

  async function addVehicle() {
    const r = await run(() => api('/vehicles/personal', { method: 'POST', body: { plate, vehicleType: vType, connectorType: connector, hubId: data.hubs[0]?.id } }));
    if (r) { setPlate(''); setAdding(false); setVehicleId(r.vehicle.id); setHubId(r.vehicle.hub_id || ''); await load(); setStep(2); }
  }
  async function reserve() {
    const r = await run(() => api('/parking/reservations', { method: 'POST', body: { vehicleId, hubId, slotId: slot.id, ...fixed } }));
    if (r) { setMessage(`Spot ${slot.code} is reserved for you.`); reset(); await load(); }
  }

  /* ---- Wizard ---- */
  if (wizard || active.length === 0) {
    const back = () => (adding ? setAdding(false) : step === 1 ? (active.length ? reset() : onClose()) : setStep(step - 1));
    return <>
      <BackHeader title={['', 'Which vehicle?', 'Which Hub?', 'When and how long?', 'Check and confirm'][step]} onBack={back} step={step} steps={4}/>
      {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
      {step === 1 && !adding && <div className="choice-list">
        {data.vehicles.map(v => <Choice key={v.id} icon={'🛵'} title={v.plate} hint={v.vehicle_type} chosen={vehicleId === v.id} onClick={() => { setVehicleId(v.id); setHubId(v.hub_id || ''); setStep(2); }}/>)}
        <Choice icon="➕" title="Add a vehicle" hint="Register your own EV" onClick={() => setAdding(true)}/>
      </div>}
      {step === 1 && adding && <div className="stu-card">
        <label>License plate<input value={plate} onChange={e => setPlate(e.target.value)} placeholder="51A-123.45"/></label>
        <div><b>Type</b><Chips value={vType} onChange={setVType} options={[{ value: 'Motorcycle', label: '🛵 Motorcycle' }, { value: 'Car', label: 'Car' }]}/></div>
        <div><b>Connector</b><Chips value={connector} onChange={setConnector} options={[{ value: 'Type2', label: 'Type 2' }, { value: 'GB/T', label: 'GB/T' }]}/></div>
        <button className="stu-btn" disabled={busy || plate.trim().length < 4} onClick={addVehicle}>Save vehicle</button>
      </div>}
      {step === 2 && <div className="choice-list">
        {data.hubs.map(h => <Choice key={h.id} icon="📍" title={h.name} hint={hubHint(h)} disabled={!h.open_now} chosen={hubId === h.id} onClick={() => { setHubId(h.id); setStep(3); }}/>)}
      </div>}
      {step === 3 && <>
        <div className="stu-card"><b>When do you arrive?</b><Chips value={startIn} onChange={setStartIn} options={START}/></div>
        <div className="stu-card"><b>How long will you stay?</b><Chips value={length} onChange={setLength} options={LENGTH}/></div>
        <button className="stu-btn" onClick={() => { setFixed(period()); setStep(4); }}>Next</button>
      </>}
      {step === 4 && vehicle && <>
        <div className="stu-card">
          <div><small>Vehicle</small><h2>{vehicle.plate}</h2></div>
          <div><small>Hub</small><h2>{hubName(hubId)}</h2></div>
          <div><small>Time</small><h2>{fixed && `${fmt(fixed.startAt)} – ${fmt(fixed.endAt)}`}</h2></div>
          <div><small>Parking spot</small><h2>{slot === null ? 'Looking…' : slot ? slot.code : 'None free'}</h2></div>
        </div>
        {slot === false && <div className="stu-error">No parking spot is free for that time. Go back and pick another time or Hub.</div>}
        <div className="stu-note">Please arrive within 15 minutes of your start time, and leave by your end time.</div>
        <button className="stu-btn" disabled={busy || !slot} onClick={reserve}>Confirm parking</button>
      </>}
    </>;
  }

  /* ---- Active reservations ---- */
  return <>
    <BackHeader title="My parking" onBack={onClose}/>
    {message && <div className="stu-ok" onClick={() => setMessage('')}>{message}</div>}
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {active.map(r => {
      const started = now >= Date.parse(r.start_at);
      return <div key={r.id} className="stu-card highlight">
        <div className="trip-big"><div className="emoji">🅿️</div><h2>Spot {r.slot_code}</h2><p>{r.hub_name} · {r.plate}</p><p>{fmt(r.start_at)} – {fmt(r.end_at)}</p></div>
        {r.status === 'Confirmed' && <div style={{ textAlign: 'center' }}><Countdown until={started ? r.expires_at : r.start_at} label={started ? 'Arrive within' : 'Starts in'} overLabel="expired"/></div>}
        {r.status === 'In Progress' && <div style={{ textAlign: 'center' }}><Countdown until={r.end_at} label="Time left" overLabel="over by" warnSeconds={600}/></div>}
        {r.status === 'Confirmed' && started && <button className="stu-btn" disabled={busy} onClick={() => act(r.id, 'arrive', 'Welcome! Your parking has started.')}>I have arrived</button>}
        {r.status === 'Confirmed' && !started && <button className="stu-btn danger" disabled={busy} onClick={() => act(r.id, 'cancel', 'Reservation cancelled.')}>Cancel reservation</button>}
        {r.status === 'In Progress' && <button className="stu-btn" disabled={busy} onClick={() => act(r.id, 'complete', 'Safe travels! The spot is free again.')}>I am leaving now</button>}
      </div>;
    })}
    <button className="stu-btn secondary" onClick={() => { setWizard(true); setMessage(''); }}>Reserve another spot</button>
  </>;
}
