import { useEffect, useState } from 'react';
import { api } from '../api';

// Parking map of one Hub: every slot as a small tile, coloured by what is happening there right now.
// Used in the Operator's Hub Dashboard and in the Student's Mobility Hubs screen. The server hides which vehicle
// occupies a slot from Students (BR-07), so the map only shows whether a slot is free, reserved or taken.
const GROUPS = [
  { type: 'Shared', title: 'Shared slots', hint: 'Shared vehicles park here' },
  { type: 'Personal', title: 'Personal slots', hint: 'Students reserve these' },
  { type: 'Holding', title: 'Holding area', hint: 'Waiting for a charger or for pickup' }
];
const STATE = {
  Available: { cls: 'free', label: 'Free' },
  Reserved: { cls: 'reserved', label: 'Reserved' },
  Occupied: { cls: 'taken', label: 'Occupied' },
  'Out of Service': { cls: 'out', label: 'Out of service' }
};
// A Shared slot is only ever "Reserved" while its shared vehicle is away charging (BR-39: the slot is kept for it).
const CHARGING = { cls: 'charging', label: 'Vehicle charging' };
const stateOf = slot => (slot.slot_type === 'Shared' && slot.status === 'Reserved' ? CHARGING : STATE[slot.status] || STATE.Available);
// "hub-central-S12" → "S12"
const shortCode = code => String(code).split('-').pop();

export default function SlotMap({ hubId, refreshSeconds = 15, showOwner = false }) {
  const [slots, setSlots] = useState(null);
  const [picked, setPicked] = useState(null);   // Operator: the occupied Personal slot whose owner is shown
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await api(`/parking/slots?hubId=${encodeURIComponent(hubId)}`); if (alive) { setSlots(r.slots); setError(''); } }
      catch (e) { if (alive) setError(e.message); }
    };
    setSlots(null); setPicked(null);
    load();
    const timer = setInterval(load, refreshSeconds * 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [hubId, refreshSeconds]);

  if (error) return <div className="slot-map-note">{error}</div>;
  if (!slots) return <div className="slot-map-note">Loading parking map…</div>;
  return <div className="slot-map">
    {GROUPS.map(g => {
      const list = slots.filter(s => s.slot_type === g.type);
      if (!list.length) return null;
      const taken = list.filter(s => s.status === 'Occupied').length;
      const charging = list.filter(s => stateOf(s) === CHARGING).length;
      const reserved = list.filter(s => s.status === 'Reserved').length - charging;
      return <div className="slot-group" key={g.type}>
        <div className="slot-group-head"><strong>{g.title}</strong><span>{taken} occupied{charging ? ` · ${charging} charging` : ''}{reserved ? ` · ${reserved} reserved` : ''} · {list.length} total</span></div>
        <div className="slot-grid">{list.map(s => {
          const st = stateOf(s);
          const canOpen = showOwner && ['Personal', 'Holding'].includes(s.slot_type) && s.status === 'Occupied' && s.vehicle_plate;
          const Tag = canOpen ? 'button' : 'div';
          return <Tag key={s.id} {...(canOpen ? { type: 'button', onClick: () => setPicked(picked === s.id ? null : s.id) } : {})}
            className={`slot-tile ${st.cls}${canOpen ? ' clickable' : ''}${picked === s.id ? ' picked' : ''}`} title={`${shortCode(s.code)} · ${st.label}`} aria-label={`${s.code}: ${st.label}`}>
            <span>{shortCode(s.code)}</span>{st === CHARGING ? <i aria-hidden="true">⚡</i> : s.status === 'Occupied' ? <i aria-hidden="true">🛵</i> : s.status === 'Reserved' && <i aria-hidden="true">🕒</i>}
          </Tag>;
        })}</div>
        {(() => { const s = list.find(x => x.id === picked); return s && <div className="slot-owner" role="status">
          <b>{shortCode(s.code)}</b><span>Licence plate: <strong>{s.vehicle_plate}</strong></span><span>User: <strong>{s.owner_name || (s.vehicle_kind === 'shared' ? 'Shared vehicle (no owner)' : '—')}</strong></span>
          <button type="button" className="slot-owner-close" onClick={() => setPicked(null)} aria-label="Close">×</button>
        </div>; })()}
      </div>;
    })}
    <div className="slot-legend">{[...Object.values(STATE), CHARGING].map(st => <span key={st.cls}><i className={`slot-dot ${st.cls}`}/>{st.label}</span>)}</div>
  </div>;
}
