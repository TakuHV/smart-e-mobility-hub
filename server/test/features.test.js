import '../testSetup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, nowIso } from '../src/database/db.js';
import { jump, now as clockNow } from '../src/clock.js';
import { config, resetConfig } from '../src/config.js';
import { addUser, makeHub, addSlot, addCharger, addVehicle, row, notificationKinds, later } from './helpers.js';
import { createBooking, pickupBooking, returnBooking, createPersonalVehicle, normalizeVnMotorcyclePlate } from '../src/services/vehicleService.js';
import { createReservation } from '../src/services/parkingService.js';
import { createPersonalChargingRequest, connectPersonalVehicle, startMoveRequest, completeMoveRequest, calculatePriority, rankQueue, runScheduler, stopAutoMove, resumeAutoMove, previewPersonalCharging } from '../src/services/chargingService.js';
import { runTimers, runCycle } from '../src/services/timerService.js';
import { saveSettings, resetSettings, loadSavedSettings } from '../src/services/settingsService.js';
import { adminOverview, updateHub, addSlots, removeSlot, addCharger as adminAddCharger, updateCharger, removeCharger,
  addSharedVehicle, addPersonalVehicle, retireVehicle } from '../src/services/adminService.js';
import { redistributionOverview, createTask, startTask, completeTask, cancelTask } from '../src/services/redistributionService.js';
import { listUsers, createUser, setUserStatus, setUserRole, accessOverview } from '../src/services/userAdminService.js';
import { userRedirectOverview, createUserRedirect, endUserRedirect, activeRedirects } from '../src/services/userRedirectService.js';
import { resetDemoData } from '../src/services/demoResetService.js';
import { demoLogin, ensureDemoAccounts } from '../src/services/authService.js';
import { reportIncident, acknowledgeIncident, resolveIncident, attentionItems } from '../src/services/incidentService.js';
import { getViolationSummary } from '../src/services/commonService.js';

const fail = (fn, status) => assert.throws(fn, error => error.status === status, `expected HTTP ${status}`);

/* ---------- A booking remembers the Shared slot where the vehicle waits ---------- */
test('A booking stores the Shared slot where the vehicle waits, so the student can find it', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 90, slotId: slot });
  const code = row('SELECT code FROM parking_slots WHERE id=?', slot).code;
  const booking = createBooking({ user: student, vehicleId: vehicle.id });
  assert.equal(row('SELECT pickup_slot_code FROM bookings WHERE id=?', booking.id).pickup_slot_code, code);
  assert.equal(row('SELECT status FROM parking_slots WHERE id=?', slot).status, 'Available'); // the slot itself is free again (BR-39)
});

/* ---------- NI-11: shared-vehicle trip timers ---------- */
test('NI-11: a trip lowers the battery, reminds the student and becomes Overdue after the limit', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 90, slotId: slot });
  const booking = createBooking({ user: student, vehicleId: vehicle.id });
  pickupBooking({ user: student, bookingId: booking.id });
  assert.equal(row('SELECT start_battery FROM bookings WHERE id=?', booking.id).start_battery, 90);

  jump(config.reminders.tripReminderMinutes + 2);
  runTimers();
  runTimers(); // a second cycle must not lower the battery again from the reduced level
  const afterReminder = row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level;
  assert.ok(afterReminder < 90 && afterReminder > 0, `battery fell to ${afterReminder}`);
  assert.ok(notificationKinds(student.id).includes('trip_reminder'));
  assert.equal(row('SELECT status FROM bookings WHERE id=?', booking.id).status, 'In Progress');

  jump(config.booking.maxTripHours * 60 - config.reminders.tripReminderMinutes + 5);
  runTimers();
  assert.equal(row('SELECT status FROM bookings WHERE id=?', booking.id).status, 'Overdue');
  assert.ok(notificationKinds(student.id).includes('trip_overdue'));
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE audience_role='Operator' AND kind='trip_overdue_ops' AND entity_id=?`).get(booking.id));
  assert.ok(attentionItems({ role: 'Operator' }).some(item => item.kind === 'overdue_trip' && item.entityId === booking.id));

  const returned = returnBooking({ user: student, bookingId: booking.id, returnSlotId: slot, batteryLevel: afterReminder });
  assert.equal(returned.booking.status, 'Completed');
  assert.ok(returned.tripHours > config.booking.maxTripHours);
  assert.equal(row('SELECT COUNT(*) AS n FROM violations WHERE user_id=?', student.id).n, 1); // the overdue trip costs 1 violation point
});

/* ---------- NI-04 / NI-09: charging progress, end of session, connection window ---------- */
test('NI-04: a charging session gains battery with the clock and ends at the target', () => {
  const student = addUser('Student');
  const operator = addUser('Operator');
  const hub = makeHub();
  const chargerId = addCharger(hub, 7.2);
  const vehicle = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 40 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: vehicle.id, hubId: hub, batteryLevel: 40,
    nextRequiredUsageAt: later(6) });
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Assigned');
  connectPersonalVehicle({ user: student, requestId: request.id });
  assert.equal(row('SELECT start_battery FROM charging_requests WHERE id=?', request.id).start_battery, 40);

  jump(8); // 7.2 kW into a 3.5 kWh motorcycle is about 206 % per hour: about 27 points in 8 minutes
  runTimers();
  const mid = row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level;
  assert.ok(mid >= 64 && mid <= 71, `battery was ${mid}`);
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Charging');

  jump(12);
  runTimers();
  const done = row('SELECT * FROM charging_requests WHERE id=?', request.id);
  assert.equal(done.status, 'Completed');
  assert.equal(row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level, config.charging.targetBatteryPercent);
  assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Awaiting Removal');
  assert.ok(notificationKinds(student.id).includes('charging_complete'));

  // The vehicle stays at the charger until the removal is Done; ignoring it past the grace period is flagged.
  jump(config.parking.overstayGraceMinutes + 1);
  runTimers();
  assert.ok(row('SELECT overstay_flagged_at FROM charging_requests WHERE id=?', request.id).overstay_flagged_at);
  assert.ok(notificationKinds(student.id).includes('charging_removal_overdue'));

  const move = row(`SELECT id FROM move_vehicle_requests WHERE charging_request_id=? AND direction='FROM_CHARGER'`, request.id);
  startMoveRequest({ user: operator, moveRequestId: move.id });
  completeMoveRequest({ user: operator, moveRequestId: move.id });
  assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Available');
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Available');
});

test('NI-01 / NI-09: an unused charger assignment expires, the student is told and gets 1 violation point', () => {
  const student = addUser('Student');
  const hub = makeHub();
  addCharger(hub, 7.2);
  const vehicle = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 30 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: vehicle.id, hubId: hub, batteryLevel: 30,
    nextRequiredUsageAt: later(5) });
  jump(config.charging.personalConnectWindowMinutes - 3);
  runTimers();
  assert.ok(notificationKinds(student.id).includes('charging_connect_reminder'));
  jump(5);
  runCycle();
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Expired');
  assert.ok(notificationKinds(student.id).includes('charging_expired'));
  assert.equal(row('SELECT COUNT(*) AS n FROM violations WHERE user_id=?', student.id).n, 1); // the unused assignment costs 1 violation point
  const summary = getViolationSummary(student.id);
  assert.equal(summary.activePoints, 1);
  assert.equal(summary.threshold, 5);
  assert.equal(summary.isSuspended, false);
});

test('the maximum session length (BR-23) ends a session early when it is set', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const chargerId = addCharger(hub, 7.2);
  const vehicle = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 20 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: vehicle.id, hubId: hub, batteryLevel: 20,
    nextRequiredUsageAt: later(5) });
  connectPersonalVehicle({ user: student, requestId: request.id });
  const admin = addUser('Admin');
  saveSettings({ user: admin, patch: { charging: { maxSessionMinutes: 10 } } });
  try {
    jump(12);
    runTimers();
    assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Completed');
    const battery = row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level;
    assert.ok(battery < config.charging.targetBatteryPercent, `stopped at ${battery}`);
    assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Awaiting Removal');
  } finally { resetSettings({ user: admin }); }
});

/* ---------- Admin: settings ---------- */
test('Admin settings: validated, applied at once, stored, and reset', () => {
  const admin = addUser('Admin');
  const student = addUser('Student');
  fail(() => saveSettings({ user: student, patch: { booking: { pickupHoldMinutes: 10 } } }), 403);
  fail(() => saveSettings({ user: admin, patch: { booking: { pickupHoldMinutes: -5 } } }), 400);
  fail(() => saveSettings({ user: admin, patch: { demoData: { seedChargerPowerKw: 1 } } }), 400);
  fail(() => saveSettings({ user: admin, patch: { charging: { scheduler: { weights: { need: 0, urgency: 0, waiting: 0 } } } } }), 400);
  assert.equal(config.booking.pickupHoldMinutes, 15, 'a rejected change must not change anything');

  const probe = { battery_level: 50, next_required_usage_at: null, registered_at: nowIso() };
  const before = calculatePriority(probe).score;
  saveSettings({ user: admin, patch: { booking: { pickupHoldMinutes: 5 }, charging: { scheduler: { weights: { need: 1, urgency: 0, waiting: 0 } } } } });
  assert.equal(config.booking.pickupHoldMinutes, 5);
  assert.ok(Math.abs(calculatePriority(probe).score - 50) < 0.01);
  assert.notEqual(before, 50);
  assert.ok(db.prepare(`SELECT 1 FROM app_settings WHERE key='config_overrides'`).get());

  // A new booking now holds the vehicle for the changed number of minutes.
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 80, slotId: slot });
  const booking = createBooking({ user: addUser('Student'), vehicleId: vehicle.id });
  const minutes = (Date.parse(booking.pickup_deadline) - Date.parse(booking.created_at)) / 60000;
  assert.ok(Math.abs(minutes - 5) < 0.1, `hold was ${minutes} minutes`);

  resetConfig(); // as after a restart: the stored settings are applied again
  assert.equal(config.booking.pickupHoldMinutes, 15);
  loadSavedSettings();
  assert.equal(config.booking.pickupHoldMinutes, 5);

  resetSettings({ user: admin });
  assert.equal(config.booking.pickupHoldMinutes, 15);
  assert.ok(Math.abs(calculatePriority(probe).score - before) < 0.01);
  assert.equal(db.prepare(`SELECT 1 FROM app_settings WHERE key='config_overrides'`).get(), undefined);
});

/* ---------- Admin: network ---------- */
test('Admin network: slots, chargers, shared and personal vehicles, Hub settings', () => {
  const admin = addUser('Admin');
  const student = addUser('Student');
  const hub = makeHub();
  fail(() => adminOverview(student), 403);
  fail(() => addSlots({ user: student, hubId: hub, slotType: 'Shared', count: 1 }), 403);

  const slots = addSlots({ user: admin, hubId: hub, slotType: 'Shared', count: 2 });
  assert.deepEqual(slots.map(s => s.code), ['S-01', 'S-02']);
  assert.equal(addSlots({ user: admin, hubId: hub, slotType: 'Shared', count: 1 })[0].code, 'S-03');
  fail(() => addSlots({ user: admin, hubId: hub, slotType: 'Nope', count: 1 }), 400);
  fail(() => addSlots({ user: admin, hubId: hub, slotType: 'Shared', count: 99 }), 400);

  const vehicle = addSharedVehicle({ user: admin, hubId: hub, plate: ' ev 9 001 ', vehicleType: 'Motorcycle', connectorType: 'Type2', batteryLevel: 70 });
  assert.equal(vehicle.plate, 'EV 9 001');
  assert.equal(vehicle.status, 'Available');
  assert.equal(row(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND status='Occupied' AND current_vehicle_id=?`, hub, vehicle.id).n, 1);
  fail(() => addSharedVehicle({ user: admin, hubId: hub, plate: 'EV 9 001', vehicleType: 'Motorcycle', connectorType: 'Type2' }), 409);

  addCharger(hub, 7.2); // a charger exists so that a low-battery vehicle can be queued
  const low = addSharedVehicle({ user: admin, hubId: hub, plate: 'EV-9-002', vehicleType: 'Motorcycle', connectorType: 'Type2', batteryLevel: 10 });
  assert.equal(low.status, 'Needs Charging');
  assert.ok(row(`SELECT 1 AS x FROM charging_requests WHERE vehicle_id=?`, low.id), 'a low-battery vehicle joins the charging queue');

  const freeBefore = row(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND status='Available' AND slot_type='Shared'`, hub).n;
  retireVehicle({ user: admin, vehicleId: vehicle.id });
  assert.equal(row('SELECT status, hub_id FROM vehicles WHERE id=?', vehicle.id).status, 'Retired');
  assert.equal(row(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND status='Available' AND slot_type='Shared'`, hub).n, freeBefore + 1);
  fail(() => retireVehicle({ user: admin, vehicleId: vehicle.id }), 404);

  const personal = addPersonalVehicle({ user: admin, ownerId: student.id, hubId: hub, plate: 'P-9-001', vehicleType: 'Motorcycle', connectorType: 'GB/T' });
  assert.equal(personal.owner_id, student.id);
  fail(() => addPersonalVehicle({ user: admin, ownerId: admin.id, hubId: hub, plate: 'P-9-002', vehicleType: 'Motorcycle', connectorType: 'Type2' }), 400);

  const charger = adminAddCharger({ user: admin, hubId: hub, powerKw: 11, connectorTypes: ['Type2'] });
  assert.equal(charger.power_kw, 11);
  assert.equal(updateCharger({ user: admin, chargerId: charger.id, powerKw: 22 }).power_kw, 22);
  fail(() => updateCharger({ user: admin, chargerId: charger.id, powerKw: 0 }), 400);
  assert.equal(updateCharger({ user: admin, chargerId: charger.id, status: 'Out of Service' }).status, 'Out of Service');
  assert.equal(updateCharger({ user: admin, chargerId: charger.id, status: 'Available' }).status, 'Available');
  assert.equal(removeCharger({ user: admin, chargerId: charger.id }).result, 'deleted');

  const emptySlot = addSlots({ user: admin, hubId: hub, slotType: 'Personal', count: 1 })[0];
  assert.equal(removeSlot({ user: admin, slotId: emptySlot.id }).result, 'deleted');

  assert.equal(updateHub({ user: admin, hubId: hub, powerLimitKw: 50, openTime: '06:00', closeTime: '22:00', status: 'Closed' }).status, 'Closed');
  fail(() => updateHub({ user: admin, hubId: hub, openTime: '22:00', closeTime: '06:00' }), 400);
  fail(() => updateHub({ user: admin, hubId: hub, powerLimitKw: -1 }), 400);
  fail(() => updateHub({ user: admin, hubId: hub, openTime: '25:00' }), 400);
  assert.ok(adminOverview(admin).hubs.some(h => h.id === hub));
});

/* ---------- UC-018: redistribution ---------- */
test('UC-018: redistribution reserves a destination slot, keeps the vehicle unbookable and completes', () => {
  const operator = addUser('Operator');
  const student = addUser('Student');
  const from = makeHub();
  const to = makeHub();
  const fromSlots = [addSlot(from, 'Shared'), addSlot(from, 'Shared'), addSlot(from, 'Shared')];
  const vehicles = fromSlots.map(slotId => addVehicle({ kind: 'shared', hubId: from, battery: 80, slotId }));
  for (let i = 0; i < 5; i++) addSlot(to, 'Shared');

  assert.ok(redistributionOverview(operator).suggestions.some(s => s.toHubId === to), 'an empty Hub with room is suggested as target');
  fail(() => createTask({ user: student, vehicleId: vehicles[0].id, toHubId: to }), 403);
  fail(() => createTask({ user: operator, vehicleId: vehicles[0].id, toHubId: from }), 400);

  const task = createTask({ user: operator, vehicleId: vehicles[0].id, toHubId: to, reason: 'Balance' });
  assert.equal(task.status, 'Requested');
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicles[0].id).status, 'In Transfer');
  assert.equal(row('SELECT status FROM parking_slots WHERE id=?', task.to_slot_id).status, 'Reserved');
  fail(() => createBooking({ user: student, vehicleId: vehicles[0].id }), 409);
  fail(() => createTask({ user: operator, vehicleId: vehicles[0].id, toHubId: to }), 409);
  fail(() => completeTask({ user: operator, taskId: task.id }), 409); // must be started first

  startTask({ user: operator, taskId: task.id });
  assert.equal(row('SELECT status FROM parking_slots WHERE id=?', fromSlots[0]).status, 'Available');
  fail(() => cancelTask({ user: operator, taskId: task.id }), 409); // it already left

  const done = completeTask({ user: operator, taskId: task.id });
  assert.equal(done.status, 'Done');
  const moved = row('SELECT hub_id, status FROM vehicles WHERE id=?', vehicles[0].id);
  assert.equal(moved.hub_id, to);
  assert.equal(moved.status, 'Available');
  assert.equal(row('SELECT current_vehicle_id, status FROM parking_slots WHERE id=?', task.to_slot_id).current_vehicle_id, vehicles[0].id);

  // Cancelling before the vehicle leaves restores everything.
  const second = createTask({ user: operator, vehicleId: vehicles[1].id, toHubId: to });
  cancelTask({ user: operator, taskId: second.id });
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicles[1].id).status, 'Available');
  assert.equal(row('SELECT status FROM parking_slots WHERE id=?', second.to_slot_id).status, 'Available');
});

test('UC-018: the destination Hub keeps its free Shared-slot reserve', () => {
  const operator = addUser('Operator');
  const from = makeHub();
  const to = makeHub();
  const slot = addSlot(from, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: from, battery: 80, slotId: slot });
  addSlot(to, 'Shared'); // a single Shared slot: moving a vehicle in would leave none free
  fail(() => createTask({ user: operator, vehicleId: vehicle.id, toHubId: to }), 409);
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Available');
});

/* ---------- UC-019: incidents ---------- */
test('UC-019: a vehicle fault takes the vehicle out of service and resolving brings it back', () => {
  const operator = addUser('Operator');
  const student = addUser('Student');
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 80, slotId: slot });
  const booking = createBooking({ user: student, vehicleId: vehicle.id });

  const { incident, effects } = reportIncident({ user: operator, category: 'Vehicle fault', severity: 'High', summary: 'Brake warning light', vehicleId: vehicle.id });
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Out of Service');
  assert.equal(row('SELECT status FROM bookings WHERE id=?', booking.id).status, 'Cancelled');
  assert.ok(notificationKinds(student.id).includes('booking_cancelled_incident'));
  assert.equal(row('SELECT COUNT(*) AS n FROM violations WHERE user_id=?', student.id).n, 0);
  assert.ok(effects.length >= 2);
  assert.equal(acknowledgeIncident({ user: operator, incidentId: incident.id }).status, 'In Progress');
  fail(() => acknowledgeIncident({ user: operator, incidentId: incident.id }), 409);

  const resolved = resolveIncident({ user: operator, incidentId: incident.id, note: 'Replaced brake pads' });
  assert.equal(resolved.incident.status, 'Resolved');
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Available');
  fail(() => resolveIncident({ user: operator, incidentId: incident.id }), 409);
});

test('UC-019: a student report waits for an Operator and changes nothing by itself', () => {
  const operator = addUser('Operator');
  const student = addUser('Student');
  const other = addUser('Student');
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 80, slotId: slot });
  const mine = addVehicle({ kind: 'personal', hubId: hub, ownerId: other.id });
  fail(() => reportIncident({ user: student, category: 'Vehicle fault', summary: 'x' }), 400); // too short
  fail(() => reportIncident({ user: student, category: 'Vehicle fault', summary: 'Not mine at all', vehicleId: mine.id }), 403);
  const { incident } = reportIncident({ user: student, category: 'Vehicle fault', summary: 'Seat is broken', vehicleId: vehicle.id });
  assert.equal(incident.source, 'student');
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Available');
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE audience_role='Operator' AND kind='incident_reported' AND entity_id=?`).get(incident.id));
  fail(() => acknowledgeIncident({ user: student, incidentId: incident.id }), 403);
  resolveIncident({ user: operator, incidentId: incident.id, note: 'Checked, seat is fine' });
  assert.ok(notificationKinds(student.id).includes('incident_resolved'));
});

test('UC-019: a charger failing during charging stops the session and the charger returns after the vehicle is moved', () => {
  const operator = addUser('Operator');
  const student = addUser('Student');
  const hub = makeHub();
  const chargerId = addCharger(hub, 7.2);
  const vehicle = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 40 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: vehicle.id, hubId: hub, batteryLevel: 40,
    nextRequiredUsageAt: later(6) });
  connectPersonalVehicle({ user: student, requestId: request.id });
  jump(5);
  runTimers();

  const { incident } = reportIncident({ user: operator, category: 'Charger fault', severity: 'High', summary: 'Cable overheating', chargerId });
  assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Out of Service');
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Cancelled');
  const interrupted = row('SELECT battery_level, status FROM vehicles WHERE id=?', vehicle.id);
  assert.ok(interrupted.battery_level > 40 && interrupted.battery_level < config.charging.targetBatteryPercent);
  assert.ok(notificationKinds(student.id).includes('charger_failed'));
  const move = row(`SELECT id, status FROM move_vehicle_requests WHERE charging_request_id=? AND direction='FROM_CHARGER'`, request.id);
  assert.equal(move.status, 'Requested');
  fail(() => reportIncident({ user: operator, category: 'Charger fault', summary: 'Again the same charger', chargerId }), 409);

  // The charger cannot come back while the vehicle is still recorded there.
  let result = resolveIncident({ user: operator, incidentId: incident.id, note: 'Cable replaced' });
  assert.ok(result.effects.some(text => /stays out of service/.test(text)));
  assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Out of Service');

  startMoveRequest({ user: operator, moveRequestId: move.id });
  completeMoveRequest({ user: operator, moveRequestId: move.id });
  assert.equal(row('SELECT status, current_vehicle_id FROM chargers WHERE id=?', chargerId).current_vehicle_id, null);
  assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Out of Service');
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Available');
  updateCharger({ user: addUser('Admin'), chargerId, status: 'Available' });
  assert.equal(row('SELECT status FROM chargers WHERE id=?', chargerId).status, 'Available');
});

test('UC-019: a charger that fails before the vehicle is connected sends the request back to the queue', () => {
  const operator = addUser('Operator');
  const student = addUser('Student');
  const hub = makeHub();
  const broken = addCharger(hub, 7.2, 'CH-A');
  const vehicle = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 35 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: vehicle.id, hubId: hub, batteryLevel: 35,
    nextRequiredUsageAt: later(5) });
  assert.equal(row('SELECT charger_id FROM charging_requests WHERE id=?', request.id).charger_id, broken);
  reportIncident({ user: operator, category: 'Charger fault', summary: 'Display is dead', chargerId: broken });
  const requeued = row('SELECT status, charger_id FROM charging_requests WHERE id=?', request.id);
  assert.equal(requeued.status, 'Queued');
  assert.equal(requeued.charger_id, null);
  const spare = addCharger(hub, 7.2, 'CH-B'); // the scheduler uses the next free charger
  runCycle();
  assert.equal(row('SELECT charger_id FROM charging_requests WHERE id=?', request.id).charger_id, spare);
});

test('UC-019: a blocked slot is taken out of service only when it is free', () => {
  const operator = addUser('Operator');
  const hub = makeHub();
  const free = addSlot(hub, 'Personal');
  const taken = addSlot(hub, 'Shared');
  addVehicle({ kind: 'shared', hubId: hub, battery: 80, slotId: taken });
  fail(() => reportIncident({ user: operator, category: 'Slot blocked', summary: 'A car is parked there', slotId: taken }), 409);
  const { incident } = reportIncident({ user: operator, category: 'Slot blocked', summary: 'Oil on the floor', slotId: free });
  assert.equal(row('SELECT status FROM parking_slots WHERE id=?', free).status, 'Out of Service');
  resolveIncident({ user: operator, incidentId: incident.id, note: 'Cleaned' });
  assert.equal(row('SELECT status FROM parking_slots WHERE id=?', free).status, 'Available');
});

/* ---------- Student flow: destination Hub, automatic slot, no typed battery ---------- */
test('Booking with a destination Hub: the trip ends at a free Shared slot there and uses the simulated battery', () => {
  const student = addUser('Student');
  const origin = makeHub();
  const destination = makeHub();
  const full = makeHub();
  const originSlot = addSlot(origin, 'Shared');
  const freeSlot = addSlot(destination, 'Shared');
  addSlot(full, 'Shared'); db.prepare(`UPDATE parking_slots SET status='Occupied' WHERE hub_id=?`).run(full);
  const vehicle = addVehicle({ kind: 'shared', hubId: origin, battery: 80, slotId: originSlot });

  fail(() => createBooking({ user: student, vehicleId: vehicle.id, destinationHubId: full }), 409); // destination has no free slot
  const booking = createBooking({ user: student, vehicleId: vehicle.id, destinationHubId: destination });
  assert.equal(booking.destination_hub_id, destination);
  pickupBooking({ user: student, bookingId: booking.id });
  jump(30); runTimers();
  const level = row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level;
  assert.ok(level < 80, 'battery went down during the trip');

  const result = returnBooking({ user: student, bookingId: booking.id }); // no slot id, no battery typed
  assert.equal(result.booking.status, 'Completed');
  const after = row('SELECT hub_id, battery_level FROM vehicles WHERE id=?', vehicle.id);
  assert.equal(after.hub_id, destination);
  assert.equal(after.battery_level, level);
  assert.equal(row('SELECT current_vehicle_id FROM parking_slots WHERE id=?', freeSlot).current_vehicle_id, vehicle.id);
});

test('Return without a free Shared slot at the Hub is refused and the trip stays active', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 70, slotId: slot });
  const booking = createBooking({ user: student, vehicleId: vehicle.id });
  pickupBooking({ user: student, bookingId: booking.id });
  db.prepare(`UPDATE parking_slots SET status='Occupied' WHERE hub_id=?`).run(hub);
  fail(() => returnBooking({ user: student, bookingId: booking.id, hubId: hub }), 409);
  assert.equal(row('SELECT status FROM bookings WHERE id=?', booking.id).status, 'In Progress');
});

test('Booking: a round trip is allowed, the destination can be the pick-up Hub', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const slot = addSlot(hub, 'Shared');                 // the only Shared slot: it is free again once the vehicle has left
  const vehicle = addVehicle({ kind: 'shared', hubId: hub, battery: 80, slotId: slot });
  const booking = createBooking({ user: student, vehicleId: vehicle.id, destinationHubId: hub });
  assert.equal(booking.destination_hub_id, hub);
  pickupBooking({ user: student, bookingId: booking.id });
  jump(10); runTimers();
  const result = returnBooking({ user: student, bookingId: booking.id });
  assert.equal(result.booking.status, 'Completed');
  assert.equal(row('SELECT hub_id FROM vehicles WHERE id=?', vehicle.id).hub_id, hub);
  assert.equal(row('SELECT current_vehicle_id FROM parking_slots WHERE id=?', slot).current_vehicle_id, vehicle.id);
});

test('Admin: create users, change roles, deactivate accounts, and always keep one active Admin', () => {
  const admin = addUser('Admin');
  const student = addUser('Student');
  fail(() => listUsers(student), 403);
  fail(() => createUser({ user: student, fullName: 'Nope', role: 'Student' }), 403);

  const created = createUser({ user: admin, fullName: 'Lan Tran', role: 'Student' });
  assert.equal(created.status, 'Active');
  fail(() => createUser({ user: admin, fullName: 'lan tran', role: 'Student' }), 409);
  assert.ok(listUsers(admin).some(u => u.id === created.id));

  assert.equal(setUserRole({ user: admin, userId: created.id, role: 'Operator' }).role, 'Operator');
  fail(() => setUserRole({ user: admin, userId: admin.id, role: 'Student' }), 409);       // not your own role
  fail(() => setUserStatus({ user: admin, userId: admin.id, status: 'Deactivated' }), 409); // not yourself

  assert.equal(setUserStatus({ user: admin, userId: created.id, status: 'Deactivated' }).status, 'Deactivated');
  fail(() => demoLogin({ displayName: 'Lan Tran', role: 'Operator' }), 403);               // cannot sign in any more
  assert.equal(setUserStatus({ user: admin, userId: created.id, status: 'Active' }).status, 'Active');
  assert.equal(demoLogin({ displayName: 'Lan Tran', role: 'Operator' }).id, created.id);

  // the last active Admin cannot be demoted or deactivated by another Admin
  db.prepare(`UPDATE users SET status='Deactivated' WHERE role='Admin' AND id<>? AND id NOT LIKE 'test-%'`).run(admin.id);
  const secondAdmin = createUser({ user: admin, fullName: 'Second Admin', role: 'Admin' });
  setUserStatus({ user: admin, userId: secondAdmin.id, status: 'Deactivated' });
  const third = createUser({ user: admin, fullName: 'Third Admin', role: 'Admin' });
  assert.equal(setUserRole({ user: admin, userId: third.id, role: 'Student' }).role, 'Student'); // two active admins: allowed
  assert.ok(accessOverview(admin).roles.every(r => r.permissions.length > 0));
});

test('Demo accounts: Admin, Student, Operator, Simulation Operator, and Demo with all four roles', () => {
  db.prepare(`UPDATE users SET status='Active'`).run(); // an earlier test deactivates some accounts
  ensureDemoAccounts(); ensureDemoAccounts(); // safe to repeat
  for (const role of ['Admin', 'Student', 'Operator', 'Simulation Operator']) {
    assert.equal(demoLogin({ displayName: role, role }).role, role);
    assert.equal(demoLogin({ displayName: 'Demo', role }).role, role);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE full_name='Demo'`).get().n, 4);
  assert.equal(db.prepare(`SELECT id FROM users WHERE full_name='Student' AND role='Student'`).get().id, 'student-demo'); // the seeded account keeps its data
});

test('Login: by username, the account must exist, and Demo needs a role', () => {
  db.prepare(`UPDATE users SET status='Active'`).run();
  ensureDemoAccounts();
  assert.equal(demoLogin({ displayName: 'student' }).role, 'Student');             // one role: no need to choose
  assert.equal(demoLogin({ displayName: '  ADMIN ' }).role, 'Admin');              // case and spaces do not matter
  fail(() => demoLogin({ displayName: 'nobody-here' }), 404);                      // no account is created by signing in
  fail(() => demoLogin({ displayName: 'Demo' }), 400);                             // Demo has four roles
  assert.equal(demoLogin({ displayName: 'demo', role: 'Simulation Operator' }).role, 'Simulation Operator');
  fail(() => demoLogin({ displayName: 'Student', role: 'Admin' }), 404);           // that account has no such role
});

test('Demo reset: data returns to the sample state and accounts return to the five defaults', () => {
  db.prepare(`UPDATE users SET status='Active'`).run();
  const admin = addUser('Admin');
  fail(() => resetDemoData({ user: addUser('Student') }), 403);
  ensureDemoAccounts();
  const extra = createUser({ user: admin, fullName: 'Lan Reset', role: 'Student' });
  const anyHub = db.prepare('SELECT id FROM hubs LIMIT 1').get().id;
  db.prepare(`INSERT INTO simulation_runs (id, scenario_type, hub_id, baseline_json, parameters_json, results_json, created_by, created_at)
    VALUES ('run-reset-test', 'test', ?, '{}', '{}', '{}', ?, ?)`).run(anyHub, admin.id, nowIso());
  setUserStatus({ user: admin, userId: db.prepare(`SELECT id FROM users WHERE full_name='Operator'`).get().id, status: 'Deactivated' });
  saveSettings({ user: admin, patch: { booking: { pickupHoldMinutes: 30 } } });
  jump(120);

  const result = resetDemoData({ user: admin });
  assert.equal(result.reset, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hubs').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 0);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM vehicles WHERE kind='shared'`).get().n > 0);
  assert.equal(config.booking.pickupHoldMinutes, 15);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM simulation_runs').get().n, 0);
  db.prepare(`INSERT INTO simulation_runs (id, scenario_type, hub_id, baseline_json, parameters_json, results_json, created_by, created_at)
    VALUES ('run-after-reset', 'test', 'hub-central', '{}', '{}', '{}', 'admin-demo', ?)`).run(nowIso());
  assert.throws(() => db.prepare(`DELETE FROM simulation_runs`).run(), /BR-33/); // the protection is back
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='DEMO_DATA_RESET'`).get().n >= 1);

  // accounts: only the defaults and the five seeded Students remain (Demo has four roles), all Active
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(extra.id), undefined);
  const names = db.prepare('SELECT full_name, role, status FROM users ORDER BY full_name, role').all();
  assert.equal(names.length, 13);
  assert.ok(names.every(u => u.status === 'Active' && (u.full_name === u.role || u.full_name === 'Demo' || /^student[1-5]$/.test(u.full_name))));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM parking_reservations WHERE status='In Progress'`).get().n, 5);
  assert.equal(names.filter(u => u.full_name === 'Demo').length, 4);

  // the system works again after the reset
  const student = demoLogin({ displayName: 'Student' });
  const vehicle = db.prepare(`SELECT id FROM vehicles WHERE kind='shared' AND status='Available' AND battery_level>=20 LIMIT 1`).get();
  assert.equal(createBooking({ user: student, vehicleId: vehicle.id }).status, 'Confirmed');
});

/* ---------- User redistribution: ask students to use another Hub ---------- */
test('User redistribution: an Operator redirects students from a busy Hub, students are notified, and it can be ended', () => {
  const operator = addUser('Operator');
  const student = addUser('Student');
  const busy = makeHub();
  const other = makeHub();
  fail(() => createUserRedirect({ user: student, fromHubId: busy, toHubId: other }), 403);
  fail(() => createUserRedirect({ user: operator, fromHubId: busy, toHubId: busy }), 400);

  const redirect = createUserRedirect({ user: operator, fromHubId: busy, toHubId: other, reason: 'No vehicles' });
  assert.equal(redirect.status, 'Active');
  assert.ok(activeRedirects().some(r => r.id === redirect.id && r.from_hub_id === busy));
  assert.ok(notificationKinds(student.id).includes('hub_redirect'));
  fail(() => createUserRedirect({ user: operator, fromHubId: busy, toHubId: other }), 409);   // one active redirection per Hub
  fail(() => createUserRedirect({ user: operator, fromHubId: other, toHubId: busy }), 409);   // the alternative must not be redirected itself
  assert.ok(userRedirectOverview(operator).active.some(r => r.id === redirect.id));

  endUserRedirect({ user: operator, redirectId: redirect.id });
  assert.ok(!activeRedirects().some(r => r.id === redirect.id));
  fail(() => endUserRedirect({ user: operator, redirectId: redirect.id }), 409);
});

/* ---------- Shared vehicles charge automatically; personal requests, bookings and Holding ---------- */
const sharedAtHub = (hub, battery) => { const slot = addSlot(hub, 'Shared'); return addVehicle({ kind: 'shared', hubId: hub, battery, slotId: slot }); };
const moveOf = (requestId, direction) => row('SELECT * FROM move_vehicle_requests WHERE charging_request_id=? AND direction=?', requestId, direction);
// Lets the countdown end and the simulated Field Staff finish a move.
const finishMoves = () => { jump(0.3); runTimers(); jump(0.6); runTimers(); };

test('A free charger always takes an idle shared vehicle; the move is sent by itself; the vehicle stays bookable and gains battery', () => {
  const hub = makeHub();
  addSlot(hub, 'Holding');
  const charger = addCharger(hub);
  const vehicle = sharedAtHub(hub, 50);
  runScheduler(hub);
  const request = row(`SELECT * FROM charging_requests WHERE vehicle_id=?`, vehicle.id);
  assert.equal(request.status, 'Assigned');
  const toCharger = moveOf(request.id, 'TO_CHARGER');
  assert.ok(toCharger.auto_send_at, 'the move has a countdown');
  finishMoves();
  assert.equal(row('SELECT status FROM move_vehicle_requests WHERE id=?', toCharger.id).status, 'Done');
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Charging');
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', vehicle.id).status, 'Available', 'a charging shared vehicle stays Available');
  jump(20); runTimers();
  assert.ok(row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level > 50);
  jump(240); runTimers();                         // 100% is the target
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Completed');
  assert.equal(row('SELECT battery_level FROM vehicles WHERE id=?', vehicle.id).battery_level, 100);
  assert.equal(row('SELECT status FROM chargers WHERE id=?', charger).status, 'Awaiting Removal');
  assert.ok(moveOf(request.id, 'FROM_CHARGER'));
});

test('An Operator can stop the countdown of an automatic move', () => {
  const operator = addUser('Operator');
  const hub = makeHub();
  addCharger(hub);
  const vehicle = sharedAtHub(hub, 40);
  runScheduler(hub);
  const request = row(`SELECT * FROM charging_requests WHERE vehicle_id=?`, vehicle.id);
  const move = moveOf(request.id, 'TO_CHARGER');
  stopAutoMove({ user: operator, moveRequestId: move.id });
  jump(2); runTimers();
  const after = row('SELECT * FROM move_vehicle_requests WHERE id=?', move.id);
  assert.equal(after.status, 'Requested');
  assert.equal(after.sent_at, null);
  fail(() => stopAutoMove({ user: addUser('Student'), moveRequestId: move.id }), 403);
  // Resume: the countdown starts again and the request is sent when it ends.
  resumeAutoMove({ user: operator, moveRequestId: move.id });
  assert.ok(row('SELECT auto_send_at FROM move_vehicle_requests WHERE id=?', move.id).auto_send_at);
  jump(1); runTimers();
  assert.notEqual(row('SELECT sent_at FROM move_vehicle_requests WHERE id=?', move.id).sent_at, null);
});

test('A personal request with a higher priority takes the charger of the lowest-priority shared vehicle', () => {
  const student = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 5; i++) addSlot(hub, 'Holding');
  const charger = addCharger(hub);
  const shared = sharedAtHub(hub, 80);
  runScheduler(hub); finishMoves();
  assert.equal(row('SELECT status FROM chargers WHERE id=?', charger).status, 'Charging');
  const personal = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 10 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: personal.id, hubId: hub, batteryLevel: 10, nextRequiredUsageAt: later(2.8) });
  assert.ok(['Queued', 'Assigned'].includes(request.status));
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, shared.id).status, 'Completed', 'the shared session stopped');
  finishMoves();                                 // the shared vehicle is moved away, then the charger goes to the personal request
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Assigned');
  assert.equal(row('SELECT charger_id FROM charging_requests WHERE id=?', request.id).charger_id, charger);
});

test('A booked shared vehicle leaves its charger and is never displaced', () => {
  const student = addUser('Student');
  const other = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 5; i++) addSlot(hub, 'Holding');
  const charger = addCharger(hub);
  const shared = sharedAtHub(hub, 60);
  runScheduler(hub); finishMoves();
  assert.equal(row('SELECT status FROM chargers WHERE id=?', charger).status, 'Charging');

  const booking = createBooking({ user: student, vehicleId: shared.id, pickupInMinutes: 0 });
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', shared.id).status, 'Reserved');
  assert.equal(row('SELECT status FROM chargers WHERE id=?', charger).status, 'Awaiting Removal', 'charging stopped for the booking');
  fail(() => pickupBooking({ user: student, bookingId: booking.id }), 409);  // still being brought back
  finishMoves();
  assert.equal(row('SELECT status FROM parking_slots WHERE current_vehicle_id=?', shared.id).status, 'Occupied');
  assert.equal(pickupBooking({ user: student, bookingId: booking.id }).status, 'In Progress');
  assert.ok(other);
});

test('Booking ahead: the pickup time and the 15-minute hold start at the chosen time; the minimum battery is 30%', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const low = sharedAtHub(hub, 25);
  fail(() => createBooking({ user: student, vehicleId: low.id }), 409);
  const ok = sharedAtHub(hub, 80);
  fail(() => createBooking({ user: student, vehicleId: ok.id, pickupInMinutes: 7 }), 400);
  const booking = createBooking({ user: student, vehicleId: ok.id, pickupInMinutes: 15 });
  const hold = Date.parse(booking.pickup_deadline) - Date.parse(row('SELECT pickup_from FROM bookings WHERE id=?', booking.id).pickup_from);
  assert.equal(hold, config.booking.pickupHoldMinutes * 60000);
  fail(() => pickupBooking({ user: student, bookingId: booking.id }), 409);   // too early
  jump(16);
  assert.equal(pickupBooking({ user: student, bookingId: booking.id }).status, 'In Progress');
});

test('The Holding area keeps 40% free: a request that would use more is refused', () => {
  const hub = makeHub();
  for (let i = 0; i < 5; i++) addSlot(hub, 'Holding');           // 3 of 5 may be used
  addCharger(hub);
  const shared = sharedAtHub(hub, 70);
  runScheduler(hub); finishMoves();
  createBooking({ user: addUser('Student'), vehicleId: shared.id, pickupInMinutes: 30 }); // booked: it cannot be displaced
  let refused = 0;
  for (let i = 0; i < 4; i++) {
    const student = addUser('Student');
    const car = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 20 });
    try { createPersonalChargingRequest({ user: student, vehicleId: car.id, hubId: hub, batteryLevel: 20, nextRequiredUsageAt: later(1) }); }
    catch (error) { assert.equal(error.status, 409); assert.match(error.message, /Holding/); refused++; }
  }
  assert.equal(refused, 1);
});

test('A personal vehicle that is not collected 5 minutes after 100% is moved to Holding (a warning, no points)', () => {
  const student = addUser('Student');
  const hub = makeHub();
  addSlot(hub, 'Holding');
  const charger = addCharger(hub);
  const car = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 80 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: car.id, hubId: hub, batteryLevel: 80, nextRequiredUsageAt: later(2) });
  assert.equal(request.status, 'Assigned');
  connectPersonalVehicle({ user: student, requestId: request.id });
  jump(25); runTimers();
  assert.ok(notificationKinds(student.id).includes('charging_pickup_notice'), 'told at 90%');
  jump(20); runTimers();
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Completed');
  const points = row('SELECT COUNT(*) AS n FROM violations WHERE user_id=?', student.id).n;
  jump(config.charging.pickupGraceMinutes + 1); runTimers();
  assert.equal(row('SELECT destination FROM move_vehicle_requests WHERE charging_request_id=? AND direction=?', request.id, 'FROM_CHARGER').destination, 'Holding');
  finishMoves(); jump(0.6); runTimers();
  assert.equal(row('SELECT status FROM vehicles WHERE id=?', car.id).status, 'Parked');
  assert.notEqual(row('SELECT status FROM chargers WHERE id=?', charger).status, 'Awaiting Removal');
  assert.equal(row('SELECT COUNT(*) AS n FROM violations WHERE user_id=?', student.id).n, points, 'no violation point is recorded');
});

/* ---------- Priority: slack-based urgency and the displacement margin (worst cases) ---------- */
test('Priority: urgency uses slack (time left minus charging time); a deadline that can still be missed by a little is class H, one that cannot be met is class X; no time = no urgency', () => {
  const at = minutes => new Date(clockNow() + minutes * 60000).toISOString();
  const base = { vehicle_type: 'Motorcycle', registered_at: nowIso() };
  // Motorcycle: reference charger 1 kW, 3.5 kWh, so 40% -> 100% takes 126 minutes and 90% -> 100% takes 21 minutes.
  const longJob = calculatePriority({ ...base, battery_level: 40, next_required_usage_at: at(150) });   // slack 24
  const shortJob = calculatePriority({ ...base, battery_level: 90, next_required_usage_at: at(60) });   // slack 39
  assert.ok(longJob.components.urgency > shortJob.components.urgency, 'the long job with little spare time is more urgent');
  assert.ok(Math.abs(longJob.components.slack - 24) < 0.5);
  const late = calculatePriority({ ...base, battery_level: 40, next_required_usage_at: at(120) });      // needs 126 min, has 120: late by 6, can still be saved
  assert.equal(late.cls, 'H');
  assert.equal(late.components.urgency, 100);
  const impossible = calculatePriority({ ...base, battery_level: 40, next_required_usage_at: at(60) });  // needs 126 min, has 60: late by 66
  assert.equal(impossible.cls, 'X', 'it cannot be saved any more');
  assert.equal(impossible.components.urgency, 100);
  assert.ok(impossible.components.slack < 0);
  const overdue = calculatePriority({ ...base, battery_level: 40, next_required_usage_at: at(-30) });   // time already passed
  assert.equal(overdue.cls, 'X');
  assert.ok(Number.isFinite(overdue.score) && overdue.components.urgency === 100);
  const unknown = calculatePriority({ ...base, battery_level: 40, next_required_usage_at: null });
  assert.equal(unknown.components.urgency, 0);
  assert.equal(unknown.components.slack, null);
  assert.equal(unknown.cls, 'L');
  const fullAlready = calculatePriority({ ...base, battery_level: 100, next_required_usage_at: at(1) });
  assert.equal(fullAlready.cls, 'L', 'a full vehicle is never class H');
  assert.ok(Number.isFinite(calculatePriority({ ...base, battery_level: 40, next_required_usage_at: at(130), vehicle_type: 'Unknown' }).score), 'an unknown vehicle type uses the default capacity');
});

test('Priority: a personal request that is only slightly ahead does not displace a charging shared vehicle', () => {
  const student = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 5; i++) addSlot(hub, 'Holding');
  const charger = addCharger(hub);
  const shared = sharedAtHub(hub, 50);
  runScheduler(hub); finishMoves();
  assert.equal(row('SELECT status FROM chargers WHERE id=?', charger).status, 'Charging');
  const personal = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 45 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: personal.id, hubId: hub, batteryLevel: 45, nextRequiredUsageAt: later(10) });
  assert.equal(request.status, 'Queued', 'the margin protects the running session');
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, shared.id).status, 'Charging');
});

test('Priority: a shared vehicle at 90% or more only uses idle time, so it gives way first; the 60% vehicle keeps charging', () => {
  const student = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 6; i++) addSlot(hub, 'Holding');
  const c1 = addCharger(hub); const c2 = addCharger(hub);
  const nearlyFull = sharedAtHub(hub, 92);
  const middle = sharedAtHub(hub, 60);
  runScheduler(hub); finishMoves();
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, nearlyFull.id).status, 'Charging');
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, middle.id).status, 'Charging');
  const personal = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 10 });
  createPersonalChargingRequest({ user: student, vehicleId: personal.id, hubId: hub, batteryLevel: 10, nextRequiredUsageAt: later(2.8) });
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, nearlyFull.id).status, 'Completed', 'the 92% vehicle stops');
  assert.ok(row('SELECT battery_level FROM vehicles WHERE id=?', nearlyFull.id).battery_level >= 92, 'it keeps the battery it has');
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, middle.id).status, 'Charging', 'the 60% vehicle keeps charging');
  assert.ok(c1 && c2);
});

test('Shared bands: a vehicle stops at 90% when another one needs the charger, and goes on to 100% when nobody waits', () => {
  const hub = makeHub();
  addCharger(hub);
  const first = sharedAtHub(hub, 70);
  runScheduler(hub); finishMoves();
  const second = sharedAtHub(hub, 80);                        // arrives later: it waits for the only charger
  jump(12); runTimers();                                       // 7.2 kW: about 3.4% per minute, the first vehicle passes 90%
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=? ORDER BY created_at`, first.id).status, 'Completed');
  assert.equal(row('SELECT battery_level FROM vehicles WHERE id=?', first.id).battery_level, 90, 'stopped at 90% for the waiting vehicle');
  finishMoves(); runScheduler(hub); finishMoves();
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, second.id).status, 'Charging');
  jump(4); runTimers();                                        // about 94%: the first vehicle is at 90%, so nobody waits
  assert.ok(row('SELECT battery_level FROM vehicles WHERE id=?', second.id).battery_level > 90);
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, second.id).status, 'Charging', 'past 90% it goes on');
  jump(3); runTimers();
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, second.id).status, 'Completed');
  assert.equal(row('SELECT battery_level FROM vehicles WHERE id=?', second.id).battery_level, 100);
});

test('Shared bands: a vehicle below 60% takes the charger of a vehicle that only uses idle time', () => {
  const hub = makeHub();
  addCharger(hub);
  const topUp = sharedAtHub(hub, 75);
  runScheduler(hub); finishMoves();
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, topUp.id).status, 'Charging');
  const low = sharedAtHub(hub, 30);
  runScheduler(hub);
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, topUp.id).status, 'Completed', 'the 75% vehicle gives way');
  finishMoves(); runScheduler(hub); finishMoves();
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=? ORDER BY created_at DESC`, low.id).status, 'Charging');
});

test('Shared bands: a vehicle below 60% does not take the charger of another mandatory vehicle', () => {
  const hub = makeHub();
  addCharger(hub);
  const first = sharedAtHub(hub, 40);
  runScheduler(hub); finishMoves();
  sharedAtHub(hub, 20);
  runScheduler(hub);
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, first.id).status, 'Charging');
});

test('Shared bands: a vehicle at 60% or more rests 10 minutes after it left a charger; the 90-100% band waits for the lower ones', () => {
  const hub = makeHub();
  addCharger(hub);
  const v = sharedAtHub(hub, 70);
  runScheduler(hub); finishMoves();
  const other = sharedAtHub(hub, 85);
  jump(12); runTimers(); finishMoves();                       // v stops at 90% for the waiting vehicle and is moved away
  runScheduler(hub); finishMoves();
  assert.equal(row(`SELECT status FROM charging_requests WHERE vehicle_id=?`, other.id).status, 'Charging');
  jump(5); runTimers(); finishMoves(); runScheduler(hub);     // the other one reached 100% (about 4.4 min); v still rests
  assert.equal(row(`SELECT COUNT(*) AS n FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging')`, v.id).n, 0);
  jump(4); runTimers(); runScheduler(hub);                     // rest is over and the charger is free: v tops up to 100%
  assert.equal(row(`SELECT COUNT(*) AS n FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging')`, v.id).n, 1);
});

test('Priority: a vehicle that cannot be saved (class X) is ranked behind the others and does not displace anyone', () => {
  const student = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 6; i++) addSlot(hub, 'Holding');
  const charger = addCharger(hub);
  // Only one charger. A cannot be ready in time (needs 147 min, has 5), B can still make it (needs 42 min, has 60).
  const a = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 30 });
  const bOwner = addUser('Student');
  const b = addVehicle({ kind: 'personal', hubId: hub, ownerId: bOwner.id, battery: 80 });
  const busy = addVehicle({ kind: 'personal', hubId: hub, ownerId: addUser('Student').id, battery: 50 });
  const first = createPersonalChargingRequest({ user: db.prepare('SELECT * FROM users WHERE id=?').get(busy.owner_id), vehicleId: busy.id, hubId: hub, batteryLevel: 50, nextRequiredUsageAt: later(10) });
  assert.equal(first.status, 'Assigned');
  const ra = createPersonalChargingRequest({ user: student, vehicleId: a.id, hubId: hub, batteryLevel: 30, nextRequiredUsageAt: later(5 / 60) });
  const rb = createPersonalChargingRequest({ user: bOwner, vehicleId: b.id, hubId: hub, batteryLevel: 80, nextRequiredUsageAt: later(60 / 60) });
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', ra.id).status, 'Queued', 'A is X and does not displace the vehicle that is charging');
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', rb.id).status, 'Queued');
  const ranked = rankQueue(hub);
  assert.equal(ranked[0].id, rb.id, 'B (not late) goes first');
  assert.equal(ranked[1].id, ra.id, 'A (cannot be saved) goes behind');
  assert.equal(ranked[1].cls, 'X');
  assert.ok(charger);
});

test('Priority: a class X vehicle is still charged when nobody else needs the charger', () => {
  const student = addUser('Student');
  const hub = makeHub();
  const charger = addCharger(hub);
  const car = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 30 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: car.id, hubId: hub, batteryLevel: 30, nextRequiredUsageAt: later(5 / 60) }); // needs 147 min, has 5
  assert.equal(calculatePriority({ battery_level: 30, vehicle_type: 'Motorcycle', next_required_usage_at: later(5 / 60), registered_at: nowIso() }).cls, 'X');
  assert.equal(request.status, 'Assigned');
  assert.equal(row('SELECT charger_id FROM charging_requests WHERE id=?', request.id).charger_id, charger);
});

test('Class X: a personal vehicle that cannot be ready in time still takes the charger of a shared vehicle nobody has scheduled', () => {
  const student = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 6; i++) addSlot(hub, 'Holding');
  addCharger(hub);
  const shared = sharedAtHub(hub, 50);
  runScheduler(hub);
  const sharedRequest = row('SELECT * FROM charging_requests WHERE vehicle_id=?', shared.id);
  assert.ok(['Assigned', 'Charging'].includes(sharedRequest.status));
  const bike = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 15 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: bike.id, hubId: hub, batteryLevel: 15, nextRequiredUsageAt: later(1) }); // needs 178 min, has 60: class X
  assert.equal(calculatePriority({ battery_level: 15, vehicle_type: 'Motorcycle', next_required_usage_at: later(1), registered_at: nowIso() }).cls, 'X');
  assert.equal(request.status, 'Assigned', 'the unscheduled shared vehicle gives way');
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', sharedRequest.id).status, 'Cancelled');
});

test('Class X: a shared vehicle that has a Next Required Usage Time is not displaced', () => {
  const student = addUser('Student');
  const hub = makeHub();
  for (let i = 0; i < 6; i++) addSlot(hub, 'Holding');
  addCharger(hub);
  const shared = sharedAtHub(hub, 50);
  runScheduler(hub);
  db.prepare('UPDATE charging_requests SET next_required_usage_at=? WHERE vehicle_id=?').run(later(6), shared.id);
  const bike = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 15 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: bike.id, hubId: hub, batteryLevel: 15, nextRequiredUsageAt: later(1) });
  assert.equal(request.status, 'Queued');
});

test('Preview before joining: tells at once whether the request would be class X and suggests a later time', () => {
  const hub = makeHub();
  const tight = previewPersonalCharging({ hubId: hub, batteryLevel: 15, nextRequiredUsageAt: later(1) });
  assert.equal(tight.willBeClassX, true);
  assert.ok(tight.chargeMinutesNeeded >= 170 && tight.chargeMinutesNeeded <= 185);
  assert.ok(Date.parse(tight.earliestUseAt) >= clockNow() + tight.chargeMinutesNeeded * 60000 - 60000);
  const roomy = previewPersonalCharging({ hubId: hub, batteryLevel: 15, nextRequiredUsageAt: later(5) });
  assert.equal(roomy.willBeClassX, false);
  fail(() => previewPersonalCharging({ hubId: hub, batteryLevel: 150, nextRequiredUsageAt: later(1) }), 400);
});

/* ---------- Motorcycles only, pickup message on a clock jump, parking limit ---------- */
test('Only motorcycles are accepted: Car is refused for personal and shared vehicles', () => {
  const admin = addUser('Admin');
  const student = addUser('Student');
  const hub = makeHub();
  addSlot(hub, 'Shared');
  fail(() => createPersonalVehicle({ user: student, plate: '59B-123.45', vehicleType: 'Car', connectorType: 'Type2', hubId: hub }), 400);
  fail(() => addSharedVehicle({ user: admin, hubId: hub, plate: 'CAR-0002', vehicleType: 'Car', connectorType: 'Type2' }), 400);
  const ok = createPersonalVehicle({ user: student, plate: '59A-123.45', hubId: hub }); // type and connector default
  assert.equal(ok.vehicle_type, 'Motorcycle');
  assert.equal(ok.connector_type, 'Type2');
  assert.deepEqual(db.prepare(`SELECT DISTINCT vehicle_type FROM vehicles WHERE id LIKE 'vehicle-%' OR kind='shared' AND id NOT LIKE 'test-%'`).all().map(r => r.vehicle_type), ['Motorcycle']);
});

test('A personal vehicle needs a Vietnamese motorcycle plate; the plate is stored in the standard form', () => {
  const student = addUser('Student');
  const hub = makeHub();
  addSlot(hub, 'Shared');
  // accepted forms, with or without dash, dot, spaces, in lower case
  assert.equal(normalizeVnMotorcyclePlate('59a12345'), '59A-123.45');
  assert.equal(normalizeVnMotorcyclePlate(' 62an-116.30 '), '62AN-116.30');
  assert.equal(normalizeVnMotorcyclePlate('59X1 123.45'), '59X1-123.45');
  // refused: wrong shape, province below 11, letters that are not used, all zeros, too short or too long
  for (const bad of ['', 'ABC', 'MOTO-0001', '10A-123.45', '59I-123.45', '59A-000.00', '59A-1234', '59A-123.456', '5A-123.45', '59AAA-123.45']) {
    assert.equal(normalizeVnMotorcyclePlate(bad), null, bad);
  }
  fail(() => createPersonalVehicle({ user: student, plate: 'MOTO-0001', hubId: hub }), 400);
  assert.equal(createPersonalVehicle({ user: student, plate: '51d12345', hubId: hub }).plate, '51D-123.45');
});

test('The 90% message is sent even when a clock jump goes past 90% to the end in one step', () => {
  const student = addUser('Student');
  const hub = makeHub();
  addCharger(hub);
  const car = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 50 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: car.id, hubId: hub, batteryLevel: 50, nextRequiredUsageAt: later(3) });
  connectPersonalVehicle({ user: student, requestId: request.id });
  jump(30); runTimers();                      // 50% -> 100% in a single step
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Completed');
  const kinds = notificationKinds(student.id);
  assert.ok(kinds.includes('charging_pickup_notice'), 'the 90% message was sent');
  assert.ok(kinds.includes('charging_complete'));
  runTimers();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND kind='charging_pickup_notice'`).get(student.id).n, 1, 'sent only once');
});

test('Parking: at most 8 hours, and the stay must end the same day before the Hub closes', () => {
  const student = addUser('Student');
  const hub = makeHub();                       // open 00:00-23:59
  const slots = [addSlot(hub, 'Personal'), addSlot(hub, 'Personal'), addSlot(hub, 'Personal')];
  const car = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 60 });
  // Put the demo clock at 20:00 Vietnam time (UTC+7) so that the periods below are deterministic.
  const vnMinutes = (Math.floor(clockNow() / 60000) + 7 * 60) % (24 * 60);
  jump(((20 * 60 - vnMinutes) + 24 * 60) % (24 * 60) || 24 * 60);
  const at = minutes => new Date(clockNow() + minutes * 60000).toISOString();
  const book = (slotId, from, to) => createReservation({ user: student, vehicleId: car.id, hubId: hub, slotId, startAt: at(from), endAt: at(to) });
  fail(() => book(slots[0], 10, 10 + 9 * 60), 400);          // 9 hours is too long
  fail(() => book(slots[0], 10, 10 + 4 * 60 + 5), 400);      // 20:10 -> 00:15 crosses midnight
  const ok = book(slots[0], 10, 10 + 3 * 60);                // 20:10 -> 23:10
  assert.equal(ok.status, 'Confirmed');
});

test('Demo data: chargers and Hub Power Limits come from the configuration and charging takes about 3.5 hours', () => {
  const power = config.demoData.seedChargerPowerKw;
  assert.equal(power, 1);
  assert.deepEqual(db.prepare(`SELECT DISTINCT power_kw FROM chargers WHERE id LIKE 'hub-%'`).all().map(r => r.power_kw), [power]);
  for (const [hub, kw] of Object.entries(config.demoData.seedHubPowerLimitsKw)) {
    assert.equal(row('SELECT power_limit_kw FROM hubs WHERE id=?', hub).power_limit_kw, kw);
  }
  const student = addUser('Student');
  const hub = makeHub();
  addCharger(hub, power);
  const moto = addVehicle({ kind: 'personal', hubId: hub, ownerId: student.id, battery: 50 });
  const request = createPersonalChargingRequest({ user: student, vehicleId: moto.id, hubId: hub, batteryLevel: 50, nextRequiredUsageAt: later(6) });
  connectPersonalVehicle({ user: student, requestId: request.id });
  jump(60); runTimers();                         // 1 kW into 3.5 kWh: about 29 points per hour
  const mid = row('SELECT battery_level FROM vehicles WHERE id=?', moto.id).battery_level;
  assert.ok(mid >= 77 && mid <= 80, `battery was ${mid}`);
  jump(50); runTimers();                         // 50% -> 100% takes about 105 minutes in total
  assert.equal(row('SELECT status FROM charging_requests WHERE id=?', request.id).status, 'Completed');
  assert.ok(notificationKinds(student.id).includes('charging_pickup_notice'));
});
