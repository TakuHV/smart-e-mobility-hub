import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAutoRefresh } from '../clock';

const sevClass = { critical: 'red', warning: 'amber', info: 'blue', success: 'green' };

export default function NotificationBell() {
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => { try { setData(await api('/notifications')); } catch { /* ignore */ } }, []);
  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, 15);

  const readAll = async () => { await api('/notifications/read', { method: 'POST', body: {} }).catch(() => {}); load(); };
  const readOne = async id => { await api('/notifications/read', { method: 'POST', body: { id } }).catch(() => {}); load(); };

  return <div className="bell-wrap">
    <button className="bell-button" aria-label={`Notifications (${data.unread} unread)`} onClick={() => { setOpen(o => !o); load(); }}>
      <span aria-hidden="true">🔔</span>{data.unread > 0 && <i className="bell-count">{data.unread > 9 ? '9+' : data.unread}</i>}
    </button>
    {open && <>
      <div className="menu-backdrop" onClick={() => setOpen(false)}/>
      <div className="bell-panel" role="dialog" aria-label="Notifications">
        <div className="bell-head"><strong>Notifications</strong>{data.unread > 0 && <button className="button small ghost" onClick={readAll}>Mark all read</button>}</div>
        {data.notifications.length === 0 ? <p className="helper-text">Nothing yet.</p> : <ul className="bell-list">
          {data.notifications.map(n => <li key={n.id} className={n.read_at ? 'read' : ''} onClick={() => !n.read_at && readOne(n.id)}>
            <span className={`dot ${sevClass[n.severity] || 'blue'}`}/>
            <div><strong>{n.title}</strong><span>{n.message}</span><small>{new Date(n.created_at).toLocaleString('en-GB')}</small></div>
          </li>)}
        </ul>}
      </div>
    </>}
  </div>;
}
