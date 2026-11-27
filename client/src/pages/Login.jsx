import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Feedback } from '../components/Feedback';

const ROLES = ['Student', 'Operator', 'Simulation Operator', 'Admin'];

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [demoRole, setDemoRole] = useState('Student');
  const isDemo = username.trim().toLowerCase() === 'demo';

  // The sign-in screen never scrolls on a phone (see .login-lock in styles.css); the lock is removed when the screen closes.
  useEffect(() => {
    document.documentElement.classList.add('login-lock');
    return () => document.documentElement.classList.remove('login-lock');
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      // The Demo account has all four roles, so the role is sent only for it.
      const result = await api('/auth/demo-login', { method: 'POST', body: { displayName: username, ...(isDemo ? { role: demoRole } : {}) } });
      onLogin(result.user);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <div className="login-screen">
    <div className="login-art">
      <div className="aurora a1"/><div className="aurora a2"/><div className="art-grid"/>
      <div className="login-brand"><div className="brand-mark large">E</div><span>SMART E-MOBILITY HUB</span></div>
      <div className="login-message"><span className="eyebrow">CAMPUS MOBILITY, CONNECTED</span><h1>Move smarter.<br/><em>Charge better.</em></h1><p>A lightweight campus mobility platform for shared vehicles, personal parking, smart charging and what-if planning.</p></div>
      <div className="art-cards" aria-hidden="true">
        <div className="glass art-battery">
          <svg viewBox="0 0 48 48" width="54" height="54"><circle cx="24" cy="24" r="19" fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="5"/><circle cx="24" cy="24" r="19" fill="none" stroke="#7ee7d3" strokeWidth="5" strokeLinecap="round" strokeDasharray="98 120" transform="rotate(-90 24 24)"/></svg>
          <div><b>82%</b><small>Charging · CH-1</small></div>
        </div>
        <div className="glass art-trip"><span className="art-emoji">🛵</span><div><b>Central Hub → Library Hub</b><small>Trip in progress</small></div></div>
        <div className="glass art-slot"><span className="art-check">✓</span><div><b>Parking spot reserved</b><small>Personal slot P-04</small></div></div>
      </div>
    </div>
    <div className="login-panel">
      <div className="login-form-wrap">
        <div className="eyebrow">MVP ACCESS</div><h2>Welcome back</h2><p className="muted-text">Sign in with a demo account: admin, student, operator, simulation operator or demo.</p>
        <form onSubmit={submit} className="form-stack">
          <label>Username<input value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter your username" autoComplete="username" autoCapitalize="none" required/></label>
          {isDemo && <label>Open as<select value={demoRole} onChange={e => setDemoRole(e.target.value)}>
            {ROLES.map(r => <option key={r}>{r}</option>)}
          </select></label>}
          <Feedback error={error}/>
          <button className="button primary full" disabled={busy}>{busy ? 'Signing in…' : 'Enter workspace'} <span>→</span></button>
        </form>
        <p className="login-register">Don't have an account? <a href="#register" onClick={e => e.preventDefault()}>Register</a></p>
        <div className="login-demo-note"><strong>Demo authentication only</strong><span>Student identity is simulated; staff accounts are not connected to production SSO.</span></div>
      </div>
    </div>
  </div>;
}
