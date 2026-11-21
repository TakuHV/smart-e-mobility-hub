import { useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';

export default function HubDashboard() {
  const [hubs, setHubs] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [q, setQ] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadHubs() {
    setLoading(true); setError('');
    try {
      const result = await api(`/hubs?q=${encodeURIComponent(q)}&resourceType=${resourceType}`);
      setHubs(result.hubs);
      if (!selectedId && result.hubs[0]) setSelectedId(result.hubs[0].id);
      else if (selectedId && !result.hubs.some(h => h.id === selectedId)) setSelectedId(result.hubs[0]?.id || '');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  async function loadDetail(id) {
    if (!id) { setDetail(null); return; }
    try { const result = await api(`/hubs/${id}/status`); setDetail(result.status); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { loadHubs(); }, [resourceType]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId]);
  useEffect(() => { const timer = setTimeout(loadHubs, 250); return () => clearTimeout(timer); }, [q]);

  const totalVehicles = hubs.reduce((s,h)=>s+Number(h.available_shared_vehicles||0),0);
  const totalParking = hubs.reduce((s,h)=>s+Number(h.available_personal_slots||0),0);
  const totalChargers = hubs.reduce((s,h)=>s+Number(h.available_chargers||0),0);

  return <>
    <SectionHeader eyebrow="CAMPUS OPERATIONS" title="Hub Dashboard" description="Search mobility hubs and inspect current resources, availability and simulated status." action={<button className="button secondary" onClick={loadHubs}>↻ Refresh status</button>}/>
    <Feedback error={error}/>
    <div className="stat-grid three">
      <StatCard label="Available shared vehicles" value={totalVehicles} detail="Across listed Hubs" icon="↗"/>
      <StatCard label="Available personal slots" value={totalParking} detail="Personal parking capacity" icon="▤"/>
      <StatCard label="Available chargers" value={totalChargers} detail="Common charging areas" icon="ϟ"/>
    </div>
    <div className="toolbar card-surface">
      <div className="search-box"><span>⌕</span><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search by Hub name, code or location"/></div>
      <select value={resourceType} onChange={e=>setResourceType(e.target.value)}><option value="">All resources</option><option value="shared">Shared vehicles</option><option value="parking">Personal parking</option><option value="charger">Chargers</option></select>
    </div>
    <div className="hub-layout">
      <div className="hub-list">
        <div className="subsection-title"><strong>Mobility Hubs</strong><span>{hubs.length} locations</span></div>
        {loading ? <div className="loading-block">Loading Hubs…</div> : hubs.length === 0 ? <EmptyState title="No matching Hubs" description="Try changing your search or resource filter."/> : hubs.map(hub =>
          <button key={hub.id} className={`hub-card ${selectedId===hub.id?'selected':''}`} onClick={()=>setSelectedId(hub.id)}>
            <div className="hub-card-top"><span className="hub-code">{hub.code}</span><StatusBadge value={hub.statusFreshness}/></div>
            <strong>{hub.name}</strong><span className="hub-location">⌖ {hub.location}</span>
            <div className="hub-mini-metrics"><span><b>{hub.available_shared_vehicles}</b> vehicles</span><span><b>{hub.available_personal_slots}</b> parking</span><span><b>{hub.available_chargers}</b> chargers</span></div>
            {hub.warnings?.length > 0 && <div className="warning-line">⚠ {hub.warnings.join(' · ')}</div>}
          </button>
        )}
      </div>
      <div className="hub-detail card-surface">
        {!detail ? <EmptyState title="Select a Hub" description="Select a location to inspect its live and simulated resource status."/> : <>
          <div className="detail-heading"><div><span className="hub-code">{detail.code}</span><h3>{detail.name}</h3><p>{detail.location} · Operating hours {detail.open_time}–{detail.close_time}</p></div><StatusBadge value={detail.statusFreshness}/></div>
          <div className="detail-status-banner"><div><span className="status-dot"/> Sensor status: <strong>{detail.statusFreshness}</strong></div><span>Last refresh: {new Date(detail.sensor_updated_at).toLocaleTimeString()}</span></div>
          <div className="resource-grid">
            <div className="resource-tile"><span>Shared vehicles</span><strong>{detail.availableSharedVehicles}</strong><small>Available for booking</small></div>
            <div className="resource-tile"><span>Shared slots</span><strong>{detail.availableSharedSlots}</strong><small>Free return spaces</small></div>
            <div className="resource-tile"><span>Personal slots</span><strong>{detail.availablePersonalSlots}</strong><small>Free parking spaces</small></div>
            <div className="resource-tile"><span>Charging queue</span><strong>{detail.queue.length}</strong><small>Queued, assigned or charging</small></div>
          </div>
          <div className="detail-section"><div className="subsection-title"><strong>Parking capacity by slot type</strong></div>
            <div className="table-wrap"><table><thead><tr><th>Slot type</th><th>Total</th><th>Available</th><th>Occupied</th><th>Reserved</th></tr></thead><tbody>
              {detail.slotSummary.map(row=><tr key={row.slot_type}><td>{row.slot_type}</td><td>{row.total}</td><td>{row.available}</td><td>{row.occupied}</td><td>{row.reserved}</td></tr>)}
            </tbody></table></div>
          </div>
          <div className="detail-section"><div className="subsection-title"><strong>Chargers and power</strong><span>{detail.activePowerKw} / {detail.powerLimitKw} kW</span></div>
            <div className="power-track"><span style={{width:`${Math.min(100,detail.powerUtilizationPercent)}%`}}/></div>
            <div className="charger-list">{detail.chargers.map(ch=><div className="charger-row" key={ch.id}><span>{ch.code}</span><span>{ch.plate || 'No vehicle assigned'}</span><StatusBadge value={ch.status}/></div>)}</div>
          </div>
          {detail.warnings?.length > 0 && <div className="feedback is-warning">{detail.warnings.join(' · ')}</div>}
        </>}
      </div>
    </div>
  </>;
}
