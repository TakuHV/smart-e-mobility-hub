import { useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';
import RefreshButton from '../components/RefreshButton';
import BatteryIcon from '../components/BatteryIcon.jsx';
import SlotMap from '../components/SlotMap.jsx';
import { useIsMobile } from '../hooks';

const REFRESH_MS = 30000;
const fmtTime = value => (value ? new Date(value).toLocaleTimeString() : '—');

export default function HubDashboard() {
  const [hubs, setHubs] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const isMobile = useIsMobile();
  // On a phone the page shows either the list of Hubs or one Hub's details, with a Back button.
  const [showDetail, setShowDetail] = useState(false);

  async function loadHubs({ silent = false } = {}) {
    if (!silent) setLoading(true);
    setError('');
    try {
      const result = await api('/hubs');
      setHubs(result.hubs);
      setSelectedId(prev => (result.hubs.some(h => h.id === prev) ? prev : (result.hubs[0]?.id || '')));
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  async function loadDetail(id) {
    if (!id) { setDetail(null); return; }
    try { setDetail((await api(`/hubs/${id}/status`)).status); }
    catch (err) { setError(err.message); }
  }

  useEffect(() => { loadHubs(); }, []);
  useEffect(() => { loadDetail(selectedId); }, [selectedId]);
  // Status data ages (BR-27), so the page refreshes itself.
  useEffect(() => {
    const timer = setInterval(() => { loadHubs({ silent: true }); loadDetail(selectedId); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [selectedId]);

  const openHub = id => { setSelectedId(id); setShowDetail(true); window.scrollTo({ top: 0 }); };
  const listVisible = !isMobile || !showDetail;
  const detailVisible = !isMobile || showDetail;
  const capacityRows = detail ? ['Shared', 'Personal'].filter(type => detail.capacity?.[type]) : [];

  return <>
    {listVisible && <SectionHeader eyebrow="CAMPUS OPERATIONS" title="Hub Dashboard" description="Choose a Hub to inspect its current resources, availability and simulated status." action={<RefreshButton label="Refresh status" onClick={() => { loadHubs(); loadDetail(selectedId); }}/>}/>}
    <Feedback error={error}/>
    {listVisible && (loading ? <div className="loading-block">Loading Hubs…</div> : hubs.length === 0 ? <EmptyState title="No Hubs" description="No Hub is set up yet."/> : <div className="stat-grid three hub-picker">
      {hubs.map(hub => <button key={hub.id} className={`hub-card ${selectedId === hub.id ? 'selected' : ''}`} onClick={() => openHub(hub.id)}>
        <div className="hub-card-top"><span className="hub-code">{hub.code}</span><span className="badge-group"><StatusBadge value={hub.open_now ? 'Open now' : 'Closed'}/><StatusBadge value={hub.statusFreshness}/></span></div>
        <strong>{hub.name}</strong><span className="hub-location">⌖ {hub.location} · {hub.open_time}–{hub.close_time}</span>
        <div className="hub-mini-metrics"><span><b>{hub.available_shared_vehicles}</b> vehicles</span><span><b>{hub.available_personal_slots}</b> parking</span><span><b>{hub.available_chargers}</b> chargers</span></div>
        {hub.warnings?.length > 0 && <div className="warning-line">⚠ {hub.warnings.join(' · ')}</div>}
      </button>)}
    </div>)}
    <div className="hub-layout single">
      {detailVisible && <div className="hub-detail card-surface">
        {isMobile && <button className="button ghost small mobile-back" onClick={() => setShowDetail(false)}>← All hubs</button>}
        {!detail ? <EmptyState title="Select a Hub" description="Select a location to inspect its live and simulated resource status."/> : <>
          <div className="detail-heading"><div><span className="hub-code">{detail.code}</span><h3>{detail.name}</h3><p>{detail.location} · Operating hours {detail.open_time}–{detail.close_time}</p></div><span className="badge-group"><StatusBadge value={detail.open_now ? 'Open now' : 'Closed'}/><StatusBadge value={detail.statusFreshness}/></span></div>
          <div className="detail-status-banner"><div><span className="status-dot"/> Sensor status: <strong>{detail.statusFreshness}</strong></div><span>Last refresh: {fmtTime(detail.sensor_updated_at)}</span></div>
          {detail.statusFreshness === 'Stale' && <div className="feedback is-warning">This status is older than 2 minutes. Counts below are not confirmed (BR-27).</div>}
          {!detail.open_now && <div className="feedback is-info">This Hub is closed. New bookings and reservations are accepted only during {detail.open_time}–{detail.close_time}; returns are accepted at any time.</div>}
          <div className="resource-grid">
            <div className="resource-tile"><span>Shared vehicles</span><strong>{detail.availableSharedVehicles}</strong><small>Available for booking</small></div>
            <div className="resource-tile"><span>Shared slots</span><strong>{detail.availableSharedSlots}</strong><small>Free return spaces</small></div>
            <div className="resource-tile"><span>Personal slots</span><strong>{detail.availablePersonalSlots}</strong><small>Free parking spaces</small></div>
            <div className="resource-tile"><span>Charging queue</span><strong>{detail.queue.length}</strong><small>Queued, assigned or charging</small></div>
          </div>
          <div className="detail-section"><div className="subsection-title"><strong>Parking capacity by slot type</strong><span>Warning from 80%, critical from 95%</span></div>
            <div className="capacity-list">{capacityRows.map(type => { const c = detail.capacity[type]; return <div className="capacity-row" key={type}>
              <div><strong>{type}</strong><small>{c.available} free of {c.usable} usable</small></div>
              <div className="level-track"><i className={c.level.toLowerCase()} style={{ width: `${Math.min(100, c.occupancyPercent)}%` }}/></div>
              <span><b>{c.occupancyPercent}%</b> <StatusBadge value={c.level}/></span>
            </div>; })}</div>
            <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Slot type</th><th className="num">Total</th><th className="num">Available</th><th className="num">Occupied</th><th className="num">Reserved</th></tr></thead><tbody>
              {detail.slotSummary.map(row => <tr key={row.slot_type}><td className="primary"><strong>{row.slot_type}</strong></td><td className="num" data-label="Total">{row.total}</td><td className="num" data-label="Available">{row.available}</td><td className="num" data-label="Occupied">{row.occupied}</td><td className="num" data-label="Reserved">{row.reserved}</td></tr>)}
            </tbody></table></div>
          </div>
          <div className="detail-section"><div className="subsection-title"><strong>Chargers and power</strong><span>{detail.activePowerKw} / {detail.powerLimitKw} kW</span></div>
            <div className="power-track"><span style={{ width: `${Math.min(100, detail.powerUtilizationPercent)}%` }}/></div>
            <div className="charger-list">{detail.chargers.map(ch => <div className="charger-row" key={ch.id}><span>{ch.code}<small>{ch.power_kw} kW</small></span><span>{ch.plate || 'No vehicle assigned'}</span><StatusBadge value={ch.status}/></div>)}</div>
          </div>
          <div className="detail-section"><div className="subsection-title"><strong>Charging queue</strong><span>In scheduler order · waiting times are estimates</span></div>
            {detail.queue.length === 0 ? <EmptyState title="Queue is empty" description="No request is waiting for a charger at this Hub."/> : <div className="table-wrap"><table className="responsive-table">
              <thead><tr><th>#</th><th>Vehicle</th><th>Priority</th><th className="num">Battery</th><th>Status</th><th className="num">Est. wait</th></tr></thead>
              <tbody>{detail.queue.map((r, index) => <tr key={r.id}><td className="hide-mobile">{index + 1}</td><td className="primary"><strong>#{index + 1} · {r.plate || 'Another student’s vehicle'}</strong><small>{r.kind === 'shared' ? 'Shared · automatic' : 'Personal'}</small></td>
                <td data-label="Priority">{r.priority_class ? <StatusBadge value={`Class ${r.priority_class}`}/> : '—'}<small>score {Number(r.priority_score || 0).toFixed(1)}</small></td>
                <td className="num" data-label="Battery">{r.battery_level == null ? '—' : <BatteryIcon level={r.battery_level} charging={r.status === 'Charging'} size="sm"/>}</td><td data-label="Status"><StatusBadge value={r.status}/></td>
                <td className="num" data-label="Est. wait">{r.estimated_wait_minutes == null ? '—' : `${r.estimated_wait_minutes} min`}</td></tr>)}</tbody>
            </table></div>}
          </div>
          <div className="section-gap-small"><div className="subsection-title"><strong>Parking map</strong><span>Which slots are taken right now · click an occupied Personal or Holding slot to see its user</span></div><SlotMap hubId={detail.id || selectedId} showOwner/></div>
          {detail.warnings?.length > 0 && <div className="feedback is-warning section-gap-small">{detail.warnings.join(' · ')}</div>}
        </>}
      </div>}
    </div>
  </>;
}
