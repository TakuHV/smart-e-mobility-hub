import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, requireRole, auditChange } from './commonService.js';

/*
 * Admin: user accounts and roles & access (UC-010). The account list never shows the automatic test accounts.
 * The demo has no passwords; "Deactivated" accounts can no longer sign in or call the API (BR-07).
 */
export const ROLES = ['Student', 'Operator', 'Simulation Operator', 'Admin'];

// What each role can do. The client menu follows the same list.
export const ACCESS = {
  Student: ['Book and return shared vehicles', 'Reserve personal parking', 'Request personal charging', 'Report problems', 'View Hubs and notifications'],
  Operator: ['Hub dashboard', 'Manage smart charging', 'Handle incidents', 'Vehicle redistribution', 'View what-if simulation results'],
  'Simulation Operator': ['Hub dashboard', 'Run and compare what-if simulations'],
  Admin: ['Manage user accounts', 'Manage roles and access', 'Configuration (settings, slots, chargers, vehicles)']
};

const admin = user => requireRole(user, ['Admin']);
const activeAdmins = () => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='Admin' AND status='Active'`).get().n;

export function listUsers(user) {
  admin(user);
  return db.prepare(`SELECT id, full_name, role, status, created_at FROM users WHERE id NOT LIKE 'test-%' ORDER BY
    CASE role WHEN 'Admin' THEN 1 WHEN 'Operator' THEN 2 WHEN 'Simulation Operator' THEN 3 ELSE 4 END, full_name COLLATE NOCASE`).all();
}

export function accessOverview(user) {
  admin(user);
  const counts = Object.fromEntries(db.prepare(`SELECT role, COUNT(*) AS n FROM users WHERE status='Active' AND id NOT LIKE 'test-%' GROUP BY role`).all().map(r => [r.role, r.n]));
  return { roles: ROLES.map(role => ({ role, permissions: ACCESS[role], activeUsers: counts[role] ?? 0 })) };
}

export function createUser({ user, fullName, role }) {
  admin(user);
  const name = String(fullName ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  requireValue(name.length >= 2, 400, 'Enter a name with at least 2 characters.');
  requireValue(ROLES.includes(role), 400, 'Select a supported role.');
  const exists = db.prepare('SELECT id FROM users WHERE full_name=? COLLATE NOCASE AND role=?').get(name, role);
  requireValue(!exists, 409, 'An account with this name and role already exists.');
  const id = makeId('user');
  transaction(() => {
    db.prepare(`INSERT INTO users (id, full_name, role, status, created_at) VALUES (?,?,?, 'Active', ?)`).run(id, name, role, nowIso());
    auditChange('User', id, 'USER_CREATED', { fullName: name, role }, user.id);
  });
  return db.prepare('SELECT id, full_name, role, status, created_at FROM users WHERE id=?').get(id);
}

export function setUserStatus({ user, userId, status }) {
  admin(user);
  requireValue(['Active', 'Deactivated'].includes(status), 400, 'Status must be Active or Deactivated.');
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  requireValue(target, 404, 'User not found.');
  if (status === 'Deactivated') {
    requireValue(target.id !== user.id, 409, 'You cannot deactivate your own account.');
    requireValue(!(target.role === 'Admin' && target.status === 'Active' && activeAdmins() <= 1), 409, 'At least one active Admin must remain.');
  }
  transaction(() => {
    db.prepare('UPDATE users SET status=? WHERE id=?').run(status, userId);
    auditChange('User', userId, status === 'Active' ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', {}, user.id);
  });
  return db.prepare('SELECT id, full_name, role, status, created_at FROM users WHERE id=?').get(userId);
}

export function setUserRole({ user, userId, role }) {
  admin(user);
  requireValue(ROLES.includes(role), 400, 'Select a supported role.');
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  requireValue(target, 404, 'User not found.');
  requireValue(target.role !== role, 400, 'The user already has this role.');
  requireValue(target.id !== user.id, 409, 'You cannot change your own role.');
  requireValue(!(target.role === 'Admin' && target.status === 'Active' && activeAdmins() <= 1), 409, 'At least one active Admin must remain.');
  const clash = db.prepare('SELECT id FROM users WHERE full_name=? COLLATE NOCASE AND role=? AND id<>?').get(target.full_name, role, userId);
  requireValue(!clash, 409, `Another account named ${target.full_name} already has the role ${role}.`);
  transaction(() => {
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, userId);
    auditChange('User', userId, 'USER_ROLE_CHANGED', { from: target.role, to: role }, user.id);
  });
  return db.prepare('SELECT id, full_name, role, status, created_at FROM users WHERE id=?').get(userId);
}
