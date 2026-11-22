import { db, makeId, nowIso } from '../database/db.js';
import { HttpError } from './commonService.js';

const allowedRoles = ['Student', 'Operator', 'Simulation Operator', 'Admin'];

/*
 * DEMO identity: creates or reuses an account by display name and role. There is no password and any role can be
 * chosen, so this is not access control (the University SSO of BR-01 is outside the MVP). Keep it on localhost.
 */
export function demoLogin({ displayName, role } = {}) {
  if (!allowedRoles.includes(role)) throw new HttpError(400, 'Select a supported demo role.');
  if (typeof displayName !== 'string') throw new HttpError(400, 'Enter a display name (at least 2 characters).');
  const name = displayName.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'Enter a display name (at least 2 characters).');

  // Names are matched ignoring case, so "demo student" reuses "Demo Student" and its vehicles.
  const find = () => db.prepare('SELECT id, full_name, role FROM users WHERE full_name=? COLLATE NOCASE AND role=?').get(name, role);
  let user = find();
  if (!user) {
    // INSERT OR IGNORE: if two logins create the same account at once, the second one simply reuses it.
    db.prepare('INSERT OR IGNORE INTO users (id, full_name, role, created_at) VALUES (?, ?, ?, ?)')
      .run(makeId('user'), name, role, nowIso());
    user = find();
  }
  return user;
}