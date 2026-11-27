import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, requireRole, auditChange } from './commonService.js';
import { config } from '../config.js';
import { now as clockNow } from '../clock.js';
import { notify, notifyOperators } from './notificationService.js';
import { enqueueSharedVehicle, handleChargerFailure, restoreCharger, runScheduler } from './chargingService.js';

/*
 * UC-019 Handle Operational Incidents (MVP).
 * Students report a problem; Operators open an incident for a vehicle, charger or parking slot and the system takes
 * the faulty resource out of service. Resolving it puts the resource back. Status: Open -> In Progress -> Resolved.
 */
export const CATEGORIES = ['Vehicle fault', 'Charger fault', 'Slot blocked', 'Safety', 'Other'];
export const SEVERITIES = ['Low', 'Medium', 'High'];
const isOps = user => ['Operator', 'Admin'].includes(user?.role);

function clean(summary) {
  const text = String(summary ?? '').trim();
  requireValue(text.length >= 5 && text.length <= 500, 400, 'Describe the problem in 5 to 500 characters.');
  return text;
}

export function listIncidents({ user, status }) {
  requireValue(user, 401, 'Please sign in with a demo account.');
  const where = []; const params = [];
  if (!isOps(user)) { where.push('i.reported_by=?'); params.push(user.id); }
  if (status) { where.push('i.status=?'); params.push(status); }
  return db.prepare(`SELECT i.*, h.name AS hub_name, v.plate, c.code AS charger_code, s.code AS slot_code, u.full_name AS reporter_name
    FROM incidents i LEFT JOIN hubs h ON h.id=i.hub_id LEFT JOIN vehicles v ON v.id=i.vehicle_id
    LEFT JOIN chargers c ON c.id=i.charger_id LEFT JOIN parking_slots s ON s.id=i.slot_id LEFT JOIN users u ON u.id=i.reported_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE i.status WHEN 'Open' THEN 1 WHEN 'In Progress' THEN 2 ELSE 3 END,
      CASE i.severity WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, i.created_at DESC LIMIT 100`).all(...params);
}

export function incidentHistory(user, incidentId) {
  requireRole(user, ['Operator', 'Admin']);
  return db.prepare(`SELECT action, details_json, responsible_user, created_at FROM audit_logs
    WHERE entity_type='Incident' AND entity_id=? ORDER BY created_at`).all(incidentId);
}

function takeVehicleOutOfService(vehicle, now, actorId) {
  const effects = [];
  const status = vehicle.status;
  if (!['Available', 'Needs Charging', 'Reserved'].includes(status)) {
    effects.push(`${vehicle.plate} is ${status}, so its status was not changed. Take it out of service when the trip, charging or transfer has ended.`);
    return effects;
  }
  if (status === 'Reserved') {
    const booking = db.prepare(`SELECT * FROM bookings WHERE vehicle_id=? AND status='Confirmed'`).get(vehicle.id);
    if (booking) {
      db.prepare(`UPDATE bookings SET status='Cancelled' WHERE id=?`).run(booking.id);
      auditChange('Booking', booking.id, 'BOOKING_CANCELLED_BY_INCIDENT', {}, actorId);
      notify({ userId: booking.user_id, kind: 'booking_cancelled_incident', entityType: 'Booking', entityId: booking.id, severity: 'warning',
        title: 'Booking cancelled', message: `${vehicle.plate} has a fault, so your booking was cancelled without a violation. Please choose another vehicle.` });
      effects.push('The booking of this vehicle was cancelled (no violation point).');
    }
  }
  // A faulty vehicle cannot be charged or booked.
  const pending = db.prepare(`SELECT * FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned')`).get(vehicle.id);
  if (pending) {
    if (pending.status === 'Assigned' && pending.charger_id) {
      db.prepare(`UPDATE move_vehicle_requests SET status='Cancelled' WHERE charging_request_id=? AND direction='TO_CHARGER' AND status IN ('Requested','In Progress')`).run(pending.id);
      db.prepare(`UPDATE chargers SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=? AND status='Assigned'`).run(now, pending.charger_id);
    }
    db.prepare(`UPDATE charging_requests SET status='Cancelled', charger_id=NULL WHERE id=?`).run(pending.id);
    effects.push('Its charging request was cancelled.');
  }
  db.prepare(`UPDATE vehicles SET status='Out of Service', updated_at=? WHERE id=?`).run(now, vehicle.id);
  effects.push(`${vehicle.plate} is out of service.`);
  return effects;
}

export function reportIncident({ user, category, severity = 'Medium', summary, vehicleId = null, chargerId = null, slotId = null, hubId = null }) {
  requireValue(user, 401, 'Please sign in with a demo account.');
  requireValue(CATEGORIES.includes(category), 400, `Category must be one of: ${CATEGORIES.join(', ')}.`);
  requireValue(SEVERITIES.includes(severity), 400, `Severity must be one of: ${SEVERITIES.join(', ')}.`);
  const text = clean(summary);
  const operations = isOps(user);
  const effects = [];
  const id = makeId('incident');

  transaction(() => {
    const now = nowIso();
    const vehicle = vehicleId ? db.prepare('SELECT * FROM vehicles WHERE id=?').get(vehicleId) : null;
    const charger = chargerId ? db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId) : null;
    const slot = slotId ? db.prepare('SELECT * FROM parking_slots WHERE id=?').get(slotId) : null;
    requireValue(!vehicleId || vehicle, 404, 'Vehicle not found.');
    requireValue(!chargerId || charger, 404, 'Charger not found.');
    requireValue(!slotId || slot, 404, 'Parking slot not found.');
    if (!operations && vehicle) requireValue(vehicle.kind === 'shared' || vehicle.owner_id === user.id, 403, 'You can report a problem only for a shared vehicle or your own vehicle.');
    const hub = hubId ?? vehicle?.hub_id ?? charger?.hub_id ?? slot?.hub_id ?? null;
    if (hub) requireValue(db.prepare('SELECT id FROM hubs WHERE id=?').get(hub), 404, 'Hub not found.');

    db.prepare(`INSERT INTO incidents (id,hub_id,vehicle_id,summary,status,created_at,category,severity,source,charger_id,slot_id,reported_by,updated_at)
      VALUES (?,?,?,?, 'Open', ?,?,?,?,?,?,?,?)`)
      .run(id, hub, vehicleId, text, now, category, severity, operations ? 'operator' : 'student', chargerId, slotId, user.id, now);
    auditChange('Incident', id, 'INCIDENT_OPENED', { category, severity, vehicleId, chargerId, slotId }, user.id);

    // Only staff change the state of a resource; a student's report waits for an Operator.
    if (operations) {
      if (category === 'Vehicle fault' && vehicle) effects.push(...takeVehicleOutOfService(vehicle, now, user.id));
      if (category === 'Slot blocked' && slot) {
        requireValue(slot.status === 'Available', 409, 'Only a free slot can be taken out of service. Ask the vehicle to leave first.');
        db.prepare(`UPDATE parking_slots SET status='Out of Service', updated_at=? WHERE id=?`).run(now, slot.id);
        effects.push(`Slot ${slot.code} is out of service.`);
      }
      // The charger failure runs in this same transaction (nested transactions are savepoints), so an error undoes the incident too.
      if (category === 'Charger fault' && charger) {
        handleChargerFailure({ chargerId: charger.id, actorId: user.id });
        effects.push(`${charger.code} is out of service; its charging request was re-planned.`);
      }
    }
  });
  if (!operations) {
    notifyOperators({ kind: 'incident_reported', entityType: 'Incident', entityId: id, severity: severity === 'High' ? 'critical' : 'warning',
      title: `Problem reported: ${category}`, message: text.slice(0, 140) });
  }
  return { incident: db.prepare('SELECT * FROM incidents WHERE id=?').get(id), effects };
}

export function acknowledgeIncident({ user, incidentId }) {
  requireRole(user, ['Operator', 'Admin']);
  const changed = db.prepare(`UPDATE incidents SET status='In Progress', assigned_to=?, updated_at=? WHERE id=? AND status='Open'`).run(user.id, nowIso(), incidentId);
  requireValue(changed.changes === 1, 409, 'Only an Open incident can be taken over.');
  auditChange('Incident', incidentId, 'INCIDENT_ACKNOWLEDGED', {}, user.id);
  return db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
}

export function resolveIncident({ user, incidentId, note = '', restore = true }) {
  requireRole(user, ['Operator', 'Admin']);
  const resolution = String(note ?? '').trim().slice(0, 500) || 'Resolved.';
  const effects = [];
  let hubId = null;
  transaction(() => {
    const now = nowIso();
    const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
    requireValue(incident, 404, 'Incident not found.');
    requireValue(incident.status !== 'Resolved', 409, 'This incident is already resolved.');
    hubId = incident.hub_id;
    // A resource goes back into service only when no other open incident still points to it.
    const stillOpen = (column, value) => value && db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ${column}=? AND status<>'Resolved' AND id<>?`).get(value, incidentId).n > 0;

    if (restore && incident.vehicle_id && !stillOpen('vehicle_id', incident.vehicle_id)) {
      const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(incident.vehicle_id);
      if (vehicle?.status === 'Out of Service') {
        const low = vehicle.battery_level < config.booking.minimumBatteryToBookPercent;
        db.prepare(`UPDATE vehicles SET status=?, updated_at=? WHERE id=?`).run(low ? 'Needs Charging' : 'Available', now, vehicle.id);
        if (low && vehicle.kind === 'shared' && vehicle.hub_id) enqueueSharedVehicle(vehicle.id, vehicle.hub_id);
        effects.push(`${vehicle.plate} is back in service${low ? ' and was added to the charging queue' : ''}.`);
      }
    }
    if (restore && incident.slot_id && !stillOpen('slot_id', incident.slot_id)) {
      const changed = db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Out of Service'`).run(now, incident.slot_id);
      if (changed.changes) effects.push('The parking slot is available again.');
    }
    if (restore && incident.charger_id && !stillOpen('charger_id', incident.charger_id)) {
      try { restoreCharger({ chargerId: incident.charger_id, actorId: user.id }); effects.push('The charger is available again.'); }
      catch (error) {
        // The vehicle is still recorded at the charger: the incident can close, the charger is restored after the removal.
        if (error instanceof HttpError) effects.push(`The charger stays out of service: ${error.message}`);
        else throw error;
      }
    }
    db.prepare(`UPDATE incidents SET status='Resolved', resolution_note=?, resolved_at=?, updated_at=?, assigned_to=COALESCE(assigned_to,?) WHERE id=?`)
      .run(resolution, now, now, user.id, incidentId);
    auditChange('Incident', incidentId, 'INCIDENT_RESOLVED', { note: resolution, restore }, user.id);
    if (incident.reported_by && incident.source === 'student') {
      notify({ userId: incident.reported_by, kind: 'incident_resolved', entityType: 'Incident', entityId: incidentId, severity: 'info',
        title: 'Your report was resolved', message: resolution });
    }
  });
  if (hubId) runScheduler(hubId, user.id);
  return { incident: db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId), effects };
}

// Things an Operator should look at now. They are computed from the live data, so they disappear when the cause is gone.
export function attentionItems(user) {
  requireRole(user, ['Operator', 'Admin']);
  const nowMs = clockNow();
  const minutes = since => Math.max(0, Math.round((nowMs - Date.parse(since)) / 60000));
  const items = [];
  for (const b of db.prepare(`SELECT b.id, b.overdue_at, b.started_at, v.plate FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.status='Overdue'`).all()) {
    items.push({ kind: 'overdue_trip', severity: 'critical', title: 'Overdue shared-vehicle trip', detail: `${b.plate} has been out for ${minutes(b.started_at)} minutes (limit ${config.booking.maxTripHours} h).`, since: b.overdue_at ?? b.started_at, entityType: 'Booking', entityId: b.id });
  }
  for (const r of db.prepare(`SELECT r.id, r.overstay_flagged_at, v.plate, s.code FROM parking_reservations r JOIN vehicles v ON v.id=r.vehicle_id JOIN parking_slots s ON s.id=r.slot_id WHERE r.status='In Progress' AND r.overstay_flagged_at IS NOT NULL`).all()) {
    items.push({ kind: 'parking_overstay', severity: 'critical', title: 'Vehicle overstaying a parking slot', detail: `${r.plate} is still in ${r.code}.`, since: r.overstay_flagged_at, entityType: 'ParkingReservation', entityId: r.id });
  }
  for (const c of db.prepare(`SELECT r.id, r.overstay_flagged_at, v.plate, ch.code FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id JOIN chargers ch ON ch.id=r.charger_id
    WHERE r.overstay_flagged_at IS NOT NULL AND ch.status='Awaiting Removal'`).all()) {
    items.push({ kind: 'charger_blocked', severity: 'critical', title: 'Charger blocked by a finished vehicle', detail: `${c.plate} must be moved away from ${c.code}.`, since: c.overstay_flagged_at, entityType: 'ChargingRequest', entityId: c.id });
  }
  const staleMs = config.status.staleAfterMinutes * 60000;
  for (const h of db.prepare('SELECT id, name, sensor_updated_at FROM hubs').all()) {
    if (nowMs - Date.parse(h.sensor_updated_at) > staleMs) {
      items.push({ kind: 'stale_status', severity: 'warning', title: 'Hub status is stale', detail: `${h.name} has had no sensor update for ${minutes(h.sensor_updated_at)} minutes (BR-27).`, since: h.sensor_updated_at, entityType: 'Hub', entityId: h.id });
    }
  }
  for (const m of db.prepare(`SELECT m.id, m.requested_at, v.plate, c.code FROM move_vehicle_requests m JOIN vehicles v ON v.id=m.vehicle_id JOIN chargers c ON c.id=m.charger_id
    WHERE m.direction='TO_CHARGER' AND m.status='Requested'`).all()) {
    if (nowMs - Date.parse(m.requested_at) > 10 * 60000) {
      items.push({ kind: 'move_waiting', severity: 'warning', title: 'Vehicle not yet moved to its charger', detail: `${m.plate} has waited ${minutes(m.requested_at)} minutes for a move to ${m.code}. Cancel the request to return it to the queue (OD-3).`, since: m.requested_at, entityType: 'MoveVehicleRequest', entityId: m.id });
    }
  }
  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
}
