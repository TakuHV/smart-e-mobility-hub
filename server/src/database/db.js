import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '../../..');
export const dataDirectory = resolve(projectRoot, 'data');
export const databasePath = resolve(dataDirectory, 'smart_e_mobility.sqlite');
mkdirSync(dataDirectory, { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function audit(entityType, entityId, action, details = {}, responsibleUser = 'system') {
  db.prepare(`INSERT INTO audit_logs
    (id, entity_type, entity_id, action, details_json, responsible_user, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(makeId('audit'), entityType, String(entityId), action,
      JSON.stringify(details), responsibleUser, nowIso());
}

export function json(value, fallback = {}) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
