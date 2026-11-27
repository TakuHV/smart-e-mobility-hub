import { db, makeId, nowIso } from '../database/db.js';
import { HttpError } from './commonService.js';

const allowedRoles = ['Student', 'Operator', 'Simulation Operator', 'Admin'];

/*
 * The five accounts of the demo: Admin, Student, Operator and Simulation Operator (each with its own role), and Demo,
 * which exists with all four roles so that one person can open every part of the app. Older databases have the same
 * accounts under the names "Demo Admin", "Demo Student", ...; those are renamed so that their data is kept.
 */
export const DEMO_ACCOUNT_NAMES = ['Admin', 'Student', 'Operator', 'Simulation Operator'];
export function ensureDemoAccounts() {
  const now = nowIso();
  for (const role of allowedRoles) {
    const taken = db.prepare('SELECT id FROM users WHERE full_name=? COLLATE NOCASE AND role=?').get(role, role);
    if (!taken) db.prepare('UPDATE users SET full_name=? WHERE full_name=? AND role=?').run(role, `Demo ${role}`, role);
    db.prepare('INSERT OR IGNORE INTO users (id, full_name, role, status, created_at) VALUES (?, ?, ?, \'Active\', ?)').run(makeId('user'), role, role, now);
    db.prepare('INSERT OR IGNORE INTO users (id, full_name, role, status, created_at) VALUES (?, ?, ?, \'Active\', ?)').run(makeId('user'), 'Demo', role, now);
  }
}

/*
 * DEMO identity: signs in by account name. There is no password, so this is not access control (the University SSO of
 * BR-01 is outside the MVP). Keep it on localhost. An account must already exist (the five demo accounts above, or one
 * an Admin created). A name that has several roles (Demo) needs the role to open.
 */
export function demoLogin({ displayName, role } = {}) {
  if (typeof displayName !== 'string') throw new HttpError(400, 'Enter your username.');
  const name = displayName.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Enter your username.');
  if (role !== undefined && role !== null && role !== '' && !allowedRoles.includes(role)) throw new HttpError(400, 'Select a supported role.');

  const accounts = db.prepare('SELECT id, full_name, role, status FROM users WHERE full_name=? COLLATE NOCASE').all(name);
  if (accounts.length === 0) throw new HttpError(404, 'Account not found. Check the username and try again.');
  let user;
  if (role) user = accounts.find(account => account.role === role);
  else if (accounts.length === 1) user = accounts[0];
  else throw new HttpError(400, 'This account has several roles. Choose the role to open.');
  if (!user) throw new HttpError(404, 'This account does not have that role.');
  if (user.status !== 'Active') throw new HttpError(403, 'This account is deactivated. Please contact an Admin.');
  return { id: user.id, full_name: user.full_name, role: user.role };
}
