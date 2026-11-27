import { db, makeId, nowIso } from '../database/db.js';
import { requireValue } from './commonService.js';

/*
 * In-app notifications (NI-06). A notification is addressed to one user or to a role: 'Operator' reaches every
 * Operator and Admin. The same event (kind + entity + addressee) is stored once, so a repeating timer cannot
 * send the same reminder twice.
 */
export function notify({ userId = null, role = null, kind, entityType, entityId, title, message, severity = 'info' }) {
  if (!userId && !role) return null;
  const id = makeId('note');
  const result = db.prepare(`INSERT OR IGNORE INTO notifications
    (id, user_id, audience_role, kind, entity_type, entity_id, title, message, severity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, role, kind, entityType, String(entityId), title, message, severity, nowIso());
  return result.changes === 1 ? id : null;
}

// Convenience for the two usual addressees of one event.
export const notifyOperators = fields => notify({ ...fields, role: 'Operator', userId: null });

function visibleTo(user) {
  return ['Operator', 'Admin'].includes(user.role)
    ? { where: `(user_id=? OR audience_role='Operator')`, params: [user.id] }
    : { where: 'user_id=?', params: [user.id] };
}

export function listNotifications(user, limit = 30) {
  requireValue(user, 401, 'Please sign in with a demo account.');
  const { where, params } = visibleTo(user);
  const notifications = db.prepare(`SELECT id, kind, entity_type, entity_id, title, message, severity, created_at, read_at
    FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit);
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where} AND read_at IS NULL`).get(...params).n;
  return { notifications, unread };
}

export function markNotificationsRead(user, id = null) {
  requireValue(user, 401, 'Please sign in with a demo account.');
  const { where, params } = visibleTo(user);
  const result = id
    ? db.prepare(`UPDATE notifications SET read_at=? WHERE id=? AND ${where} AND read_at IS NULL`).run(nowIso(), id, ...params)
    : db.prepare(`UPDATE notifications SET read_at=? WHERE ${where} AND read_at IS NULL`).run(nowIso(), ...params);
  return { marked: result.changes };
}
