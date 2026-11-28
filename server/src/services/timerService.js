import { db, transaction, nowIso } from '../database/db.js';
import { config } from '../config.js';
import { now as clockNow } from '../clock.js';
import { tripBattery } from './batteryModel.js';
import { runChargingTimers, runMaintenance } from './chargingService.js';
import { notify, notifyOperators } from './notificationService.js';
import { auditChange } from './commonService.js';

const MIN = 60000;
const HOUR = 3600000;
const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });

/*
 * Shared-vehicle trips (NI-11): the battery falls with consumption, the student is reminded near the maximum trip duration,
 * the trip becomes Overdue at the maximum (Operators are told), and a low battery is reported once.
 * Every step compares timestamps with "now", so skipping ahead on the demo clock cannot miss an event.
 */
function runTripTimers(nowMs) {
  const maxMs = config.booking.maxTripHours * HOUR;
  const reminderMs = config.reminders.tripReminderMinutes * MIN;
  const trips = db.prepare(`SELECT b.*, v.vehicle_type, v.battery_level AS vehicle_battery, v.plate
    FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id
    WHERE b.status IN ('In Progress','Overdue') AND b.started_at IS NOT NULL`).all();
  for (const trip of trips) {
    const elapsed = nowMs - Date.parse(trip.started_at);
    const battery = Math.round(tripBattery(trip.start_battery ?? trip.vehicle_battery, trip.vehicle_type, elapsed));
    db.prepare(`UPDATE vehicles SET battery_level=? WHERE id=? AND status='In Use' AND battery_level<>?`).run(battery, trip.vehicle_id, battery);

    if (elapsed >= reminderMs && elapsed < maxMs) {
      notify({ userId: trip.user_id, kind: 'trip_reminder', entityType: 'Booking', entityId: trip.id, severity: 'warning', title: 'Trip is almost at the limit',
        message: `Your trip with ${trip.plate} has lasted ${Math.round(elapsed / MIN)} minutes. Return it within ${Math.max(1, Math.round((maxMs - elapsed) / MIN))} minutes to stay within ${config.booking.maxTripHours} hours.` });
    }
    if (elapsed >= maxMs && trip.status === 'In Progress') {
      db.prepare(`UPDATE bookings SET status='Overdue', overdue_at=? WHERE id=? AND status='In Progress'`).run(new Date(nowMs).toISOString(), trip.id);
      auditChange('Booking', trip.id, 'BOOKING_OVERDUE', { elapsedMinutes: Math.round(elapsed / MIN) }, 'system');
      notify({ userId: trip.user_id, kind: 'trip_overdue', entityType: 'Booking', entityId: trip.id, severity: 'critical', title: 'Trip is overdue',
        message: `Your trip with ${trip.plate} passed ${config.booking.maxTripHours} hours. Please return the vehicle now.` });
      notifyOperators({ kind: 'trip_overdue_ops', entityType: 'Booking', entityId: trip.id, severity: 'critical', title: 'Overdue shared-vehicle trip',
        message: `${trip.plate} has been out for more than ${config.booking.maxTripHours} hours.` });
    }
    if (battery <= config.reminders.lowBatteryWarningPercent) {
      notify({ userId: trip.user_id, kind: 'trip_low_battery', entityType: 'Booking', entityId: trip.id, severity: 'warning', title: 'Low battery',
        message: `${trip.plate} is down to ${battery}%. Return it to a Hub soon.` });
    }
  }
}

/*
 * Personal parking (NI-09): a notice shortly before the period ends and when it ends; a vehicle still parked once the
 * grace period has passed is flagged, and the student and the Operators are told.
 */
function runParkingTimers(nowMs) {
  const beforeMs = config.reminders.parkingReminderBeforeEndMinutes * MIN;
  const graceMs = config.parking.overstayGraceMinutes * MIN;
  const parked = db.prepare(`SELECT r.*, v.plate, s.code AS slot_code FROM parking_reservations r
    JOIN vehicles v ON v.id=r.vehicle_id JOIN parking_slots s ON s.id=r.slot_id WHERE r.status='In Progress'`).all();
  for (const r of parked) {
    const endMs = Date.parse(r.end_at);
    if (nowMs >= endMs - beforeMs && nowMs < endMs) {
      notify({ userId: r.user_id, kind: 'parking_ending_soon', entityType: 'ParkingReservation', entityId: r.id, severity: 'info', title: 'Parking ends soon',
        message: `Your parking in ${r.slot_code} ends at ${hhmm(endMs)}. Plan to leave on time.` });
    }
    if (nowMs >= endMs) {
      notify({ userId: r.user_id, kind: 'parking_ended', entityType: 'ParkingReservation', entityId: r.id, severity: 'warning', title: 'Parking period ended',
        message: `Your parking period ended at ${hhmm(endMs)}. Please leave within ${config.parking.overstayGraceMinutes} minutes.` });
    }
    if (nowMs >= endMs + graceMs && !r.overstay_flagged_at) {
      db.prepare(`UPDATE parking_reservations SET overstay_flagged_at=? WHERE id=? AND overstay_flagged_at IS NULL`).run(new Date(nowMs).toISOString(), r.id);
      auditChange('ParkingReservation', r.id, 'PARKING_OVERSTAY_FLAGGED', { slotId: r.slot_id }, 'system');
      const text = `${r.plate} is still in ${r.slot_code}, ${config.parking.overstayGraceMinutes} minutes after the reservation ended.`;
      notify({ userId: r.user_id, kind: 'parking_overstay', entityType: 'ParkingReservation', entityId: r.id, severity: 'critical', title: 'You are overstaying', message: text });
      notifyOperators({ kind: 'parking_overstay_ops', entityType: 'ParkingReservation', entityId: r.id, severity: 'critical', title: 'Vehicle overstaying a slot', message: text });
    }
  }
}

export function runTimers(nowMs = clockNow()) {
  transaction(() => { runTripTimers(nowMs); runParkingTimers(nowMs); });
  runChargingTimers(nowMs);
}

// One full cycle: timers first (battery, reminders, session ends), then expiry of holds and the Charging Scheduler (NI-01, NI-04).
const cycleState = { lastRunAt: null };
export function runCycle() {
  runTimers();
  const result = runMaintenance();
  cycleState.lastRunAt = nowIso();
  return result;
}

export function maintenanceStatus() {
  const intervalSeconds = config.status.refreshIntervalSeconds;
  return {
    intervalSeconds,
    lastRunAt: cycleState.lastRunAt,
    nextRunAt: cycleState.lastRunAt ? new Date(Date.parse(cycleState.lastRunAt) + intervalSeconds * 1000).toISOString() : null
  };
}
