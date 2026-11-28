import { useState } from 'react';
import { api } from '../api';
import { useClockState, useNow } from '../clock';
import { Countdown, ElapsedBar } from '../components/Timers';
import { BackHeader, Battery, Choice, Chips, useLoad, useAction, hubHint } from './ui';

const PICKUP = [{ value: 0, label: 'Now' }, { value: 5, label: 'In 5 min' }, { value: 15, label: 'In 15 min' }, { value: 30, label: 'In 30 min' }];
const hhmm = value => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/*
 * Book a vehicle, one question per screen:
 *   1 pick-up Hub -> 2 vehicle -> 3 destination Hub -> 4 confirm
 * then the server state drives the screen: Confirmed = go and pick up, In Progress = big "I have arrived" screen, done.
 */
export default function BookFlow({ onClose }) {
  const { limits } = useClockState();
  const now = useNow();
  const [pickupIn, setPickupIn] = useState(0);
  const [data, setData] = useState(null);
  const [step, setStep] = useState(1);
  const [fromHub, setFromHub] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [toHub, setToHub] = useState('');
  const [arriveHub, setArriveHub] = useState('');
  const [done, setDone] = useState(null);
  const [redirects, setRedirects] = useState([]);
  const { busy, error, setError, run } = useAction();

  const load = useLoad(async () => {
    try {
      const [h, v, b, s, rd] = await Promise.all([api('/hubs'), api('/vehicles?kind=shared'), api('/vehicles/bookings'), api('/parking/slots?slotType=Shared'), api('/hubs/redirects')]);
      setRedirects(rd.redirects);
      setData({ hubs: h.hubs, vehicles: v.vehicles, bookings: b.bookings, slots: s.slots });
    } catch (e) { setError(e.message); }
  }, 10);

  if (!data) return <><BackHeader title="Book a vehicle" onBack={onClose}/>{error ? <div className="stu-error">{error}</div> : <p>Loading…</p>}</>;

  const active = data.bookings.find(b => ['Confirmed', 'In Progress', 'Overdue'].includes(b.status));
  const minBattery = limits?.minimumBatteryToBookPercent ?? 30;
  const hubName = id => data.hubs.find(h => h.id === id)?.name || '';
  const freeSlotsAt = id => data.slots.filter(s => s.hub_id === id && s.status === 'Available').length;
  const vehiclesAt = id => data.vehicles.filter(v => v.hub_id === id && v.status === 'Available' && v.battery_level >= minBattery);

  /* ---- Finished ---- */
  if (done) return <>
    <div className="trip-big"><div className="emoji">🎉</div><h1>Trip finished</h1><p>Thank you! The vehicle is parked at <b>{done.hubName}</b>.</p></div>
    {done.chargingQueued && <div className="stu-note">The battery is low, so the vehicle was sent to charge automatically.</div>}
    <button className="stu-btn" onClick={onClose}>Back to home</button>
  </>;

  /* ---- Booked: go and pick up ---- */
  if (active?.status === 'Confirmed') return <>
    <BackHeader title="Pick up your vehicle" onBack={onClose}/>
    <div className="stu-card highlight">
      <div className="trip-big"><div className="emoji">🛵</div><h2>{active.plate}</h2><p>Waiting for you at <b>{active.hub_name}</b></p></div>
      {active.pickup_from && now < Date.parse(active.pickup_from) - 1000
        ? <div style={{ textAlign: 'center' }}><Countdown until={active.pickup_from} label={`You can pick up from ${hhmm(active.pickup_from)} in`} warnSeconds={0}/></div>
        : <div style={{ textAlign: 'center' }}><Countdown until={active.pickup_deadline} label="Pick up within" overLabel="expired" warnSeconds={180}/></div>}
      <Battery level={active.battery_level}/>
      {active.destination_hub_name && <p>Going to: <b>{active.destination_hub_name}</b></p>}
    </div>
    {error && <div className="stu-error">{error}</div>}
    <button className="stu-btn" disabled={busy || (active.pickup_from && now < Date.parse(active.pickup_from) - 1000)} onClick={() => run(async () => { await api(`/vehicles/bookings/${active.id}/pickup`, { method: 'POST', body: {} }); await load(); })}>I have the vehicle — start trip</button>
    <button className="stu-btn danger" disabled={busy} onClick={() => run(async () => { await api(`/vehicles/bookings/${active.id}/cancel`, { method: 'POST', body: {} }); await load(); })}>Cancel booking</button>
  </>;

  /* ---- On the trip: one big screen ---- */
  if (active) {
    const dest = arriveHub || active.destination_hub_id || '';
    const openHubs = data.hubs.filter(h => h.open_now);
    return <div className="trip-screen"><div className="stu-col">
      <div className="trip-big">
        <div className="emoji">🛣️</div>
        <h1>{active.destination_hub_name ? `On the way to ${active.destination_hub_name}` : 'You are on a trip'}</h1>
        <p>Vehicle {active.plate}</p>
        {active.status === 'Overdue' && <div className="stu-error">You are over the time limit. Please return the vehicle now.</div>}
      </div>
      <div className="stu-card">
        <ElapsedBar since={active.started_at} limitMinutes={(limits?.maxTripHours ?? 3) * 60} warnAtMinutes={limits?.tripReminderMinutes ?? 150} label="Trip time"/>
        <Battery level={active.battery_level}/>
        {active.battery_level < (limits?.lowBatteryWarningPercent ?? 15) && <div className="stu-error">Battery is low. Please return the vehicle soon.</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <div className="stu-error">{error}</div>}
        {!active.destination_hub_id && <label>Where are you arriving?<select value={dest} onChange={e => setArriveHub(e.target.value)}><option value="">Choose a Hub</option>{openHubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>}
        <button className="stu-btn huge" disabled={busy || !dest} onClick={async () => {
          const r = await run(() => api(`/vehicles/bookings/${active.id}/return`, { method: 'POST', body: { hubId: dest } }));
          if (r) setDone({ hubName: hubName(dest), chargingQueued: r.chargingQueued });
        }}>✔ I have arrived{dest ? ` at ${hubName(dest)}` : ''}</button>
        <button className="stu-btn ghost" onClick={onClose}>Back to home</button>
      </div>
    </div></div>;
  }

  /* ---- Choose: Hub -> vehicle -> destination -> confirm ---- */
  const back = () => (step === 1 ? onClose() : setStep(step - 1));
  const chosen = data.vehicles.find(v => v.id === vehicleId);
  const confirm = async () => {
    const r = await run(() => api('/vehicles/bookings', { method: 'POST', body: { vehicleId, destinationHubId: toHub, pickupInMinutes: pickupIn } }));
    if (r) { setPickupIn(0); setStep(1); setFromHub(''); setVehicleId(''); setToHub(''); await load(); window.scrollTo({ top: 0 }); }
  };

  return <>
    <BackHeader title={['', 'Where do you pick up?', 'Choose a vehicle', 'Where are you going?', 'Check and confirm'][step]} onBack={back} step={step} steps={4}/>
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {step === 1 && <div className="choice-list">
      {data.hubs.map(h => <Choice key={h.id} icon="📍" title={h.name} hint={redirects.find(r => r.from_hub_id === h.id) ? `Busy. Please use ${redirects.find(r => r.from_hub_id === h.id).to_hub_name}` : hubHint(h)} disabled={!h.open_now} onClick={() => { setFromHub(h.id); setVehicleId(''); setStep(2); }}/>)}
    </div>}
    {step === 2 && <div className="choice-list">
      {vehiclesAt(fromHub).length === 0 ? <div className="stu-card"><p>No vehicle is ready at {hubName(fromHub)} right now. Please try another Hub.</p></div>
        : vehiclesAt(fromHub).map(v => <Choice key={v.id} icon={'🛵'} title={v.plate} hint={v.vehicle_type} right={`${v.battery_level}%`} chosen={vehicleId === v.id} onClick={() => { setVehicleId(v.id); setStep(3); }}/>)}
    </div>}
    {step === 3 && <div className="choice-list">
      {data.hubs.map(h => { const same = h.id === fromHub; const free = same || freeSlotsAt(h.id) > 0; return <Choice key={h.id} icon="🏁" title={h.name} hint={!h.open_now ? 'Closed now' : same ? 'Round trip: bring it back here' : free ? hubHint(h) : 'No free spot right now'} disabled={!h.open_now || !free} chosen={toHub === h.id} onClick={() => { setToHub(h.id); setStep(4); }}/>; })}
    </div>}
    {step === 4 && chosen && <>
      <div className="stu-card">
        <div><small>From</small><h2>{hubName(fromHub)}</h2></div>
        <div><small>Vehicle</small><h2>{chosen.plate}</h2></div>
        <Battery level={chosen.battery_level}/>
        <div><small>To</small><h2>{hubName(toHub)}{toHub === fromHub ? ' (round trip)' : ''}</h2></div>
      </div>
      <div className="stu-card"><b>When will you pick it up?</b><Chips value={pickupIn} onChange={setPickupIn} options={PICKUP}/></div>
      <div className="stu-note">After booking you have {limits?.pickupHoldMinutes ?? 15} minutes to pick up the vehicle.</div>
      <button className="stu-btn" disabled={busy} onClick={confirm}>Confirm booking</button>
    </>}
  </>;
}
