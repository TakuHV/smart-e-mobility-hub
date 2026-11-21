import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, isStudentSuspended, inHubOperatingHours, overlap, auditChange, addViolation } from './commonService.js';

export function listSlots({ hubId, slotType }) {
  let sql = `SELECT s.*, h.name AS hub_name FROM parking_slots s JOIN hubs h ON h.id=s.hub_id WHERE 1=1`;
  const params = [];
  if (hubId) { sql += ' AND s.hub_id=?'; params.push(hubId); }
  if (slotType) { sql += ' AND s.slot_type=?'; params.push(slotType); }
  sql += ' ORDER BY h.name, s.slot_type, s.code';
  return db.prepare(sql).all(...params).map(row => ({
    ...row, supported_vehicle_types: JSON.parse(row.supported_vehicle_types_json)
  }));
}

export function listReservations(user) {
  const studentFilter = user.role === 'Student' ? 'WHERE r.user_id=?' : '';
  const sql = `SELECT r.*, v.plate, v.vehicle_type, s.code AS slot_code, h.name AS hub_name
    FROM parking_reservations r JOIN vehicles v ON v.id=r.vehicle_id
    JOIN parking_slots s ON s.id=r.slot_id JOIN hubs h ON h.id=r.hub_id
    ${studentFilter} ORDER BY r.created_at DESC LIMIT 100`;
  return user.role === 'Student' ? db.prepare(sql).all(user.id) : db.prepare(sql).all();
}

export function createReservation({ user, vehicleId, hubId, slotId, startAt, endAt }) {
  requireValue(user?.role === 'Student', 403, 'Only students can create personal parking reservations.');
  requireValue(!isStudentSuspended(user.id), 403, 'Your account is suspended from creating new reservations.');
  const vehicle = db.prepare(`SELECT * FROM vehicles WHERE id=? AND kind='personal' AND owner_id=?`)
    .get(vehicleId, user.id);
  requireValue(vehicle, 404, 'Choose one of your registered personal vehicles.');
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  requireValue(hub && hub.status === 'Open', 404, 'The selected Hub is not available.');
  const slot = db.prepare('SELECT * FROM parking_slots WHERE id=? AND hub_id=?').get(slotId, hubId);
  requireValue(slot && slot.slot_type === 'Personal', 400, 'Personal vehicles may use Personal slots only (BR-38).');
  requireValue(slot.status === 'Available', 409, 'The selected parking slot is not available.');
  const start = new Date(startAt);
  const end = new Date(endAt);
  requireValue(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start,
    400, 'Choose a valid parking start and end time.');
  requireValue(start.getTime() > Date.now() - 60_000, 400, 'The parking start time must be in the future.');
  requireValue(inHubOperatingHours(hub, start.toISOString(), end.toISOString()), 400,
    `The parking period must be inside Hub operating hours (${hub.open_time}–${hub.close_time}, BR-42).`);
  const supported = JSON.parse(slot.supported_vehicle_types_json);
  requireValue(supported.includes(vehicle.vehicle_type), 400, 'The selected slot does not support this vehicle type (BR-41).');

  const conflictForSlot = db.prepare(`SELECT id FROM parking_reservations
    WHERE slot_id=? AND status IN ('Confirmed','In Progress') AND start_at < ? AND end_at > ?`).get(slotId, end.toISOString(), start.toISOString());
  requireValue(!conflictForSlot, 409, 'The selected slot has a conflicting reservation (BR-08).');
  const conflictForVehicle = db.prepare(`SELECT id FROM parking_reservations
    WHERE vehicle_id=? AND status IN ('Confirmed','In Progress') AND start_at < ? AND end_at > ?`).get(vehicleId, end.toISOString(), start.toISOString());
  requireValue(!conflictForVehicle, 409, 'This vehicle already has an overlapping active parking reservation (BR-09).');
  const chargingConflict = db.prepare(`SELECT id, registered_at, next_required_usage_at FROM charging_requests
    WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging') AND registered_at < ? AND next_required_usage_at > ?`)
    .get(vehicleId, end.toISOString(), start.toISOString());
  requireValue(!chargingConflict, 409, 'This parking period overlaps an active charging request for the same vehicle (BR-24).');

  const now = nowIso();
  const reservationId = makeId('parking');
  const expiresAt = new Date(start.getTime() + 15 * 60 * 1000).toISOString();
  transaction(() => {
    const update = db.prepare(`UPDATE parking_slots SET status='Reserved', updated_at=?
      WHERE id=? AND status='Available'`).run(now, slotId);
    requireValue(update.changes === 1, 409, 'The selected slot was just reserved by another request.');
    db.prepare(`INSERT INTO parking_reservations
      (id,user_id,vehicle_id,hub_id,slot_id,status,start_at,end_at,expires_at,created_at)
      VALUES (?,?,?,?,?,'Confirmed',?,?,?,?)`)
      .run(reservationId, user.id, vehicleId, hubId, slotId, start.toISOString(), end.toISOString(), expiresAt, now);
    auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_CONFIRMED',
      { slotId, startAt: start.toISOString(), endAt: end.toISOString(), expiresAt }, user.id);
  });
  return db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
}

export function arriveReservation({ user, reservationId }) {
  const reservation = db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
  requireValue(reservation, 404, 'Parking reservation not found.');
  requireValue(user.role !== 'Student' || reservation.user_id === user.id, 403, 'Only the reservation owner can check in.');
  requireValue(reservation.status === 'Confirmed', 409, 'Only a Confirmed parking reservation can be checked in.');
  requireValue(Date.now() >= new Date(reservation.start_at).getTime(), 409, 'The reservation start time has not arrived yet.');
  requireValue(Date.now() <= new Date(reservation.expires_at).getTime(), 409, 'The 15-minute arrival grace period has elapsed.')
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE parking_reservations SET status='In Progress', arrived_at=? WHERE id=?`).run(now, reservationId);
    db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=?`)
      .run(reservation.vehicle_id, now, reservation.slot_id);
    db.prepare(`UPDATE vehicles SET status='Parked', hub_id=?, updated_at=? WHERE id=?`)
      .run(reservation.hub_id, now, reservation.vehicle_id);
    auditChange('ParkingReservation', reservationId, 'PERSONAL_VEHICLE_ARRIVED', {}, user.id);
  });
  return db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
}

export function completeReservation({ user, reservationId }) {
  const reservation = db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
  requireValue(reservation, 404, 'Parking reservation not found.');
  requireValue(user.role !== 'Student' || reservation.user_id === user.id, 403, 'Only the reservation owner can complete this reservation.');
  requireValue(reservation.status === 'In Progress', 409, 'Only an active parking reservation can be completed.');
  const now = nowIso();
  const lateMinutes = Math.max(0, (Date.now() - new Date(reservation.end_at).getTime()) / 60000);
  transaction(() => {
    db.prepare(`UPDATE parking_reservations SET status='Completed', completed_at=? WHERE id=?`).run(now, reservationId);
    db.prepare(`UPDATE parking_slots SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=?`)
      .run(now, reservation.slot_id);
    db.prepare(`UPDATE vehicles SET status='Available', hub_id=?, updated_at=? WHERE id=?`)
      .run(reservation.hub_id, now, reservation.vehicle_id);
    if (lateMinutes > 15) addViolation(reservation.user_id, 1, 'Personal vehicle overstayed a parking reservation.', 'parking', reservationId);
    auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_COMPLETED', { lateMinutes }, user.id);
  });
  return { reservation: db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId), lateMinutes };
}

export function cancelReservation({ user, reservationId }) {
  const reservation = db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
  requireValue(reservation, 404, 'Parking reservation not found.');
  requireValue(user.role !== 'Student' || reservation.user_id === user.id, 403, 'Only the reservation owner can cancel this reservation.');
  requireValue(reservation.status === 'Confirmed', 409, 'Only a reservation that has not started can be cancelled.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE parking_reservations SET status='Cancelled' WHERE id=?`).run(reservationId);
    db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, reservation.slot_id);
    auditChange('ParkingReservation', reservationId, 'PARKING_RESERVATION_CANCELLED', {}, user.id);
  });
  return db.prepare('SELECT * FROM parking_reservations WHERE id=?').get(reservationId);
}
