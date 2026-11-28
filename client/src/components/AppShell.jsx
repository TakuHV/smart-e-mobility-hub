import { useState } from 'react';
import DemoClockBar from './DemoClockBar';
import NotificationBell from './NotificationBell';

// What each role sees. Students use the separate StudentApp, so they are not listed here.
const navItems = [
  { id: 'dashboard', label: 'Hub Dashboard', short: 'Hubs', icon: '🏢', roles: ['Operator','Simulation Operator'] },
  { id: 'charging', label: 'Smart Charging', short: 'Charging', icon: '🔌', roles: ['Operator'] },
  { id: 'incidents', label: 'Incidents', short: 'Issues', icon: '⚠️', roles: ['Operator'] },
  { id: 'dispatch', label: 'Vehicle & User Redistribution', short: 'Dispatch', icon: '🚚', roles: ['Operator'] },
  { id: 'simulation', label: 'What-if Simulation', short: 'Simulation', icon: '🧮', roles: ['Operator','Simulation Operator'] },
  { id: 'users', label: 'User Accounts', short: 'Users', icon: '👥', roles: ['Admin'] },
  { id: 'access', label: 'Roles & Access', short: 'Access', icon: '🔐', roles: ['Admin'] },
  { id: 'admin', label: 'Configuration', short: 'Config', icon: '⚙️', roles: ['Admin'] }
];

const ROLES = ['Student', 'Operator', 'Simulation Operator', 'Admin'];

// Only the Demo account (which has all four roles) can open the app as another role.
export function RoleSwitch({ user, onSwitchRole }) {
  if (user.full_name !== 'Demo' || !onSwitchRole) return null;
  return <label className="role-switch">Open as<select value={user.role} onChange={e => onSwitchRole(e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</select></label>;
}

export default function AppShell({ user, page, setPage, onLogout, online = true, onSwitchRole, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const roleLabel = user.role === 'Simulation Operator' ? 'Simulation' : user.role;
  const items = navItems.filter(item => item.roles.includes(user.role));
  const initial = user.full_name?.slice(0, 1)?.toUpperCase() || 'U';
  const go = id => { setPage(id); setMenuOpen(false); window.scrollTo({ top: 0 }); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">E</div>
        <div><strong>e-Mobility</strong><span>SMART HUB PLATFORM</span></div>
      </div>
      <div className="nav-caption">WORKSPACE</div>
      <nav>
        {items.map(item =>
          <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => go(item.id)}>
            <span className="nav-icon">{item.icon}</span>{item.label}
          </button>
        )}
      </nav>
      <div className="sidebar-bottom">
        <div className={`system-status ${online === false ? 'offline' : ''}`}><span className="pulse-dot"/> {online === false ? 'Backend not reachable' : 'MVP services online'}</div>
        <RoleSwitch user={user} onSwitchRole={onSwitchRole}/>
        <div className="user-chip">
          <div className="avatar">{initial}</div>
          <div className="user-meta"><strong>{user.full_name}</strong><span>{roleLabel}</span></div>
          <button className="logout-icon" title="Sign out" aria-label="Sign out" onClick={onLogout}>↪</button>
        </div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="mobile-brand"><div className="brand-mark small">E</div></div>
        <div className="breadcrumb"><span>Workspace</span><b>/</b><strong>{navItems.find(n => n.id === page)?.label || 'Dashboard'}</strong></div>
        <div className="topbar-right">
          <span className="demo-pill">DEMO ENVIRONMENT</span><DemoClockBar user={user}/><NotificationBell/>
        </div>
        <div className="mobile-user">
          {online === false && <span className="offline-dot" title="Backend not reachable"/>}
          <button className="avatar avatar-button" aria-label="Account menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>{initial}</button>
          {menuOpen && <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)}/>
            <div className="user-menu" role="menu">
              <strong>{user.full_name}</strong><span>{roleLabel} · demo account</span>
              <RoleSwitch user={user} onSwitchRole={role => { setMenuOpen(false); onSwitchRole(role); }}/>
              <button className="button secondary full" onClick={onLogout}>Sign out</button>
            </div>
          </>}
        </div>
      </header>
      <div className="page-content">{children}</div>
      <footer className="app-footer">Smart E-Mobility Hub · MVP · Simulated sensor data · No real payment or physical IoT integration</footer>
    </main>
    <nav className="bottom-nav" aria-label="Main navigation">
      {items.map(item =>
        <button key={item.id} className={`bottom-tab ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => go(item.id)}>
          <span className="bottom-icon" aria-hidden="true">{item.icon}</span><span>{item.short}</span>
        </button>
      )}
    </nav>
  </div>;
}
