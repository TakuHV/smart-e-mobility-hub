import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, auditChange, parseJson } from './commonService.js';

function captureBaseline(hubId) {
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  requireValue(hub, 404, 'Hub not found.');
  const vehicles = db.prepare(`SELECT id,plate,kind,vehicle_type,battery_level,status FROM vehicles WHERE hub_id=?`).all(hubId);
  const slots = db.prepare(`SELECT id,code,slot_type,status FROM parking_slots WHERE hub_id=?`).all(hubId);
  const chargers = db.prepare(`SELECT id,code,power_kw,status FROM chargers WHERE hub_id=?`).all(hubId);
  const queue = db.prepare(`SELECT id,vehicle_id,status,battery_level,next_required_usage_at FROM charging_requests
    WHERE hub_id=? AND status IN ('Queued','Assigned','Charging')`).all(hubId);
  return { hub, vehicles, slots, chargers, chargingQueue: queue, capturedAt: nowIso() };
}

const scenarioLabels = {
  parking_surge: 'Sudden increase of arrivals at a Hub',
  capacity_pressure: 'Hub approaching full parking capacity',
  charger_outage: 'Charger outage',
  charging_demand: 'Increased charging demand',
  vehicle_imbalance: 'Vehicle concentration at one Hub'
};

export function runSimulation({ user, hubId, scenarioType, demandDelta = 2, chargerOutageCount = 1, label = '' }) {
  requireValue(user?.role === 'Simulation Operator' || user?.role === 'Admin', 403,
    'Only the Strategic Simulation Operator can run a what-if simulation.');
  requireValue(Object.hasOwn(scenarioLabels, scenarioType), 400, 'Choose a supported scenario type.');
  const baseline = captureBaseline(hubId);
  const demand = Math.max(0, Math.min(20, Number(demandDelta) || 0));
  const outages = Math.max(0, Math.min(baseline.chargers.length, Number(chargerOutageCount) || 0));
  const availablePersonal = baseline.slots.filter(s => s.slot_type === 'Personal' && s.status === 'Available').length;
  const occupiedPersonal = baseline.slots.filter(s => s.slot_type === 'Personal' && s.status !== 'Available').length;
  const availableSharedVehicles = baseline.vehicles.filter(v => v.kind === 'shared' && v.status === 'Available').length;
  const availableChargers = baseline.chargers.filter(c => c.status === 'Available').length;
  const totalPersonal = baseline.slots.filter(s => s.slot_type === 'Personal').length;
  const projectedOccupancy = totalPersonal ? Math.min(100, Math.round((occupiedPersonal + demand) / totalPersonal * 100)) : 0;
  const projectedChargers = Math.max(0, availableChargers - (scenarioType === 'charger_outage' ? outages : 0));
  const projectedQueue = baseline.chargingQueue.length + (scenarioType === 'charging_demand' ? demand : 0);
  const results = {
    label: 'Simulated',
    scenarioName: scenarioLabels[scenarioType],
    hubName: baseline.hub.name,
    currentAvailablePersonalSlots: availablePersonal,
    projectedPersonalSlotOccupancyPercent: projectedOccupancy,
    currentAvailableSharedVehicles: availableSharedVehicles,
    currentAvailableChargers: availableChargers,
    projectedAvailableChargers: projectedChargers,
    currentChargingQueue: baseline.chargingQueue.length,
    projectedChargingQueue: projectedQueue,
    summary: buildSummary(scenarioType, projectedOccupancy, projectedChargers, projectedQueue, availableSharedVehicles)
  };
  const parameters = { demandDelta: demand, chargerOutageCount: outages, note: 'Scenario assumptions affect this stored simulation only; live resources are not changed.' };
  const runId = makeId('sim');
  const now = nowIso();
  const recommendations = buildRecommendations(scenarioType, baseline, results, parameters);
  transaction(() => {
    db.prepare(`INSERT INTO simulation_runs
      (id,scenario_type,hub_id,label,baseline_json,parameters_json,results_json,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, scenarioType, hubId, 'Simulated', JSON.stringify(baseline), JSON.stringify(parameters), JSON.stringify(results), user.id, now);
    const add = db.prepare(`INSERT INTO recommendations
      (id,run_id,type,title,description,projected_benefit,payload_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,'Proposed',?)`);
    recommendations.forEach(rec => add.run(makeId('rec'), runId, rec.type, rec.title, rec.description,
      rec.benefit, JSON.stringify(rec.payload), now));
    auditChange('SimulationRun', runId, 'SIMULATION_RUN_CREATED', { scenarioType, hubId, recommendationCount: recommendations.length }, user.id);
  });
  return getSimulationRun(runId);
}

function buildSummary(type, occupancy, chargers, queue, availableVehicles) {
  if (type === 'parking_surge' || type === 'capacity_pressure') return `The simulated Personal-slot occupancy reaches ${occupancy}%. This is a simulated forecast, not a live status change.`;
  if (type === 'charger_outage') return `${chargers} charger(s) remain available in the scenario. The live charger status is unchanged.`;
  if (type === 'charging_demand') return `The simulated charging queue contains ${queue} request(s). Live requests are unchanged.`;
  return `${availableVehicles} shared vehicle(s) are currently available in the baseline. The scenario highlights a possible distribution imbalance.`;
}

function buildRecommendations(type, baseline, results, parameters) {
  if (type === 'charger_outage' || type === 'charging_demand') return [{
    type: 'ADJUST_CHARGING', title: 'Review the smart charging schedule',
    description: 'Pass a proposed charging-schedule adjustment to UC-022 for current-state validation.',
    benefit: 'Helps the Operator respond to simulated charger capacity or charging-demand pressure.',
    payload: { hubId: baseline.hub.id, projectedQueue: results.projectedChargingQueue, affectedHub: baseline.hub.name }
  }];
  if (type === 'vehicle_imbalance') return [{
    type: 'REDISTRIBUTE_VEHICLES', title: 'Review vehicle redistribution',
    description: 'Prepare a proposed redistribution plan for UC-018; a receiving Operator must validate source and destination capacity.',
    benefit: 'May improve the distribution of shared vehicles between Hubs.',
    payload: { sourceHubId: baseline.hub.id, availableSharedVehicles: results.currentAvailableSharedVehicles }
  }];
  return [{
    type: 'REDIRECT_USERS', title: 'Review an alternative-Hub advisory',
    description: 'Pass a proposed redirect advisory to UC-020; the target Hub must be checked for warning level and free capacity.',
    benefit: 'May guide students toward Hubs with available capacity.',
    payload: { sourceHubId: baseline.hub.id, projectedOccupancy: results.projectedPersonalSlotOccupancyPercent }
  }];
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

export function compareSimulationRuns({ user, runIds }) {
  requireValue(user?.role === 'Simulation Operator' || user?.role === 'Admin', 403,
    'Only the Strategic Simulation Operator can compare scenarios.');
  const ids = [...new Set((runIds || []).map(String))];
  requireValue(ids.length >= 2, 400, 'Select at least two stored simulation runs (UC-024).');
  const runs = ids.map(getSimulationRun);
  requireValue(runs.every(Boolean), 404, 'One or more selected simulation runs could not be found.');
  requireValue(runs.every(r => r.hub_id === runs[0].hub_id), 400,
    'For this MVP comparison, select runs from the same Hub.');
  return runs.map(r => ({ id: r.id, scenario_type: r.scenario_type, label: r.label,
    hub_name: r.hub_name, created_at: r.created_at, results: r.results, recommendations: r.recommendations }));
}

export function applyRecommendation({ user, recommendationId }) {
  requireValue(user?.role === 'Simulation Operator' || user?.role === 'Admin', 403,
    'Only the Strategic Simulation Operator can submit a recommendation.');
  const recommendation = db.prepare('SELECT * FROM recommendations WHERE id=?').get(recommendationId);
  requireValue(recommendation, 404, 'Recommendation not found.');
  requireValue(recommendation.status === 'Proposed', 409, 'Only a Proposed recommendation can be sent for execution.');
  const payload = parseJson(recommendation.payload_json);
  // Validate against current state before hand-off. Do not mutate live resource state here (BR-34).
  if (payload.hubId || payload.sourceHubId) {
    const hubId = payload.hubId || payload.sourceHubId;
    requireValue(db.prepare('SELECT id FROM hubs WHERE id=? AND status=\'Open\'').get(hubId), 409,
      'The affected Hub is no longer open. Review or rerun the simulation.');
  }
  const target = {
    REDISTRIBUTE_VEHICLES: 'UC-018 Coordinate Vehicle Redistribution',
    ADJUST_CHARGING: 'UC-022 Adjust a Charging Schedule',
    REDIRECT_USERS: 'UC-020 Redirect Users to Alternative Hubs'
  }[recommendation.type];
  const now = nowIso();
  const handoffId = makeId('handoff');
  transaction(() => {
    db.prepare(`UPDATE recommendations SET status='Sent for Execution', decided_at=? WHERE id=?`).run(now, recommendationId);
    db.prepare(`INSERT INTO recommendation_handoffs
      (id,recommendation_id,target_workflow,status,prefilled_payload_json,created_by,created_at)
      VALUES (?,?,?,'Pending',?,?,?)`)
      .run(handoffId, recommendationId, target, JSON.stringify(payload), user.id, now);
    auditChange('Recommendation', recommendationId, 'RECOMMENDATION_SENT_FOR_EXECUTION', { targetWorkflow: target, handoffId }, user.id);
  });
  return { recommendation: db.prepare('SELECT * FROM recommendations WHERE id=?').get(recommendationId),
    handoff: db.prepare('SELECT * FROM recommendation_handoffs WHERE id=?').get(handoffId),
    note: 'The matching operational workflow is pending. The recommendation is not Applied until that workflow completes.' };
}

export function declineRecommendation({ user, recommendationId }) {
  requireValue(user?.role === 'Simulation Operator' || user?.role === 'Admin', 403,
    'Only the Strategic Simulation Operator can decline a recommendation.');
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

export function completeHandoff({ user, handoffId, completionNote = '' }) {
  requireValue(user?.role === 'Operator' || user?.role === 'Admin', 403,
    'Only the Real-time Operations Operator can confirm a receiving workflow completion.');
  const handoff = db.prepare('SELECT * FROM recommendation_handoffs WHERE id=?').get(handoffId);
  requireValue(handoff, 404, 'Recommendation hand-off not found.');
  requireValue(handoff.status === 'Pending', 409, 'This hand-off is no longer pending.');
  const now = nowIso();
  transaction(() => {
    db.prepare(`UPDATE recommendation_handoffs SET status='Completed', completed_at=? WHERE id=?`).run(now, handoffId);
    db.prepare(`UPDATE recommendations SET status='Applied', decided_at=? WHERE id=? AND status='Sent for Execution'`)
      .run(now, handoff.recommendation_id);
    auditChange('RecommendationHandoff', handoffId, 'RECEIVING_WORKFLOW_CONFIRMED', { completionNote }, user.id);
  });
  return db.prepare('SELECT * FROM recommendation_handoffs WHERE id=?').get(handoffId);
}
