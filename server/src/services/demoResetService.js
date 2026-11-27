import { db, transaction } from '../database/db.js';
import { requireRole, auditChange } from './commonService.js';
import { resetConfig } from '../config.js';
import { resetClock } from '../clock.js';
import { seedDatabase } from '../database/seed.js';
import { ensureDemoAccounts } from './authService.js';

/*
 * DEMO ONLY — not part of the project scope. Puts the sample data back to its starting state: bookings, reservations,
 * charging requests, incidents, notifications, violations, simulation runs, redistribution tasks and saved settings are
 * deleted, then the sample Hubs, slots, chargers and vehicles are created again and the demo clock returns to real time.
 * Accounts go back to the five defaults (Admin, Student, Operator, Simulation Operator and Demo, which has all four
 * roles): any other account is deleted and the defaults are made Active again. The audit log is kept and gets one entry.
 */
// Stored simulation runs are protected by a trigger (BR-33). The reset is the only place that may remove them, so the
// trigger is dropped and created again inside the same transaction.
const NO_DELETE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS simulation_runs_no_delete BEFORE DELETE ON simulation_runs
BEGIN SELECT RAISE(ABORT, 'Stored simulation runs cannot be deleted (BR-33)'); END;`;
const KEEP = new Set(['users', 'audit_logs', 'sqlite_sequence']);

export function resetDemoData({ user }) {
  requireRole(user, ['Admin']);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()
    .map(row => row.name).filter(name => !KEEP.has(name));

  db.exec('PRAGMA foreign_keys = OFF'); // rows are removed table by table; the data is consistent again after seeding
  try {
    transaction(() => {
      db.exec('DROP TRIGGER IF EXISTS simulation_runs_no_delete');
      for (const name of tables) db.exec(`DELETE FROM ${name}`);
      db.exec(NO_DELETE_TRIGGER);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  resetConfig();
  resetClock();
  const seeded = seedDatabase();
  ensureDemoAccounts();
  // Accounts: keep only the defaults ("Admin" with role Admin, ..., and "Demo" with any role).
  const removed = db.prepare(`DELETE FROM users WHERE NOT (full_name = role COLLATE NOCASE OR full_name = 'Demo' COLLATE NOCASE)`).run().changes;
  db.prepare(`UPDATE users SET status='Active'`).run();
  auditChange('Demo', 'data', 'DEMO_DATA_RESET', { tablesCleared: tables.length }, user.id);
  return { reset: true, seeded: seeded.seeded !== false, tablesCleared: tables.length, accountsRemoved: Number(removed) };
}
