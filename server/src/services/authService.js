import { db, makeId, nowIso } from '../database/db.js';
import { HttpError } from './commonService.js';

const allowedRoles = ['Student', 'Operator', 'Simulation Operator', 'Admin'];

export function demoLogin({ displayName, role }) {
  if (!allowedRoles.includes(role)) throw new HttpError(400, 'Select a supported demo role.');
  const name = String(displayName || '').trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'Enter a display name (at least 2 characters).');
  let user = db.prepare('SELECT id, full_name, role FROM users WHERE full_name=? AND role=?').get(name, role);
  if (!user) {
    const id = makeId('user');
    db.prepare('INSERT INTO users (id, full_name, role, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, role, nowIso());
    user = { id, full_name: name, role };
  }
  return user;
}
