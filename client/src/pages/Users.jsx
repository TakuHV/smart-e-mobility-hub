import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import RefreshButton from '../components/RefreshButton';
import { EmptyState, Feedback } from '../components/Feedback';
import { sortAccounts, isMainAccount } from '../userOrder';

// Admin: manage user accounts (create, deactivate, reactivate).
export default function Users({ user }) {
  const [data, setData] = useState({ users: [], roles: [] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ fullName: '', role: 'Student' });
  const [filter, setFilter] = useState('All');

  const load = useCallback(async () => { try { setData(await api('/admin/users')); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  async function act(call, message) {
    setError(''); setSuccess('');
    try { await call(); setSuccess(message); await load(); return true; } catch (e) { setError(e.message); return false; }
  }
  const create = async () => { if (await act(() => api('/admin/users', { method: 'POST', body: form }), 'Account created.')) setForm({ ...form, fullName: '' }); };
  const shown = sortAccounts(data.users.filter(u => filter === 'All' || u.role === filter));

  return <>
    <SectionHeader eyebrow="ADMIN · ACCOUNTS" title="User Accounts" description="Create accounts and deactivate or reactivate them. A deactivated account cannot sign in." action={<RefreshButton onClick={load}/>}/>
    <Feedback error={error} success={success}/>
    <section className="card-surface padded">
      <div className="subsection-title"><strong>New account</strong></div>
      <div className="form-grid">
        <label>Full name<input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="At least 2 characters"/></label>
        <label>Role<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{data.roles.map(r => <option key={r}>{r}</option>)}</select></label>
        <button className="button primary" disabled={form.fullName.trim().length < 2} onClick={create}>Create account</button>
      </div>
    </section>
    <section className="card-surface padded section-gap">
      <div className="subsection-title"><strong>Accounts</strong><span>{shown.length}</span></div>
      <div className="tabs">{['All', ...data.roles].map(r => <button key={r} className={`button small ${filter === r ? 'primary' : 'secondary'}`} onClick={() => setFilter(r)}>{r}</button>)}</div>
      {shown.length === 0 ? <EmptyState title="No accounts" description="Nothing matches this filter."/> : <div className="table-wrap"><table className="responsive-table">
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{shown.map(u => <tr key={u.id} className={isMainAccount(u) ? 'main-account' : ''}>
          <td className="primary"><strong>{isMainAccount(u) && <span aria-hidden="true">★ </span>}{u.full_name}</strong>{isMainAccount(u) && <small>Main account</small>}<small>{new Date(u.created_at).toLocaleDateString('en-GB')}</small></td>
          <td data-label="Role">{u.role}</td>
          <td data-label="Status"><StatusBadge value={u.status === 'Active' ? 'Normal' : 'Cancelled'}/> {u.status}</td>
          <td className="actions">{u.id === user.id ? '—' : u.status === 'Active'
            ? <button className="button small ghost" onClick={() => act(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'Deactivated' } }), 'Account deactivated.')}>Deactivate</button>
            : <button className="button small secondary" onClick={() => act(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'Active' } }), 'Account reactivated.')}>Reactivate</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </>;
}
