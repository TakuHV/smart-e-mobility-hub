import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, auditChange, parseJson } from './commonService.js';

/*
 * What-if simulation (UC-023, UC-024, UC-025; BR-32, BR-33, BR-34).
 * A run reads a baseline snapshot and writes ONLY simulation_runs, recommendations, recommendation_handoffs
 * and audit rows. It never changes bookings, vehicles, slots, chargers or charging requests.
 */

// BR-26 default thresholds, BR-40 shared-slot reserve. A per-Hub override (UC-016) is not read in the MVP.
const WARNING_PERCENT = 80;
const CRITICAL_PERCENT = 95;
const SHARED_FREE_RESERVE_PERCENT = 10;
const UNUSABLE_STATUSES = new Set(['Out of Service', 'Status Unknown', 'Connection Lost']); // BR-28
const DEFAULT_SESSION_MINUTES = 45; // scenario assumption only (see Technical Design Document: Proposed Value)

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
function slotStats(slots, type, extra = 0) {
  const usable = slots.filter(s => s.slot_type === type && !UNUSABLE_STATUSES.has(s.status));
  const total = usable.length;
  const occupied = usable.filter(s => s.status !== 'Available').length;
  const projectedOccupied = Math.min(total, occupied + extra);
  return {
    total, occupied, free: total - occupied,
    percent: total ? Math.round((occupied / total) * 100) : 0,
    projectedPercent: total ? Math.round((projectedOccupied / total) * 100) : 0,
    unserved: Math.max(0, occupied + extra - total)
  };
}

function levelOf(percent) {
  if (percent >= CRITICAL_PERCENT) return 'Critical';
  if (percent >= WARNING_PERCENT) return 'Warning';
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
  return slotType === 'Shared' ? Math.ceil(total * SHARED_FREE_RESERVE_PERCENT / 100) : 0; // BR-40
}

// A Hub that can receive vehicles or users: open, enough free slots (BR-40 reserve kept) and below warning level (BR-31).
function pickDestinationHub(network, sourceHubId, slotType, needed) {
  return network
    .filter(h => h.id !== sourceHubId && h.status === 'Open')
    .map(h => ({ hub: h, stats: h.slots[slotType] }))
    .filter(({ stats }) => stats.total > 0
      && stats.free - needed >= reserveSlots(slotType, stats.total)
      && Math.round(((stats.occupied + needed) / stats.total) * 100) < WARNING_PERCENT)
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
  const chargingQueue = db.prepare(`SELECT id,vehicle_id,status,battery_level,next_required_usage_at FROM charging_requests
    WHERE hub_id=? AND status IN ('Queued','Assigned','Charging')`).all(hubId);
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

function readParameters(scenarioType, input, baseline) {
  const parameters = {};
  const name = String(input.label ?? '').trim().slice(0, 80);
  if (name) parameters.runName = name;
  if (scenarioType === 'parking_surge' || scenarioType === 'capacity_pressure') {
    parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra arriving vehicles)', 1, 200, 2);
    const slotType = input.slotType ?? 'Personal';
    requireValue(['Personal', 'Shared'].includes(slotType), 400, 'slotType must be Personal or Shared.');
    parameters.slotType = slotType;
  } else if (scenarioType === 'vehicle_imbalance') {
    parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra vehicles concentrated at this Hub)', 1, 200, 2);
  } else {
    if (scenarioType === 'charging_demand') {
      parameters.demandDelta = readInteger(input.demandDelta, 'demandDelta (extra charging requests)', 1, 200, 2);
    } else {
      const usable = baseline.chargers.filter(c => !UNUSABLE_STATUSES.has(c.status)).length;
      requireValue(usable > 0, 400, 'This Hub has no usable charger to put out of service.');
      parameters.chargerOutageCount = readInteger(input.chargerOutageCount, 'chargerOutageCount', 1, usable, 1);
    }
    parameters.estimatedSessionMinutes = readInteger(input.estimatedSessionMinutes, 'estimatedSessionMinutes', 10, 180, DEFAULT_SESSION_MINUTES);
    if (input.powerLimitKw !== undefined && input.powerLimitKw !== null && input.powerLimitKw !== '') {
      const limit = Number(input.powerLimitKw);
      requireValue(Number.isFinite(limit) && limit > 0 && limit <= 1000, 400, 'powerLimitKw must be a number above 0 and at most 1000.');
      parameters.powerLimitKw = limit; // what-if on a different Hub Power Limit; comparable with other runs (UC-024)
    }
  }
  parameters.note = 'Scenario assumptions affect this stored simulation only; live resources are not changed.';
  return parameters;
}

/* ----------------------------------------------------------------------------------------------
 * Simulation
 * -------------------------------------------------------------------------------------------- */
function simulate(scenarioType, baseline, parameters) {
  const demand = parameters.demandDelta ?? 0;
  const slotType = parameters.slotType ?? (scenarioType === 'vehicle_imbalance' ? 'Shared' : 'Personal');
  const parkingExtra = ['parking_surge', 'capacity_pressure', 'vehicle_imbalance'].includes(scenarioType) ? demand : 0;
  const personal = slotStats(baseline.slots, 'Personal', slotType === 'Personal' ? parkingExtra : 0);
  const shared = slotStats(baseline.slots, 'Shared', slotType === 'Shared' ? parkingExtra : 0);
  const affected = slotType === 'Shared' ? shared : personal;

  const availableSharedVehicles = baseline.vehicles.filter(v => v.kind === 'shared' && v.status === 'Available').length;
  const availableChargers = baseline.chargers.filter(c => c.status === 'Available').length;
  const powerLimitKw = parameters.powerLimitKw ?? Number(baseline.hub.power_limit_kw);

  // Charging: capacity under the Hub Power Limit, then how long the last request in the line waits.
  const outageCount = scenarioType === 'charger_outage' ? parameters.chargerOutageCount : 0;
  const remaining = [...baseline.chargers].filter(c => !UNUSABLE_STATUSES.has(c.status))
    .sort((a, b) => String(a.code).localeCompare(String(b.code))).slice(outageCount);
  const currentCapacity = chargingCapacity(baseline.chargers, Number(baseline.hub.power_limit_kw)).concurrent;
  const projectedCapacity = chargingCapacity(remaining, powerLimitKw).concurrent;
  const extraRequests = scenarioType === 'charging_demand' ? demand : 0;
  const projectedQueue = baseline.chargingQueue.length + extraRequests;
  const sessionMinutes = parameters.estimatedSessionMinutes ?? DEFAULT_SESSION_MINUTES;
  const waitingRequests = Math.max(0, projectedQueue - projectedCapacity);
  const longestWait = waitingRequests === 0 ? 0 : (projectedCapacity > 0 ? Math.ceil(waitingRequests / projectedCapacity) * sessionMinutes : null);

  const results = {
    label: 'Simulated',
    scenarioName: scenarioLabels[scenarioType],
    hubName: baseline.hub.name,
    currentAvailablePersonalSlots: personal.free,
    projectedPersonalSlotOccupancyPercent: personal.projectedPercent,
    projectedSharedSlotOccupancyPercent: shared.projectedPercent,
    affectedSlotType: slotType,
    occupancyLevel: levelOf(affected.projectedPercent),
    unservedVehicles: affected.unserved,
    currentAvailableSharedVehicles: availableSharedVehicles,
    projectedAvailableSharedVehicles: availableSharedVehicles + (scenarioType === 'vehicle_imbalance' ? demand : 0),
    currentAvailableChargers: availableChargers,
    projectedAvailableChargers: Math.max(0, availableChargers - outageCount),
    hubPowerLimitKw: powerLimitKw,
    currentConcurrentChargingCapacity: currentCapacity,
    projectedConcurrentChargingCapacity: projectedCapacity,
    currentChargingQueue: baseline.chargingQueue.length,
    projectedChargingQueue: projectedQueue,
    projectedLongestWaitMinutes: longestWait
  };
  results.summary = buildSummary(scenarioType, results, parameters);
  return results;
}

function buildSummary(type, r, parameters) {
  if (type === 'parking_surge' || type === 'capacity_pressure') {
    const unserved = r.unservedVehicles ? ` ${r.unservedVehicles} vehicle(s) would find no free ${r.affectedSlotType} slot.` : '';
    return `The simulated ${r.affectedSlotType}-slot occupancy reaches ${r.affectedSlotType === 'Shared' ? r.projectedSharedSlotOccupancyPercent : r.projectedPersonalSlotOccupancyPercent}% (${r.occupancyLevel}).${unserved} This is a simulated forecast, not a live status change.`;
  }
  const wait = r.projectedLongestWaitMinutes === null ? 'no charger can run under the Power Limit' : `the longest simulated wait is about ${r.projectedLongestWaitMinutes} minutes`;
  if (type === 'charger_outage') {
    return `${parameters.chargerOutageCount} charger(s) are out of service in the scenario: ${r.projectedConcurrentChargingCapacity} can charge at the same time under a ${r.hubPowerLimitKw} kW limit and ${wait}. Live charger status is unchanged.`;
  }
  if (type === 'charging_demand') {
    return `The simulated charging queue holds ${r.projectedChargingQueue} request(s) for ${r.projectedConcurrentChargingCapacity} concurrent charger(s) under a ${r.hubPowerLimitKw} kW limit; ${wait}. Live requests are unchanged.`;
  }
  return `${r.projectedAvailableSharedVehicles} shared vehicle(s) would be available at this Hub and its Shared-slot occupancy reaches ${r.projectedSharedSlotOccupancyPercent}% (${r.occupancyLevel}). The scenario highlights a possible distribution imbalance.`;
}

function buildRecommendations(type, baseline, results, parameters) {
  const hubId = baseline.hub.id;
  if (type === 'charger_outage' || type === 'charging_demand') {
    return [{
      type: 'ADJUST_CHARGING', title: 'Review the smart charging schedule',
      description: 'Pass a proposed charging-schedule adjustment to UC-022 for current-state validation.',
      benefit: 'Helps the Operator respond to simulated charger capacity or charging-demand pressure.',
      payload: { hubId, affectedHub: baseline.hub.name, projectedQueue: results.projectedChargingQueue,
        concurrentCapacity: results.projectedConcurrentChargingCapacity, longestWaitMinutes: results.projectedLongestWaitMinutes }
    }];
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
  const slotType = results.affectedSlotType;
  const target = pickDestinationHub(baseline.network, hubId, slotType, 1);
  return [{
    type: 'REDIRECT_USERS', title: 'Review an alternative-Hub advisory',
    description: target
      ? `Pass a proposed redirect advisory towards ${target.name} to UC-020; the target Hub is checked again for warning level and free capacity.`
      : 'No other Hub is below warning level with free capacity in the baseline. Review manually.',
    benefit: results.occupancyLevel === 'Normal'
      ? 'Optional: the simulated occupancy stays at a normal level.'
      : 'May guide students toward Hubs with available capacity.',
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

export function listSimulationRuns() {
  return db.prepare(`SELECT r.id,r.scenario_type,r.hub_id,r.label,r.created_at,h.name AS hub_name,
    json_extract(r.results_json,'$.summary') AS summary,
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
    return stats.free > 0 && stats.percent < WARNING_PERCENT
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
  const target = WORKFLOW_TARGETS[recommendation.type];
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