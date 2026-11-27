import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, getViolationSummary, inHubOperatingHours, auditChange, addViolation, parseJson } from './commonService.js';


import { now as clockNow } from '../clock.js';
import { config } from '../config.js';
function parsePeriod(startAt, endAt) {
  requireValue(startAt && endAt, 400, 'Choose a valid parking start and end time.');
  const start = new Date(startAt);
  const end = new Date(endAt);
  requireValue(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start,
    400, 'Choose a valid parking start and end time.');
  return { start, end };
}

// A slot that can be offered for a period: no active reservation overlaps it (half-open intervals).
function slotHasConflict(slotId, startIso, endIso) {
  return db.prepare(`SELECT id FROM parking_reservations
    WHERE slot_id=? AND status IN ('Confirmed','In Progress') AND start_at < ? AND end_at > ?`).get(slotId, endIso, startIso);
}

// UC-008 step 4: the compatible Personal slots that are available for the period.
// startAt/endAt/vehicleType are optional; without them the list is the plain slot list.
export function listSlots({ hubId, slotType, startAt, endAt, vehicleType } = {}) {
  let sql = `SELECT s.*, h.name AS hub_name FROM parking_slots s JOIN hubs h ON h.id=s.hub_id WHERE 1=1`;
  const params = [];
  if (hubId) { sql += ' AND s.hub_id=?'; params.push(hubId); }
  if (slotType) { sql += ' AND s.slot_type=?'; params.push(slotType); }
  sql += ' ORDER BY h.name, s.slot_type, s.code';
  const period = startAt && endAt ? parsePeriod(startAt, endAt) : null;
  return db.prepare(sql).all(...params).map(row => {
    const supported = parseJson(row.supported_vehicle_types_json, []);
    const slot = { ...row, supported_vehicle_types: supported };
    if (vehicleType) slot.fits_vehicle = row.slot_type === 'Personal' && supported.includes(vehicleType);
    if (period) {
      slot.available_for_period = row.status === 'Available'
        && !slotHasConflict(row.id, period.start.toISOString(), period.end.toISOString());
    }
    return slot;
  });
}

export function listReservations(user) {
  requireValue(user, 401, 'You must be logged in to view reservations.');
  const studentFilter = user.role === 'Student' ? 'WHERE r.user_id=?' : '';
  const sql = `SELECT r.*, v.plate, v.vehicle_type, s.code AS slot_code, h.name AS hub_name
    FROM parking_reservations r JOIN vehicles v ON v.id=r.vehicle_id
    JOIN parking_slots s ON s.id=r.slot_id JOIN hubs h ON h.id=r.hub_id
    ${studentFilter} ORDER BY r.created_at DESC LIMIT 100`;
  return user.role === 'Student' ? db.prepare(sql).all(user.id) : db.prepare(sql).all();
}

// UC-008. The state-dependent checks run in the same transaction as the writes (BR-08, E2, E3).
// Model (MVP): a Confirmed reservation marks its slot Reserved (UC-008 step 7), so a slot holds one pending
// reservation at a time. The period-conflict checks stay as a second line of defence (BR-08).
export function createReservation({ user, vehicleId, hubId, slotId, startAt, endAt }) {
  requireValue(user?.role === 'Student', 403, 'Only students can create personal parking reservations.');
  const restriction = getViolationSummary(user.id);
  requireValue(!restriction.suspended, 403,
    `Your account is suspended from creating new reservations until ${restriction.suspendedUntil} (BR-59).`);
  const { start, end } = parsePeriod(startAt, endAt);
  requireValue(start.getTime() > clockNow() - 60_000, 400, 'The parking start time must be in the future.');
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const reservationId = makeId('parking');
  const expiresAt = new Date(start.getTime() + config.parking.arrivalGraceMinutes * 60 * 1000).toISOString();
  const mustLeaveBy = new Date(end.getTime() + config.parking.overstayGraceMinutes * 60 * 1000).toISOString();

  transaction(() => {
    const now = nowIso();
    const vehicle = db.prepare(`SELECT * FROM vehicles WHERE id=? AND kind='personal' AND owner_id=?`).get(vehicleId, user.id);
    requireValue(vehicle, 404, 'Choose one of your registered personal vehicles.');
    const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
    requireValue(hub, 404, 'Hub not found.');
    requireValue(hub.status === 'Open', 409, `The selected Hub is closed. Operating hours: ${hub.open_time}–${hub.close_time}.`);
    requireValue(inHubOperatingHours(hub, startIso, endIso), 400,
      `The parking period must be inside Hub operating hours (${hub.open_time}–${hub.close_time}, BR-42).`);
    const slot = db.prepare('SELECT * FROM parking_slots WHERE id=? AND hub_id=?').get(slotId, hubId);
    requireValue(slot, 404, 'Parking slot not found at this Hub.');
    requireValue(slot.slot_type === 'Personal', 400, 'Personal vehicles may use Personal slots only (BR-38).');
    requireValue(parseJson(slot.supported_vehicle_types_json, []).includes(vehicle.vehicle_type), 400,
      'The selected slot does not support this vehicle type (BR-41).');
    requireValue(slot.status === 'Available', 409, 'The selected parking slot is not available.');
    requireValue(!slotHasConflict(slotId, startIso, endIso), 409, 'The selected slot has a conflicting reservation (BR-08).');
    const vehicleConflict = db.prepare(`SELECT id FROM parking_reservations
      WHERE vehicle_id=? AND status IN ('Confirmed','In Progress') AND start_at < ? AND end_at > ?`).get(vehicleId, endIso, startIso);
    if (vehicleConflict) {
      throw new HttpError(409, 'This vehicle already has an overlapping active parking reservation (BR-09).', { reservationId: vehicleConflict.id });
    }
    // BR-24: a parking reservation starting at or after the Next Required Usage Time is allowed.
    const charging = db.prepare(`SELECT id, registered_at, next_required_usage_at FROM charging_requests
      WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging') AND registered_at < ? AND next_required_usage_at > ?`)
      .get(vehicleId, endIso, startIso);
    if (charging) {
      throw new HttpError(409,
        `This parking period overlaps an active charging request (until ${charging.next_required_usage_at}). Choose a period that starts at or after that time, or cancel the charging request first (BR-24).`,
        { chargingRequestId: charging.id, chargingFrom: charging.registered_at, chargingUntil: charging.next_required_usage_at });
    }

    const reserved = db.prepare(`UPDATE parking_slots SET status='Reserved', updated_at=? WHERE id=? AND status='Available'`).run(now, slotId);
    requireValue(reserved.changes === 1, 409, 'The selected slot was just reserved by another request.');
    db.prepare(`INSERT INTO parking_reservations
      (id,user_id,vehicle_id,hub_id,slot_id,status,start_at,end_at,expires_at,created_at)
      VALUES (?,?,?,?,?,'Confirmed',?,?,?,?)`)
      .run(reservationId, user.id, vehicleId, hubId, slotId, startIso, endIso, expiresAt, now);
    auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_CONFIRMED',
      { slotId, startAt: startIso, endAt: endIso, expiresAt, mustLeaveBy }, user.id);
  });
  // UC-008 step 8: the confirmation shows the time by which the vehicle must leave (end time + 15 minutes).
  return { ...db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId), must_leave_by: mustLeaveBy };
}

// Owner (student) or Operations staff. Operations staff may record an arrival or departure that the
// simulated sensor reports (UC-008 assumptions).
function loadReservationForActor(user, reservationId, ownerMessage) {
  const reservation = db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
  requireValue(reservation, 404, 'Parking reservation not found.');
  const isOperations = ['Operator', 'Admin'].includes(user?.role);
  const isOwner = user?.role === 'Student' && reservation.user_id === user.id;
  requireValue(isOperations || isOwner, 403, ownerMessage);
  return reservation;
}

export function arriveReservation({ user, reservationId }) {
  let graceElapsed = false;
  transaction(() => {
    const now = nowIso();
    const reservation = loadReservationForActor(user, reservationId, 'Only the reservation owner can check in.');
    requireValue(reservation.status === 'Confirmed', 409, 'Only a Confirmed parking reservation can be checked in.');
    requireValue(clockNow() >= Date.parse(reservation.start_at), 409, 'The reservation start time has not arrived yet.');

    if (clockNow() > Date.parse(reservation.expires_at)) {
      // BR-12 / UC-008: not used in time -> Expired, the spot is released, 1 point (BR-52).
      db.prepare(`UPDATE parking_reservations SET status='Expired' WHERE id=? AND status='Confirmed'`).run(reservationId);
      db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, reservation.slot_id);
      addViolation(reservation.user_id, 1, `Personal parking reservation was not used within the ${config.parking.arrivalGraceMinutes}-minute arrival grace period.`,
        'parking', reservationId);
      auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_EXPIRED', { detectedAt: 'arrival' }, 'system');
      graceElapsed = true;
      return; // commit the expiry
    }
    const started = db.prepare(`UPDATE parking_reservations SET status='In Progress', arrived_at=? WHERE id=? AND status='Confirmed'`).run(now, reservationId);
    requireValue(started.changes === 1, 409, 'The reservation changed. Please reload and try again.');
    const slot = db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=? AND status='Reserved'`)
      .run(reservation.vehicle_id, now, reservation.slot_id);
    requireValue(slot.changes === 1, 409, 'The reserved slot is not available for this vehicle.');
    db.prepare(`UPDATE vehicles SET status='Parked', hub_id=?, updated_at=? WHERE id=?`).run(reservation.hub_id, now, reservation.vehicle_id);
    auditChange('ParkingReservation', reservationId, 'PERSONAL_VEHICLE_ARRIVED', {}, user.id);
  });
  requireValue(!graceElapsed, 409,
    `The ${config.parking.arrivalGraceMinutes}-minute arrival grace period has elapsed. The reservation is now Expired, the spot is released and one violation point was recorded (BR-12, BR-52).`);
  return db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
}

export function completeReservation({ user, reservationId }) {
  let lateMinutes = 0;
  transaction(() => {
    const now = nowIso();
    const reservation = loadReservationForActor(user, reservationId, 'Only the reservation owner can complete this reservation.');
    requireValue(reservation.status === 'In Progress', 409, 'Only an active parking reservation can be completed.');
    lateMinutes = Math.max(0, (clockNow() - Date.parse(reservation.end_at)) / 60000);
    db.prepare(`UPDATE parking_reservations SET status='Completed', completed_at=? WHERE id=?`).run(now, reservationId);
    db.prepare(`UPDATE parking_slots SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=?`).run(now, reservation.slot_id);
    // Do not overwrite a status set meanwhile by another workflow (for example charging).
    db.prepare(`UPDATE vehicles SET status='Available', hub_id=?, updated_at=? WHERE id=? AND status='Parked'`)
      .run(reservation.hub_id, now, reservation.vehicle_id);
    // BR-48 / BR-52: staying more than 15 minutes after the end is an overstay (1 point).
    if (lateMinutes > config.parking.overstayGraceMinutes) {
      addViolation(reservation.user_id, 1, 'Personal vehicle overstayed a parking reservation.', 'parking', reservationId);
    }
    auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_COMPLETED', { lateMinutes: Number(lateMinutes.toFixed(1)) }, user.id);
  });
  return {
    reservation: db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId),
    lateMinutes: Number(lateMinutes.toFixed(1))
  };
}

// BR-13: a parking reservation can be cancelled only before its parking period starts.
export function cancelReservation({ user, reservationId }) {
  transaction(() => {
    const now = nowIso();
    const reservation = loadReservationForActor(user, reservationId, 'Only the reservation owner can cancel this reservation.');
    requireValue(reservation.status === 'Confirmed', 409, 'Only a reservation that has not started can be cancelled.');
    requireValue(clockNow() < Date.parse(reservation.start_at), 409,
      'The parking period has already started, so the reservation can no longer be cancelled (BR-13).');
    const cancelled = db.prepare(`UPDATE parking_reservations SET status='Cancelled' WHERE id=? AND status='Confirmed'`).run(reservationId);
    requireValue(cancelled.changes === 1, 409, 'The reservation changed. Please reload and try again.');
    // BR-15: a cancelled reservation never leaves the slot Reserved.
    db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, reservation.slot_id);
    auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_CANCELLED', {}, user.id);
  });
  return db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
}