import { useState } from 'react';
import { api } from '../api';
import { useLoad } from './ui';
import StatusBadge from '../components/StatusBadge';

export default function History({ user }) {
  const [items, setItems] = useState(null);
  useLoad(async () => {
    try {
      const [b, r, q, i] = await Promise.all([api('/vehicles/bookings'), api('/parking/reservations'), api('/charging/queue'), api('/incidents')]);
      const list = [
        ...b.bookings.map(x => ({ id: x.id, icon: '🛵', title: `Vehicle ${x.plate}`, sub: x.destination_hub_name ? `${x.hub_name} → ${x.destination_hub_name}` : x.hub_name, status: x.status, at: x.created_at })),
        ...r.reservations.map(x => ({ id: x.id, icon: '🅿️', title: `Parking ${x.slot_code}`, sub: `${x.hub_name} · ${x.plate}`, status: x.status, at: x.start_at })),
        ...q.requests.filter(x => x.user_id === user.id).map(x => ({ id: x.id, icon: '⚡', title: `Charging ${x.plate}`, sub: x.hub_name, status: x.status, at: x.registered_at || x.created_at })),
        ...i.incidents.map(x => ({ id: x.id, icon: '🛟', title: x.category, sub: x.summary, status: x.status, at: x.created_at }))
      ].sort((a, b2) => Date.parse(b2.at) - Date.parse(a.at));
      setItems(list);
    } catch { /* keep */ }
  }, 20);
  return <>
    <h1>My history</h1>
    {items === null ? <p>Loading…</p> : items.length === 0 ? <div className="stu-card"><p>Nothing here yet. Your trips, parking and charging will be listed here.</p></div>
      : items.map(x => <div className="hist-item" key={x.id}><span className="hi">{x.icon}</span><div className="ht"><b>{x.title}</b><small>{x.sub}</small><small>{new Date(x.at).toLocaleString('en-GB')}</small></div><StatusBadge value={x.status}/></div>)}
  </>;
}
