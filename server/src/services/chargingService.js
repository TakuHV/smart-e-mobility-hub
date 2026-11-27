import { db, transaction, makeId, nowIso } from '../database/db.js';
import { config } from '../config.js';
import { requireValue, isStudentSuspended, auditChange, addViolation, inHubOperatingHours } from './commonService.js';
import { now as clockNow } from '../clock.js';
import { notify, notifyOperators } from './notificationService.js';
import { chargedBattery, minutesToReach } from './batteryModel.js';

const MIN = 60000;


/*
 * Scheduler parameters.
 * Source: Technical Design Document, sections 2.2 and 2.3. All of these are PROPOSED VALUES,
 * not approved requirements. They are set in data/configuration.json under "charging.scheduler"
 * (defaults and validation: server/src/config.js).
 */
const SCHED = config.charging.scheduler; // validated, with defaults, in config.js

// Demo switch for NI-02: when the simulated feed is paused, hub data stops being refreshed and becomes Stale.
let simulatedSensorFeedEnabled = true;
export function setSimulatedSensorFeed(enabled) {
  simulatedSensorFeedEnabled = Boolean(enabled);
  return simulatedSensorFeedEnabled;
}
export const isSimulatedSensorFeedEnabled = () => simulatedSensorFeedEnabled;

// The last scheduler runs that did something (or were started by a person), newest first. Kept in memory for the demo screen.
const schedulerRuns = [];
export function recentSchedulerRuns(limit = 8) {
  return schedulerRuns.slice(0, limit);
}
function recordSchedulerRun(entry) {
  if (!entry.assigned && entry.trigger === 'system') return;
  schedulerRuns.unshift(entry);
  if (schedulerRuns.length > 20) schedulerRuns.length = 20;
}

// Thrown inside a transaction to roll it back when a row was changed by someone else.
class SchedulerSkip extends Error {}

function localDayRange() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clockNow()));
  const start = new Date(`${parts}T00:00:00+07:00`).toISOString();
  const end = new Date(new Date(`${parts}T00:00:00+07:00`).getTime() + 24 * 3600000).toISOString();
  return { start, end };
}

export function enqueueSharedVehicle(vehicleId, hubId) {
  const active = db.prepare(`SELECT id FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging')`).get(vehicleId);
  if (active) return active.id;
  const vehicle = db.prepare(`SELECT * FROM vehicles WHERE id=? AND kind='shared'`).get(vehicleId);
  if (!vehicle) return null;
  const now = nowIso();
  const requestId = makeId('charge');
  // OD-2: if the Operator has not entered a Next Required Usage Time, it stays NULL (urgency = 0).
  // No value is invented here. If charging_requests.next_required_usage_at is NOT NULL in schema.sql, make it nullable.
  const nextUse = vehicle.next_required_usage_at || null;
  db.prepare(`INSERT INTO charging_requests
    (id, user_id, vehicle_id, hub_id, request_type, status, battery_level, next_required_usage_at,
     registered_at, estimated_start_at, created_at)
    VALUES (?, NULL, ?, ?, 'shared_automatic', 'Queued', ?, ?, ?, ?, ?)`)
    .run(requestId, vehicleId, hubId, vehicle.battery_level, nextUse, now, now, now);
  auditChange('ChargingRequest', requestId, 'SHARED_VEHICLE_AUTO_QUEUED', { vehicleId, hubId }, 'system');
  return requestId;
}

/*
 * Priority of one queued request (Technical Design Document 2.2).
 * The Hub Power Limit is NOT a ranking criterion: it limits capacity in runScheduler().
 *   need    = 100 - battery level
 *   urgency = 100 * max(0, 1 - minutesUntilNextUse / horizon); 0 when the time is unknown (OD-2)
 *   waiting = min(100, minutesWaited / divisor)
 *   class H = battery below threshold, or next use within the window while battery is below the target
 */
export function calculatePriority(request, nowMs = clockNow()) {
  const battery = Number(request.battery_level);
  const hasUsageTime = Boolean(request.next_required_usage_at);
  const minutesToUse = hasUsageTime ? (Date.parse(request.next_required_usage_at) - nowMs) / 60000 : null;
  const minutesWaited = Math.max(0, (nowMs - Date.parse(request.registered_at)) / 60000);

  const need = 100 - battery;
  const urgency = hasUsageTime
    ? 100 * Math.min(1, Math.max(0, 1 - Math.max(0, minutesToUse) / SCHED.urgencyHorizonMinutes))
    : 0;
  const waiting = Math.min(100, minutesWaited / SCHED.waitingDivisorMinutes);
  const w = SCHED.weights;
  const score = w.need * need + w.urgency * urgency + w.waiting * waiting;

  const isClassH = battery < SCHED.classH.batteryBelowPercent
    || (hasUsageTime && minutesToUse <= SCHED.classH.usageWithinMinutes && battery < config.charging.targetBatteryPercent);
  return { cls: isClassH ? 'H' : 'L', score, components: { need, urgency, waiting } };
}

// Class H first, then by score (high to low).
// OD-2/OD-1: the last key is a deterministic TECHNICAL tie-break (vehicle id), not a business rule and not arrival order.
function compareRanked(a, b) {
  if (a.cls !== b.cls) return a.cls === 'H' ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  return String(a.vehicle_id).localeCompare(String(b.vehicle_id));
}

// One ranking used by BOTH the scheduler and the queue-time estimate.
export function rankQueue(hubId, nowMs = clockNow()) {
  const queue = db.prepare(`SELECT r.*, v.connector_type, v.plate, v.kind, v.status AS vehicle_status
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    WHERE r.hub_id=? AND r.status='Queued'`).all(hubId);
  return queue.map(r => ({ ...r, ...calculatePriority(r, nowMs) })).sort(compareRanked);
}

/*
 * Estimated start time (BR-43): follows the same ranking as the scheduler. Each charger becomes free when its running
 * session is expected to end; each ranked request takes the earliest compatible charger.
 * Simplification: the Hub Power Limit is not simulated into the future. This is an estimate, not a guarantee.
 */
function estimateQueueTimes(hubId, nowMs = clockNow()) {
  const ranked = rankQueue(hubId, nowMs);
  if (!ranked.length) return;
  const sessionMs = SCHED.estimatedSessionMinutes * 60000;
  const rows = db.prepare(`SELECT c.*, r.charging_started_at, r.assigned_at
    FROM chargers c
    LEFT JOIN charging_requests r ON r.charger_id=c.id AND r.status IN ('Assigned','Charging')
    WHERE c.hub_id=? AND c.status IN ('Available','Assigned','Charging','Awaiting Removal')`).all(hubId);
  const chargers = rows.map(c => {
    let freeAt = nowMs;
    if (c.status === 'Awaiting Removal') freeAt = nowMs + 5 * 60000;
    else if (c.status === 'Charging' && c.charging_started_at) freeAt = Date.parse(c.charging_started_at) + sessionMs;
    else if (c.status === 'Assigned' && c.assigned_at) freeAt = Date.parse(c.assigned_at) + sessionMs;
    return { connectors: JSON.parse(c.connector_types_json), freeAt: Math.max(nowMs, freeAt) };
  });
  const update = db.prepare('UPDATE charging_requests SET estimated_start_at=? WHERE id=?');
  for (const request of ranked) {
    const candidates = chargers.filter(c => c.connectors.includes(request.connector_type));
    if (!candidates.length) continue;
    const next = candidates.reduce((best, c) => (c.freeAt < best.freeAt ? c : best));
    update.run(new Date(next.freeAt).toISOString(), request.id);
    next.freeAt += sessionMs;
  }
}

export function runScheduler(hubId = null, responsibleUser = 'system') {
  const nowMs = clockNow();
  const hubs = hubId
    ? [db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId)].filter(Boolean)
    : db.prepare('SELECT * FROM hubs').all();
  const assigned = [];
  for (const hub of hubs) {
    const activePowerRow = db.prepare(`SELECT COALESCE(SUM(c.power_kw),0) AS kw FROM chargers c
      WHERE c.hub_id=? AND c.status IN ('Assigned','Charging')`).get(hub.id);
    let activePower = Number(activePowerRow.kw || 0);
    // Charger choice is deterministic (lowest power, then code); the documents do not define it.
    const freeChargers = db.prepare(`SELECT * FROM chargers WHERE hub_id=? AND status='Available' ORDER BY power_kw, code`).all(hub.id);

    for (const request of rankQueue(hub.id, nowMs)) {
      if (!freeChargers.length) break;
      // Capacity: the sum of the power of active chargers must stay within the Hub Power Limit.
      const chargerIndex = freeChargers.findIndex(charger =>
        JSON.parse(charger.connector_types_json).includes(request.connector_type)
        && activePower + charger.power_kw <= hub.power_limit_kw + 1e-6);
      if (chargerIndex < 0) continue;
      const charger = freeChargers.splice(chargerIndex, 1)[0];
      const now = nowIso();
      const deadline = request.request_type === 'personal'
        ? new Date(clockNow() + config.charging.personalConnectWindowMinutes * 60000).toISOString() : null;
      try {
        transaction(() => {
          const requestUpdate = db.prepare(`UPDATE charging_requests
            SET status='Assigned', charger_id=?, assigned_at=?, connect_deadline=?, priority_score=?
            WHERE id=? AND status='Queued'`).run(charger.id, now, deadline, request.score, request.id);
          if (requestUpdate.changes !== 1) throw new SchedulerSkip();
          const chargerUpdate = db.prepare(`UPDATE chargers SET status='Assigned', current_vehicle_id=?, updated_at=?
            WHERE id=? AND status='Available'`).run(request.vehicle_id, now, charger.id);
          if (chargerUpdate.changes !== 1) throw new SchedulerSkip(); // rolls back the request update too
          if (request.kind === 'shared') {
            const moveId = makeId('move');
            db.prepare(`INSERT INTO move_vehicle_requests
              (id,charging_request_id,vehicle_id,charger_id,direction,status,requested_at,note)
              VALUES (?,?,?,?, 'TO_CHARGER','Requested',?,?)`)
              .run(moveId, request.id, request.vehicle_id, charger.id, now, 'Field Staff moves the shared vehicle to its assigned charger (BR-46).');
          }
          auditChange('ChargingRequest', request.id, 'CHARGER_ASSIGNED',
            { chargerId: charger.id, priorityClass: request.cls, priorityScore: request.score, deadline }, responsibleUser);
        });
      } catch (error) {
        if (error instanceof SchedulerSkip) continue; // the row changed meanwhile; nothing was assigned
        throw error;
      }
      activePower += charger.power_kw;
      assigned.push({ requestId: request.id, chargerId: charger.id, vehicleId: request.vehicle_id, connectDeadline: deadline });
      if (request.request_type === 'personal' && request.user_id) {
        notify({ userId: request.user_id, kind: 'charging_assigned', entityType: 'ChargingRequest', entityId: request.id, severity: 'info',
          title: 'Charger assigned',
          message: `${charger.code} is assigned to ${request.plate}. Connect the vehicle within ${config.charging.personalConnectWindowMinutes} minutes.` });
      } else if (request.kind === 'shared') {
        notifyOperators({ kind: 'move_to_charger', entityType: 'ChargingRequest', entityId: request.id, severity: 'info',
          title: 'Move a shared vehicle to its charger', message: `Move ${request.plate} to ${charger.code}.` });
      }
    }
    estimateQueueTimes(hub.id, nowMs);
  }
  recordSchedulerRun({ at: nowIso(), hubId, assigned: assigned.length, trigger: responsibleUser === 'system' ? 'system' : 'manual' });
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
  requireValue(Number.isFinite(nextUse.getTime()) && nextUse.getTime() > clockNow(), 400, 'Next Required Usage Time must be in the future.');
  const registrationTime = nowIso();
  requireValue(inHubOperatingHours(hub, registrationTime, nextUse.toISOString()), 400,
    `The charging period must be inside Hub operating hours (${hub.open_time}–${hub.close_time}, BR-42).`);
  const hubChargers = db.prepare(`SELECT connector_types_json FROM chargers WHERE hub_id=? AND status NOT IN ('Out of Service','Status Unknown')`).all(hubId);
  const hasCompatibleCharger = hubChargers.some(charger => JSON.parse(charger.connector_types_json).includes(vehicle.connector_type));
  requireValue(hasCompatibleCharger, 409, 'No compatible charger is configured at this Hub (BR-16 / BR-41).');
  requireValue(vehicle.hub_id === hubId, 400, 'The personal vehicle must be at the selected Hub before registering a request.');
  requireValue(['Available', 'Parked', 'Needs Charging'].includes(vehicle.status), 409, 'The personal vehicle is not currently eligible for a charging request.');

  const id = makeId('charge');
  // The state-dependent checks run inside the same transaction as the insert, so they cannot go stale.
  transaction(() => {
    const { start, end } = localDayRange();
    const daily = db.prepare(`SELECT COUNT(*) AS count FROM charging_requests r
      WHERE r.vehicle_id=? AND r.request_type='personal' AND r.registered_at>=? AND r.registered_at<?`).get(vehicleId, start, end);
    requireValue(daily.count < config.charging.personalRequestsPerVehiclePerDay, 409,
      `This vehicle has reached the daily limit of ${config.charging.personalRequestsPerVehiclePerDay} personal charging requests.`);
    const parkingConflict = db.prepare(`SELECT id FROM parking_reservations
      WHERE vehicle_id=? AND status IN ('Confirmed','In Progress') AND start_at < ? AND end_at > ?`)
      .get(vehicleId, nextUse.toISOString(), nowIso());
    requireValue(!parkingConflict, 409, 'The charging period overlaps an active parking reservation for this vehicle (BR-24).');
    const active = db.prepare(`SELECT id FROM charging_requests WHERE vehicle_id=? AND status IN ('Queued','Assigned','Charging')`).get(vehicleId);
    requireValue(!active, 409, 'This vehicle already has an active charging request.');
    const now = nowIso();
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
  const studentFilter = user.role === 'Student' ? `AND (r.user_id=? OR r.request_type='shared_automatic')` : '';
  const requestSql = `SELECT r.*, v.plate, v.kind, v.connector_type, v.vehicle_type, v.battery_level AS vehicle_battery,
      h.name AS hub_name, c.code AS charger_code, c.power_kw AS charger_power_kw
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id JOIN hubs h ON h.id=r.hub_id
    LEFT JOIN chargers c ON c.id=r.charger_id WHERE 1=1 ${studentFilter}
    ORDER BY CASE r.status WHEN 'Charging' THEN 1 WHEN 'Assigned' THEN 2 WHEN 'Queued' THEN 3 ELSE 4 END,
      r.priority_score DESC, r.registered_at`;
  const rows = user.role === 'Student' ? db.prepare(requestSql).all(user.id) : db.prepare(requestSql).all();
  // Queued requests show their live class and score, in scheduler order; the stored score exists only after an assignment.
  const nowMs = clockNow();
  const ranked = new Map();
  for (const hubId of new Set(rows.filter(r => r.status === 'Queued').map(r => r.hub_id))) {
    rankQueue(hubId, nowMs).forEach((r, index) => ranked.set(r.id, { index, score: Math.round(r.score * 100) / 100, cls: r.cls }));
  }
  const statusOrder = { Charging: 1, Assigned: 2, Queued: 3 };
  const target = config.charging.targetBatteryPercent;
  // Running sessions: the live battery level and when the target is expected (the screen counts down to it).
  const withProgress = r => {
    if (r.status !== 'Charging' || !r.charger_power_kw) return r;
    const minutes = minutesToReach(target, r.vehicle_battery, r.charger_power_kw, r.vehicle_type);
    return { ...r, target_battery: target, eta_complete_at: new Date(nowMs + minutes * MIN).toISOString() };
  };
  const requests = rows
    .map(r => (ranked.has(r.id) ? { ...r, priority_score: ranked.get(r.id).score, priority_class: ranked.get(r.id).cls } : r))
    .map(withProgress)
    .sort((a, b) => (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
      || (a.status === 'Queued'
      ? String(a.hub_id).localeCompare(String(b.hub_id)) || ranked.get(a.id).index - ranked.get(b.id).index
      : 0));
  const chargers = db.prepare(`SELECT c.*, h.name AS hub_name, v.plate AS vehicle_plate
    FROM chargers c JOIN hubs h ON h.id=c.hub_id LEFT JOIN vehicles v ON v.id=c.current_vehicle_id
    ORDER BY h.name,c.code`).all();
  const movesSql = `SELECT m.*, v.plate, c.code AS charger_code, h.name AS hub_name
    FROM move_vehicle_requests m JOIN vehicles v ON v.id=m.vehicle_id
    JOIN chargers c ON c.id=m.charger_id JOIN hubs h ON h.id=c.hub_id
    ${user.role === 'Student' ? `WHERE v.owner_id=? OR v.kind='shared'` : ''}
    ORDER BY m.requested_at DESC LIMIT 100`;
  const moveRequests = user.role === 'Student' ? db.prepare(movesSql).all(user.id) : db.prepare(movesSql).all();
  return { requests, chargers, moveRequests, targetBatteryPercent: target };
}

export function connectPersonalVehicle({ user, requestId }) {
  const request = db.prepare(`SELECT r.*, v.owner_id, v.kind, c.status AS charger_status
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    JOIN chargers c ON c.id=r.charger_id WHERE r.id=?`).get(requestId);
  requireValue(request, 404, 'Charging request or charger assignment not found.');
  requireValue(request.request_type === 'personal' && request.owner_id === user.id, 403,
    'Only the owner can confirm connection of a personal vehicle.');
  requireValue(request.status === 'Assigned' && request.charger_status === 'Assigned', 409, 'This request is not waiting for connection.');
  requireValue(request.connect_deadline && clockNow() <= new Date(request.connect_deadline).getTime(), 409,
    'The 15-minute connection window has elapsed.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE charging_requests SET status='Charging', charging_started_at=?,
      start_battery=(SELECT battery_level FROM vehicles WHERE id=charging_requests.vehicle_id) WHERE id=?`).run(now, requestId);
    db.prepare(`UPDATE chargers SET status='Charging', updated_at=? WHERE id=?`).run(now, request.charger_id);
    db.prepare(`UPDATE vehicles SET status='Charging', updated_at=? WHERE id=?`).run(now, request.vehicle_id);
    auditChange('ChargingRequest', requestId, 'PERSONAL_VEHICLE_CONNECTED', { chargerId: request.charger_id }, user.id);
  });
  return db.prepare('SELECT * FROM charging_requests WHERE id=?').get(requestId);
}

export function completeCharging({ user, requestId, finalBatteryLevel = config.charging.targetBatteryPercent }) {
  requireValue(['Operator', 'Admin', 'Student'].includes(user?.role), 403, 'This action is not available for this role.');
  const request = db.prepare(`SELECT r.*, v.owner_id, v.kind, v.plate, c.status AS charger_status
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    JOIN chargers c ON c.id=r.charger_id WHERE r.id=?`).get(requestId);
  requireValue(request, 404, 'Charging request not found.');
  requireValue(request.status === 'Charging' && request.charger_status === 'Charging', 409, 'Only an active charging session can be completed.');
  requireValue(user.role !== 'Student' || request.owner_id === user.id, 403, 'Only the owner can complete this charging session.');
  // MVP simplification: the final battery level comes from the caller (in the demo it plays the role of the sensor reading).
  const battery = Number(finalBatteryLevel);
  const target = config.charging.targetBatteryPercent;
  requireValue(Number.isInteger(battery) && battery >= target && battery <= 100, 400, `Charging can be completed when the target battery level (${target}%) is reached in this MVP.`);
  finishCharging({ request, battery, actorId: user.id, reason: 'completed by user' });
  return {
    request: db.prepare('SELECT * FROM charging_requests WHERE id=?').get(requestId),
    moveRequest: db.prepare(`SELECT * FROM move_vehicle_requests WHERE charging_request_id=? AND direction='FROM_CHARGER'`).get(requestId)
  };
}

// Ends a running session: the charger waits for the vehicle to be moved away (BR-46). Used by people and by the timer.
function finishCharging({ request, battery, actorId, reason }) {
  const now = nowIso();
  transaction(() => {
    const updated = db.prepare(`UPDATE charging_requests SET status='Completed', charging_completed_at=? WHERE id=? AND status='Charging'`).run(now, request.id);
    if (updated.changes !== 1) return; // another cycle was faster
    db.prepare(`UPDATE chargers SET status='Awaiting Removal', updated_at=? WHERE id=?`).run(now, request.charger_id);
    db.prepare(`UPDATE vehicles SET battery_level=?, status='Charging', updated_at=? WHERE id=?`).run(battery, now, request.vehicle_id);
    const moveId = makeId('move');
    db.prepare(`INSERT INTO move_vehicle_requests
      (id,charging_request_id,vehicle_id,charger_id,direction,status,requested_at,note)
      VALUES (?,?,?,?,'FROM_CHARGER','Requested',?,?)`)
      .run(moveId, request.id, request.vehicle_id, request.charger_id, now, 'Charging completed; vehicle must be moved away before the charger is released (BR-46).');
    auditChange('ChargingRequest', request.id, 'CHARGING_COMPLETED', { finalBatteryLevel: battery, moveRequestId: moveId, reason }, actorId);
    if (request.kind === 'personal' && request.owner_id) {
      notify({ userId: request.owner_id, kind: 'charging_complete', entityType: 'ChargingRequest', entityId: request.id, severity: 'info',
        title: 'Charging finished', message: `${request.plate} reached ${battery}%. Please move it away so the charger can be released.` });
    } else {
      notifyOperators({ kind: 'charging_complete_ops', entityType: 'ChargingRequest', entityId: request.id, severity: 'info',
        title: 'Charging finished', message: `${request.plate} reached ${battery}%. Move it back to its Shared slot.` });
    }
  });
}

// Operations staff may update any Move Vehicle Request. The owner of a personal vehicle may update
// the requests of their own vehicle, because the owner moves a personal vehicle (BR-46, assumptions).
function loadMoveForActor(user, moveRequestId) {
  const move = db.prepare(`SELECT m.*, v.kind, v.owner_id, v.battery_level
    FROM move_vehicle_requests m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.id=?`).get(moveRequestId);
  requireValue(move, 404, 'Move Vehicle Request not found.');
  const isOperations = ['Operator', 'Admin'].includes(user?.role);
  const isOwner = user?.role === 'Student' && move.kind === 'personal' && move.owner_id === user.id;
  requireValue(isOperations || isOwner, 403,
    'Only Operations staff, or the owner of a personal vehicle for their own vehicle, can update a Move Vehicle Request.');
  return move;
}

export function startMoveRequest({ user, moveRequestId }) {
  const now = nowIso();
  transaction(() => {
    const move = loadMoveForActor(user, moveRequestId);
    requireValue(move.status === 'Requested', 409, 'Only a Requested Move Vehicle Request can start.');
    db.prepare(`UPDATE move_vehicle_requests SET status='In Progress', assigned_to=?, started_at=? WHERE id=?`)
      .run(user.id, now, moveRequestId);
    auditChange('MoveVehicleRequest', moveRequestId, 'MOVE_REQUEST_STARTED', {}, user.id);
  });
  return db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
}

export function completeMoveRequest({ user, moveRequestId }) {
  const now = nowIso();
  transaction(() => {
    const move = loadMoveForActor(user, moveRequestId);
    // Status model: Requested -> In Progress -> Done.
    requireValue(move.status === 'In Progress', 409, 'Only an In Progress Move Vehicle Request can be completed. Start it first.');

    // Validate first, write afterwards.
    let heldSlotId = null;
    if (move.direction === 'TO_CHARGER' && move.kind === 'shared') {
      const slot = db.prepare(`SELECT id FROM parking_slots
        WHERE current_vehicle_id=? AND slot_type='Shared' AND status='Occupied'`).get(move.vehicle_id);
      requireValue(slot, 409, 'The shared vehicle must have its Shared return slot recorded before moving to a charger (BR-39).');
      heldSlotId = slot.id;
    }

    db.prepare(`UPDATE move_vehicle_requests SET status='Done', completed_at=?, assigned_to=COALESCE(assigned_to,?) WHERE id=?`)
      .run(now, user.id, moveRequestId);

    if (move.direction === 'TO_CHARGER') {
      if (heldSlotId) {
        // BR-39: keep the vehicle's Shared slot reserved while the shared vehicle is charging.
        db.prepare(`UPDATE parking_slots SET status='Reserved', updated_at=? WHERE id=?`).run(now, heldSlotId);
      }
      db.prepare(`UPDATE chargers SET status='Charging', updated_at=? WHERE id=? AND status='Assigned'`).run(now, move.charger_id);
      db.prepare(`UPDATE charging_requests SET status='Charging', charging_started_at=?,
        start_battery=(SELECT battery_level FROM vehicles WHERE id=charging_requests.vehicle_id) WHERE id=? AND status='Assigned'`)
        .run(now, move.charging_request_id);
      db.prepare(`UPDATE vehicles SET status='Charging', updated_at=? WHERE id=?`).run(now, move.vehicle_id);
    } else {
      // BR-46: the charger becomes Available only after the removal request is Done.
      // A charger that failed meanwhile stays Out of Service; a normal one is released now.
      db.prepare(`UPDATE chargers SET status=CASE WHEN status='Awaiting Removal' THEN 'Available' ELSE status END,
        current_vehicle_id=NULL, updated_at=? WHERE id=?`).run(now, move.charger_id);
      const after = db.prepare('SELECT battery_level FROM vehicles WHERE id=?').get(move.vehicle_id);
      const lowBattery = after.battery_level < config.booking.minimumBatteryToBookPercent;
      db.prepare(`UPDATE vehicles SET status=?, updated_at=? WHERE id=?`).run(lowBattery ? 'Needs Charging' : 'Available', now, move.vehicle_id);
      if (lowBattery && move.kind === 'shared') {
        const chargerHub = db.prepare('SELECT hub_id FROM chargers WHERE id=?').get(move.charger_id);
        enqueueSharedVehicle(move.vehicle_id, chargerHub.hub_id);
      }
      if (move.kind === 'shared') {
        // The Shared slot was held during charging; the vehicle now returns to that reserved slot.
        db.prepare(`UPDATE parking_slots SET status='Occupied', updated_at=?
          WHERE current_vehicle_id=? AND slot_type='Shared' AND status='Reserved'`).run(now, move.vehicle_id);
      }
    }
    auditChange('MoveVehicleRequest', moveRequestId, 'MOVE_REQUEST_DONE', { direction: move.direction }, user.id);
  });
  runScheduler(null, user.id);
  return db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
}

export function cancelMoveRequest({ user, moveRequestId }) {
  requireValue(['Operator', 'Admin'].includes(user?.role), 403, 'Only Operations staff can cancel a Move Vehicle Request.');
  const move = db.prepare('SELECT * FROM move_vehicle_requests WHERE id=?').get(moveRequestId);
  requireValue(move, 404, 'Move Vehicle Request not found.');
  requireValue(move.status === 'Requested', 409, 'A move request can only be cancelled before movement starts.');
  requireValue(move.direction === 'TO_CHARGER', 409, 'A removal request cannot be cancelled until the vehicle is confirmed away from the charger.');
  // OD-3: when Field Staff never move an assigned shared vehicle, an Operator cancels the request here
  // and the request returns to the queue. No automatic timeout is defined by the requirements.
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
  requireValue(['Operator', 'Admin'].includes(user?.role), 403, 'Only Operations staff can adjust a shared-vehicle schedule.');
  const request = db.prepare(`SELECT r.*, v.kind FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id WHERE r.id=?`).get(requestId);
  requireValue(request && request.kind === 'shared', 404, 'Only shared-vehicle charging requests can be adjusted here.');
  requireValue(['Queued', 'Assigned'].includes(request.status), 409, 'This charging request can no longer be adjusted.');
  const time = new Date(nextRequiredUsageAt);
  requireValue(Number.isFinite(time.getTime()) && time.getTime() > clockNow(), 400, 'Next Required Usage Time must be in the future.');
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
      addViolation(b.user_id, 1, `Shared vehicle was not collected within the ${config.booking.pickupHoldMinutes}-minute pickup hold.`, 'booking', b.id);
      auditChange('Booking', b.id, 'BOOKING_EXPIRED', {}, 'system');
      notify({ userId: b.user_id, kind: 'booking_expired', entityType: 'Booking', entityId: b.id, severity: 'warning',
        title: 'Booking expired', message: 'The vehicle was not picked up in time. It was released and one violation point was recorded.' });
      expiredBookings++;
    }
    const parks = db.prepare(`SELECT * FROM parking_reservations WHERE status='Confirmed' AND expires_at<=?`).all(now);
    for (const p of parks) {
      db.prepare(`UPDATE parking_reservations SET status='Expired' WHERE id=?`).run(p.id);
      db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Reserved'`).run(now, p.slot_id);
      addViolation(p.user_id, 1, `Personal parking reservation was not used within the ${config.parking.arrivalGraceMinutes}-minute arrival grace period.`, 'parking', p.id);
      auditChange('ParkingReservation', p.id, 'PARKING_RESERVATION_EXPIRED', {}, 'system');
      notify({ userId: p.user_id, kind: 'parking_expired', entityType: 'ParkingReservation', entityId: p.id, severity: 'warning',
        title: 'Parking reservation expired', message: 'You did not arrive in time. The slot was released and one violation point was recorded.' });
      expiredParking++;
    }
    const assigned = db.prepare(`SELECT r.*, v.owner_id FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
      WHERE r.status='Assigned' AND r.request_type='personal' AND r.connect_deadline<=?`).all(now);
    for (const r of assigned) {
      db.prepare(`UPDATE charging_requests SET status='Expired' WHERE id=?`).run(r.id);
      db.prepare(`UPDATE chargers SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=? AND status='Assigned'`).run(now, r.charger_id);
      db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=?`).run(now, r.vehicle_id);
      addViolation(r.owner_id, 1, `Personal vehicle was not connected within ${config.charging.personalConnectWindowMinutes} minutes after charger assignment.`, 'charging', r.id);
      auditChange('ChargingRequest', r.id, 'PERSONAL_CHARGING_ASSIGNMENT_EXPIRED', {}, 'system');
      notify({ userId: r.owner_id, kind: 'charging_expired', entityType: 'ChargingRequest', entityId: r.id, severity: 'warning',
        title: 'Charger assignment expired', message: 'The vehicle was not connected in time. The charger was released and one violation point was recorded.' });
      expiredCharging++;
    }
  });
  // NI-02: the simulated feed refreshes the timestamp only while it is enabled, so Stale status can be demonstrated.
  if (simulatedSensorFeedEnabled) db.prepare('UPDATE hubs SET sensor_updated_at=?').run(now);
  // NI-04: the Charging Scheduler runs on every maintenance cycle, because the Waiting Duration changes with time.
  runScheduler();
  return { expiredBookings, expiredParking, expiredCharging };
}

/*
 * Timers of the charging flow (NI-04, NI-09), run by timerService on every cycle.
 *  - A running session gains battery from the charger power; at the target (or at the maximum session length, when one is set) it ends.
 *  - A student is reminded shortly before the connection window closes.
 *  - A vehicle that is not moved away after the grace period is flagged and the Operators are told.
 */
export function runChargingTimers(nowMs = clockNow()) {
  const target = config.charging.targetBatteryPercent;
  const capMs = config.charging.maxSessionMinutes ? config.charging.maxSessionMinutes * MIN : null;
  const graceMs = config.parking.overstayGraceMinutes * MIN;
  const nowText = new Date(nowMs).toISOString();

  const sessions = db.prepare(`SELECT r.*, v.vehicle_type, v.plate, v.owner_id, v.kind, v.battery_level AS vehicle_battery, c.power_kw
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id JOIN chargers c ON c.id=r.charger_id
    WHERE r.status='Charging' AND c.status='Charging' AND r.charging_started_at IS NOT NULL`).all();
  for (const session of sessions) {
    const elapsed = nowMs - Date.parse(session.charging_started_at);
    const battery = Math.min(100, Math.round(chargedBattery(session.start_battery ?? session.battery_level, session.power_kw, session.vehicle_type, elapsed)));
    if (battery >= target) { finishCharging({ request: session, battery: target, actorId: 'system', reason: 'target reached' }); continue; }
    if (capMs !== null && elapsed >= capMs) { finishCharging({ request: session, battery, actorId: 'system', reason: 'maximum session length' }); continue; }
    if (battery !== session.vehicle_battery) {
      db.prepare('UPDATE vehicles SET battery_level=?, updated_at=? WHERE id=?').run(battery, nowText, session.vehicle_id);
    }
  }

  const waiting = db.prepare(`SELECT r.*, v.plate, v.owner_id, c.code AS charger_code FROM charging_requests r
    JOIN vehicles v ON v.id=r.vehicle_id JOIN chargers c ON c.id=r.charger_id
    WHERE r.status='Assigned' AND r.request_type='personal' AND r.connect_deadline IS NOT NULL`).all();
  for (const r of waiting) {
    const left = Date.parse(r.connect_deadline) - nowMs;
    if (left > 0 && left <= 5 * MIN) {
      notify({ userId: r.owner_id, kind: 'charging_connect_reminder', entityType: 'ChargingRequest', entityId: r.id, severity: 'warning',
        title: 'Connect your vehicle', message: `Connect ${r.plate} to ${r.charger_code} within ${Math.max(1, Math.ceil(left / MIN))} minutes or the charger is released.` });
    }
  }

  const removals = db.prepare(`SELECT m.requested_at, m.id AS move_id, v.plate, v.owner_id, v.kind, r.id AS request_id, c.code AS charger_code
    FROM move_vehicle_requests m JOIN vehicles v ON v.id=m.vehicle_id
    JOIN charging_requests r ON r.id=m.charging_request_id JOIN chargers c ON c.id=m.charger_id
    WHERE m.direction='FROM_CHARGER' AND m.status IN ('Requested','In Progress') AND r.overstay_flagged_at IS NULL`).all();
  for (const m of removals) {
    if (nowMs - Date.parse(m.requested_at) < graceMs) continue;
    db.prepare('UPDATE charging_requests SET overstay_flagged_at=? WHERE id=? AND overstay_flagged_at IS NULL').run(nowText, m.request_id);
    auditChange('ChargingRequest', m.request_id, 'CHARGER_REMOVAL_OVERDUE', { moveRequestId: m.move_id }, 'system');
    const text = `${m.plate} is still at ${m.charger_code}, ${config.parking.overstayGraceMinutes} minutes after charging ended.`;
    if (m.kind === 'personal' && m.owner_id) {
      notify({ userId: m.owner_id, kind: 'charging_removal_overdue', entityType: 'ChargingRequest', entityId: m.request_id, severity: 'critical', title: 'Move your vehicle', message: text });
    }
    notifyOperators({ kind: 'charging_removal_overdue_ops', entityType: 'ChargingRequest', entityId: m.request_id, severity: 'critical', title: 'Charger is blocked', message: text });
  }
}

/*
 * UC-019 / charging-point failure. The charger leaves service; what happens to its request depends on where it was:
 *  - Assigned (vehicle not connected yet): the request returns to the queue, an open "move to charger" task is cancelled.
 *  - Charging: the session is stopped at the battery level reached; a removal task is opened and the vehicle keeps its place until it is moved.
 */
export function handleChargerFailure({ chargerId, actorId }) {
  const now = nowIso();
  let hubId = null;
  const events = [];
  transaction(() => {
    const charger = db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
    requireValue(charger, 404, 'Charger not found.');
    requireValue(charger.status !== 'Out of Service', 409, 'This charger is already out of service.');
    requireValue(charger.status !== 'Awaiting Removal', 409, 'A vehicle is waiting to be moved away from this charger. Finish that removal first.');
    hubId = charger.hub_id;
    const request = db.prepare(`SELECT r.*, v.plate, v.owner_id, v.kind, v.vehicle_type FROM charging_requests r
      JOIN vehicles v ON v.id=r.vehicle_id WHERE r.charger_id=? AND r.status IN ('Assigned','Charging')`).get(chargerId);

    if (request?.status === 'Assigned') {
      db.prepare(`UPDATE move_vehicle_requests SET status='Cancelled' WHERE charging_request_id=? AND direction='TO_CHARGER' AND status IN ('Requested','In Progress')`).run(request.id);
      db.prepare(`UPDATE charging_requests SET status='Queued', charger_id=NULL, assigned_at=NULL, connect_deadline=NULL WHERE id=?`).run(request.id);
      db.prepare(`UPDATE chargers SET status='Out of Service', current_vehicle_id=NULL, updated_at=? WHERE id=?`).run(now, chargerId);
      events.push({ request, text: `${charger.code} failed before ${request.plate} was connected. The request is back in the queue.` });
    } else if (request?.status === 'Charging') {
      const elapsed = clockNow() - Date.parse(request.charging_started_at);
      const battery = Math.min(100, Math.round(chargedBattery(request.start_battery ?? request.battery_level, charger.power_kw, request.vehicle_type, elapsed)));
      db.prepare(`UPDATE charging_requests SET status='Cancelled', charging_completed_at=? WHERE id=?`).run(now, request.id);
      db.prepare(`UPDATE vehicles SET battery_level=?, status='Needs Charging', updated_at=? WHERE id=?`).run(battery, now, request.vehicle_id);
      db.prepare(`UPDATE chargers SET status='Out of Service', updated_at=? WHERE id=?`).run(now, chargerId);
      db.prepare(`INSERT INTO move_vehicle_requests (id,charging_request_id,vehicle_id,charger_id,direction,status,requested_at,note)
        VALUES (?,?,?,?,'FROM_CHARGER','Requested',?,?)`)
        .run(makeId('move'), request.id, request.vehicle_id, chargerId, now, `${charger.code} failed during charging at ${battery}%; move the vehicle away.`);
      events.push({ request, text: `${charger.code} failed while charging ${request.plate} (${battery}%). Move the vehicle away from the charger.` });
    } else {
      db.prepare(`UPDATE chargers SET status='Out of Service', current_vehicle_id=NULL, updated_at=? WHERE id=?`).run(now, chargerId);
    }
    auditChange('Charger', chargerId, 'CHARGER_OUT_OF_SERVICE', { requestId: request?.id ?? null, wasStatus: charger.status }, actorId);
  });
  for (const { request, text } of events) {
    if (request.kind === 'personal' && request.owner_id) {
      notify({ userId: request.owner_id, kind: 'charger_failed', entityType: 'ChargingRequest', entityId: request.id, severity: 'warning', title: 'Charger failure', message: text });
    }
    notifyOperators({ kind: 'charger_failed_ops', entityType: 'ChargingRequest', entityId: request.id, severity: 'critical', title: 'Charger failure', message: text });
  }
  runScheduler(hubId, actorId);
  return db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
}

export function restoreCharger({ chargerId, actorId }) {
  const charger = db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
  requireValue(charger, 404, 'Charger not found.');
  requireValue(charger.status === 'Out of Service', 409, 'Only a charger that is out of service can be restored.');
  requireValue(!charger.current_vehicle_id, 409, 'A vehicle is still recorded at this charger. Confirm its removal first.');
  db.prepare(`UPDATE chargers SET status='Available', updated_at=? WHERE id=?`).run(nowIso(), chargerId);
  auditChange('Charger', chargerId, 'CHARGER_RESTORED', {}, actorId);
  runScheduler(charger.hub_id, actorId);
  return db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
}
