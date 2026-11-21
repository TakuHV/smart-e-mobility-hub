import React, { useState } from 'react';
import { api } from '../api';
import { Feedback } from '../components/Feedback';

export default function Login({ onLogin }) {
  const [displayName, setDisplayName] = useState('Demo Student');
  const [role, setRole] = useState('Student');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api('/auth/demo-login', { method: 'POST', body: { displayName, role } });
      onLogin(result.user);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <div className="login-screen">
    <div className="login-art">
      <div className="login-orbit orbit-one"/><div className="login-orbit orbit-two"/>
      <div className="login-brand"><div className="brand-mark large">E</div><span>SMART E-MOBILITY HUB</span></div>
      <div className="login-message"><span className="eyebrow">CAMPUS MOBILITY, CONNECTED</span><h1>Move smarter.<br/><em>Charge better.</em></h1><p>A lightweight campus mobility platform for shared vehicles, personal parking, smart charging and what-if planning.</p></div>
      <div className="login-mini-stats"><div><b>03</b><span>Mobility Hubs</span></div><div><b>05</b><span>Core workflows</span></div><div><b>01</b><span>Modular backend</span></div></div>
    </div>
    <div className="login-panel">
      <div className="login-form-wrap">
        <div className="eyebrow">MVP ACCESS</div><h2>Welcome back</h2><p className="muted-text">Sign in with a simulated project identity to explore the demo workflows.</p>
        <form onSubmit={submit} className="form-stack">
          <label>Display name<input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your name" required minLength={2}/></label>
          <label>Demo role<select value={role} onChange={e=>setRole(e.target.value)}>
            <option>Student</option><option>Operator</option><option>Simulation Operator</option><option>Admin</option>
          </select></label>
          <Feedback error={error}/>
          <button className="button primary full" disabled={busy}>{busy ? 'Signing in…' : 'Enter workspace'} <span>→</span></button>
        </form>
        <div className="login-demo-note"><strong>Demo authentication only</strong><span>Student identity is simulated; staff accounts are not connected to production SSO.</span></div>
      </div>
    </div>
  </div>;
}
