import { db, makeId, nowIso } from '../database/db.js';

export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function requireValue(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export function addViolation(userId, points, reason, sourceType, sourceId) {
  if (!userId || points <= 0) return;
  const recordedAt = nowIso();
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO violations
    (id, user_id, points, reason, source_type, source_id, recorded_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Recorded')`)
    .run(makeId('vio'), userId, points, reason, sourceType, sourceId, recordedAt, expiresAt);
}

export function isStudentSuspended(userId) {
  if (!userId) return false;
  const result = db.prepare(`SELECT COALESCE(SUM(points),0) AS total FROM violations
    WHERE user_id=? AND status IN ('Recorded','Upheld') AND expires_at > ?`).get(userId, nowIso());
  return result.total >= 5;
}

export function inHubOperatingHours(hub, start, end = start) {
  if (!hub) return false;
  const fmt = (value) => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
  const startTime = fmt(start);
  const endTime = fmt(end);
  return startTime >= hub.open_time && endTime <= hub.close_time;
}

export function overlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
    && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

export function auditChange(entityType, entityId, action, details, userId = 'system') {
  db.prepare(`INSERT INTO audit_logs
    (id, entity_type, entity_id, action, details_json, responsible_user, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(makeId('audit'), entityType, String(entityId), action, JSON.stringify(details ?? {}), userId, nowIso());
}

export function requireRole(user, roles) {
  if (!user || !roles.includes(user.role)) {
    throw new HttpError(403, `This action requires one of these roles: ${roles.join(', ')}.`);
  }
}

export function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
