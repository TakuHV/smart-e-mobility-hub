import { useState } from 'react';
import { api } from '../api';
import { useLoad } from './ui';

export default function Notifications({ onChanged }) {
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const load = useLoad(async () => { try { setData(await api('/notifications')); } catch { /* ignore */ } }, 10);
  const readAll = async () => { await api('/notifications/read', { method: 'POST', body: {} }).catch(() => {}); await load(); onChanged?.(); };
  const readOne = async n => { if (n.read_at) return; await api('/notifications/read', { method: 'POST', body: { id: n.id } }).catch(() => {}); await load(); onChanged?.(); };
  return <>
    <h1>Notifications</h1>
    {data.unread > 0 && <button className="stu-btn secondary" onClick={readAll}>Mark all as read</button>}
    {data.notifications.length === 0 ? <div className="stu-card"><p>No messages yet. Reminders about your trip, parking and charging will appear here.</p></div>
      : data.notifications.map(n => <div key={n.id} className={`note-item ${n.read_at ? '' : 'unread'}`} onClick={() => readOne(n)}>
        <b>{n.title}</b><span>{n.message}</span><small>{new Date(n.created_at).toLocaleString('en-GB')}</small>
      </div>)}
  </>;
}
