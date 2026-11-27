import '../testSetup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, makeId, nowIso } from '../src/database/db.js';
import { seedDatabase } from '../src/database/seed.js';
import { createBooking, pickupBooking, returnBooking } from '../src/services/vehicleService.js';
import { createReservation, cancelReservation } from '../src/services/parkingService.js';
import { createPersonalChargingRequest, connectPersonalVehicle, completeCharging,
  runScheduler, startMoveRequest, completeMoveRequest, enqueueSharedVehicle } from '../src/services/chargingService.js';
import { runSimulation, compareSimulationRuns, applyRecommendation, completeHandoff } from '../src/services/simulationService.js';

seedDatabase();
const addUser = (role) => {
  const user = { id: makeId('test-user'), full_name: `Test ${role} ${Date.now()}`, role };
  db.prepare('INSERT INTO users (id,full_name,role,created_at) VALUES (?,?,?,?)')
    .run(user.id,user.full_name,user.role,nowIso());
  return user;
};
const addVehicle = ({ kind, hubId, ownerId = null, battery = 64, connector = 'Type2' }) => {
  const id=makeId('test-vehicle');
  db.prepare(`INSERT INTO vehicles
    (id,plate,vehicle_type,connector_type,kind,hub_id,owner_id,battery_level,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id,`TEST-${id.slice(-8)}`,'Car',connector,kind,hubId,ownerId,battery,
      battery < 20 ? 'Needs Charging' : 'Available',nowIso());
  return db.prepare('SELECT * FROM vehicles WHERE id=?').get(id);
};

test('UC-005/006/007: booking, pickup, low-battery return and automatic queueing', () => {
  const student=addUser('Student');
  const hubId=makeId('test-booking-hub');
  const now=nowIso();
  db.prepare(`INSERT INTO hubs (id,code,name,location,open_time,close_time,power_limit_kw,status,sensor_updated_at)
    VALUES (?,?,? ,?,'05:00','23:00',30,'Open',?)`)
    .run(hubId, `TB-${hubId.slice(-8)}`, 'Test Booking Hub', 'Automated Test', now);
  const slotId=makeId('test-booking-slot');
  db.prepare(`INSERT INTO parking_slots
    (id,hub_id,code,slot_type,supported_vehicle_types_json,status,updated_at)
    VALUES (?,?,?,'Shared',?,'Available',?)`)
    .run(slotId, hubId, 'TEST-S-01', JSON.stringify(['Car']), now);
  const vehicle=addVehicle({kind:'shared',hubId,battery:64});
  const booking=createBooking({user:student,vehicleId:vehicle.id});
  assert.equal(booking.status,'Confirmed');
  assert.equal(db.prepare('SELECT status FROM vehicles WHERE id=?').get(vehicle.id).status,'Reserved');
  pickupBooking({user:student,bookingId:booking.id});
  assert.equal(db.prepare('SELECT status FROM vehicles WHERE id=?').get(vehicle.id).status,'In Use');
  const returned=returnBooking({user:student,bookingId:booking.id,returnSlotId:slotId,batteryLevel:15});
  assert.equal(returned.booking.status,'Completed');
  assert.equal(returned.vehicleStatus,'Needs Charging');
  assert.equal(returned.chargingQueued,true);
  assert.ok(db.prepare(`SELECT id FROM charging_requests WHERE vehicle_id=? AND request_type='shared_automatic' AND status IN ('Queued','Assigned')`).get(vehicle.id));
});

test('UC-008: personal parking reservation occupies and releases a Personal slot on cancellation', () => {
  const student=addUser('Student');
  const vehicle=addVehicle({kind:'personal',hubId:'hub-library',ownerId:student.id,battery:54});
  const slot=db.prepare(`SELECT * FROM parking_slots WHERE hub_id='hub-library' AND slot_type='Personal' AND status='Available' LIMIT 1`).get();
  const start=new Date(Date.now()+60*60000), end=new Date(Date.now()+180*60000);
  const reservation=createReservation({user:student,vehicleId:vehicle.id,hubId:'hub-library',slotId:slot.id,startAt:start.toISOString(),endAt:end.toISOString()});
  assert.equal(reservation.status,'Confirmed');
  assert.equal(db.prepare('SELECT status FROM parking_slots WHERE id=?').get(slot.id).status,'Reserved');
  cancelReservation({user:student,reservationId:reservation.id});
  assert.equal(db.prepare('SELECT status FROM parking_slots WHERE id=?').get(slot.id).status,'Available');
});

test('UC-009/021 and BR-46: personal charging, removal request and charger release only after Done', () => {
  const student=addUser('Student');
  const operator=addUser('Operator');
  // The test must not depend on the time of day: the Hub is open all day and the next use is soon.
  db.prepare("UPDATE hubs SET open_time='00:00', close_time='23:59' WHERE id='hub-engineering'").run();
  const vehicle=addVehicle({kind:'personal',hubId:'hub-engineering',ownerId:student.id,battery:32});
  const request=createPersonalChargingRequest({user:student,vehicleId:vehicle.id,hubId:'hub-engineering',batteryLevel:32,
    nextRequiredUsageAt:new Date(Date.now()+20*60000).toISOString()});
  assert.ok(['Assigned','Queued'].includes(request.status));
  if(request.status==='Queued') runScheduler('hub-engineering');
  const assigned=db.prepare('SELECT * FROM charging_requests WHERE id=?').get(request.id);
  assert.equal(assigned.status,'Assigned');
  connectPersonalVehicle({user:student,requestId:request.id});
  const done=completeCharging({user:student,requestId:request.id,finalBatteryLevel:90});
  const chargerId=done.request.charger_id;
  assert.equal(db.prepare('SELECT status FROM chargers WHERE id=?').get(chargerId).status,'Awaiting Removal');
  startMoveRequest({user:operator,moveRequestId:done.moveRequest.id});
  completeMoveRequest({user:operator,moveRequestId:done.moveRequest.id});
  assert.notEqual(db.prepare('SELECT status FROM chargers WHERE id=?').get(chargerId).status,'Awaiting Removal'); // released; the scheduler may give it to the next vehicle at once
});

test('UC-023/024/025: simulation snapshots stay separate from live data and recommendations hand off', () => {
  const simulationOperator=addUser('Simulation Operator');
  const operator=addUser('Operator');
  const before=db.prepare("SELECT id,status,battery_level FROM vehicles WHERE hub_id='hub-central' ORDER BY id").all();
  const run1=runSimulation({user:simulationOperator,hubId:'hub-central',scenarioType:'parking_surge',demandDelta:2,chargerOutageCount:1});
  const run2=runSimulation({user:simulationOperator,hubId:'hub-central',scenarioType:'capacity_pressure',demandDelta:3,chargerOutageCount:1});
  assert.equal(run1.label,'Simulated');
  assert.equal(run1.recommendations[0].status,'Proposed');
  const comparison=compareSimulationRuns({user:simulationOperator,runIds:[run1.id,run2.id]});
  assert.equal(comparison.runs.length,2);
  const after=db.prepare("SELECT id,status,battery_level FROM vehicles WHERE hub_id='hub-central' ORDER BY id").all();
  assert.deepEqual(after,before,'Simulation must not mutate live vehicle state.');
  const sent=applyRecommendation({user:simulationOperator,recommendationId:run1.recommendations[0].id});
  assert.equal(sent.recommendation.status,'Sent for Execution');
  const completed=completeHandoff({user:operator,handoffId:sent.handoff.id,completionNote:'Receiving workflow completion confirmed in test.'});
  assert.equal(completed.status,'Completed');
  assert.equal(db.prepare('SELECT status FROM recommendations WHERE id=?').get(run1.recommendations[0].id).status,'Applied');
});


test('Shared vehicle Move Vehicle Request cycle: TO_CHARGER and FROM_CHARGER keep charger occupied until Done', () => {
  const operator = addUser('Operator');
  const hubId = makeId('test-hub-shared-move');
  const now = nowIso();
  db.prepare(`INSERT INTO hubs (id,code,name,location,open_time,close_time,power_limit_kw,status,sensor_updated_at)
    VALUES (?,?,? ,?,'05:00','23:00',30,'Open',?)`)
    .run(hubId, `MVR-${hubId.slice(-8)}`, 'Test Shared Move Hub', 'Automated Test', now);
  const vehicleId = makeId('test-shared-mvr');
  db.prepare(`INSERT INTO vehicles
    (id,plate,vehicle_type,connector_type,kind,hub_id,owner_id,battery_level,status,updated_at)
    VALUES (?,?,?,?, 'shared', ?, NULL, 16, 'Needs Charging', ?)`)
    .run(vehicleId, `MVR-${vehicleId.slice(-8)}`, 'Car', 'Type2', hubId, now);
  const slotId = makeId('test-shared-slot');
  db.prepare(`INSERT INTO parking_slots
    (id,hub_id,code,slot_type,supported_vehicle_types_json,status,current_vehicle_id,updated_at)
    VALUES (?,?,?,'Shared',?,'Occupied',?,?)`)
    .run(slotId, hubId, 'TEST-S-01', JSON.stringify(['Car']), vehicleId, now);
  const chargerId = makeId('test-charger');
  db.prepare(`INSERT INTO chargers (id,hub_id,code,connector_types_json,power_kw,status,updated_at)
    VALUES (?,?,?,? ,7.2,'Available',?)`)
    .run(chargerId, hubId, 'TEST-CH-1', JSON.stringify(['Type2']), now);

  const requestId = enqueueSharedVehicle(vehicleId, hubId);
  runScheduler(hubId, operator.id);
  const assigned = db.prepare('SELECT * FROM charging_requests WHERE id=?').get(requestId);
  assert.equal(assigned.status, 'Assigned');
  assert.equal(assigned.charger_id, chargerId);

  const toCharger = db.prepare(`SELECT * FROM move_vehicle_requests WHERE charging_request_id=? AND direction='TO_CHARGER'`).get(requestId);
  assert.equal(toCharger.status, 'Requested');
  startMoveRequest({ user: operator, moveRequestId: toCharger.id });
  completeMoveRequest({ user: operator, moveRequestId: toCharger.id });
  assert.equal(db.prepare('SELECT status FROM parking_slots WHERE id=?').get(slotId).status, 'Reserved',
    'A shared vehicle keeps its Shared slot reserved while charging (BR-39).');
  assert.equal(db.prepare('SELECT status FROM charging_requests WHERE id=?').get(requestId).status, 'Charging');
  assert.equal(db.prepare('SELECT status FROM chargers WHERE id=?').get(chargerId).status, 'Charging');

  const completed = completeCharging({ user: operator, requestId, finalBatteryLevel: 90 });
  assert.equal(completed.request.status, 'Completed');
  assert.equal(db.prepare('SELECT status FROM chargers WHERE id=?').get(chargerId).status, 'Awaiting Removal');
  const fromCharger = completed.moveRequest;
  assert.equal(fromCharger.direction, 'FROM_CHARGER');
  startMoveRequest({ user: operator, moveRequestId: fromCharger.id });
  completeMoveRequest({ user: operator, moveRequestId: fromCharger.id });
  assert.equal(db.prepare('SELECT status FROM parking_slots WHERE id=?').get(slotId).status, 'Occupied',
    'The shared vehicle occupies its held Shared slot again after removal (BR-39 / BR-46).');
  assert.notEqual(db.prepare('SELECT status FROM chargers WHERE id=?').get(chargerId).status, 'Awaiting Removal'); // released; an idle shared vehicle may take it at once
  assert.equal(db.prepare('SELECT status FROM vehicles WHERE id=?').get(vehicleId).status, 'Available');
});
