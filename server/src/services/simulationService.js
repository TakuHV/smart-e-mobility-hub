import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, auditChange, parseJson } from './commonService.js';

import { config } from '../config.js';
import { calculatePriority, compareRanked, chargeMinutesNeeded } from './chargingService.js';
/*
 * What-if simulation (UC-023, UC-024, UC-025; BR-32, BR-33, BR-34).
 * A run reads a baseline snapshot and writes ONLY simulation_runs, recommendations, recommendation_handoffs
 * and audit rows. It never changes bookings, vehicles, slots, chargers or charging requests.
 */

const UNUSABLE_STATUSES = new Set(['Out of Service', 'Status Unknown', 'Connection Lost']); // BR-28

const scenarioLabels = {
  parking_surge: 'Sudden increase of arrivals at a Hub',
  capacity_pressure: 'Hub approaching full parking capacity',
  charger_outage: 'Charger outage',
  charging_demand: 'Increased charging demand',
  vehicle_imbalance: 'Vehicle concentration at one Hub'
};

const isOperator = user => user?.role === 'Simulation Operator' || user?.role === 'Admin';

/* ----------------------------------------------------------------------------------------------
 * Pure calculations on snapshot data
 * -------------------------------------------------------------------------------------------- */
// `extra` vehicles arrive on top of the occupied slots. `minOccupied` lets a scenario assume a fuller starting point
// than the baseline (capacity_pressure); the current values always stay the real baseline values.
function slotStats(slots, type, extra = 0, minOccupied = 0) {
  const usable = slots.filter(s => s.slot_type === type && !UNUSABLE_STATUSES.has(s.status));
  const total = usable.length;
  const occupied = usable.filter(s => s.status !== 'Available').length;
  const startOccupied = Math.min(total, Math.max(occupied, minOccupied));
  const projectedOccupied = Math.min(total, startOccupied + extra);
  return {
    total, occupied, free: total - occupied,
    percent: total ? Math.round((occupied / total) * 100) : 0,
    startOccupied,
    projectedPercent: total ? Math.round((projectedOccupied / total) * 100) : 0,
    unserved: Math.max(0, startOccupied + extra - total)
  };
}

const usableChargers = chargers => chargers.filter(c => !UNUSABLE_STATUSES.has(c.status));
const byCode = (a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true });

function levelOf(percent) {
  if (percent >= config.thresholds.parkingCriticalPercent) return 'Critical';
  if (percent >= config.thresholds.parkingWarningPercent) return 'Warning';
  return 'Normal';
}

// How many chargers can run at the same time without exceeding the Hub Power Limit (BR-47):
// chargers are added, lowest power first, until the sum would exceed the limit. Same rule as the Charging Scheduler.
function chargingCapacity(chargers, powerLimitKw) {
  const usable = chargers.filter(c => !UNUSABLE_STATUSES.has(c.status)).sort((a, b) => a.power_kw - b.power_kw);
  let sum = 0;
  let concurrent = 0;
  for (const charger of usable) {
    if (sum + charger.power_kw > powerLimitKw + 1e-6) break;
    sum += charger.power_kw;
    concurrent++;
  }
  return { usable: usable.length, concurrent };
}

function reserveSlots(slotType, total) {
  return slotType === 'Shared' ? Math.ceil(total * config.parking.sharedReturnReservePercent / 100) : 0; // BR-40
}

// A Hub that can receive vehicles or users: open, enough free slots (BR-40 reserve kept) and below warning level (BR-31).
function pickDestinationHub(network, sourceHubId, slotType, needed) {
  return network
    .filter(h => h.id !== sourceHubId && h.status === 'Open')
    .map(h => ({ hub: h, stats: h.slots[slotType] }))
    .filter(({ stats }) => stats.total > 0
      && stats.free - needed >= reserveSlots(slotType, stats.total)
      && Math.round(((stats.occupied + needed) / stats.total) * 100) < config.thresholds.parkingWarningPercent)
    .sort((a, b) => a.stats.percent - b.stats.percent || String(a.hub.id).localeCompare(String(b.hub.id)))[0]?.hub ?? null;
}

/* ----------------------------------------------------------------------------------------------
 * Baseline snapshot (BR-32): the selected Hub in detail, and a summary of every Hub for destinations.
 * -------------------------------------------------------------------------------------------- */
function captureBaseline(hubId) {
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  requireValue(hub, 404, 'Hub not found.');
  const vehicles = db.prepare(`SELECT id,plate,kind,vehicle_type,battery_level,status FROM vehicles WHERE hub_id=?`).all(hubId);
  const slots = db.prepare(`SELECT id,code,slot_type,status FROM parking_slots WHERE hub_id=?`).all(hubId);
  const chargers = db.prepare(`SELECT id,code,power_kw,status FROM chargers WHERE hub_id=?`).all(hubId);
  // The live charging requests: registration time, battery and vehicle type let the simulation rank them like the Scheduler.
  const chargingQueue = db.prepare(`SELECT r.id,r.vehicle_id,r.status,r.battery_level,r.next_required_usage_at,r.registered_at,r.charger_id,
      v.vehicle_type,v.battery_level AS vehicle_battery_level
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    WHERE r.hub_id=? AND r.status IN ('Queued','Assigned','Charging')`).all(hubId);
  const network = db.prepare('SELECT id,name,status FROM hubs ORDER BY id').all().map(h => {
    const hubSlots = db.prepare('SELECT slot_type,status FROM parking_slots WHERE hub_id=?').all(h.id);
    return {
      id: h.id, name: h.name, status: h.status,
      slots: { Shared: slotStats(hubSlots, 'Shared'), Personal: slotStats(hubSlots, 'Personal') },
      availableSharedVehicles: db.prepare(`SELECT COUNT(*) AS c FROM vehicles WHERE hub_id=? AND kind='shared' AND status='Available'`).get(h.id).c
    };
  });
  return { hub, vehicles, slots, chargers, chargingQueue, network, capturedAt: nowIso() };
}

/* ----------------------------------------------------------------------------------------------
 * Parameter validation (UC-023 E1): invalid input is rejected with the field to correct, never silently changed.
 * -------------------------------------------------------------------------------------------- */
function readInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  requireValue(Number.isInteger(n) && n >= min && n <= max, 400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

// Scheduler weights to test (TDD 2.2): need, urgency and waiting, each 0..1, together 1. Default: the configured weights.
const WEIGHT_KEYS = ['need', 'urgency', 'waiting'];
const configuredWeights = () => ({ ...config.charging.scheduler.weights });
const sameWeights = (a, b) => WEIGHT_KEYS.every(k => Math.abs(Number(a?.[k]) - Number(b?.[k])) < 1e-9);
function readWeights(input) {
  if (input === undefined || input === null || input === '') return configuredWeights();
  requireValue(typeof input === 'object' && !Array.isArray(input), 400, 'weights must be an object with need, urgency and waiting.');
  const weights = {};
  for (const key of WEIGHT_KEYS) {
    const n = Number(input[key]);
    requireValue(Number.isFinite(n) && n >= 0 && n <= 1, 400, `weights.${key} must be a number from 0 to 1.`);
    weights[key] = Math.round(n * 1000) / 1000;
  }
  const sum = WEIGHT_KEYS.reduce((total, key) => total + weights[key], 0);
  requireValue(Math.abs(sum - 1) <= 0.01, 400, `The three weights must add up to 1 (100%); they add up to ${Math.round(sum * 100)}%.`);
  return weights;
}

function readParameters(scenarioType, input, baseline) {
  const parameters = {};
  const name = String(input.label ?? '').trim().slice(0, 80);
  if (name) parameters.runName = name;
  const hasValue = value => value !== undefined && value !== null && value !== '';
  if (scenarioType === 'parking_surge' || scenarioType === 'capacity_pressure') {
    parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra arriving vehicles)', 1, 200, 2);
    const slotType = input.slotType ?? 'Personal';
    requireValue(['Personal', 'Shared'].includes(slotType), 400, 'slotType must be Personal or Shared.');
    parameters.slotType = slotType;
    if (scenarioType === 'capacity_pressure') {
      // The Hub is assumed to start this full (or fuller, if the baseline already is) before the extra vehicles arrive.
      parameters.startOccupancyPercent = readInteger(input.startOccupancyPercent, 'startOccupancyPercent (starting occupancy)', 50, 100, 90);
    }
  } else if (scenarioType === 'vehicle_imbalance') {
    parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra vehicles concentrated at this Hub)', 1, 200, 2);
  } else {
    if (scenarioType === 'charging_demand') {
      parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra charging requests)', 1, 200, 2);
      parameters.urgentSharePercent = readInteger(input.urgentSharePercent, 'urgentSharePercent (share of urgent requests)', 0, 100, 30);
      parameters.demandSeed = readInteger(input.demandSeed, 'demandSeed (demand sample number)', 1, 9999, 1);
      // MVP rule: the Hub Power Limit is a what-if input of the outage scenario only; a normal Hub runs all its chargers.
      requireValue(!hasValue(input.powerLimitKw), 400, 'A different Hub Power Limit can only be tested in the Charger outage scenario.');
    } else {
      const usable = usableChargers(baseline.chargers).sort(byCode);
      requireValue(usable.length > 0, 400, 'This Hub has no usable charger to put out of service.');
      let out;
      if (Array.isArray(input.outageChargerIds) && input.outageChargerIds.length) {
        const ids = [...new Set(input.outageChargerIds.map(String))];
        out = ids.map(id => usable.find(c => c.id === id));
        requireValue(out.every(Boolean), 400, 'Choose chargers of this Hub that are currently usable (not already out of service).');
      } else {
        // No charger chosen: the first chargers by code are assumed out of service (deterministic and repeatable).
        out = usable.slice(0, readInteger(input.chargerOutageCount, 'chargerOutageCount', 1, usable.length, 1));
      }
      // Optional busy-hour demand during the outage; 0 = only the live requests.
      parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra charging requests)', 0, 200, 0);
      if (parameters.demandDelta > 0) {
        parameters.urgentSharePercent = readInteger(input.urgentSharePercent, 'urgentSharePercent (share of urgent requests)', 0, 100, 30);
        parameters.demandSeed = readInteger(input.demandSeed, 'demandSeed (demand sample number)', 1, 9999, 1);
      }
      parameters.chargerOutageCount = out.length;
      parameters.outageChargerIds = out.map(c => c.id);
      parameters.outageChargerCodes = out.map(c => c.code);
      if (hasValue(input.powerLimitKw)) {
        const limit = Number(input.powerLimitKw);
        requireValue(Number.isFinite(limit) && limit > 0 && limit <= 1000, 400, 'powerLimitKw must be a number above 0 and at most 1000.');
        parameters.powerLimitKw = limit; // what-if on a different Hub Power Limit; comparable with other runs (UC-024)
      }
    }
    parameters.weights = readWeights(input.weights);
  }
  parameters.note = 'Scenario assumptions affect this stored simulation only; live resources are not changed.';
  return parameters;
}

/* ----------------------------------------------------------------------------------------------
 * Simulation
 * -------------------------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------------------------
 * Charging queue simulation (charger_outage, charging_demand).
 * Each time a charger becomes free, the waiting requests are ranked with the Scheduler's own calculatePriority()
 * and compareRanked(), using the weights of the scenario; the first one starts. A session lasts as long as the
 * vehicle needs to reach the target battery (chargeMinutesNeeded). The weights only change the ORDER, so the
 * results that matter are per vehicle: who is ready before its next required usage time and who is late.
 * Simplifications: no new requests arrive during the run, no shared vehicle is displaced (preemption),
 * and a request that has to wait keeps its registration battery level.
 * -------------------------------------------------------------------------------------------- */
const MINUTE = 60000;

// Small seeded random generator (mulberry32): the same seed always gives the same simulated demand.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Extra requests of charging_demand. Urgent ones are needed soon after they could be fully charged (15-120 minutes of
// slack); the others have 3-10 hours of slack. Battery 10-70%. They registered up to 30 minutes before the baseline.
function simulatedRequests(count, urgentSharePercent, seed, startMs) {
  const random = seededRandom(seed);
  const between = (min, max) => min + Math.floor(random() * (max - min + 1));
  const urgentCount = Math.round(count * urgentSharePercent / 100);
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const urgent = new Set(order.slice(0, urgentCount));
  return Array.from({ length: count }, (_, i) => {
    const battery = between(10, 70);
    const needed = chargeMinutesNeeded(battery, 'Motorcycle');
    const slack = urgent.has(i) ? between(15, 120) : between(180, 600);
    return {
      id: `sim-${String(i + 1).padStart(3, '0')}`, label: `Simulated #${i + 1}`, source: 'simulated', urgentProfile: urgent.has(i),
      battery, vehicleType: 'Motorcycle', running: false,
      nextUseMs: startMs + Math.round((needed + slack) * MINUTE),
      registeredMs: startMs - between(0, 30) * MINUTE
    };
  });
}

// The live requests of the baseline. A request on a charger that stays usable keeps charging; one on a charger that
// is out of service in the scenario goes back to the queue.
function existingRequests(baseline, outIds) {
  return baseline.chargingQueue.map((r, i) => {
    const onCharger = (r.status === 'Charging' || r.status === 'Assigned') && r.charger_id && !outIds.has(r.charger_id);
    const battery = Number(r.status === 'Charging' ? (r.vehicle_battery_level ?? r.battery_level) : r.battery_level);
    return {
      id: r.id, label: `Live request ${i + 1}`, source: 'existing', battery, vehicleType: r.vehicle_type || 'Motorcycle',
      running: Boolean(onCharger),
      nextUseMs: r.next_required_usage_at ? Date.parse(r.next_required_usage_at) : null,
      registeredMs: r.registered_at ? Date.parse(r.registered_at) : Date.parse(baseline.capturedAt)
    };
  });
}

function simulateChargingQueue({ requests, chargers, powerLimitKw, weights, startMs }) {
  const capacity = chargingCapacity(chargers, powerLimitKw).concurrent;
  const freeAt = Array.from({ length: capacity }, () => startMs);
  const timeline = [];
  const toPriorityInput = r => ({ battery_level: r.battery, vehicle_type: r.vehicleType, vehicle_id: r.id,
    next_required_usage_at: r.nextUseMs ? new Date(r.nextUseMs).toISOString() : null,
    registered_at: new Date(Math.min(r.registeredMs, startMs)).toISOString() });
  const URGENT_SLACK_MINUTES = 120; // "urgent": at the start it has at most 2 hours to spare before its usage time
  const atStart = r => calculatePriority(toPriorityInput(r), startMs, weights);
  const record = (r, start) => {
    const end = start === null ? null : start + chargeMinutesNeeded(r.battery, r.vehicleType) * MINUTE;
    const p = atStart(r);
    const slack = p.components.slack === null ? null : Math.round(p.components.slack);
    timeline.push({ id: r.id, label: r.label, source: r.source, battery: r.battery, priorityClass: p.cls,
      slackMinutes: slack, urgent: slack !== null && slack <= URGENT_SLACK_MINUTES,
      dueInMinutes: r.nextUseMs ? Math.round((r.nextUseMs - startMs) / MINUTE) : null,
      waitMinutes: start === null ? null : Math.round((start - startMs) / MINUTE),
      readyInMinutes: end === null ? null : Math.round((end - startMs) / MINUTE),
      onTime: r.nextUseMs ? (end !== null && end <= r.nextUseMs) : null,
      alreadyCharging: r.running });
    return end;
  };

  const queue = [];
  for (const r of requests.filter(x => x.running)) {
    // Keeps its charger if the Power Limit still lets that many chargers run; otherwise it waits like the others.
    const slot = freeAt.findIndex(t => t === startMs);
    if (slot === -1) { queue.push({ ...r, running: false }); continue; }
    freeAt[slot] = record(r, startMs);
  }
  queue.push(...requests.filter(x => !x.running));

  while (queue.length) {
    if (!capacity) { queue.splice(0).forEach(r => record(r, null)); break; }
    const slot = freeAt.indexOf(Math.min(...freeAt));
    const now = freeAt[slot];
    const ranked = queue.map(r => ({ r, ...calculatePriority(toPriorityInput(r), now, weights) })).sort(compareRanked);
    const next = ranked[0].r;
    queue.splice(queue.indexOf(next), 1);
    freeAt[slot] = record(next, now);
  }

  const waiting = timeline.filter(t => !t.alreadyCharging);
  const waits = waiting.map(t => t.waitMinutes);
  const withUse = timeline.filter(t => t.onTime !== null);
  const urgent = waiting.filter(t => t.urgent);
  const average = list => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0);
  return {
    capacity,
    requests: timeline.length,
    longestWait: waits.some(w => w === null) ? null : Math.max(0, ...waits),
    averageWait: waits.some(w => w === null) ? null : average(waits),
    urgentAverageWait: urgent.some(t => t.waitMinutes === null) ? null : (urgent.length ? average(urgent.map(t => t.waitMinutes)) : null),
    withUsageTime: withUse.length,
    late: withUse.filter(t => !t.onTime).length,
    onTimePercent: withUse.length ? Math.round(withUse.filter(t => t.onTime).length / withUse.length * 100) : null,
    timeline: timeline.sort((a, b) => (a.waitMinutes ?? Infinity) - (b.waitMinutes ?? Infinity))
  };
}

/* ----------------------------------------------------------------------------------------------
 * Simulation
 * -------------------------------------------------------------------------------------------- */
function simulate(scenarioType, baseline, parameters) {
  const demand = parameters.demandDelta ?? 0;
  const slotType = parameters.slotType ?? (scenarioType === 'vehicle_imbalance' ? 'Shared' : 'Personal');
  const parkingExtra = ['parking_surge', 'capacity_pressure', 'vehicle_imbalance'].includes(scenarioType) ? demand : 0;
  const startFor = type => {
    if (scenarioType !== 'capacity_pressure' || type !== slotType) return 0;
    const total = baseline.slots.filter(s => s.slot_type === type && !UNUSABLE_STATUSES.has(s.status)).length;
    return Math.ceil(total * parameters.startOccupancyPercent / 100);
  };
  const personal = slotStats(baseline.slots, 'Personal', slotType === 'Personal' ? parkingExtra : 0, startFor('Personal'));
  const shared = slotStats(baseline.slots, 'Shared', slotType === 'Shared' ? parkingExtra : 0, startFor('Shared'));
  const affected = slotType === 'Shared' ? shared : personal;

  const availableSharedVehicles = baseline.vehicles.filter(v => v.kind === 'shared' && v.status === 'Available').length;
  const availableChargers = baseline.chargers.filter(c => c.status === 'Available').length;
  const hubLimitKw = Number(baseline.hub.power_limit_kw);
  const powerLimitKw = parameters.powerLimitKw ?? hubLimitKw;
  const startMs = Date.parse(baseline.capturedAt);
  const charging = scenarioType === 'charger_outage' || scenarioType === 'charging_demand';
  const weights = parameters.weights ?? configuredWeights();

  // "Now": the live requests on all usable chargers with the configured weights. "Scenario": the scenario's assumptions.
  const outIds = new Set(scenarioType === 'charger_outage' ? parameters.outageChargerIds ?? [] : []);
  const live = existingRequests(baseline, new Set());
  const now = simulateChargingQueue({ requests: live, chargers: usableChargers(baseline.chargers), powerLimitKw: hubLimitKw,
    weights: configuredWeights(), startMs });
  const scenarioRequests = [...existingRequests(baseline, outIds),
    ...(charging && demand > 0 ? simulatedRequests(demand, parameters.urgentSharePercent, parameters.demandSeed, startMs) : [])];
  const remaining = usableChargers(baseline.chargers).filter(c => !outIds.has(c.id));
  const projected = charging
    ? simulateChargingQueue({ requests: scenarioRequests, chargers: remaining, powerLimitKw, weights, startMs })
    : now;
  // Same demand with the configured weights, so a run with other weights shows what the change gains or loses.
  const withConfigured = charging && !sameWeights(weights, configuredWeights())
    ? simulateChargingQueue({ requests: scenarioRequests, chargers: remaining, powerLimitKw, weights: configuredWeights(), startMs })
    : projected;
  const outAvailable = baseline.chargers.filter(c => outIds.has(c.id) && c.status === 'Available').length;

  const results = {
    label: 'Simulated',
    scenarioName: scenarioLabels[scenarioType],
    hubName: baseline.hub.name,
    baselineCapturedAt: baseline.capturedAt,
    warningPercent: config.thresholds.parkingWarningPercent,
    criticalPercent: config.thresholds.parkingCriticalPercent,
    currentAvailablePersonalSlots: personal.free,
    currentPersonalSlotOccupancyPercent: personal.percent,
    projectedPersonalSlotOccupancyPercent: personal.projectedPercent,
    currentSharedSlotOccupancyPercent: shared.percent,
    projectedSharedSlotOccupancyPercent: shared.projectedPercent,
    affectedSlotType: slotType,
    currentOccupancyLevel: levelOf(affected.percent),
    occupancyLevel: levelOf(affected.projectedPercent),
    unservedVehicles: affected.unserved,
    currentAvailableSharedVehicles: availableSharedVehicles,
    projectedAvailableSharedVehicles: availableSharedVehicles + (scenarioType === 'vehicle_imbalance' ? demand : 0),
    currentAvailableChargers: availableChargers,
    projectedAvailableChargers: Math.max(0, availableChargers - outAvailable),
    outageChargerCodes: parameters.outageChargerCodes ?? [],
    currentHubPowerLimitKw: hubLimitKw,
    hubPowerLimitKw: powerLimitKw,
    weights,
    usesConfiguredWeights: sameWeights(weights, configuredWeights()),
    currentConcurrentChargingCapacity: now.capacity,
    projectedConcurrentChargingCapacity: projected.capacity,
    currentChargingQueue: now.requests,
    projectedChargingQueue: projected.requests,
    currentLongestWaitMinutes: now.longestWait,
    projectedLongestWaitMinutes: projected.longestWait,
    currentAverageWaitMinutes: now.averageWait,
    projectedAverageWaitMinutes: projected.averageWait,
    projectedUrgentAverageWaitMinutes: projected.urgentAverageWait,
    currentVehiclesWithUsageTime: now.withUsageTime,
    projectedVehiclesWithUsageTime: projected.withUsageTime,
    currentLateVehicles: now.late,
    projectedLateVehicles: projected.late,
    currentOnTimePercent: now.onTimePercent,
    projectedOnTimePercent: projected.onTimePercent,
    configuredWeightsLateVehicles: withConfigured.late,
    configuredWeightsAverageWaitMinutes: withConfigured.averageWait,
    chargingTimeline: charging ? projected.timeline.slice(0, 60) : []
  };
  results.summary = buildSummary(scenarioType, results, parameters);
  return results;
}

const pctWeights = w => `${Math.round(w.need * 100)}/${Math.round(w.urgency * 100)}/${Math.round(w.waiting * 100)}`;

function buildSummary(type, r, parameters) {
  if (type === 'parking_surge' || type === 'capacity_pressure') {
    const start = type === 'capacity_pressure' ? `Starting from at least ${parameters.startOccupancyPercent}% occupancy, the` : 'The';
    const unserved = r.unservedVehicles ? ` ${r.unservedVehicles} vehicle(s) would find no free ${r.affectedSlotType} slot.` : '';
    return `${start} simulated ${r.affectedSlotType}-slot occupancy reaches ${r.affectedSlotType === 'Shared' ? r.projectedSharedSlotOccupancyPercent : r.projectedPersonalSlotOccupancyPercent}% (${r.occupancyLevel}).${unserved} This is a simulated forecast, not a live status change.`;
  }
  if (type === 'charger_outage' || type === 'charging_demand') {
    const opening = type === 'charger_outage'
      ? `${parameters.chargerOutageCount} charger(s) (${r.outageChargerCodes.join(', ')}) are out of service: ${r.projectedConcurrentChargingCapacity} charger(s) can run under a ${r.hubPowerLimitKw} kW limit${r.projectedChargingQueue ? ` for ${r.projectedChargingQueue} request(s)${parameters.demandDelta ? ` (${parameters.demandDelta} simulated, ${parameters.urgentSharePercent}% of them urgent)` : ''}` : ' and there is no live charging request'}.`
      : `${r.projectedChargingQueue} charging request(s) (${parameters.demandDelta} simulated, ${parameters.urgentSharePercent}% of them urgent) share ${r.projectedConcurrentChargingCapacity} charger(s) under the Hub's ${r.hubPowerLimitKw} kW limit.`;
    const wait = r.projectedLongestWaitMinutes === null ? 'Some requests never get a charger.'
      : !r.projectedChargingQueue ? 'Add charging demand to see the effect on waiting.'
      : r.projectedLongestWaitMinutes === 0 ? 'No request has to wait.'
      : `Average wait ${r.projectedAverageWaitMinutes} min, longest ${r.projectedLongestWaitMinutes} min.`;
    const late = r.projectedVehiclesWithUsageTime
      ? ` ${r.projectedLateVehicles} of ${r.projectedVehiclesWithUsageTime} vehicle(s) with a usage time would not be fully charged in time.` : '';
    const compare = r.usesConfiguredWeights ? '' : ` With the configured weights the same demand gives ${r.configuredWeightsLateVehicles} late vehicle(s).`;
    return `${opening} Scheduler weights need/urgency/waiting = ${pctWeights(r.weights)}. ${wait}${late}${compare} Live requests are unchanged.`;
  }
  return `${r.projectedAvailableSharedVehicles} shared vehicle(s) would be available at this Hub and its Shared-slot occupancy reaches ${r.projectedSharedSlotOccupancyPercent}% (${r.occupancyLevel}). The scenario highlights a possible distribution imbalance.`;
}

// Only a scenario that shows pressure produces a recommendation; a run without one says so in its summary.
function buildRecommendations(type, baseline, results, parameters) {
  const hubId = baseline.hub.id;
  if (type === 'charger_outage' || type === 'charging_demand') {
    const recommendations = [];
    if (results.projectedLongestWaitMinutes !== 0 || results.projectedLateVehicles > 0) {
      recommendations.push({
        type: 'ADJUST_CHARGING', title: 'Review the smart charging schedule',
        description: 'Pass a proposed charging-schedule adjustment to UC-022 for current-state validation.',
        benefit: results.projectedLateVehicles
          ? `Helps the ${results.projectedLateVehicles} vehicle(s) that would not be ready in time.`
          : results.projectedLongestWaitMinutes === null
            ? 'No charger can run in the scenario: the waiting requests need another plan.'
            : `Helps reduce a simulated wait of up to ${results.projectedLongestWaitMinutes} minutes.`,
        payload: { hubId, affectedHub: baseline.hub.name, projectedQueue: results.projectedChargingQueue,
          concurrentCapacity: results.projectedConcurrentChargingCapacity, longestWaitMinutes: results.projectedLongestWaitMinutes,
          lateVehicles: results.projectedLateVehicles }
      });
    }
    if (!results.usesConfiguredWeights && results.projectedLateVehicles < results.configuredWeightsLateVehicles) {
      recommendations.push({
        // Same type as other charging-schedule changes (UC-022; the recommendations table allows three types); payload.kind tells them apart.
        type: 'ADJUST_CHARGING', title: 'Review the Charging Scheduler weights',
        description: `With weights need/urgency/waiting = ${pctWeights(results.weights)} the simulation has ${results.projectedLateVehicles} late vehicle(s) instead of ${results.configuredWeightsLateVehicles} with the configured ${pctWeights(configuredWeights())}. An Admin decides whether to change charging.scheduler.weights in Settings.`,
        benefit: `${results.configuredWeightsLateVehicles - results.projectedLateVehicles} fewer vehicle(s) not ready in time in this scenario.`,
        payload: { kind: 'scheduler_weights', hubId, affectedHub: baseline.hub.name, testedWeights: results.weights, configuredWeights: configuredWeights(),
          lateWithTested: results.projectedLateVehicles, lateWithConfigured: results.configuredWeightsLateVehicles }
      });
    }
    return recommendations;
  }
  if (type === 'vehicle_imbalance') {
    const count = Math.min(parameters.demandDelta, results.projectedAvailableSharedVehicles);
    const target = pickDestinationHub(baseline.network, hubId, 'Shared', count);
    return [{
      type: 'REDISTRIBUTE_VEHICLES', title: 'Review vehicle redistribution',
      description: target
        ? `Prepare a proposed redistribution of ${count} shared vehicle(s) to ${target.name} for UC-018; the Operator validates source and destination capacity.`
        : 'No other Hub can receive vehicles in the baseline (open, free Shared slots with the 10% reserve, below warning level). Review manually.',
      benefit: 'May improve the distribution of shared vehicles between Hubs.',
      payload: { sourceHubId: hubId, targetHubId: target?.id ?? null, targetHubName: target?.name ?? null, vehicleCount: count }
    }];
  }
  if (results.occupancyLevel === 'Normal' && results.unservedVehicles === 0) return [];
  const slotType = results.affectedSlotType;
  const target = pickDestinationHub(baseline.network, hubId, slotType, Math.max(1, results.unservedVehicles));
  return [{
    type: 'REDIRECT_USERS', title: 'Review an alternative-Hub advisory',
    description: target
      ? `Pass a proposed redirect advisory towards ${target.name} to UC-020; the target Hub is checked again for warning level and free capacity.`
      : 'No other Hub is below warning level with free capacity in the baseline. Review manually.',
    benefit: 'May guide students toward Hubs with available capacity.',
    payload: { sourceHubId: hubId, targetHubId: target?.id ?? null, targetHubName: target?.name ?? null, slotType,
      projectedOccupancy: slotType === 'Shared' ? results.projectedSharedSlotOccupancyPercent : results.projectedPersonalSlotOccupancyPercent,
      level: results.occupancyLevel }
  }];
}

export function runSimulation({ user, hubId, scenarioType, ...input }) {
  requireValue(isOperator(user), 403, 'Only the Strategic Simulation Operator can run a what-if simulation.');
  requireValue(Object.hasOwn(scenarioLabels, scenarioType), 400, 'Choose a supported scenario type.');
  const runId = makeId('sim');
  // Everything is computed first; nothing is stored unless the whole run succeeds (UC-023 failure postcondition, BR-36).
  const baseline = captureBaseline(hubId);
  const parameters = readParameters(scenarioType, input, baseline);
  const results = simulate(scenarioType, baseline, parameters);
  const recommendations = buildRecommendations(scenarioType, baseline, results, parameters);
  if (!recommendations.length) results.summary += ' No coordination recommendation is needed for this scenario.';
  const now = nowIso();
  transaction(() => {
    db.prepare(`INSERT INTO simulation_runs
      (id,scenario_type,hub_id,label,baseline_json,parameters_json,results_json,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, scenarioType, hubId, 'Simulated', JSON.stringify(baseline), JSON.stringify(parameters), JSON.stringify(results), user.id, now);
    const add = db.prepare(`INSERT INTO recommendations
      (id,run_id,type,title,description,projected_benefit,payload_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,'Proposed',?)`);
    for (const rec of recommendations) {
      add.run(makeId('rec'), runId, rec.type, rec.title, rec.description, rec.benefit, JSON.stringify(rec.payload), now);
    }
    auditChange('SimulationRun', runId, 'SIMULATION_RUN_CREATED', { scenarioType, hubId, recommendationCount: recommendations.length }, user.id);
  });
  return getSimulationRun(runId);
}

// Read-only context for the scenario form: the selected Hub as it is now (no vehicle plates) and the limits of each input.
export function getHubBaselineContext(hubId) {
  const baseline = captureBaseline(hubId);
  const usable = usableChargers(baseline.chargers);
  const limit = Number(baseline.hub.power_limit_kw);
  const personal = slotStats(baseline.slots, 'Personal');
  const shared = slotStats(baseline.slots, 'Shared');
  const strip = s => ({ total: s.total, occupied: s.occupied, free: s.free, percent: s.percent, level: levelOf(s.percent) });
  return {
    hub: { id: baseline.hub.id, name: baseline.hub.name, status: baseline.hub.status, powerLimitKw: limit },
    slots: { Personal: strip(personal), Shared: strip(shared) },
    chargers: [...baseline.chargers].sort(byCode).map(c => ({ id: c.id, code: c.code, powerKw: c.power_kw, status: c.status,
      usable: !UNUSABLE_STATUSES.has(c.status) })),
    usableChargerCount: usable.length,
    concurrentChargingCapacity: chargingCapacity(baseline.chargers, limit).concurrent,
    chargingQueue: baseline.chargingQueue.length,
    availableSharedVehicles: baseline.vehicles.filter(v => v.kind === 'shared' && v.status === 'Available').length,
    thresholds: { warningPercent: config.thresholds.parkingWarningPercent, criticalPercent: config.thresholds.parkingCriticalPercent },
    defaults: { weights: configuredWeights(), startOccupancyPercent: 90, urgentSharePercent: 30, demandSeed: 1 },
    capturedAt: baseline.capturedAt
  };
}

export function listSimulationRuns() {
  return db.prepare(`SELECT r.id,r.scenario_type,r.hub_id,r.label,r.created_at,h.name AS hub_name,
    json_extract(r.results_json,'$.summary') AS summary,
    json_extract(r.parameters_json,'$.runName') AS run_name,
    (SELECT COUNT(*) FROM recommendations x WHERE x.run_id=r.id) AS recommendation_count
    FROM simulation_runs r JOIN hubs h ON h.id=r.hub_id ORDER BY r.created_at DESC`).all();
}

export function getSimulationRun(runId) {
  const run = db.prepare(`SELECT r.*,h.name AS hub_name FROM simulation_runs r JOIN hubs h ON h.id=r.hub_id WHERE r.id=?`).get(runId);
  if (!run) return null;
  return {
    ...run,
    baseline: parseJson(run.baseline_json),
    parameters: parseJson(run.parameters_json),
    results: parseJson(run.results_json),
    recommendations: db.prepare('SELECT * FROM recommendations WHERE run_id=? ORDER BY created_at').all(runId)
      .map(r => ({ ...r, payload: parseJson(r.payload_json) }))
  };
}

// UC-024: only stored runs are compared; the comparison names the runs and adds the difference to the first run.
export function compareSimulationRuns({ user, runIds }) {
  requireValue(isOperator(user), 403, 'Only the Strategic Simulation Operator can compare scenarios.');
  const ids = [...new Set((runIds || []).map(String))];
  requireValue(ids.length >= 2, 400, 'Select at least two different stored simulation runs (UC-024).');
  const runs = ids.map(getSimulationRun);
  const missing = ids.filter((id, i) => !runs[i]);
  requireValue(!missing.length, 404, `These simulation runs are not available: ${missing.join(', ')}. Select other runs.`);
  requireValue(runs.every(r => r.hub_id === runs[0].hub_id), 400, 'For this MVP comparison, select runs from the same Hub.');

  const metricNames = [...new Set(runs.flatMap(r => Object.entries(r.results)
    .filter(([, v]) => typeof v === 'number' || v === null).map(([k]) => k)))];
  const metrics = metricNames.map(metric => {
    const values = Object.fromEntries(runs.map(r => [r.id, r.results[metric] ?? null]));
    const first = values[runs[0].id];
    const differenceFromFirst = Object.fromEntries(runs.map(r => [r.id,
      typeof values[r.id] === 'number' && typeof first === 'number' ? values[r.id] - first : null]));
    return { metric, values, differenceFromFirst };
  });
  return {
    label: 'Simulated',
    comparedRunIds: ids,
    runs: runs.map(r => ({ id: r.id, scenario_type: r.scenario_type, label: r.label, hub_name: r.hub_name,
      created_at: r.created_at, parameters: r.parameters, results: r.results, recommendations: r.recommendations })),
    metrics
  };
}

/* ----------------------------------------------------------------------------------------------
 * UC-025: recommendations. Applying only starts the matching workflow (BR-34); live state never changes here.
 * -------------------------------------------------------------------------------------------- */
function liveSlotStats(hubId, slotType) {
  return slotStats(db.prepare('SELECT slot_type,status FROM parking_slots WHERE hub_id=?').all(hubId), slotType);
}

// Returns a reason when the recommendation is no longer feasible in the CURRENT network state, otherwise null.
function validateRecommendationNow(type, payload) {
  const openHub = id => db.prepare(`SELECT * FROM hubs WHERE id=? AND status='Open'`).get(id);
  if (type === 'ADJUST_CHARGING' && payload.kind === 'scheduler_weights') {
    // Still useful only while the configured weights are the ones the run compared against.
    return sameWeights(payload.configuredWeights, configuredWeights())
      ? null : 'The configured Scheduler weights have changed since this run.';
  }
  if (type === 'ADJUST_CHARGING') {
    if (!openHub(payload.hubId)) return 'The affected Hub is no longer open.';
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM charging_requests WHERE hub_id=? AND status IN ('Queued','Assigned')`).get(payload.hubId).c;
    return pending > 0 ? null : 'There is no waiting or assigned charging request left to adjust.';
  }
  if (!openHub(payload.sourceHubId)) return 'The source Hub is no longer open.';
  if (!payload.targetHubId) return 'The simulation found no Hub that can receive vehicles or users.';
  if (!openHub(payload.targetHubId)) return 'The target Hub is no longer open.';
  if (type === 'REDIRECT_USERS') {
    const stats = liveSlotStats(payload.targetHubId, payload.slotType || 'Personal');
    return stats.free > 0 && stats.percent < config.thresholds.parkingWarningPercent
      ? null : 'The target Hub is now at warning level or has no free capacity (BR-31).';
  }
  if (type === 'REDISTRIBUTE_VEHICLES') {
    const count = Number(payload.vehicleCount) || 0;
    const available = db.prepare(`SELECT COUNT(*) AS c FROM vehicles WHERE hub_id=? AND kind='shared' AND status='Available'`).get(payload.sourceHubId).c;
    if (count < 1 || available < count) return 'The source Hub can no longer release that many available shared vehicles (BR-29).';
    const stats = liveSlotStats(payload.targetHubId, 'Shared');
    return stats.free - count >= reserveSlots('Shared', stats.total)
      ? null : 'The target Hub would not keep its 10% free Shared-slot reserve (BR-29, BR-40).';
  }
  return 'Unknown recommendation type.';
}

const WORKFLOW_TARGETS = {
  REDISTRIBUTE_VEHICLES: 'UC-018 Coordinate Vehicle Redistribution',
  ADJUST_CHARGING: 'UC-022 Adjust a Charging Schedule',
  REDIRECT_USERS: 'UC-020 Redirect Users to Alternative Hubs'
};

export function applyRecommendation({ user, recommendationId }) {
  requireValue(isOperator(user), 403, 'Only the Strategic Simulation Operator can submit a recommendation.');
  const recommendation = db.prepare('SELECT * FROM recommendations WHERE id=?').get(recommendationId);
  requireValue(recommendation, 404, 'Recommendation not found.');
  requireValue(recommendation.status === 'Proposed', 409, 'Only a Proposed recommendation can be sent for execution.');
  const payloadForTarget = parseJson(recommendation.payload_json);
  const target = payloadForTarget?.kind === 'scheduler_weights'
    ? 'UC-022 Adjust a Charging Schedule (Admin: Charging Scheduler weights)' : WORKFLOW_TARGETS[recommendation.type];
  requireValue(target, 409, 'This recommendation type has no matching workflow.');
  const payload = parseJson(recommendation.payload_json);

  // BR-34 / UC-025 step 4 and E1: validate against the current state first. A failed application is recorded as such.
  const reason = validateRecommendationNow(recommendation.type, payload);
  if (reason) {
    auditChange('Recommendation', recommendationId, 'RECOMMENDATION_VALIDATION_FAILED', { reason }, user.id);
    throw new HttpError(409, `${reason} Review the recommendation or run the simulation again.`, { reason });
  }

  const now = nowIso();
  const handoffId = makeId('handoff');
  transaction(() => {
    const decided = db.prepare(`UPDATE recommendations SET status='Sent for Execution', decided_at=? WHERE id=? AND status='Proposed'`)
      .run(now, recommendationId);
    requireValue(decided.changes === 1, 409, 'The recommendation changed. Please reload and try again.');
    db.prepare(`INSERT INTO recommendation_handoffs
      (id,recommendation_id,target_workflow,status,prefilled_payload_json,created_by,created_at)
      VALUES (?,?,?,'Pending',?,?,?)`)
      .run(handoffId, recommendationId, target, JSON.stringify(payload), user.id, now);
    auditChange('Recommendation', recommendationId, 'RECOMMENDATION_SENT_FOR_EXECUTION', { targetWorkflow: target, handoffId }, user.id);
  });
  return {
    recommendation: db.prepare('SELECT * FROM recommendations WHERE id=?').get(recommendationId),
    handoff: db.prepare('SELECT * FROM recommendation_handoffs WHERE id=?').get(handoffId),
    note: 'The matching operational workflow is pending. The recommendation is not Applied until that workflow completes.'
  };
}

export function declineRecommendation({ user, recommendationId }) {
  requireValue(isOperator(user), 403, 'Only the Strategic Simulation Operator can decline a recommendation.');
  const result = db.prepare(`UPDATE recommendations SET status='Declined', decided_at=? WHERE id=? AND status='Proposed'`)
    .run(nowIso(), recommendationId);
  requireValue(result.changes === 1, 409, 'Only a Proposed recommendation can be declined.');
  auditChange('Recommendation', recommendationId, 'RECOMMENDATION_DECLINED', {}, user.id);
  return db.prepare('SELECT * FROM recommendations WHERE id=?').get(recommendationId);
}

export function listHandoffs() {
  return db.prepare(`SELECT h.*,r.title AS recommendation_title,r.status AS recommendation_status
    FROM recommendation_handoffs h JOIN recommendations r ON r.id=h.recommendation_id
    ORDER BY h.created_at DESC`).all().map(h => ({ ...h, prefilled_payload: parseJson(h.prefilled_payload_json) }));
}

// MVP stand-in for the receiving workflow (UC-018, UC-020, UC-022): the Operator confirms it was carried out.
export function completeHandoff({ user, handoffId, completionNote = '' }) {
  requireValue(user?.role === 'Operator' || user?.role === 'Admin', 403,
    'Only the Real-time Operations Operator can confirm a receiving workflow completion.');
  const note = String(completionNote || '').trim().slice(0, 500);
  transaction(() => {
    const now = nowIso();
    const handoff = db.prepare('SELECT * FROM recommendation_handoffs WHERE id=?').get(handoffId);
    requireValue(handoff, 404, 'Recommendation hand-off not found.');
    const done = db.prepare(`UPDATE recommendation_handoffs SET status='Completed', completed_at=? WHERE id=? AND status='Pending'`).run(now, handoffId);
    requireValue(done.changes === 1, 409, 'This hand-off is no longer pending.');
    db.prepare(`UPDATE recommendations SET status='Applied', decided_at=? WHERE id=? AND status='Sent for Execution'`)
      .run(now, handoff.recommendation_id);
    auditChange('RecommendationHandoff', handoffId, 'RECEIVING_WORKFLOW_CONFIRMED', { completionNote: note }, user.id);
  });
  return db.prepare('SELECT * FROM recommendation_handoffs WHERE id=?').get(handoffId);
}