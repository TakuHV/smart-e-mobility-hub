import React, { useEffect, useState } from 'react';
import Login from './pages/Login';
import HubDashboard from './pages/HubDashboard';
import Charging from './pages/Charging';
import Simulation from './pages/Simulation';
import Dispatch from './pages/Dispatch';
import Incidents from './pages/Incidents';
import Admin from './pages/Admin';
import Users from './pages/Users';
import Access from './pages/Access';
import StudentApp from './student/StudentApp';
import AppShell from './components/AppShell';
import { getStoredUser, setStoredUser, api, verifyStoredUser, UNAUTHORIZED_EVENT } from './api';

const firstPage = user => (user?.role === 'Admin' ? 'users' : 'dashboard');

export default function App() {
  const [user, setUser] = useState(getStoredUser());
  const [page, setPage] = useState(() => firstPage(getStoredUser()));
  const [apiOnline, setApiOnline] = useState(null);

  useEffect(() => {
    api('/health').then(() => setApiOnline(true)).catch(() => setApiOnline(false));

    // A stored demo id that the server no longer knows (for example after the database was recreated) signs out.
    verifyStoredUser()
      .then(valid => { if (!valid) setUser(null); })
      .catch(() => {});
    const onUnauthorized = () => { setUser(null); setPage('dashboard'); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  function login(nextUser) {
    setStoredUser(nextUser);
    setUser(nextUser);
    setPage(firstPage(nextUser));
  }

  // The Demo account exists with all four roles; this opens the same person under another role.
  async function switchRole(role) {
    try { login((await api('/auth/demo-login', { method: 'POST', body: { displayName: 'Demo', role } })).user); }
    catch { /* the offline banner covers an unreachable server */ }
  }

  function logout() {
    setStoredUser(null);
    setUser(null);
    setPage('dashboard');
  }

  if (!user) return <Login onLogin={login} />;

  // Students get their own large, simple app (see client/src/student). Operators and Admins keep the workspace layout.
  if (user.role === 'Student') return <StudentApp user={user} onLogout={logout} online={apiOnline} onSwitchRole={switchRole}/>;

  let content;
  switch (page) {
    case 'charging': content = <Charging user={user} />; break;
    case 'dispatch': content = <Dispatch user={user} />; break;
    case 'incidents': content = <Incidents user={user} />; break;
    case 'admin': content = <Admin user={user} />; break;
    case 'users': content = <Users user={user} />; break;
    case 'access': content = <Access user={user} />; break;
    case 'simulation': content = <Simulation user={user} />; break;
    default: content = user.role === 'Admin' ? <Users user={user} /> : <HubDashboard user={user} />;
  }

  return (
    <AppShell user={user} page={page} setPage={setPage} onLogout={logout} online={apiOnline} onSwitchRole={switchRole}>
      {apiOnline === false && (
        <div className="feedback is-error top-error">
          Backend API is not reachable. Start the server with <code>npm run dev</code>.
        </div>
      )}
      {content}
    </AppShell>
  );
}
