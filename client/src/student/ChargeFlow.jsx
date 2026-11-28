import { useState } from 'react';
import { api } from '../api';
import { virtualNow, useClockState, skipDemoSeconds } from '../clock';
import { Countdown, ElapsedBar } from '../components/Timers';
import { BackHeader, Battery, Choice, Chips, TimeFields, toInt, todayAt, clockText, useLoad, useAction, normalizeVnPlate } from './ui';

const pad2 = n => String(n).padStart(2, '0');
const START = [{ value: 0, label: 'Now' }, { value: 5, label: 'In 5 min' }, { value: 10, label: 'In 10 min' }, { value: 15, label: 'In 15 min' }];
const hhmm = value => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function ChargeFlow({ user, onClose }) {
  const { limits } = useClockState();
  const [data, setData] = useState(null);
  const [step, setStep] = useState(1);
  const [vehicleId, setVehicleId] = useState('');
  const [hubId, setHubId] = useState('');
  const [battery, setBattery] = useState('');   // typed by the student
  const [startIn, setStartIn] = useState(0);
  // The time the student needs the vehicle again is typed (24-hour clock); it starts at two hours from now.
  const [needH, setNeedH] = useState(() => pad2(new Date(virtualNow() + 2 * 3600000).getHours()));
  const [needM, setNeedM] = useState(() => pad2(new Date(virtualNow() + 2 * 3600000).getMinutes()));
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const [plate, setPlate] = useState('');
  const [warn, setWarn] = useState(null);   // result of the check before joining: this request would be class X
  const { busy, error, setError, run } = useAction();

  const load = useLoad(async () => {
    try {
      const [v, q, h] = await Promise.all([api('/vehicles?kind=personal'), api('/charging/queue'), api('/hubs')]);
      setData({ vehicles: v.vehicles, requests: q.requests, moves: q.moveRequests, hubs: h.hubs, grace: q.pickupGraceMinutes ?? 5 });
    } catch (e) { setError(e.message); }
  }, 8);

  if (!data) return <><BackHeader title="Charge my vehicle" onBack={onClose}/>{error ? <div className="stu-error">{error}</div> : <p>Loading…</p>}</>;
  const mineIds = new Set(data.vehicles.map(v => v.id));
  const active = data.requests.find(r => r.user_id === user.id && ['Queued', 'Assigned', 'Charging'].includes(r.status));
  const moves = data.moves.filter(m => mineIds.has(m.vehicle_id) && ['Requested', 'In Progress'].includes(m.status));
  const vehicle = data.vehicles.find(v => v.id === vehicleId);
  // The next time on the clock that matches what was typed (a time that has passed today means tomorrow).
  const needed = () => {
    const h = toInt(needH), m = toInt(needM);
    if (Number.isNaN(h) || Number.isNaN(m)) return { error: 'Please type the hour and the minutes.' };
    const now = virtualNow();
    let at = todayAt(now, h, m), tomorrow = false;
    if (at <= now + startIn * 60000 + 60000) { at += 24 * 3600000; tomorrow = true; }
    return { at, tomorrow };
  };
  const post = (path, text) => run(async () => { await api(path, { method: 'POST', body: {} }); setMessage(text); await load(); });

  const batteryNumber = battery === '' ? NaN : Number(battery);
  const requestBody = () => ({ hubId, vehicleId, batteryLevel: batteryNumber, startInMinutes: startIn, nextRequiredUsageAt: new Date(needed().at).toISOString() });
  // Pressing confirm first checks at once whether the vehicle could be ready in time (class X means it cannot).
  async function join() {
    const check = await run(() => api('/charging/preview', { method: 'POST', body: requestBody() }));
    if (check?.willBeClassX) { setWarn(check); return; }
    if (check) await register();
  }
  const laterTime = () => {
    const at = new Date(Date.parse(warn.earliestUseAt));
    setNeedH(pad2(at.getHours())); setNeedM(pad2(at.getMinutes()));
    setWarn(null); setStep(3);
  };
  async function addVehicle() {
    const r = await run(() => api('/vehicles/personal', { method: 'POST', body: { plate: normalizeVnPlate(plate), vehicleType: 'Motorcycle', connectorType: 'Type2', hubId: data.hubs[0]?.id } }));
    if (r) { setPlate(''); setAdding(false); setVehicleId(r.vehicle.id); setHubId(r.vehicle.hub_id || ''); setBattery(String(Math.round(r.vehicle.battery_level ?? 0))); await load(); setStep(2); }
  }
  async function register() {
    setWarn(null);
    const r = await run(() => api('/charging/requests', { method: 'POST', body: requestBody() }));
    if (r) { setMessage('You are in the charging queue. We will tell you when a charger is ready.'); setStep(1); setVehicleId(''); setHubId(''); setBattery(''); await load(); }
  }

  /* ---- Something is going on: show it ---- */
  if (active || moves.length) return <>
    <BackHeader title="My charging" onBack={onClose}/>
    {message && <div className="stu-ok" onClick={() => setMessage('')}>{message}</div>}
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {moves.map(m => <div key={m.id} className="stu-card warn">
      <div className="trip-big"><div className="emoji">🔌</div>
        <h2>{m.destination === 'Holding' ? 'Your vehicle is being moved to Holding' : m.direction === 'FROM_CHARGER' ? 'Please collect your vehicle' : 'Please move your vehicle to the charger'}</h2>
        <p>{m.plate} · charger {m.charger_code} · {m.hub_name}</p>
        {m.direction === 'FROM_CHARGER' && m.destination !== 'Holding' && <p>Collect it within {data.grace} minutes of full charge, or it will be moved to the Holding area.</p>}
        {m.direction === 'FROM_CHARGER' && m.destination !== 'Holding' && <div style={{ textAlign: 'center' }}><Countdown until={new Date(Date.parse(m.requested_at) + data.grace * 60000).toISOString()} label="Collect within" overLabel="late by" warnSeconds={60}/></div>}</div>
      {m.destination !== 'Holding' && <button className="stu-btn" disabled={busy} onClick={() => run(async () => {
        if (m.status === 'Requested') await api(`/charging/move-requests/${m.id}/start`, { method: 'POST', body: {} });
        await api(`/charging/move-requests/${m.id}/done`, { method: 'POST', body: {} });
        setMessage('Thank you! The charger is free for the next person.'); await load();
      })}>I have moved it</button>}
    </div>)}
    {active && <div className="stu-card highlight">
      <div className="trip-big"><div className="emoji">{active.status === 'Charging' ? '⚡' : active.status === 'Assigned' ? '🔌' : '⏳'}</div>
        <h2>{active.status === 'Queued' ? 'Waiting for a charger' : active.status === 'Assigned' ? `Go to charger ${active.charger_code}` : 'Charging now'}</h2>
        <p>{active.plate} · {active.hub_name}</p></div>
      {active.eta_notice_at && active.status !== 'Charging' && <div className="stu-note">Expected to reach {active.notice_battery}% at about <b>{hhmm(active.eta_notice_at)}</b>. Come and collect your vehicle then. Charging goes on to 100%.</div>}
      {active.status === 'Queued' && <>
        {active.estimated_start_at && <div style={{ textAlign: 'center' }}><Countdown until={active.estimated_start_at} label="Estimated start in" overLabel="soon" warnSeconds={0}/></div>}
        <p>You can close the app. We will send you a message when it is your turn.</p>
        <button className="stu-btn secondary" disabled={busy} onClick={() => run(async () => { await skipDemoSeconds(); await load(); })}>+45s demo clock <small>(demo only)</small></button>
      </>}
      {active.status === 'Assigned' && <>
        {active.connect_deadline && <div style={{ textAlign: 'center' }}><Countdown until={active.connect_deadline} label="Connect within" overLabel="expired"/></div>}
        <button className="stu-btn" disabled={busy} onClick={() => post(`/charging/requests/${active.id}/connect`, 'Connected. Charging has started.')}>I have connected my vehicle</button>
      </>}
      {active.status === 'Charging' && <>
        <Battery level={active.vehicle_battery ?? active.battery_level} charging={active.status === 'Charging'} label={`Battery (goal ${limits?.targetBatteryPercent ?? 100}%)`}/>
        {active.eta_notice_at && (active.vehicle_battery ?? 0) < (active.notice_battery ?? 90) && <div className="stu-note">Expected to reach {active.notice_battery}% at about <b>{hhmm(active.eta_notice_at)}</b>. We will tell you then. Charging goes on to 100%.</div>}
        {(active.vehicle_battery ?? 0) >= (active.notice_battery ?? 90) && <div className="stu-note">Your vehicle is ready. Please come and collect it.</div>}
        <ElapsedBar since={active.charging_started_at} limitMinutes={limits?.maxSessionMinutes || undefined} label="Charging time"/>
        <button className="stu-btn secondary" disabled={busy} onClick={() => post(`/charging/requests/${active.id}/complete`, 'Charging stopped. Please move your vehicle away from the charger.')}>Stop charging</button>
      </>}
    </div>}
  </>;

  /* ---- New request ---- */
  const back = () => { setWarn(null); if (adding) { setAdding(false); return; } return step === 1 ? onClose() : setStep(step - 1); };
  const n = needed();
  const batteryOk = Number.isInteger(batteryNumber) && batteryNumber >= 0 && batteryNumber <= 100;
  return <>
    <BackHeader title={['', 'Which vehicle?', 'Which Hub?', 'Battery and times', 'Check and confirm'][step]} onBack={back} step={step} steps={4}/>
    {message && <div className="stu-ok" onClick={() => setMessage('')}>{message}</div>}
    {error && <div className="stu-error" onClick={() => setError('')}>{error}</div>}
    {step === 1 && !adding && <div className="choice-list">{data.vehicles.map(v => <Choice key={v.id} icon={'🛵'} title={v.plate} hint={`${v.vehicle_type}${v.hub_id ? ` · at ${data.hubs.find(h => h.id === v.hub_id)?.name || 'a Hub'}` : ''}`} chosen={vehicleId === v.id} onClick={() => { setVehicleId(v.id); setHubId(v.hub_id || ''); setBattery(String(Math.round(v.battery_level))); setStep(2); }}/>)}
      <Choice icon="➕" title="Add a vehicle" hint="Register your motorcycle" onClick={() => setAdding(true)}/>
    </div>}
    {step === 1 && adding && <div className="stu-card">
      <label>License plate<input value={plate} onChange={e => setPlate(e.target.value)} placeholder="51A-123.45" autoCapitalize="characters"/></label>
        {plate.trim() !== '' && !normalizeVnPlate(plate) && <div className="stu-note">Use a Vietnamese motorcycle plate, for example 59A-123.45 or 62AN-116.30.</div>}
      <button className="stu-btn" disabled={busy || !normalizeVnPlate(plate)} onClick={addVehicle}>Save vehicle</button>
    </div>}
    {step === 2 && <div className="choice-list">{data.hubs.map(h => <Choice key={h.id} icon="📍" title={h.name} hint={h.open_now ? `Open until ${h.close_time}` : `Closed · opens ${h.open_time}`} disabled={!h.open_now} chosen={hubId === h.id} onClick={() => { setHubId(h.id); setStep(3); }}/>)}</div>}
    {step === 3 && <>
      <div className="stu-card"><b>Battery level now (%)</b>
        <div className="time-fields"><label><input inputMode="numeric" value={battery} onFocus={e => e.target.select()} onChange={e => setBattery(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="0–100" aria-label="Battery percent"/><small>percent</small></label></div></div>
      <div className="stu-card"><b>Start charging</b><Chips value={startIn} onChange={setStartIn} options={START}/></div>
      <div className="stu-card"><b>I need my vehicle at</b><TimeFields clock hour={needH} minute={needM} onHour={setNeedH} onMinute={setNeedM} hourLabel="hour (0–23)" minuteLabel="minute"/></div>
      {!batteryOk && <div className="stu-error">Please type the battery level, from 0 to 100.</div>}
      {n.error ? <div className="stu-error">{n.error}</div> : n.tomorrow && <div className="stu-note">That time has passed today, so it means tomorrow at {clockText(n.at)}.</div>}
      <button className="stu-btn" disabled={!batteryOk || !!n.error} onClick={() => setStep(4)}>Next</button>
    </>}
    {step === 4 && vehicle && <>
      <div className="stu-card">
        <div><small>Vehicle</small><h2>{vehicle.plate}</h2></div>
        <div><small>Hub</small><h2>{data.hubs.find(h => h.id === hubId)?.name}</h2></div>
        <Battery level={batteryNumber}/>
        <div><small>Charging starts</small><h2>{startIn === 0 ? 'now' : `in ${startIn} minutes`}</h2></div>
        <div><small>Needed at</small><h2>{clockText(n.at)}{n.tomorrow ? ' (tomorrow)' : ''}</h2></div>
      </div>
      <div className="stu-note">Your vehicle must be at the Hub when it is time. After you join we show when it should reach 90%, so you know when to come back.</div>
      {warn ? <div className="stu-card" role="alert">
        <b>Your vehicle may not be ready in time</b>
        <p>At {batteryNumber}% it needs about {warn.chargeMinutesNeeded} minutes of charging, but you need it in {Math.max(0, warn.minutesToUse)} minutes. It would be put behind the other vehicles.</p>
        {warn.earliestFitsToday
          ? <p>A realistic time to need it: <b>{clockText(Date.parse(warn.earliestUseAt))}</b> or later.</p>
          : <p>There is not enough time left today to charge it fully before the Hub closes.</p>}
        {warn.earliestFitsToday && <button className="stu-btn" onClick={laterTime}>Choose a later time</button>}
        <button className="stu-btn secondary" disabled={busy} onClick={register}>Join the queue anyway</button>
        <button className="stu-btn secondary" onClick={() => { setWarn(null); onClose(); }}>Do not register</button>
      </div> : <button className="stu-btn" disabled={busy} onClick={join}>Join the charging queue</button>}
    </>}
  </>;
}
