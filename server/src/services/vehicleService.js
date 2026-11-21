import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, isStudentSuspended, inHubOperatingHours, auditChange, addViolation } from './commonService.js';
import { enqueueSharedVehicle } from './chargingService.js';

export function listVehicles({ kind, hubId, user }) {
  let sql = `SELECT v.*, h.name AS hub_name FROM vehicles v LEFT JOIN hubs h ON h.id=v.hub_id WHERE 1=1`;
  const params = [];
  if (kind) { sql += ' AND v.kind=?'; params.push(kind); }
  if (hubId) { sql += ' AND v.hub_id=?'; params.push(hubId); }
  if (user?.role === 'Student' && kind !== 'shared') {
    sql += ' AND (v.kind="shared" OR v.owner_id=?)'; params.push(user.id);
  }
  sql += ' ORDER BY v.kind, v.hub_id, v.plate';
  return db.prepare(sql).all(...params);
}

export function createPersonalVehicle({ user, plate, vehicleType, connectorType, hubId }) {
  requireValue(user?.role === 'Student', 403, 'Only students can add a personal vehicle.');
  const cleanPlate = String(plate || '').trim().toUpperCase();
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
  const sql = `SELECT b.*, v.plate, v.battery_level, v.status AS vehicle_status,
    h.name AS hub_name, h.location AS hub_location
    FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id JOIN hubs h ON h.id=b.hub_id
    ${user.role === 'Student' ? 'WHERE b.user_id=?' : ''}
    ORDER BY b.created_at DESC LIMIT 100`;
  return user.role === 'Student' ? db.prepare(sql).all(user.id) : db.prepare(sql).all();
}

export function createBooking({ user, vehicleId }) {
  requireValue(user?.role === 'Student', 403, 'Only students can book shared vehicles.');
  requireValue(!isStudentSuspended(user.id), 403, 'Your account is suspended from creating new bookings.');
  const vehicle = db.prepare(`SELECT v.*, h.open_time, h.close_time, h.status AS hub_status
    FROM vehicles v JOIN hubs h ON h.id=v.hub_id WHERE v.id=? AND v.kind='shared'`).get(vehicleId);
  requireValue(vehicle, 404, 'Shared vehicle not found.');
  requireValue(vehicle.status === 'Available' && vehicle.battery_level >= 20, 409,
    'Only an Available shared vehicle with at least 20% battery can be booked (BR-10).');
  requireValue(vehicle.hub_status === 'Open', 409, 'The selected Hub is not open.');
  const now = nowIso();
  requireValue(inHubOperatingHours({ open_time: vehicle.open_time, close_time: vehicle.close_time }, now), 409,
    'New bookings are accepted only during Hub operating hours (BR-42).');
  const existing = db.prepare(`SELECT id FROM bookings WHERE user_id=? AND status IN ('Confirmed','In Progress','Overdue')`).get(user.id);
  requireValue(!existing, 409, 'You already have an active shared-vehicle booking.');
  const bookingId = makeId('booking');
  const deadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  transaction(() => {
    const check = db.prepare(`UPDATE vehicles SET status='Reserved', updated_at=?
      WHERE id=? AND status='Available' AND battery_level>=20`).run(now, vehicleId);
    requireValue(check.changes === 1, 409, 'Vehicle availability changed. Please select another vehicle.');
    // BR-39: a shared slot held for a charging vehicle is released when the vehicle is booked.
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

export function pickupBooking({ user, bookingId }) {
  const booking = db.prepare(`SELECT b.*, v.status AS vehicle_status FROM bookings b
    JOIN vehicles v ON v.id=b.vehicle_id WHERE b.id=?`).get(bookingId);
  requireValue(booking, 404, 'Booking not found.');
  requireValue(user.role !== 'Student' || booking.user_id === user.id, 403, 'Only the booking owner can pick up this vehicle.');
  requireValue(booking.status === 'Confirmed', 409, 'Only a Confirmed booking can be picked up.');
  requireValue(new Date(booking.pickup_deadline).getTime() > Date.now(), 409,
    'The 15-minute pickup window has elapsed. The booking will expire.');
  requireValue(booking.vehicle_status === 'Reserved', 409, 'The reserved vehicle is not available.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE bookings SET status='In Progress', started_at=? WHERE id=? AND status='Confirmed'`).run(now, bookingId);
    db.prepare(`UPDATE vehicles SET status='In Use', updated_at=? WHERE id=?`).run(now, booking.vehicle_id);
    auditChange('Booking', bookingId, 'SHARED_VEHICLE_PICKED_UP', {}, user.id);
  });
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
}

export function returnBooking({ user, bookingId, returnSlotId, batteryLevel, reportProblem = false, problemNote = '' }) {
  const booking = db.prepare(`SELECT b.*, v.status AS vehicle_status, v.kind, h.name AS origin_hub
    FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id JOIN hubs h ON h.id=b.hub_id WHERE b.id=?`).get(bookingId);
  requireValue(booking, 404, 'Booking not found.');
  requireValue(user.role !== 'Student' || booking.user_id === user.id, 403, 'Only the booking owner can return this vehicle.');
  requireValue(['In Progress','Overdue'].includes(booking.status) && booking.vehicle_status === 'In Use', 409,
    'The vehicle does not have an active trip.');
  const slot = db.prepare(`SELECT s.*, h.name AS hub_name FROM parking_slots s
    JOIN hubs h ON h.id=s.hub_id WHERE s.id=?`).get(returnSlotId);
  requireValue(slot && slot.slot_type === 'Shared', 400, 'A shared vehicle must be returned to a Shared slot (BR-17).');
  requireValue(slot.status === 'Available', 409, 'The selected Shared slot is not free.');
  const battery = Number(batteryLevel);
  requireValue(Number.isInteger(battery) && battery >= 0 && battery <= 100, 400, 'Battery level must be between 0 and 100.');
  const now = nowIso();
  const tripHours = (Date.now() - new Date(booking.started_at).getTime()) / 3600000;
  const lowBattery = battery < 20;
  const nextVehicleStatus = reportProblem ? 'Out of Service' : (lowBattery ? 'Needs Charging' : 'Available');
  const incidentId = reportProblem ? makeId('incident') : null;
  // A valid return may be made to another Hub as long as the destination has a free Shared slot.
  const wrongHub = false;

  transaction(() => {
    db.prepare(`UPDATE bookings SET status='Completed', returned_at=? WHERE id=?`).run(now, bookingId);
    db.prepare(`UPDATE vehicles SET hub_id=?, battery_level=?, status=?, updated_at=? WHERE id=?`)
      .run(slot.hub_id, battery, nextVehicleStatus, now, booking.vehicle_id);
    db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=? AND status='Available'`)
      .run(booking.vehicle_id, now, slot.id);
    if (reportProblem) {
      db.prepare(`INSERT INTO incidents (id,hub_id,vehicle_id,summary,status,created_at)
        VALUES (?,?,?,?,'Open',?)`)
        .run(incidentId, slot.hub_id, booking.vehicle_id, problemNote || 'Vehicle problem reported during return.', now);
    }
    if (wrongHub) addViolation(user.id, 2, 'Returned a shared vehicle to a wrong Hub/slot location.', 'booking', bookingId);
    if (tripHours > 3) addViolation(user.id, 1, 'Shared-vehicle trip exceeded the 3-hour maximum.', 'booking', bookingId);
    if (lowBattery && !reportProblem) enqueueSharedVehicle(booking.vehicle_id, slot.hub_id);
    auditChange('Booking', bookingId, 'SHARED_VEHICLE_RETURNED',
      { returnSlotId, batteryLevel: battery, lowBattery, reportProblem, wrongHub }, user.id);
  });
  return { booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId), vehicleStatus: nextVehicleStatus,
    chargingQueued: lowBattery && !reportProblem, incidentCreated: Boolean(incidentId), tripHours: Number(tripHours.toFixed(2)) };
}

export function cancelBooking({ user, bookingId }) {
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  requireValue(booking, 404, 'Booking not found.');
  requireValue(user.role !== 'Student' || booking.user_id === user.id, 403, 'Only the booking owner can cancel this booking.');
  requireValue(booking.status === 'Confirmed', 409, 'Only a booking that has not started can be cancelled.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE bookings SET status='Cancelled' WHERE id=?`).run(bookingId);
    db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, booking.vehicle_id);
    auditChange('Booking', bookingId, 'BOOKING_CANCELLED', {}, user.id);
  });
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
}
