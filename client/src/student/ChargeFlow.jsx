import { useState } from 'react';
import { api } from '../api';
import { virtualNow, useClockState } from '../clock';
import { Countdown, ElapsedBar } from '../components/Timers';
import { BackHeader, Battery, Choice, Chips, useLoad, useAction } from './ui';

const NEED = [{ value: 1, label: 'In 1 hour' }, { value: 2, label: 'In 2 hours' }, { value: 3, label: 'In 3 hours' }, { value: 4, label: 'In 4 hours' }];

export default function ChargeFlow({ user, onClose }) {
  const { limits } = useClockState();
  const [data, setData] = useState(null);
  const [step, setStep] = useState(1);
  const [vehicleId, setVehicleId] = useState('');
  const [hours, setHours] = useState(2);
  const [message, setMessage] = useState('');
  const { busy, error, setError, run } = useAction();

  const load = useLoad(async () => {
    try {
      const [v, q] = await Promise.all([api('/vehicles?kind=personal'), api('/charging/queue')]);
      setData({ vehicles: v.vehicles, requests: q.requests, moves: q.moveRequests });
    } catch (e) { setError(e.message); }
  }, 8);

  if (!data) return <><BackHeader title="Charge my vehicle" onBack={onClose}/>{error ? <div className="stu-error">{error}</div> : <p>Loading…</p>}</>;
  const mineIds = new Set(data.vehicles.map(v => v.id));
  const active = data.requests.find(r => r.user_id === user.id && ['Queued', 'Assigned', 'Charging'].includes(r.status));
  const moves = data.moves.filter(m => mineIds.has(m.vehicle_id) && ['Requested', 'In Progress'].includes(m.status));
  const vehicle = data.vehicles.find(v => v.id === vehicleId);
  const post = (path, text) => run(async () => { await api(path, { method: 'POST', body: {} }); setMessage(text); await load(); });

  async function join() {
    const r = await run(() => api('/charging/requests', { method: 'POST', body: {
      hubId: vehicle.hub_id, vehicleId, batteryLevel: Math.round(vehicle.battery_level), nextRequiredUsageAt: new Date(virtualNow() + hours * 3600000).toISOString() } }));
    if (r) { setMessage('You are in the charging queue. We will tell you when a charger is ready.'); setStep(1); setVehicleId(''); await load(); }
  }

  /* ---- Something is going on: show it ---- */
  if (active || moves.length) return <>
    <BackHeader title="My charging" onBack={onClose}/>
    {message && <div className="stu-ok" onClick={() => setMessage('')}>{message}</div>}
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {moves.map(m => <div key={m.id} className="stu-card warn">
      <div className="trip-big"><div className="emoji">🔌</div>
        <h2>{m.direction === 'FROM_CHARGER' ? 'Please move your vehicle away' : 'Please move your vehicle to the charger'}</h2>
        <p>{m.plate} · charger {m.charger_code} · {m.hub_name}</p></div>
      <button className="stu-btn" disabled={busy} onClick={() => run(async () => {
        if (m.status === 'Requested') await api(`/charging/move-requests/${m.id}/start`, { method: 'POST', body: {} });
        await api(`/charging/move-requests/${m.id}/done`, { method: 'POST', body: {} });
        setMessage('Thank you! The charger is free for the next person.'); await load();
      })}>I have moved it</button>
    </div>)}
    {active && <div className="stu-card highlight">
      <div className="trip-big"><div className="emoji">{active.status === 'Charging' ? '⚡' : active.status === 'Assigned' ? '🔌' : '⏳'}</div>
        <h2>{active.status === 'Queued' ? 'Waiting for a charger' : active.status === 'Assigned' ? `Go to charger ${active.charger_code}` : 'Charging now'}</h2>
        <p>{active.plate} · {active.hub_name}</p></div>
      {active.status === 'Queued' && <>
        {active.estimated_start_at && <div style={{ textAlign: 'center' }}><Countdown until={active.estimated_start_at} label="Estimated start in" overLabel="soon" warnSeconds={0}/></div>}
        <p>You can close the app. We will send you a message when it is your turn.</p>
      </>}
      {active.status === 'Assigned' && <>
        {active.connect_deadline && <div style={{ textAlign: 'center' }}><Countdown until={active.connect_deadline} label="Connect within" overLabel="expired"/></div>}
        <button className="stu-btn" disabled={busy} onClick={() => post(`/charging/requests/${active.id}/connect`, 'Connected. Charging has started.')}>I have connected my vehicle</button>
      </>}
      {active.status === 'Charging' && <>
        <Battery level={active.battery_level} label={`Battery (goal ${limits?.targetBatteryPercent ?? 90}%)`}/>
        <ElapsedBar since={active.charging_started_at} limitMinutes={limits?.maxSessionMinutes || undefined} label="Charging time"/>
        <button className="stu-btn secondary" disabled={busy} onClick={() => post(`/charging/requests/${active.id}/complete`, 'Charging stopped. Please move your vehicle away from the charger.')}>Stop charging</button>
      </>}
    </div>}
  </>;

  /* ---- New request ---- */
  const back = () => (step === 1 ? onClose() : setStep(step - 1));
  return <>
    <BackHeader title={['', 'Which vehicle?', 'When do you need it?', 'Check and confirm'][step]} onBack={back} step={step} steps={3}/>
    {message && <div className="stu-ok" onClick={() => setMessage('')}>{message}</div>}
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {step === 1 && (data.vehicles.length === 0
      ? <div className="stu-card"><p>You have no vehicle yet. Open “Park my vehicle” and add your vehicle first.</p></div>
      : <div className="choice-list">{data.vehicles.map(v => <Choice key={v.id} icon={'🛵'} title={v.plate} hint={`${v.vehicle_type} · ${Math.round(v.battery_level)}% battery`} chosen={vehicleId === v.id} onClick={() => { setVehicleId(v.id); setStep(2); }}/>)}</div>)}
    {step === 2 && <><div className="stu-card"><b>I need my vehicle…</b><Chips value={hours} onChange={setHours} options={NEED}/></div><button className="stu-btn" onClick={() => setStep(3)}>Next</button></>}
    {step === 3 && vehicle && <>
      <div className="stu-card">
        <div><small>Vehicle</small><h2>{vehicle.plate}</h2></div>
        <Battery level={vehicle.battery_level}/>
        <div><small>Needed in</small><h2>{hours} {hours === 1 ? 'hour' : 'hours'}</h2></div>
      </div>
      <div className="stu-note">Your vehicle must be parked at its Hub. We will give you a charger as soon as one is free.</div>
      <button className="stu-btn" disabled={busy} onClick={join}>Join the charging queue</button>
    </>}
  </>;
}
