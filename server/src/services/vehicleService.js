import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, getViolationSummary, inHubOperatingHours, auditChange, addViolation } from './commonService.js';
import { enqueueSharedVehicle } from './chargingService.js';

const PICKUP_HOLD_MINUTES = 15;   // BR-11
const MIN_BOOKING_BATTERY = 20;   // BR-10, BR-18
const MAX_TRIP_HOURS = 3;         // BR-50

export function listVehicles({ kind, hubId, user }) {
  let sql = `SELECT v.*, h.name AS hub_name FROM vehicles v LEFT JOIN hubs h ON h.id=v.hub_id WHERE 1=1`;
  const params = [];
  if (kind) { sql += ' AND v.kind=?'; params.push(kind); }
  if (hubId) { sql += ' AND v.hub_id=?'; params.push(hubId); }
  if (user?.role === 'Student' && kind !== 'shared') {
    // A student sees the shared fleet and only their own personal vehicles (BR-07).
    sql += ` AND (v.kind='shared' OR v.owner_id=?)`; params.push(user.id);
  }
  sql += ' ORDER BY v.kind, v.hub_id, v.plate';
  return db.prepare(sql).all(...params);
}

export function createPersonalVehicle({ user, plate, vehicleType, connectorType, hubId }) {
  requireValue(user?.role === 'Student', 403, 'Only students can add a personal vehicle.');
  const cleanPlate = String(plate || '').trim().replace(/\s+/g, ' ').toUpperCase();
  requireValue(cleanPlate.length >= 4, 400, 'Enter a valid license plate.');
  requireValue(['Car', 'Motorcycle'].includes(vehicleType), 400, 'Vehicle type must be Car or Motorcycle.');
  requireValue(['Type2', 'GB/T'].includes(connectorType), 400, 'Choose a supported connector type.');
  requireValue(db.prepare('SELECT id FROM hubs WHERE id=?').get(hubId), 404, 'Hub not found.');
  const id = makeId('vehicle');
  try {
    db.prepare(`INSERT INTO vehicles
      (id, plate, vehicle_type, connector_type, kind, hub_id, owner_id, battery_level, status, updated_at)
      VALUES (?, ?, ?, ?, 'personal', ?, ?, 50, 'Available', ?)`)
      .run(id, cleanPlate, vehicleType, connectorType, hubId, user.id, nowIso());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'This license plate is already registered.');
    throw error;
  }
  auditChange('Vehicle', id, 'PERSONAL_VEHICLE_CREATED', { plate: cleanPlate }, user.id);
  return db.prepare('SELECT * FROM vehicles WHERE id=?').get(id);
}

export function listBookings(user) {
  requireValue(user, 401, 'You must be logged in to view bookings.');
  const sql = `SELECT b.*, v.plate, v.battery_level, v.status AS vehicle_status,
    h.name AS hub_name, h.location AS hub_location
    FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id JOIN hubs h ON h.id=b.hub_id
    ${user.role === 'Student' ? 'WHERE b.user_id=?' : ''}
    ORDER BY b.created_at DESC LIMIT 100`;
  return user.role === 'Student' ? db.prepare(sql).all(user.id) : db.prepare(sql).all();
}

// UC-005. Every state-dependent check runs inside the transaction that writes the booking (BR-08, BR-36).
export function createBooking({ user, vehicleId }) {
  requireValue(user?.role === 'Student', 403, 'Only students can book shared vehicles.');
  const restriction = getViolationSummary(user.id);
  requireValue(!restriction.suspended, 403,
    `Your account is suspended from creating new bookings until ${restriction.suspendedUntil} (BR-59).`);
  const bookingId = makeId('booking');

  transaction(() => {
    const now = nowIso();
    const vehicle = db.prepare(`SELECT v.*, h.open_time, h.close_time, h.status AS hub_status
      FROM vehicles v JOIN hubs h ON h.id=v.hub_id WHERE v.id=? AND v.kind='shared'`).get(vehicleId);
    requireValue(vehicle, 404, 'Shared vehicle not found.');
    requireValue(vehicle.hub_status === 'Open', 409,
      `The selected Hub is closed. Operating hours: ${vehicle.open_time}–${vehicle.close_time}.`);
    requireValue(inHubOperatingHours({ open_time: vehicle.open_time, close_time: vehicle.close_time }, now), 409,
      `New bookings are accepted only during Hub operating hours: ${vehicle.open_time}–${vehicle.close_time} (BR-42).`);
    const existing = db.prepare(`SELECT id FROM bookings WHERE user_id=? AND status IN ('Confirmed','In Progress','Overdue')`).get(user.id);
    if (existing) throw new HttpError(409, 'You already have an active shared-vehicle booking (BR-09).', { bookingId: existing.id });
    requireValue(vehicle.status === 'Available' && vehicle.battery_level >= MIN_BOOKING_BATTERY, 409,
      `Only an Available shared vehicle with at least ${MIN_BOOKING_BATTERY}% battery can be booked (BR-10).`);

    const deadline = new Date(Date.now() + PICKUP_HOLD_MINUTES * 60 * 1000).toISOString();
    const reserved = db.prepare(`UPDATE vehicles SET status='Reserved', updated_at=?
      WHERE id=? AND status='Available' AND battery_level>=?`).run(now, vehicleId, MIN_BOOKING_BATTERY);
    requireValue(reserved.changes === 1, 409, 'Vehicle availability changed. Please select another vehicle.');
    // BR-39: the Shared slot kept for the vehicle is released when a student books it.
    db.prepare(`UPDATE parking_slots SET status='Available', current_vehicle_id=NULL, updated_at=?
      WHERE current_vehicle_id=? AND slot_type='Shared'`).run(now, vehicleId);
    db.prepare(`INSERT INTO bookings (id,user_id,vehicle_id,hub_id,status,pickup_deadline,created_at)
      VALUES (?,?,?,?, 'Confirmed', ?, ?)`)
      .run(bookingId, user.id, vehicleId, vehicle.hub_id, deadline, now);
    auditChange('Booking', bookingId, 'BOOKING_CONFIRMED', { vehicleId, pickupDeadline: deadline }, user.id);
  });
  return db.prepare(`SELECT b.*, v.plate, h.name AS hub_name FROM bookings b
    JOIN vehicles v ON v.id=b.vehicle_id JOIN hubs h ON h.id=b.hub_id WHERE b.id=?`).get(bookingId);
}

// UC-006. BR-17: only the student who owns the booking can pick up the vehicle.
export function pickupBooking({ user, bookingId }) {
  let windowElapsed = false;
  transaction(() => {
    const now = nowIso();
    const booking = db.prepare(`SELECT b.*, v.status AS vehicle_status FROM bookings b
      JOIN vehicles v ON v.id=b.vehicle_id WHERE b.id=?`).get(bookingId);
    requireValue(booking, 404, 'Booking not found.');
    requireValue(user?.role === 'Student' && booking.user_id === user.id, 403, 'Only the booking owner can pick up this vehicle (BR-17).');
    requireValue(booking.status === 'Confirmed', 409, 'Only a Confirmed booking can be picked up.');

    if (Date.parse(booking.pickup_deadline) <= Date.now()) {
      // E3: the booking is expired now, the vehicle is released and one point is recorded (BR-11, BR-52).
      // BR-57: no point when the vehicle itself failed in the meantime.
      db.prepare(`UPDATE bookings SET status='Expired' WHERE id=? AND status='Confirmed'`).run(bookingId);
      db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, booking.vehicle_id);
      addViolation(booking.user_id, 1, 'Shared vehicle was not collected within the 15-minute pickup hold.', 'booking', bookingId,
        { exemptCause: booking.vehicle_status === 'Out of Service' ? 'vehicle failure' : undefined });
      auditChange('Booking', bookingId, 'BOOKING_EXPIRED', { detectedAt: 'pickup' }, 'system');
      windowElapsed = true;
      return; // commit the expiry
    }
    requireValue(booking.vehicle_status === 'Reserved', 409, 'The reserved vehicle is not available.');
    const started = db.prepare(`UPDATE bookings SET status='In Progress', started_at=? WHERE id=? AND status='Confirmed'`).run(now, bookingId);
    requireValue(started.changes === 1, 409, 'The booking changed. Please reload and try again.');
    const inUse = db.prepare(`UPDATE vehicles SET status='In Use', updated_at=? WHERE id=? AND status='Reserved'`).run(now, booking.vehicle_id);
    requireValue(inUse.changes === 1, 409, 'The reserved vehicle is not available.');
    auditChange('Booking', bookingId, 'SHARED_VEHICLE_PICKED_UP', {}, user.id);
  });
  requireValue(!windowElapsed, 409,
    'The 15-minute pickup window has elapsed. The booking is now Expired and one violation point was recorded (BR-11, BR-52). You may create a new booking.');
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
}

// UC-007. A failed return leaves the trip active and the vehicle In Use (BR-36).
export function returnBooking({ user, bookingId, returnSlotId, batteryLevel, reportProblem = false, problemNote = '' }) {
  const battery = Number(batteryLevel);
  requireValue(Number.isInteger(battery) && battery >= 0 && battery <= 100, 400, 'Battery level must be between 0 and 100.');
  const note = String(problemNote || '').trim().slice(0, 500);
  const incidentId = reportProblem ? makeId('incident') : null;
  const lowBattery = battery < MIN_BOOKING_BATTERY;                       // BR-18
  const nextVehicleStatus = reportProblem ? 'Out of Service' : (lowBattery ? 'Needs Charging' : 'Available');
  let tripHours = null;

  transaction(() => {
    const now = nowIso();
    const booking = db.prepare(`SELECT b.*, v.status AS vehicle_status FROM bookings b
      JOIN vehicles v ON v.id=b.vehicle_id WHERE b.id=?`).get(bookingId);
    requireValue(booking, 404, 'Booking not found.');
    requireValue(user?.role === 'Student' && booking.user_id === user.id, 403, 'Only the booking owner can return this vehicle.');
    requireValue(['In Progress', 'Overdue'].includes(booking.status) && booking.vehicle_status === 'In Use', 409,
      'The vehicle does not have an active trip (BR-17).');
    const slot = db.prepare('SELECT * FROM parking_slots WHERE id=?').get(returnSlotId);
    requireValue(slot && slot.slot_type === 'Shared', 400, 'A shared vehicle must be returned to a Shared slot (BR-17, BR-38).');
    requireValue(slot.status === 'Available', 409, 'The selected Shared slot is not free. Choose another slot or Hub.');

    const startedMs = Date.parse(booking.started_at);
    tripHours = Number.isFinite(startedMs) ? (Date.now() - startedMs) / 3600000 : 0;

    const slotTaken = db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=?
      WHERE id=? AND status='Available'`).run(booking.vehicle_id, now, slot.id);
    requireValue(slotTaken.changes === 1, 409, 'The selected Shared slot was just taken. Choose another slot.');
    db.prepare(`UPDATE bookings SET status='Completed', returned_at=? WHERE id=?`).run(now, bookingId);
    db.prepare(`UPDATE vehicles SET hub_id=?, battery_level=?, status=?, updated_at=? WHERE id=?`)
      .run(slot.hub_id, battery, nextVehicleStatus, now, booking.vehicle_id);

    if (reportProblem) {
      // A3: the return is recorded, an Open incident is created and the vehicle is Out of Service.
      db.prepare(`INSERT INTO incidents (id,hub_id,vehicle_id,summary,status,created_at)
        VALUES (?,?,?,?,'Open',?)`)
        .run(incidentId, slot.hub_id, booking.vehicle_id, note || 'Vehicle problem reported during return.', now);
      auditChange('Incident', incidentId, 'INCIDENT_OPENED', { vehicleId: booking.vehicle_id, source: 'return', bookingId }, user.id);
    }
    // A5 / BR-52: one point for a trip over 3 hours. The student can dispute it (BR-58, BR-57).
    if (tripHours > MAX_TRIP_HOURS) {
      addViolation(user.id, 1, 'Shared-vehicle trip exceeded the 3-hour maximum.', 'booking', bookingId);
    }
    // BR-25: a returned vehicle that needs charging gets a charging request automatically.
    if (lowBattery && !reportProblem) enqueueSharedVehicle(booking.vehicle_id, slot.hub_id);
    auditChange('Booking', bookingId, 'SHARED_VEHICLE_RETURNED',
      { returnSlotId, hubId: slot.hub_id, batteryLevel: battery, lowBattery, reportProblem, tripHours: Number(tripHours.toFixed(2)) }, user.id);
  });
  return {
    booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId),
    vehicleStatus: nextVehicleStatus,
    chargingQueued: lowBattery && !reportProblem,
    incidentCreated: Boolean(incidentId),
    tripHours: Number(tripHours.toFixed(2))
  };
}

// BR-13: a booking can be cancelled only before it starts (before pickup).
export function cancelBooking({ user, bookingId }) {
  transaction(() => {
    const now = nowIso();
    const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    requireValue(booking, 404, 'Booking not found.');
    requireValue(user.role !== 'Student' || booking.user_id === user.id, 403, 'Only the booking owner can cancel this booking.');
    requireValue(booking.status === 'Confirmed', 409, 'Only a booking that has not started can be cancelled.');
    const cancelled = db.prepare(`UPDATE bookings SET status='Cancelled' WHERE id=? AND status='Confirmed'`).run(bookingId);
    requireValue(cancelled.changes === 1, 409, 'The booking changed. Please reload and try again.');
    // BR-15: a cancelled booking never leaves the vehicle Reserved.
    db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, booking.vehicle_id);
    auditChange('Booking', bookingId, 'BOOKING_CANCELLED', {}, user.id);
  });
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
}