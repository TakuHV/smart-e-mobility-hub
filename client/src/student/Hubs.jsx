import { useState } from 'react';
import { api } from '../api';
import SlotMap from '../components/SlotMap.jsx';
import { BackHeader, useLoad } from './ui';

// Students see where the Hubs are, when they are open and a parking map (free, reserved or occupied slots; never which vehicle).
export default function Hubs({ onClose }) {
  const [hubs, setHubs] = useState(null);
  const [redirects, setRedirects] = useState([]);
  const [error, setError] = useState('');
  const [mapOpen, setMapOpen] = useState('');   // id of the Hub whose parking map is open
  useLoad(async () => { try { const [h, r] = await Promise.all([api('/hubs'), api('/hubs/redirects')]); setHubs(h.hubs); setRedirects(r.redirects); } catch (e) { setError(e.message); } }, 30);
  return <>
    <BackHeader title="Mobility Hubs" onBack={onClose}/>
    {error && <div className="stu-error">{error}</div>}
    {hubs === null ? <p>Loading…</p> : <div className="choice-list">
      {hubs.map(h => <div key={h.id} className="stu-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <h2>{h.name}</h2>
          <span className={`badge ${h.open_now ? 'green' : 'red'}`}>{h.open_now ? 'Open' : 'Closed'}</span>
        </div>
        <p>📍 {h.location}</p>
        <p>🕔 {h.open_time} – {h.close_time}</p>
        <button type="button" className="stu-btn secondary" onClick={() => setMapOpen(mapOpen === h.id ? '' : h.id)}>{mapOpen === h.id ? 'Hide parking map' : 'Show parking map'}</button>
        {mapOpen === h.id && <SlotMap hubId={h.id}/>}
        {redirects.filter(r => r.from_hub_id === h.id).map(r => <div className="stu-note" key={r.id}>Busy right now. Please use <b>{r.to_hub_name}</b>.</div>)}
      </div>)}
    </div>}
  </>;
}
