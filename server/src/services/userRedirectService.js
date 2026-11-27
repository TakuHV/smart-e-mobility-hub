import { db, transaction, makeId, nowIso } from '../database/db.js';
import { requireValue, requireRole, auditChange } from './commonService.js';
import { notify } from './notificationService.js';
import { hubBalance } from './redistributionService.js';

/*
 * User redistribution: the user side of "Vehicle & User Redistribution" (advisory only, like UC-020).
 * When a Hub is busy (no bookable vehicle or no free Shared slot) an Operator asks students to use another Hub.
 * Nothing is moved and no booking is changed: students see a notice and receive a notification.
 * At most one active redirection per Hub; the alternative Hub must be Open.
 */
const ops = user => requireRole(user, ['Operator', 'Admin']);

export function activeRedirects() {
  return db.prepare(`SELECT r.id, r.from_hub_id, r.to_hub_id, r.reason, r.created_at, fh.name AS from_hub_name, th.name AS to_hub_name
    FROM hub_redirects r JOIN hubs fh ON fh.id=r.from_hub_id JOIN hubs th ON th.id=r.to_hub_id
    WHERE r.status='Active' ORDER BY r.created_at DESC`).all();
}

function suggestions(hubs, active) {
  const redirected = new Set(active.map(r => r.from_hub_id));
  const result = [];
  for (const hub of hubs) {
    if (hub.status !== 'Open' || redirected.has(hub.id)) continue;
    const noVehicle = hub.available === 0;
    const noSlot = hub.freeSharedSlots === 0;
    if (!noVehicle && !noSlot) continue;
    const target = hubs.filter(h => h.id !== hub.id && h.status === 'Open' && h.available > 0 && h.freeSharedSlots > 0)
      .sort((a, b) => b.available - a.available)[0];
    if (!target) continue;
    result.push({
      fromHubId: hub.id, fromHubName: hub.name, toHubId: target.id, toHubName: target.name,
      reason: noVehicle && noSlot ? `${hub.name} has no bookable vehicle and no free Shared slot.`
        : noVehicle ? `${hub.name} has no bookable vehicle.` : `${hub.name} has no free Shared slot for returns.`
    });
  }
  return result;
}

export function userRedirectOverview(user) {
  ops(user);
  const hubs = hubBalance();
  const active = activeRedirects();
  const ended = db.prepare(`SELECT r.id, r.reason, r.created_at, r.ended_at, fh.name AS from_hub_name, th.name AS to_hub_name
    FROM hub_redirects r JOIN hubs fh ON fh.id=r.from_hub_id JOIN hubs th ON th.id=r.to_hub_id
    WHERE r.status='Ended' ORDER BY r.ended_at DESC LIMIT 10`).all();
  return {
    hubs: hubs.map(h => ({ id: h.id, name: h.name, status: h.status, available: h.available, freeSharedSlots: h.freeSharedSlots, sharedSlotsTotal: h.sharedSlotsTotal })),
    suggestions: suggestions(hubs, active), active, ended
  };
}

function notifyStudents(redirectId, kind, title, message) {
  for (const s of db.prepare(`SELECT id FROM users WHERE role='Student' AND status='Active'`).all()) {
    notify({ userId: s.id, kind, entityType: 'HubRedirect', entityId: redirectId, title, message, severity: 'warning' });
  }
}

export function createUserRedirect({ user, fromHubId, toHubId, reason = '' }) {
  ops(user);
  const id = makeId('redirect');
  transaction(() => {
    const from = db.prepare('SELECT * FROM hubs WHERE id=?').get(fromHubId);
    const to = db.prepare('SELECT * FROM hubs WHERE id=?').get(toHubId);
    requireValue(from && to, 404, 'Hub not found.');
    requireValue(from.id !== to.id, 400, 'Choose a different Hub as the alternative.');
    requireValue(to.status === 'Open', 409, 'The alternative Hub is closed.');
    requireValue(!db.prepare(`SELECT 1 FROM hub_redirects WHERE from_hub_id=? AND status='Active'`).get(from.id), 409, `${from.name} already has an active redirection.`);
    requireValue(!db.prepare(`SELECT 1 FROM hub_redirects WHERE from_hub_id=? AND status='Active'`).get(to.id), 409, `${to.name} is itself redirected. Choose another Hub.`);
    const text = String(reason).trim().slice(0, 300) || `${from.name} is busy.`;
    db.prepare(`INSERT INTO hub_redirects (id,from_hub_id,to_hub_id,reason,status,created_by,created_at) VALUES (?,?,?,?, 'Active', ?, ?)`)
      .run(id, from.id, to.id, text, user.id, nowIso());
    auditChange('HubRedirect', id, 'USER_REDIRECT_CREATED', { fromHubId, toHubId }, user.id);
    notifyStudents(id, 'hub_redirect', `Please use ${to.name}`, `${from.name} is busy right now. ${to.name} has vehicles and free spots.`);
  });
  return db.prepare('SELECT * FROM hub_redirects WHERE id=?').get(id);
}

export function endUserRedirect({ user, redirectId }) {
  ops(user);
  const redirect = db.prepare('SELECT * FROM hub_redirects WHERE id=?').get(redirectId);
  requireValue(redirect, 404, 'Redirection not found.');
  requireValue(redirect.status === 'Active', 409, 'This redirection has already ended.');
  transaction(() => {
    db.prepare(`UPDATE hub_redirects SET status='Ended', ended_at=? WHERE id=?`).run(nowIso(), redirectId);
    auditChange('HubRedirect', redirectId, 'USER_REDIRECT_ENDED', {}, user.id);
    const from = db.prepare('SELECT name FROM hubs WHERE id=?').get(redirect.from_hub_id);
    notifyStudents(`${redirectId}-end`, 'hub_redirect_end', `${from.name} is available again`, 'You can use this Hub as usual.');
  });
  return db.prepare('SELECT * FROM hub_redirects WHERE id=?').get(redirectId);
}
