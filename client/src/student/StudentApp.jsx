import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAutoRefresh } from '../clock';
import Home from './Home';
import History from './History';
import Notifications from './Notifications';
import Profile from './Profile';
import BookFlow from './BookFlow';
import ParkFlow from './ParkFlow';
import ChargeFlow from './ChargeFlow';
import ReportFlow from './ReportFlow';
import Hubs from './Hubs';

const TABS = [
  { id: 'home', icon: '🏠', label: 'Home' },
  { id: 'history', icon: '🕘', label: 'History' },
  { id: 'notifications', icon: '🔔', label: 'Alerts' },
  { id: 'profile', icon: '👤', label: 'Profile' }
];

// The Student experience: four big choices on the home screen, one task per screen, and a small bottom bar.
export default function StudentApp({ user, onLogout, online, onSwitchRole }) {
  const [tab, setTab] = useState('home');
  const [flow, setFlow] = useState(null);
  const [unread, setUnread] = useState(0);
  const [bigText, setBigTextState] = useState(() => localStorage.getItem('smh_big_text') === '1');
  const setBigText = v => { localStorage.setItem('smh_big_text', v ? '1' : '0'); setBigTextState(v); };

  const loadUnread = useCallback(async () => { try { setUnread((await api('/notifications')).unread); } catch { /* ignore */ } }, []);
  useEffect(() => { loadUnread(); }, [loadUnread]);
  useAutoRefresh(loadUnread, 10);

  const close = () => { setFlow(null); setTab('home'); window.scrollTo({ top: 0 }); };
  const flowProps = { user, onClose: close };
  const body = flow === 'book' ? <BookFlow {...flowProps}/>
    : flow === 'park' ? <ParkFlow {...flowProps}/>
    : flow === 'charge' ? <ChargeFlow {...flowProps}/>
    : flow === 'report' ? <ReportFlow {...flowProps}/>
    : flow === 'hubs' ? <Hubs {...flowProps}/>
    : tab === 'history' ? <History user={user}/>
    : tab === 'notifications' ? <Notifications onChanged={loadUnread}/>
    : tab === 'profile' ? <Profile user={user} onLogout={onLogout} bigText={bigText} setBigText={setBigText} onSwitchRole={onSwitchRole}/>
    : <Home user={user} open={setFlow}/>;

  return <div className={`stu ${bigText ? 'big-text' : ''}`}>
    <div className="stu-col">
      {online === false && <div className="stu-error">Cannot reach the server. Please try again in a moment.</div>}
      {body}
    </div>
    {!flow && <nav className="pill-nav" aria-label="Main">
      {TABS.map(t => <button key={t.id} className={`pill-tab ${tab === t.id ? 'active' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => { setTab(t.id); window.scrollTo({ top: 0 }); }}>
        <span className="ic" aria-hidden="true">{t.icon}</span><small>{t.label}</small>
        {t.id === 'notifications' && unread > 0 && <i className="pill-dot">{unread > 9 ? '9+' : unread}</i>}
      </button>)}
    </nav>}
  </div>;
}
