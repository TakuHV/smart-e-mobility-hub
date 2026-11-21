import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, transaction, makeId, nowIso, projectRoot } from '../database/db.js';
import { HttpError, requireValue, isStudentSuspended, auditChange, addViolation, inHubOperatingHours } from './commonService.js';

const config = JSON.parse(readFileSync(resolve(projectRoot, 'data/configuration.json'), 'utf8'));
const CHARGE_TARGET = config.charging.targetBatteryPercent;
const CONNECT_MINUTES = config.charging.personalConnectWindowMinutes;

function localDayRange() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = new Date(`${parts}T00:00:00+07:00`).toISOString();
  const end = new Date(new Date(`${parts}T00:00:00+07:00`).getTime() + 24 * 3600000).toISOString();
  return { start, end };
}

export function enqueueSharedVehicle(vehicleId, hubId) {
  const active = db.prepare(`SELECT id FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging')`).get(vehicleId);
  if (active) return active.id;
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=? AND kind=\'shared\'').get(vehicleId);
  if (!vehicle) return null;
  const now = nowIso();
  const requestId = makeId('charge');
  const nextUse = vehicle.next_required_usage_at || new Date(Date.now() + 4 * 3600000).toISOString();
  db.prepare(`INSERT INTO charging_requests
    (id, user_id, vehicle_id, hub_id, request_type, status, battery_level, next_required_usage_at,
     registered_at, estimated_start_at, created_at)
    VALUES (?, NULL, ?, ?, 'shared_automatic', 'Queued', ?, ?, ?, ?, ?)`)
    .run(requestId, vehicleId, hubId, vehicle.battery_level, nextUse, now, now, now);
  auditChange('ChargingRequest', requestId, 'SHARED_VEHICLE_AUTO_QUEUED', { vehicleId, hubId }, 'system');
  return requestId;
}

function calculatePriority(request, nowMs, availablePowerRatio) {
  const weights = config.charging.schedulerWeights;
  const battery = Math.max(0, Math.min(1, (100 - Number(request.battery_level)) / 100));
  const hoursToRequiredUse = (new Date(request.next_required_usage_at).getTime() - nowMs) / 3600000;
  const nextUseUrgency = Math.max(0, Math.min(1, (12 - hoursToRequiredUse) / 12)); // demo normalization horizon
  const waitingMinutes = Math.max(0, (nowMs - new Date(request.registered_at).getTime()) / 60000);
  const waiting = Math.max(0, Math.min(1, waitingMinutes / 120)); // demo normalization horizon
  const powerHeadroom = Math.max(0, Math.min(1, availablePowerRatio));
  const totalWeight = weights.batteryLevel + weights.nextRequiredUsageTime + weights.waitingDuration + weights.hubPowerLimit;
  const score = (battery * weights.batteryLevel
    + nextUseUrgency * weights.nextRequiredUsageTime
    + waiting * weights.waitingDuration
    + powerHeadroom * weights.hubPowerLimit) / totalWeight;
  return { score, components: { battery, nextUseUrgency, waiting, powerHeadroom } };
}

function estimateQueueTimes(hubId) {
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  if (!hub) return;
  const queued = db.prepare(`SELECT * FROM charging_requests WHERE hub_id=? AND status='Queued' ORDER BY registered_at`).all(hubId);
  const busy = db.prepare(`SELECT c.*, r.charging_started_at FROM chargers c
    LEFT JOIN charging_requests r ON r.charger_id=c.id AND r.status='Charging'
    WHERE c.hub_id=? AND c.status IN ('Assigned','Charging','Awaiting Removal') ORDER BY c.code`).all(hubId);
  const demoSessionMinutes = Number(config.charging.demoAssumptions.estimatedSessionMinutes || 45);
  const base = Date.now() + busy.filter(x => x.status === 'Awaiting Removal').length * 5 * 60000;
  queued.forEach((request, index) => {
    const estimated = new Date(base + (index + 1) * demoSessionMinutes * 60000).toISOString();
    db.prepare('UPDATE charging_requests SET estimated_start_at=? WHERE id=?').run(estimated, request.id);
  });
}

export function runScheduler(hubId = null, responsibleUser = 'system') {
  const hubs = hubId ? [db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId)].filter(Boolean) : db.prepare('SELECT * FROM hubs').all();
  const assigned = [];
  for (const hub of hubs) {
    const activePowerRow = db.prepare(`SELECT COALESCE(SUM(c.power_kw),0) AS kw FROM chargers c
      WHERE c.hub_id=? AND c.status IN ('Assigned','Charging')`).get(hub.id);
    let activePower = Number(activePowerRow.kw || 0);
    const freeChargers = db.prepare(`SELECT * FROM chargers WHERE hub_id=? AND status='Available' ORDER BY power_kw, code`).all(hub.id);
    const queue = db.prepare(`SELECT r.*, v.connector_type, v.plate, v.kind, v.status AS vehicle_status
      FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
      WHERE r.hub_id=? AND r.status='Queued' ORDER BY r.registered_at`).all(hub.id);
    const nowMs = Date.now();
    const powerRatio = hub.power_limit_kw > 0 ? Math.max(0, (hub.power_limit_kw - activePower) / hub.power_limit_kw) : 0;
    const ranked = queue.map(r => ({ ...r, ...calculatePriority(r, nowMs, powerRatio) }))
      .sort((a, b) => b.score - a.score || a.registered_at.localeCompare(b.registered_at));

    for (const request of ranked) {
      const chargerIndex = freeChargers.findIndex(charger =>
        JSON.parse(charger.connector_types_json).includes(request.connector_type)
        && activePower + charger.power_kw <= hub.power_limit_kw + 1e-6);
      if (chargerIndex < 0) continue;
      const charger = freeChargers.splice(chargerIndex, 1)[0];
      const now = nowIso();
      const deadline = request.request_type === 'personal'
        ? new Date(Date.now() + CONNECT_MINUTES * 60000).toISOString() : null;
      transaction(() => {
        db.prepare(`UPDATE chargers SET status='Assigned', current_vehicle_id=?, updated_at=? WHERE id=? AND status='Available'`)
          .run(request.vehicle_id, now, charger.id);
        db.prepare(`UPDATE charging_requests SET status='Assigned', charger_id=?, assigned_at=?, connect_deadline=?, priority_score=? WHERE id=? AND status='Queued'`)
          .run(charger.id, now, deadline, request.score, request.id);
        if (request.kind === 'shared') {
          const moveId = makeId('move');
          db.prepare(`INSERT INTO move_vehicle_requests
            (id,charging_request_id,vehicle_id,charger_id,direction,status,requested_at,note)
            VALUES (?,?,?,?, 'TO_CHARGER','Requested',?,?)`)
            .run(moveId, request.id, request.vehicle_id, charger.id, now, 'Field Staff moves the shared vehicle to its assigned charger (BR-46).');
        }
        auditChange('ChargingRequest', request.id, 'CHARGER_ASSIGNED',
          { chargerId: charger.id, priorityScore: request.score, deadline }, responsibleUser);
      });
      activePower += charger.power_kw;
      assigned.push({ requestId: request.id, chargerId: charger.id, vehicleId: request.vehicle_id, connectDeadline: deadline });
    }
    estimateQueueTimes(hub.id);
  }
  return { assigned, note: 'Power limit and connector compatibility were enforced for every assignment.' };
}

export function createPersonalChargingRequest({ user, vehicleId, hubId, batteryLevel, nextRequiredUsageAt }) {
  requireValue(user?.role === 'Student', 403, 'Only students can register a personal charging request.');
  requireValue(!isStudentSuspended(user.id), 403, 'Your account is suspended from creating charging requests.');
  const vehicle = db.prepare(`SELECT * FROM vehicles WHERE id=? AND kind='personal' AND owner_id=?`).get(vehicleId, user.id);
  requireValue(vehicle, 404, 'Choose one of your registered personal vehicles.');
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  requireValue(hub && hub.status === 'Open', 404, 'The selected Hub is not available.');
  const battery = Number(batteryLevel);
  requireValue(Number.isInteger(battery) && battery >= 0 && battery <= 100, 400, 'Battery level must be between 0 and 100.');
  const nextUse = new Date(nextRequiredUsageAt);
  requireValue(Number.isFinite(nextUse.getTime()) && nextUse.getTime() > Date.now(), 400, 'Next Required Usage Time must be in the future.');
  const registrationTime = nowIso();
  requireValue(inHubOperatingHours(hub, registrationTime, nextUse.toISOString()), 400,
    `The charging period must be inside Hub operating hours (${hub.open_time}–${hub.close_time}, BR-42).`);
  const hubChargers = db.prepare(`SELECT connector_types_json FROM chargers WHERE hub_id=? AND status NOT IN ('Out of Service','Status Unknown')`).all(hubId);
  const hasCompatibleCharger = hubChargers.some(charger => JSON.parse(charger.connector_types_json).includes(vehicle.connector_type));
  requireValue(hasCompatibleCharger, 409, 'No compatible charger is configured at this Hub (BR-16 / BR-41).');
  requireValue(vehicle.hub_id === hubId, 400, 'The personal vehicle must be at the selected Hub before registering a request.');
  requireValue(['Available','Parked','Needs Charging'].includes(vehicle.status), 409, 'The personal vehicle is not currently eligible for a charging request.');

  const { start, end } = localDayRange();
  const daily = db.prepare(`SELECT COUNT(*) AS count FROM charging_requests r
    WHERE r.vehicle_id=? AND r.request_type='personal' AND r.registered_at>=? AND r.registered_at<?`).get(vehicleId, start, end);
  requireValue(daily.count < config.charging.personalRequestsPerVehiclePerDay, 409,
    `This vehicle has reached the daily limit of ${config.charging.personalRequestsPerVehiclePerDay} personal charging requests (BR-45).`);
  const parkingConflict = db.prepare(`SELECT id FROM parking_reservations
    WHERE vehicle_id=? AND status IN ('Confirmed','In Progress') AND start_at < ? AND end_at > ?`)
    .get(vehicleId, nextUse.toISOString(), nowIso());
  requireValue(!parkingConflict, 409, 'The charging period overlaps an active parking reservation for this vehicle (BR-24).');
  const active = db.prepare(`SELECT id FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging')`).get(vehicleId);
  requireValue(!active, 409, 'This vehicle already has an active charging request.');
  const now = nowIso();
  const id = makeId('charge');
  transaction(() => {
    db.prepare(`INSERT INTO charging_requests
      (id,user_id,vehicle_id,hub_id,request_type,status,battery_level,next_required_usage_at,registered_at,created_at)
      VALUES (?,?,?,?, 'personal','Queued',?,?,?,?)`)
      .run(id, user.id, vehicleId, hubId, battery, nextUse.toISOString(), now, now);
    db.prepare(`UPDATE vehicles SET battery_level=?, status='Needs Charging', next_required_usage_at=?, updated_at=? WHERE id=?`)
      .run(battery, nextUse.toISOString(), now, vehicleId);
    auditChange('ChargingRequest', id, 'PERSONAL_CHARGING_REQUEST_QUEUED', { battery, nextRequiredUsageAt: nextUse.toISOString() }, user.id);
  });
  runScheduler(hubId, 'system');
  return db.prepare('SELECT * FROM charging_requests WHERE id=?').get(id);
}

export function listChargingData(user) {
  const studentFilter = user.role === 'Student' ? 'AND (r.user_id=? OR r.request_type=\'shared_automatic\')' : '';
  const requestSql = `SELECT r.*, v.plate, v.kind, v.connector_type, h.name AS hub_name, c.code AS charger_code
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id JOIN hubs h ON h.id=r.hub_id
    LEFT JOIN chargers c ON c.id=r.charger_id WHERE 1=1 ${studentFilter}
    ORDER BY CASE r.status WHEN 'Charging' THEN 1 WHEN 'Assigned' THEN 2 WHEN 'Queued' THEN 3 ELSE 4 END,
      r.priority_score DESC, r.registered_at`;
  const requests = user.role === 'Student' ? db.prepare(requestSql).all(user.id) : db.prepare(requestSql).all();
  const chargers = db.prepare(`SELECT c.*, h.name AS hub_name, v.plate AS vehicle_plate
    FROM chargers c JOIN hubs h ON h.id=c.hub_id LEFT JOIN vehicles v ON v.id=c.current_vehicle_id
    ORDER BY h.name,c.code`).all();
  const movesSql = `SELECT m.*, v.plate, c.code AS charger_code, h.name AS hub_name
    FROM move_vehicle_requests m JOIN vehicles v ON v.id=m.vehicle_id
    JOIN chargers c ON c.id=m.charger_id JOIN hubs h ON h.id=c.hub_id
    ${user.role === 'Student' ? 'WHERE v.owner_id=? OR v.kind="shared"' : ''}
    ORDER BY m.requested_at DESC LIMIT 100`;
  const moveRequests = user.role === 'Student' ? db.prepare(movesSql).all(user.id) : db.prepare(movesSql).all();
  return { requests, chargers, moveRequests };
}

export function connectPersonalVehicle({ user, requestId }) {
  const request = db.prepare(`SELECT r.*, v.owner_id, v.kind, c.status AS charger_status
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    JOIN chargers c ON c.id=r.charger_id WHERE r.id=?`).get(requestId);
  requireValue(request, 404, 'Charging request or charger assignment not found.');
  requireValue(request.request_type === 'personal' && request.owner_id === user.id, 403,
    'Only the owner can confirm connection of a personal vehicle.');
  requireValue(request.status === 'Assigned' && request.charger_status === 'Assigned', 409, 'This request is not waiting for connection.');
  requireValue(request.connect_deadline && Date.now() <= new Date(request.connect_deadline).getTime(), 409,
    'The 15-minute connection window has elapsed.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE charging_requests SET status='Charging', charging_started_at=? WHERE id=?`).run(now, requestId);
    db.prepare(`UPDATE chargers SET status='Charging', updated_at=? WHERE id=?`).run(now, request.charger_id);
    db.prepare(`UPDATE vehicles SET status='Charging', updated_at=? WHERE id=?`).run(now, request.vehicle_id);
    auditChange('ChargingRequest', requestId, 'PERSONAL_VEHICLE_CONNECTED', { chargerId: request.charger_id }, user.id);
  });
  return db.prepare('SELECT * FROM charging_requests WHERE id=?').get(requestId);
}

export function completeCharging({ user, requestId, finalBatteryLevel = CHARGE_TARGET }) {
  requireValue(['Operator','Admin','Student'].includes(user?.role), 403, 'This action is not available for this role.');
  const request = db.prepare(`SELECT r.*, v.owner_id, v.kind, c.status AS charger_status
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    JOIN chargers c ON c.id=r.charger_id WHERE r.id=?`).get(requestId);
  requireValue(request, 404, 'Charging request not found.');
  requireValue(request.status === 'Charging' && request.charger_status === 'Charging', 409, 'Only an active charging session can be completed.');
  requireValue(user.role !== 'Student' || request.owner_id === user.id, 403, 'Only the owner can complete this charging session.');
  const battery = Number(finalBatteryLevel);
  requireValue(Number.isInteger(battery) && battery >= CHARGE_TARGET && battery <= 100, 400, `Charging can be completed when the target battery level (${CHARGE_TARGET}%) is reached in this MVP.`);
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE charging_requests SET status='Completed', charging_completed_at=? WHERE id=?`).run(now, requestId);
    db.prepare(`UPDATE chargers SET status='Awaiting Removal', updated_at=? WHERE id=?`).run(now, request.charger_id);
    db.prepare(`UPDATE vehicles SET battery_level=?, status='Charging', updated_at=? WHERE id=?`).run(battery, now, request.vehicle_id);
    const moveId = makeId('move');
    db.prepare(`INSERT INTO move_vehicle_requests
      (id,charging_request_id,vehicle_id,charger_id,direction,status,requested_at,note)
      VALUES (?,?,?,?,'FROM_CHARGER','Requested',?,?)`)
      .run(moveId, requestId, request.vehicle_id, request.charger_id, now, 'Charging completed; vehicle must be moved away before the charger is released (BR-46).');
    auditChange('ChargingRequest', requestId, 'CHARGING_COMPLETED', { finalBatteryLevel: battery, moveRequestId: moveId }, user.id);
  });
  return { request: db.prepare('SELECT * FROM charging_requests WHERE id=?').get(requestId),
    moveRequest: db.prepare('SELECT * FROM move_vehicle_requests WHERE charging_request_id=? AND direction=\'FROM_CHARGER\'').get(requestId) };
}

export function startMoveRequest({ user, moveRequestId }) {
  requireValue(['Operator','Admin'].includes(user?.role), 403, 'Only Operations staff can update a Move Vehicle Request.');
  const move = db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
  requireValue(move, 404, 'Move Vehicle Request not found.');
  requireValue(move.status === 'Requested', 409, 'Only a Requested Move Vehicle Request can start.');
  const now = nowIso();
  db.prepare(`UPDATE move_vehicle_requests SET status='In Progress', assigned_to=?, started_at=? WHERE id=?`)
    .run(user.id, now, moveRequestId);
  auditChange('MoveVehicleRequest', moveRequestId, 'MOVE_REQUEST_STARTED', {}, user.id);
  return db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
}

export function completeMoveRequest({ user, moveRequestId }) {
  requireValue(['Operator','Admin'].includes(user?.role), 403, 'Only Operations staff can complete a Move Vehicle Request.');
  const move = db.prepare(`SELECT m.*, r.status AS request_status, v.kind, v.battery_level
    FROM move_vehicle_requests m LEFT JOIN charging_requests r ON r.id=m.charging_request_id
    JOIN vehicles v ON v.id=m.vehicle_id WHERE m.id=?`).get(moveRequestId);
  requireValue(move, 404, 'Move Vehicle Request not found.');
  requireValue(move.status === 'In Progress' || move.status === 'Requested', 409, 'This Move Vehicle Request is not active.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE move_vehicle_requests SET status='Done', completed_at=?, assigned_to=COALESCE(assigned_to,?) WHERE id=?`)
      .run(now, user.id, moveRequestId);
    if (move.direction === 'TO_CHARGER') {
      if (move.kind === 'shared') {
        // BR-39: keep the vehicle's Shared slot reserved while the shared vehicle is charging.
        const heldSlot = db.prepare(`UPDATE parking_slots SET status='Reserved', updated_at=?
          WHERE current_vehicle_id=? AND slot_type='Shared' AND status='Occupied'`).run(now, move.vehicle_id);
        requireValue(heldSlot.changes === 1, 409,
          'The shared vehicle must have its Shared return slot recorded before moving to a charger (BR-39).');
      }
      db.prepare(`UPDATE chargers SET status='Charging', updated_at=? WHERE id=? AND status='Assigned'`).run(now, move.charger_id);
      db.prepare(`UPDATE charging_requests SET status='Charging', charging_started_at=? WHERE id=? AND status='Assigned'`)
        .run(now, move.charging_request_id);
      db.prepare(`UPDATE vehicles SET status='Charging', updated_at=? WHERE id=?`).run(now, move.vehicle_id);
    } else {
      // BR-46: charger becomes Available only after the removal request is Done.
      db.prepare(`UPDATE chargers SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=? AND status='Awaiting Removal'`)
        .run(now, move.charger_id);
      const vehicleStatus = move.kind === 'shared' ? (move.battery_level >= 20 ? 'Available' : 'Needs Charging') : 'Available';
      db.prepare(`UPDATE vehicles SET status=?, updated_at=? WHERE id=?`).run(vehicleStatus, now, move.vehicle_id);
      if (move.kind === 'shared') {
        // The Shared slot was held during charging; the vehicle now returns to that reserved slot.
        db.prepare(`UPDATE parking_slots SET status='Occupied', updated_at=?
          WHERE current_vehicle_id=? AND slot_type='Shared' AND status='Reserved'`).run(now, move.vehicle_id);
      }
      if (move.kind === 'shared' && move.battery_level < 20) enqueueSharedVehicle(move.vehicle_id,
        db.prepare('SELECT hub_id FROM vehicles WHERE id=?').get(move.vehicle_id).hub_id);
    }
    auditChange('MoveVehicleRequest', moveRequestId, 'MOVE_REQUEST_DONE', { direction: move.direction }, user.id);
  });
  runScheduler(null, user.id);
  return db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
}

export function cancelMoveRequest({ user, moveRequestId }) {
  requireValue(['Operator','Admin'].includes(user?.role), 403, 'Only Operations staff can cancel a Move Vehicle Request.');
  const move = db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
  requireValue(move, 404, 'Move Vehicle Request not found.');
  requireValue(move.status === 'Requested', 409, 'A move request can only be cancelled before movement starts.');
  requireValue(move.direction === 'TO_CHARGER', 409, 'A removal request cannot be cancelled until the vehicle is confirmed away from the charger.');
  transaction(() => {
    db.prepare(`UPDATE move_vehicle_requests SET status='Cancelled' WHERE id=?`).run(moveRequestId);
    db.prepare(`UPDATE chargers SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=? AND status='Assigned'`)
      .run(nowIso(), move.charger_id);
    db.prepare(`UPDATE charging_requests SET status='Queued', charger_id=NULL, assigned_at=NULL, connect_deadline=NULL WHERE id=? AND status='Assigned'`)
      .run(move.charging_request_id);
    auditChange('MoveVehicleRequest', moveRequestId, 'MOVE_REQUEST_CANCELLED', {}, user.id);
  });
  runScheduler(null, user.id);
  return db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
}

export function updateNextRequiredUsage({ user, requestId, nextRequiredUsageAt }) {
  requireValue(['Operator','Admin'].includes(user?.role), 403, 'Only Operations staff can adjust a shared-vehicle schedule.');
  const request = db.prepare(`SELECT r.*, v.kind FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id WHERE r.id=?`).get(requestId);
  requireValue(request && request.kind === 'shared', 404, 'Only shared-vehicle charging requests can be adjusted here.');
  requireValue(['Queued','Assigned'].includes(request.status), 409, 'This charging request can no longer be adjusted.');
  const time = new Date(nextRequiredUsageAt);
  requireValue(Number.isFinite(time.getTime()) && time.getTime() > Date.now(), 400, 'Next Required Usage Time must be in the future.');
  db.prepare('UPDATE charging_requests SET next_required_usage_at=? WHERE id=?').run(time.toISOString(), requestId);
  db.prepare('UPDATE vehicles SET next_required_usage_at=?, updated_at=? WHERE id=?').run(time.toISOString(), nowIso(), request.vehicle_id);
  auditChange('ChargingRequest', requestId, 'NEXT_REQUIRED_USAGE_UPDATED', { nextRequiredUsageAt: time.toISOString() }, user.id);
  runScheduler(request.hub_id, user.id);
  return db.prepare('SELECT * FROM charging_requests WHERE id=?').get(requestId);
}

export function runMaintenance() {
  const now = nowIso();
  let expiredBookings = 0, expiredParking = 0, expiredCharging = 0;
  transaction(() => {
    const bookings = db.prepare(`SELECT * FROM bookings WHERE status='Confirmed' AND pickup_deadline<=?`).all(now);
    for (const b of bookings) {
      db.prepare(`UPDATE bookings SET status='Expired' WHERE id=?`).run(b.id);
      db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, b.vehicle_id);
      addViolation(b.user_id, 1, 'Shared vehicle was not collected within the 15-minute pickup hold.', 'booking', b.id);
      auditChange('Booking', b.id, 'BOOKING_EXPIRED', {}, 'system');
      expiredBookings++;
    }
    const parks = db.prepare(`SELECT * FROM parking_reservations WHERE status='Confirmed' AND expires_at<=?`).all(now);
    for (const p of parks) {
      db.prepare(`UPDATE parking_reservations SET status='Expired' WHERE id=?`).run(p.id);
      db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, p.slot_id);
      addViolation(p.user_id, 1, 'Personal parking reservation was not used within the 15-minute arrival grace period.', 'parking', p.id);
      auditChange('ParkingReservation', p.id, 'PARKING_RESERVATION_EXPIRED', {}, 'system');
      expiredParking++;
    }
    const assigned = db.prepare(`SELECT r.*, v.owner_id FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
      WHERE r.status='Assigned' AND r.request_type='personal' AND r.connect_deadline<=?`).all(now);
    for (const r of assigned) {
      db.prepare(`UPDATE charging_requests SET status='Expired' WHERE id=?`).run(r.id);
      db.prepare(`UPDATE chargers SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=? AND status='Assigned'`).run(now, r.charger_id);
      db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=?`).run(now, r.vehicle_id);
      addViolation(r.owner_id, 1, 'Personal vehicle was not connected within 15 minutes after charger assignment.', 'charging', r.id);
      auditChange('ChargingRequest', r.id, 'PERSONAL_CHARGING_ASSIGNMENT_EXPIRED', {}, 'system');
      expiredCharging++;
    }
  });
  // Simulator refresh: status timestamp is refreshed without inventing changes to resource state (NI-02).
  db.prepare('UPDATE hubs SET sensor_updated_at=?').run(now);
  if (expiredBookings || expiredParking || expiredCharging) runScheduler();
  return { expiredBookings, expiredParking, expiredCharging };
}
