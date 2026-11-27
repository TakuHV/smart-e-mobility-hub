import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import RefreshButton from '../components/RefreshButton';
import { EmptyState, Feedback } from '../components/Feedback';
import { refreshClock } from '../clock';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const label = key => key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

// Flat list of editable leaves: [{ path: ['charging','scheduler','weights','need'], value }]
function leaves(obj, path = []) {
  return Object.entries(obj).flatMap(([k, v]) => isObj(v) ? leaves(v, [...path, k]) : (typeof v === 'string' ? [] : [{ path: [...path, k], value: v }]));
}
function setDeep(target, path, value) {
  let o = target;
  path.slice(0, -1).forEach(k => { o = o[k] = o[k] || {}; });
  o[path[path.length - 1]] = value;
}

function SettingsPanel({ settings, onSaved, setError, setSuccess }) {
  const [draft, setDraft] = useState({});
  useEffect(() => { setDraft({}); }, [settings]);
  const entries = leaves(settings.values);
  const key = p => p.join('.');
  const shown = e => (key(e.path) in draft ? draft[key(e.path)] : e.value ?? '');

  async function save() {
    const patch = {};
    for (const e of entries) {
      const k = key(e.path);
      if (!(k in draft)) continue;
      setDeep(patch, e.path, draft[k] === '' ? null : Number(draft[k]));
    }
    if (!Object.keys(patch).length) return;
    setError(''); setSuccess('');
    try { await api('/admin/settings', { method: 'PATCH', body: { patch } }); setSuccess('Settings saved. They apply immediately.'); onSaved(); }
    catch (e) { setError(e.details ? `${e.message} ${JSON.stringify(e.details)}` : e.message); }
  }
  async function reset() {
    setError(''); setSuccess('');
    try { await api('/admin/settings/reset', { method: 'POST', body: {} }); setSuccess('Settings reset to the values in configuration.json.'); onSaved(); }
    catch (e) { setError(e.message); }
  }
  const sections = Object.keys(settings.values);
  return <section className="card-surface padded">
    <div className="subsection-title"><strong>System settings</strong><span>{settings.customised ? 'customised' : 'default values'}</span></div>
    {sections.map(section => <div key={section} className="section-gap-small">
      <h4>{label(section)}</h4>
      <div className="form-grid">
        {entries.filter(e => e.path[0] === section).map(e => <label key={key(e.path)}>{e.path.slice(1).map(label).join(' › ')}
          <input type="number" step="any" value={shown(e)} onChange={ev => setDraft({ ...draft, [key(e.path)]: ev.target.value })}/></label>)}
      </div>
    </div>)}
    <div className="inline-actions section-gap-small">
      <button className="button primary" disabled={!Object.keys(draft).length} onClick={save}>Save changes</button>
      <button className="button ghost" disabled={!settings.customised} onClick={reset}>Reset to defaults</button>
    </div>
    <p className="helper-text">Priority weights (need, urgency, waiting) feed the charging scheduler. Leave Max Session Minutes empty for no limit.</p>
  </section>;
}

function HubPanel({ hub, data, act }) {
  const [slot, setSlot] = useState({ slotType: 'Shared', count: 1 });
  const [charger, setCharger] = useState({ powerKw: 7, connectorTypes: ['Type2'] });
  const [vehicle, setVehicle] = useState({ plate: '', vehicleType: 'Car', connectorType: 'Type2', batteryLevel: 80 });
  const [edit, setEdit] = useState({ name: hub.name, powerLimitKw: hub.power_limit_kw, openTime: hub.open_time, closeTime: hub.close_time });
  return <section className="card-surface padded section-gap">
    <div className="subsection-title"><strong>{hub.name}</strong><StatusBadge value={hub.status}/></div>
    <div className="form-grid">
      <label>Name<input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })}/></label>
      <label>Power limit (kW)<input type="number" value={edit.powerLimitKw} onChange={e => setEdit({ ...edit, powerLimitKw: e.target.value })}/></label>
      <label>Opens<input value={edit.openTime} onChange={e => setEdit({ ...edit, openTime: e.target.value })} placeholder="HH:MM"/></label>
      <label>Closes<input value={edit.closeTime} onChange={e => setEdit({ ...edit, closeTime: e.target.value })} placeholder="HH:MM"/></label>
      <button className="button secondary" onClick={() => act(() => api(`/admin/hubs/${hub.id}`, { method: 'PATCH', body: { ...edit, powerLimitKw: Number(edit.powerLimitKw) } }), 'Hub updated.')}>Save Hub</button>
    </div>

    <h4 className="section-gap-small">Parking slots</h4>
    <div className="inline-actions">{Object.entries(hub.slotCounts).map(([t, c]) => <span key={t} className="badge muted">{t}: {c.available}/{c.total} free{c.outOfService ? ` · ${c.outOfService} out` : ''}</span>)}</div>
    <div className="form-grid">
      <label>Type<select value={slot.slotType} onChange={e => setSlot({ ...slot, slotType: e.target.value })}>{['Shared', 'Personal', 'Holding'].map(t => <option key={t}>{t}</option>)}</select></label>
      <label>How many<input type="number" min="1" max="20" value={slot.count} onChange={e => setSlot({ ...slot, count: e.target.value })}/></label>
      <button className="button secondary" onClick={() => act(() => api(`/admin/hubs/${hub.id}/slots`, { method: 'POST', body: { ...slot, count: Number(slot.count) } }), 'Slots added.')}>Add slots</button>
    </div>
    <details><summary>Manage individual slots ({hub.slots.length})</summary><div className="table-wrap"><table className="responsive-table"><tbody>
      {hub.slots.map(s => <tr key={s.id}><td className="primary"><strong>{s.code}</strong><small>{s.slot_type}</small></td><td data-label="Status"><StatusBadge value={s.status}/></td><td className="actions"><div className="button-row">
        {s.status === 'Out of Service' ? <button className="button small secondary" onClick={() => act(() => api(`/admin/slots/${s.id}`, { method: 'PATCH', body: { status: 'Available' } }), 'Slot back in service.')}>Restore</button>
          : s.status === 'Available' && <button className="button small ghost" onClick={() => act(() => api(`/admin/slots/${s.id}`, { method: 'PATCH', body: { status: 'Out of Service' } }), 'Slot taken out of service.')}>Disable</button>}
        <button className="button small ghost" onClick={() => act(() => api(`/admin/slots/${s.id}`, { method: 'DELETE' }), 'Slot removed.')}>Remove</button>
      </div></td></tr>)}</tbody></table></div></details>

    <h4 className="section-gap-small">Chargers</h4>
    <div className="table-wrap"><table className="responsive-table"><tbody>
      {hub.chargers.map(c => <tr key={c.id}><td className="primary"><strong>{c.code}</strong><small>{c.power_kw} kW · {c.connector_types.join(', ')}</small></td><td data-label="Status"><StatusBadge value={c.status}/>{c.plate ? ` ${c.plate}` : ''}</td><td className="actions"><div className="button-row">
        {c.status === 'Out of Service' ? <button className="button small secondary" onClick={() => act(() => api(`/admin/chargers/${c.id}`, { method: 'PATCH', body: { status: 'Available' } }), 'Charger restored.')}>Restore</button>
          : <button className="button small ghost" onClick={() => act(() => api(`/admin/chargers/${c.id}`, { method: 'PATCH', body: { status: 'Out of Service' } }), 'Charger taken out of service. A charging vehicle is requeued.')}>Disable</button>}
        <button className="button small ghost" onClick={() => act(() => api(`/admin/chargers/${c.id}`, { method: 'DELETE' }), 'Charger removed.')}>Remove</button>
      </div></td></tr>)}</tbody></table></div>
    <div className="form-grid">
      <label>Power (kW)<input type="number" value={charger.powerKw} onChange={e => setCharger({ ...charger, powerKw: e.target.value })}/></label>
      <label>Connector<select value={charger.connectorTypes[0]} onChange={e => setCharger({ ...charger, connectorTypes: [e.target.value] })}>{data.connectorTypes.map(c => <option key={c}>{c}</option>)}</select></label>
      <button className="button secondary" onClick={() => act(() => api(`/admin/hubs/${hub.id}/chargers`, { method: 'POST', body: { ...charger, powerKw: Number(charger.powerKw) } }), 'Charger added.')}>Add charger</button>
    </div>

    <h4 className="section-gap-small">Shared vehicles</h4>
    <div className="table-wrap"><table className="responsive-table"><tbody>
      {hub.sharedVehicles.map(v => <tr key={v.id}><td className="primary"><strong>{v.plate}</strong><small>{v.vehicle_type} · {v.connector_type} · {v.battery_level}%</small></td><td data-label="Status"><StatusBadge value={v.status}/></td><td className="actions"><button className="button small ghost" onClick={() => act(() => api(`/admin/vehicles/${v.id}`, { method: 'DELETE' }), 'Vehicle retired.')}>Retire</button></td></tr>)}</tbody></table></div>
    <div className="form-grid">
      <label>Plate<input value={vehicle.plate} onChange={e => setVehicle({ ...vehicle, plate: e.target.value })}/></label>
      <label>Type<select value={vehicle.vehicleType} onChange={e => setVehicle({ ...vehicle, vehicleType: e.target.value })}>{data.vehicleTypes.map(t => <option key={t}>{t}</option>)}</select></label>
      <label>Connector<select value={vehicle.connectorType} onChange={e => setVehicle({ ...vehicle, connectorType: e.target.value })}>{data.connectorTypes.map(t => <option key={t}>{t}</option>)}</select></label>
      <label>Battery %<input type="number" min="0" max="100" value={vehicle.batteryLevel} onChange={e => setVehicle({ ...vehicle, batteryLevel: e.target.value })}/></label>
      <button className="button secondary" disabled={!vehicle.plate.trim()} onClick={() => act(() => api(`/admin/hubs/${hub.id}/shared-vehicles`, { method: 'POST', body: { ...vehicle, batteryLevel: Number(vehicle.batteryLevel) } }), 'Shared vehicle added.').then(() => setVehicle({ ...vehicle, plate: '' }))}>Add vehicle</button>
    </div>
  </section>;
}

function PersonalPanel({ data, act }) {
  const [v, setV] = useState({ ownerId: '', hubId: '', plate: '', vehicleType: 'Motorcycle', connectorType: 'Type2', batteryLevel: 50 });
  return <section className="card-surface padded section-gap">
    <div className="subsection-title"><strong>Personal vehicles</strong><span>{data.personalVehicles.length}</span></div>
    {data.personalVehicles.length === 0 ? <EmptyState title="No personal vehicles" description="Add a student's vehicle below."/> : <div className="table-wrap"><table className="responsive-table"><tbody>
      {data.personalVehicles.map(p => <tr key={p.id}><td className="primary"><strong>{p.plate}</strong><small>{p.owner_name} · {p.vehicle_type} · {p.battery_level}%</small></td><td data-label="Status"><StatusBadge value={p.status}/></td>
        <td className="actions"><button className="button small ghost" onClick={() => act(() => api(`/admin/vehicles/${p.id}`, { method: 'DELETE' }), 'Vehicle retired.')}>Retire</button></td></tr>)}</tbody></table></div>}
    <div className="form-grid">
      <label>Owner<select value={v.ownerId} onChange={e => setV({ ...v, ownerId: e.target.value })}><option value="">Choose a student</option>{data.students.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></label>
      <label>Hub<select value={v.hubId} onChange={e => setV({ ...v, hubId: e.target.value })}><option value="">Choose a Hub</option>{data.hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      <label>Plate<input value={v.plate} onChange={e => setV({ ...v, plate: e.target.value })}/></label>
      <label>Type<select value={v.vehicleType} onChange={e => setV({ ...v, vehicleType: e.target.value })}>{data.vehicleTypes.map(t => <option key={t}>{t}</option>)}</select></label>
      <label>Connector<select value={v.connectorType} onChange={e => setV({ ...v, connectorType: e.target.value })}>{data.connectorTypes.map(t => <option key={t}>{t}</option>)}</select></label>
      <button className="button secondary" disabled={!v.ownerId || !v.hubId || !v.plate.trim()} onClick={() => act(() => api('/admin/personal-vehicles', { method: 'POST', body: { ...v, batteryLevel: Number(v.batteryLevel) } }), 'Personal vehicle added.').then(() => setV({ ...v, plate: '' }))}>Add vehicle</button>
    </div>
  </section>;
}

// DEMO ONLY — not part of the project scope.
function DemoTools({ onDone, setError, setSuccess }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  async function reset() {
    setBusy(true); setError(''); setSuccess('');
    try {
      const r = await api('/admin/reset-demo', { method: 'POST', body: { confirm: 'RESET' } });
      setSuccess(`Demo data was reset. ${r.accountsRemoved} extra account(s) removed; the five default accounts remain.`);
      setConfirming(false);
      await refreshClock();
      await onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section className="card-surface padded section-gap" style={{ borderColor: '#f1d8a2' }}>
    <div className="subsection-title"><strong>Demo tools</strong><span className="badge amber">DEMO ONLY</span></div>
    <p className="helper-text">Not part of the project scope. Deletes all bookings, parking reservations, charging requests, incidents, notifications, violations, simulation runs and saved settings, restores the sample Hubs, vehicles and chargers, and returns the demo clock to real time. Every account except the five defaults (Admin, Student, Operator, Simulation Operator, Demo) is deleted. This cannot be undone.</p>
    {!confirming
      ? <button className="button secondary" onClick={() => setConfirming(true)}>Reset demo data…</button>
      : <div className="inline-actions"><button className="button primary" style={{ background: '#b8312a' }} disabled={busy} onClick={reset}>{busy ? 'Resetting…' : 'Yes, reset everything'}</button><button className="button ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button></div>}
  </section>;
}

export default function Admin() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('settings');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const load = useCallback(async () => { try { setData(await api('/admin/overview')); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  async function act(call, message) {
    setError(''); setSuccess('');
    try { await call(); setSuccess(message); await load(); return true; } catch (e) { setError(e.message); return false; }
  }
  return <>
    <SectionHeader eyebrow="ADMIN · CONFIGURATION" title="Hub Network Configuration" description="Settings, slots, chargers and vehicles. Items with history are taken out of service or retired instead of deleted." action={<RefreshButton onClick={load}/>}/>
    <Feedback error={error} success={success}/>
    {!data ? <EmptyState title="Loading" description="Fetching the configuration…"/> : <>
      <div className="tabs">
        <button className={`button small ${tab === 'settings' ? 'primary' : 'secondary'}`} onClick={() => setTab('settings')}>Settings</button>
        {data.hubs.map(h => <button key={h.id} className={`button small ${tab === h.id ? 'primary' : 'secondary'}`} onClick={() => setTab(h.id)}>{h.name}</button>)}
        <button className={`button small ${tab === 'personal' ? 'primary' : 'secondary'}`} onClick={() => setTab('personal')}>Personal vehicles</button>
      </div>
      {tab === 'settings' && <SettingsPanel settings={data.settings} onSaved={load} setError={setError} setSuccess={setSuccess}/>}
      {data.hubs.filter(h => h.id === tab).map(h => <HubPanel key={h.id} hub={h} data={data} act={act}/>)}
      {tab === 'personal' && <PersonalPanel data={data} act={act}/>}
      <DemoTools onDone={load} setError={setError} setSuccess={setSuccess}/>
    </>}
  </>;
}
