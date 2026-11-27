import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import RefreshButton from '../components/RefreshButton';
import { Feedback } from '../components/Feedback';
import { sortAccounts, isMainAccount } from '../userOrder';

// Admin: manage roles & access (UC-010). Shows what each role can do and lets the Admin change a user's role.
export default function Access({ user }) {
  const [access, setAccess] = useState({ roles: [] });
  const [users, setUsers] = useState({ users: [], roles: [] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    try { const [a, u] = await Promise.all([api('/admin/access'), api('/admin/users')]); setAccess(a); setUsers(u); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function changeRole(u, role) {
    setError(''); setSuccess('');
    try { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role } }); setSuccess(`${u.full_name} is now ${role}.`); await load(); }
    catch (e) { setError(e.message); }
  }
  return <>
    <SectionHeader eyebrow="ADMIN · UC-010" title="Roles & Access" description="What each role can do, and who has which role." action={<RefreshButton onClick={load}/>}/>
    <Feedback error={error} success={success}/>
    <div className="stats-grid">
      {access.roles.map(r => <section key={r.role} className="card-surface padded">
        <div className="subsection-title"><strong>{r.role}</strong><span>{r.activeUsers} active</span></div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>{r.permissions.map(p => <li key={p}>{p}</li>)}</ul>
      </section>)}
    </div>
    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Change a user's role</strong><span>{users.users.length} accounts</span></div>
      <div className="table-wrap"><table className="responsive-table">
        <thead><tr><th>Name</th><th>Status</th><th>Role</th></tr></thead>
        <tbody>{sortAccounts(users.users).map(u => <tr key={u.id} className={isMainAccount(u) ? 'main-account' : ''}>
          <td className="primary"><strong>{isMainAccount(u) && <span aria-hidden="true">★ </span>}{u.full_name}</strong></td>
          <td data-label="Status">{u.status}</td>
          <td data-label="Role">{u.id === user.id ? `${u.role} (you)` : <select value={u.role} onChange={e => changeRole(u, e.target.value)}>{users.roles.map(r => <option key={r}>{r}</option>)}</select>}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="helper-text">You cannot change your own role, and at least one active Admin must remain.</p>
    </section>
  </>;
}
