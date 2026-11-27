import { db, transaction, makeId, nowIso } from '../database/db.js';
import { requireValue, requireRole, auditChange, parseJson } from './commonService.js';
import { config } from '../config.js';
import { enqueueSharedVehicle, runScheduler } from './chargingService.js';
import { notifyOperators } from './notificationService.js';
import { completeHandoff } from './simulationService.js';

/*
 * UC-018 Coordinate Vehicle Redistribution (MVP).
 * An Operator moves one Available shared vehicle from one Hub to another.
 *   Requested   : the vehicle is marked "In Transfer" (nobody can book it) and a free Shared slot at the destination is kept for it.
 *   In Progress : the vehicle has left; its old Shared slot is free.
 *   Done        : the vehicle takes the kept slot; a battery below the booking minimum puts it in the charging queue (BR-25).
 * The destination keeps its free Shared-slot reserve (BR-29, BR-40).
 */
const ops = user => requireRole(user, ['Operator', 'Admin']);
const reserveSlots = total => Math.ceil(total * config.parking.sharedReturnReservePercent / 100);

export function hubBalance() {
  const minBattery = config.booking.minimumBatteryToBookPercent;
  return db.prepare('SELECT id, code, name, status FROM hubs ORDER BY code').all().map(hub => {
    const vehicles = db.prepare(`SELECT id, plate, vehicle_type, battery_level, status FROM vehicles WHERE hub_id=? AND kind='shared'`).all(hub.id);
    const slots = db.prepare(`SELECT status FROM parking_slots WHERE hub_id=? AND slot_type='Shared'`).all(hub.id);
    const incoming = db.prepare(`SELECT COUNT(*) AS n FROM redistribution_tasks WHERE to_hub_id=? AND status IN ('Requested','In Progress')`).get(hub.id).n;
    const outgoing = db.prepare(`SELECT COUNT(*) AS n FROM redistribution_tasks WHERE from_hub_id=? AND status IN ('Requested','In Progress')`).get(hub.id).n;
    const usable = slots.filter(s => s.status !== 'Out of Service').length;
    const bookable = vehicles.filter(v => v.status === 'Available' && v.battery_level >= minBattery);
    return {
      ...hub,
      available: bookable.length,
      needsCharging: vehicles.filter(v => ['Needs Charging', 'Charging'].includes(v.status)).length,
      unavailable: vehicles.filter(v => ['Out of Service', 'Reserved', 'In Use', 'In Transfer'].includes(v.status)).length,
      total: vehicles.length,
      freeSharedSlots: slots.filter(s => s.status === 'Available').length,
      sharedSlotsTotal: usable,
      incoming, outgoing,
      bookable: bookable.sort((a, b) => b.battery_level - a.battery_level)
    };
  });
}

// Suggestions: while one Hub has at least two more bookable vehicles than another that still has room, move the best-charged one.
function suggestions(hubs) {
  const work = hubs.map(h => ({ ...h, effective: h.available + h.incoming - h.outgoing, pool: [...h.bookable], room: h.freeSharedSlots - reserveSlots(h.sharedSlotsTotal) }));
  const result = [];
  for (let i = 0; i < 6; i++) {
    const donor = [...work].filter(h => h.pool.length).sort((a, b) => b.effective - a.effective)[0];
    const receiver = [...work].filter(h => h.status === 'Open' && h.room > 0).sort((a, b) => a.effective - b.effective)[0];
    if (!donor || !receiver || donor.id === receiver.id || donor.effective - receiver.effective < 2) break;
    const vehicle = donor.pool.shift();
    result.push({
      vehicleId: vehicle.id, plate: vehicle.plate, battery: vehicle.battery_level,
      fromHubId: donor.id, fromHubName: donor.name, toHubId: receiver.id, toHubName: receiver.name,
      reason: `${donor.name} has ${donor.effective} bookable vehicles, ${receiver.name} only ${receiver.effective}.`
    });
    donor.effective -= 1; receiver.effective += 1; receiver.room -= 1;
  }
  return result;
}

export function listTasks(limit = 60) {
  return db.prepare(`SELECT t.*, v.plate, v.battery_level, fh.name AS from_hub_name, th.name AS to_hub_name, ts.code AS to_slot_code, fs.code AS from_slot_code
    FROM redistribution_tasks t JOIN vehicles v ON v.id=t.vehicle_id
    JOIN hubs fh ON fh.id=t.from_hub_id JOIN hubs th ON th.id=t.to_hub_id
    LEFT JOIN parking_slots ts ON ts.id=t.to_slot_id LEFT JOIN parking_slots fs ON fs.id=t.from_slot_id
    ORDER BY CASE t.status WHEN 'In Progress' THEN 1 WHEN 'Requested' THEN 2 ELSE 3 END, t.requested_at DESC LIMIT ?`).all(limit);
}

export function redistributionOverview(user) {
  ops(user);
  const hubs = hubBalance();
  // Simulation recommendations of type REDISTRIBUTE_VEHICLES that were sent to the Operator (UC-024 -> UC-018).
  const handoffs = db.prepare(`SELECT h.id, h.prefilled_payload_json, h.created_at, r.title FROM recommendation_handoffs h
    JOIN recommendations r ON r.id=h.recommendation_id WHERE h.status='Pending' AND r.type='REDISTRIBUTE_VEHICLES' ORDER BY h.created_at`).all()
    .map(({ prefilled_payload_json, ...h }) => ({ ...h, payload: parseJson(prefilled_payload_json) }));
  return {
    hubs: hubs.map(({ bookable, ...hub }) => ({ ...hub, bookableVehicles: bookable.map(v => ({ id: v.id, plate: v.plate, battery: v.battery_level })) })),
    suggestions: suggestions(hubs),
    handoffs,
    tasks: listTasks()
  };
}

export function createTask({ user, vehicleId, toHubId, reason = '', handoffId = null }) {
  ops(user);
  const id = makeId('redistribution');
  transaction(() => {
    const now = nowIso();
    const vehicle = db.prepare(`SELECT * FROM vehicles WHERE id=? AND kind='shared'`).get(vehicleId);
    requireValue(vehicle && vehicle.hub_id, 404, 'Shared vehicle not found.');
    requireValue(vehicle.status === 'Available', 409, `Only an Available shared vehicle can be moved. This one is ${vehicle.status}.`);
    requireValue(vehicle.hub_id !== toHubId, 400, 'The vehicle is already at that Hub.');
    const target = db.prepare('SELECT * FROM hubs WHERE id=?').get(toHubId);
    requireValue(target, 404, 'Destination Hub not found.');
    requireValue(target.status === 'Open', 409, 'The destination Hub is closed.');

    const slots = db.prepare(`SELECT * FROM parking_slots WHERE hub_id=? AND slot_type='Shared' ORDER BY code`).all(toHubId);
    const usable = slots.filter(s => s.status !== 'Out of Service').length;
    const free = slots.filter(s => s.status === 'Available');
    const slot = free.find(s => parseJson(s.supported_vehicle_types_json, []).includes(vehicle.vehicle_type));
    requireValue(slot, 409, 'The destination Hub has no free Shared slot for this vehicle.');
    requireValue(free.length - 1 >= reserveSlots(usable), 409,
      `The destination Hub must keep ${config.parking.sharedReturnReservePercent}% of its Shared slots free for returns (BR-29, BR-40).`);
    const from = db.prepare(`SELECT id FROM parking_slots WHERE current_vehicle_id=? AND slot_type='Shared'`).get(vehicleId);

    requireValue(db.prepare(`UPDATE parking_slots SET status='Reserved', updated_at=? WHERE id=? AND status='Available'`).run(now, slot.id).changes === 1,
      409, 'The destination slot was just taken. Try again.');
    requireValue(db.prepare(`UPDATE vehicles SET status='In Transfer', updated_at=? WHERE id=? AND status='Available'`).run(now, vehicleId).changes === 1,
      409, 'The vehicle was just booked. Choose another vehicle.');
    db.prepare(`INSERT INTO redistribution_tasks
      (id,vehicle_id,from_hub_id,to_hub_id,from_slot_id,to_slot_id,status,reason,handoff_id,requested_by,requested_at)
      VALUES (?,?,?,?,?,?, 'Requested', ?,?,?,?)`)
      .run(id, vehicleId, vehicle.hub_id, toHubId, from?.id ?? null, slot.id, String(reason).trim().slice(0, 300) || null, handoffId, user.id, now);
    auditChange('RedistributionTask', id, 'REDISTRIBUTION_REQUESTED', { vehicleId, fromHubId: vehicle.hub_id, toHubId, toSlotId: slot.id, handoffId }, user.id);
  });
  return db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(id);
}

export function startTask({ user, taskId }) {
  ops(user);
  transaction(() => {
    const now = nowIso();
    const task = db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(taskId);
    requireValue(task, 404, 'Redistribution task not found.');
    requireValue(task.status === 'Requested', 409, 'Only a Requested task can be started.');
    db.prepare(`UPDATE redistribution_tasks SET status='In Progress', assigned_to=?, started_at=? WHERE id=?`).run(user.id, now, taskId);
    // The vehicle has left its Shared slot, which is free again.
    db.prepare(`UPDATE parking_slots SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE id=? AND current_vehicle_id=?`).run(now, task.from_slot_id, task.vehicle_id);
    auditChange('RedistributionTask', taskId, 'REDISTRIBUTION_STARTED', {}, user.id);
  });
  return db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(taskId);
}

export function completeTask({ user, taskId }) {
  ops(user);
  let handoffToConfirm = null; let toHubId;
  transaction(() => {
    const now = nowIso();
    const task = db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(taskId);
    requireValue(task, 404, 'Redistribution task not found.');
    requireValue(task.status === 'In Progress', 409, 'Only an In Progress task can be completed. Start it first.');
    toHubId = task.to_hub_id;
    requireValue(db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=? AND status='Reserved'`)
      .run(task.vehicle_id, now, task.to_slot_id).changes === 1, 409, 'The kept destination slot is no longer reserved. Cancel and create the task again.');
    const vehicle = db.prepare('SELECT battery_level FROM vehicles WHERE id=?').get(task.vehicle_id);
    const low = vehicle.battery_level < config.booking.minimumBatteryToBookPercent;
    db.prepare(`UPDATE vehicles SET hub_id=?, status=?, updated_at=? WHERE id=?`).run(task.to_hub_id, low ? 'Needs Charging' : 'Available', now, task.vehicle_id);
    if (low) enqueueSharedVehicle(task.vehicle_id, task.to_hub_id);
    db.prepare(`UPDATE redistribution_tasks SET status='Done', completed_at=?, assigned_to=COALESCE(assigned_to,?) WHERE id=?`).run(now, user.id, taskId);
    auditChange('RedistributionTask', taskId, 'REDISTRIBUTION_DONE', { toHubId: task.to_hub_id }, user.id);
    if (task.handoff_id) {
      const open = db.prepare(`SELECT COUNT(*) AS n FROM redistribution_tasks WHERE handoff_id=? AND status IN ('Requested','In Progress')`).get(task.handoff_id).n;
      if (open === 0) handoffToConfirm = task.handoff_id;
    }
  });
  // The simulation hand-off is confirmed once every task made from it is done (UC-018 -> UC-024).
  if (handoffToConfirm) {
    try { completeHandoff({ user, handoffId: handoffToConfirm, completionNote: 'All vehicle moves of this recommendation are done.' }); }
    catch (error) { console.error('Hand-off could not be confirmed automatically:', error.message); }
  }
  runScheduler(toHubId, user.id);
  return db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(taskId);
}

export function cancelTask({ user, taskId }) {
  ops(user);
  transaction(() => {
    const now = nowIso();
    const task = db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(taskId);
    requireValue(task, 404, 'Redistribution task not found.');
    requireValue(task.status === 'Requested', 409, 'A task can be cancelled only before the vehicle leaves.');
    db.prepare(`UPDATE redistribution_tasks SET status='Cancelled', completed_at=? WHERE id=?`).run(now, taskId);
    db.prepare(`UPDATE parking_slots SET status='Available', updated_at=? WHERE id=? AND status='Reserved' AND current_vehicle_id IS NULL`).run(now, task.to_slot_id);
    db.prepare(`UPDATE vehicles SET status='Available', updated_at=? WHERE id=? AND status='In Transfer'`).run(now, task.vehicle_id);
    auditChange('RedistributionTask', taskId, 'REDISTRIBUTION_CANCELLED', {}, user.id);
  });
  return db.prepare('SELECT * FROM redistribution_tasks WHERE id=?').get(taskId);
}

// Turns a simulation recommendation (REDISTRIBUTE_VEHICLES) into tasks: the best-charged Available vehicles of the source Hub go to the target Hub.
export function planFromHandoff({ user, handoffId }) {
  ops(user);
  const handoff = db.prepare(`SELECT h.*, r.type FROM recommendation_handoffs h JOIN recommendations r ON r.id=h.recommendation_id WHERE h.id=?`).get(handoffId);
  requireValue(handoff && handoff.type === 'REDISTRIBUTE_VEHICLES', 404, 'Redistribution hand-off not found.');
  requireValue(handoff.status === 'Pending', 409, 'This hand-off is no longer pending.');
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM redistribution_tasks WHERE handoff_id=? AND status<>'Cancelled'`).get(handoffId).n;
  requireValue(existing === 0, 409, 'Tasks were already created for this recommendation.');
  const payload = parseJson(handoff.prefilled_payload_json);
  const count = Math.max(1, Number(payload.vehicleCount) || 1);
  const candidates = db.prepare(`SELECT id FROM vehicles WHERE hub_id=? AND kind='shared' AND status='Available' AND battery_level>=? ORDER BY battery_level DESC LIMIT ?`)
    .all(payload.sourceHubId, config.booking.minimumBatteryToBookPercent, count);
  requireValue(candidates.length > 0, 409, 'The source Hub has no vehicle that can be moved now.');
  const tasks = [];
  transaction(() => {
    for (const candidate of candidates) {
      tasks.push(createTask({ user, vehicleId: candidate.id, toHubId: payload.targetHubId, reason: 'From a what-if simulation recommendation.', handoffId }));
    }
  });
  notifyOperators({ kind: 'redistribution_planned', entityType: 'RecommendationHandoff', entityId: handoffId, severity: 'info',
    title: 'Redistribution planned', message: `${tasks.length} vehicle move(s) were created from a simulation recommendation.` });
  return tasks;
}
