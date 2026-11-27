import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso as clockNowIso } from '../clock.js';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '../../..');
export const dataDirectory = resolve(projectRoot, 'data');

// SMART_EMOBILITY_DB lets the tests use their own database (for example ':memory:' or a temporary file),
// so `npm test` never reads or changes the demo data. Without it the demo file is used.
const override = process.env.SMART_EMOBILITY_DB;
export const databasePath = override
  ? (override === ':memory:' ? override : resolve(override))
  : resolve(dataDirectory, 'smart_e_mobility.sqlite');
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

// schema.sql runs at every start, so it must use CREATE ... IF NOT EXISTS (tables, indexes, triggers).
// A changed column definition is NOT applied to an existing file: delete the database file to reseed.
try {
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
} catch (error) {
  throw new Error(`Could not apply schema.sql (${error.message}). If the schema changed, delete ${databasePath} and its -wal/-shm files to reseed the demo data.`, { cause: error });
}

// A database file created by an earlier version keeps its old tables, so columns added later are added here (CREATE TABLE IF NOT EXISTS does not).
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
for (const [column, definition] of [
  ['category', "TEXT NOT NULL DEFAULT 'Vehicle fault'"],
  ['severity', "TEXT NOT NULL DEFAULT 'Medium'"],
  ['source', "TEXT NOT NULL DEFAULT 'operator'"],
  ['charger_id', 'TEXT REFERENCES chargers(id)'],
  ['slot_id', 'TEXT REFERENCES parking_slots(id)'],
  ['reported_by', 'TEXT'],
  ['assigned_to', 'TEXT'],
  ['resolution_note', 'TEXT'],
  ['updated_at', 'TEXT'],
  ['resolved_at', 'TEXT']
]) addColumnIfMissing('incidents', column, definition);
// Columns the timers added to tables that an earlier demo database already has.
for (const [table, column, definition] of [
  ['users', 'status', "TEXT NOT NULL DEFAULT 'Active'"],
  ['bookings', 'start_battery', 'INTEGER'],
  ['bookings', 'overdue_at', 'TEXT'],
  ['bookings', 'destination_hub_id', 'TEXT REFERENCES hubs(id)'],
  ['parking_reservations', 'overstay_flagged_at', 'TEXT'],
  ['charging_requests', 'start_battery', 'INTEGER'],
  ['charging_requests', 'overstay_flagged_at', 'TEXT'],
  ['charging_requests', 'available_from', 'TEXT'],
  ['bookings', 'pickup_from', 'TEXT'],
  ['move_vehicle_requests', 'auto_send_at', 'TEXT'],
  ['move_vehicle_requests', 'sent_at', 'TEXT'],
  ['move_vehicle_requests', 'destination', "TEXT NOT NULL DEFAULT 'Slot'"]
]) addColumnIfMissing(table, column, definition);

/*
 * All-or-nothing unit of work (BR-36). The callback must be synchronous: a transaction cannot wait for a promise.
 * Calls may be nested: the outermost call is a real transaction, inner calls are savepoints, so an inner failure
 * undoes only the inner work and an outer failure undoes everything.
 */
let transactionDepth = 0;
export function transaction(fn) {
  const nested = transactionDepth > 0;
  const savepoint = `sp_${transactionDepth}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  transactionDepth++;
  let finished = false;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {}); // avoid an unhandled rejection of the discarded work
      throw new TypeError('transaction() needs a synchronous callback; an async callback would be committed too early.');
    }
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    finished = true;
    return result;
  } catch (error) {
    if (!finished) {
      try {
        db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      } catch { /* the original error is the useful one */ }
    }
    throw error;
  } finally {
    transactionDepth--;
  }
}

export function closeDatabase() {
  db.close();
}

// The demo clock (server/src/clock.js): equal to the real time at speed x1.
export function nowIso() {
  return clockNowIso();
}

export function makeId(prefix = 'id') {
  return `${prefix}_${randomUUID()}`;
}

export function audit(entityType, entityId, action, details = {}, responsibleUser = 'system') {
  db.prepare(`INSERT INTO audit_logs
    (id, entity_type, entity_id, action, details_json, responsible_user, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(makeId('audit'), entityType, String(entityId), action,
      JSON.stringify(details ?? {}), responsibleUser ?? 'system', nowIso());
}

export function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
