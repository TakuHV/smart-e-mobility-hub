
import React, { useEffect, useState } from 'react';
import Login from './pages/Login';
import HubDashboard from './pages/HubDashboard';
import SharedVehicle from './pages/SharedVehicle';
import Parking from './pages/Parking';
import Charging from './pages/Charging';
import Simulation from './pages/Simulation';
import AppShell from './components/AppShell';
import { getStoredUser, setStoredUser, api } from './api';

export default function App() {
  const [user, setUser] = useState(getStoredUser());
  const [page, setPage] = useState('dashboard');
  const [apiOnline, setApiOnline] = useState(null);

  useEffect(() => {
    api('/health')
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false));
  }, []);

  function login(nextUser) {
    setStoredUser(nextUser);
    setUser(nextUser);
    setPage(
      nextUser.role === 'Simulation Operator'
        ? 'simulation'
        : 'dashboard'
    );
  }

  function logout() {
    setStoredUser(null);
    setUser(null);
    setPage('dashboard');
  }

  if (!user) return <Login onLogin={login} />;

  let content;

  switch (page) {
    case 'vehicles':
      content = <SharedVehicle user={user} />;
      break;
    case 'parking':
      content = <Parking user={user} />;
      break;
    case 'charging':
      content = <Charging user={user} />;
      break;
    case 'simulation':
      content = <Simulation user={user} />;
      break;
    default:
      content = <HubDashboard user={user} />;
  }

  return (
    <AppShell
      user={user}
      page={page}
      setPage={setPage}
      onLogout={logout}
    >
      {apiOnline === false && (
        <div className="feedback is-error top-error">
          Backend API is not reachable. Start the server with{' '}
          <code>npm run dev</code>.
        </div>
      )}
      {content}
    </AppShell>
  );
}
