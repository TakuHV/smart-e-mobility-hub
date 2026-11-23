const navItems = [
  { id: 'dashboard', label: 'Hub Dashboard', icon: '▦', roles: ['Student','Operator','Simulation Operator','Admin'] },
  { id: 'vehicles', label: 'Shared Vehicles', icon: '↗', roles: ['Student','Operator','Admin'] },
  { id: 'parking', label: 'Parking', icon: '▤', roles: ['Student','Operator','Admin'] },
  { id: 'charging', label: 'Smart Charging', icon: 'ϟ', roles: ['Student','Operator','Admin'] },
  // Operators open this page to see recommendations sent to them and to confirm a receiving workflow is done.
  { id: 'simulation', label: 'What-if Simulation', icon: '◌', roles: ['Simulation Operator','Operator','Admin'] }
];

export default function AppShell({ user, page, setPage, onLogout, online = true, children }) {
  const roleLabel = user.role === 'Simulation Operator' ? 'Simulation' : user.role;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">E</div>
        <div><strong>e-Mobility</strong><span>SMART HUB PLATFORM</span></div>
      </div>
      <div className="nav-caption">WORKSPACE</div>
      <nav>
        {navItems.filter(item => item.roles.includes(user.role)).map(item =>
          <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}>
            <span className="nav-icon">{item.icon}</span>{item.label}
          </button>
        )}
      </nav>
      <div className="sidebar-bottom">
        <div className={`system-status ${online === false ? 'offline' : ''}`}><span className="pulse-dot"/> {online === false ? 'Backend not reachable' : 'MVP services online'}</div>
        <div className="user-chip">
          <div className="avatar">{user.full_name?.slice(0,1)?.toUpperCase() || 'U'}</div>
          <div className="user-meta"><strong>{user.full_name}</strong><span>{roleLabel}</span></div>
          <button className="logout-icon" title="Sign out" aria-label="Sign out" onClick={onLogout}>↪</button>
        </div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumb"><span>Workspace</span><b>/</b><strong>{navItems.find(n => n.id === page)?.label || 'Dashboard'}</strong></div>
        <div className="topbar-right"><span className="demo-pill">DEMO ENVIRONMENT</span><span className="topbar-date">{new Intl.DateTimeFormat('en-GB',{dateStyle:'medium'}).format(new Date())}</span></div>
      </header>
      <div className="page-content">{children}</div>
      <footer className="app-footer">Smart E-Mobility Hub · MVP · Simulated sensor data · No real payment or physical IoT integration</footer>
    </main>
  </div>;
}
