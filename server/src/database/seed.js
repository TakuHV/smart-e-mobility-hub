import { ensureDemoAccounts } from '../services/authService.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, transaction, nowIso } from './db.js';
import { config } from '../config.js';

/*
 * Mock data for the demo (the simulated sensor feed). Hub Power Limits and charger power are EXAMPLE values read from
 * data/configuration.json (demoData), not a group-approved configuration. A 1 kW charger is about what a real electric
 * scooter charger delivers (3.5 kWh in roughly 3.5 hours).
 * All three Hubs are identical: five chargers of 1 kW and a 5 kW Hub Power Limit, so all five chargers run together in normal
 * operation. The limit only matters in a what-if run (for example a power outage with a smaller backup supply).
 */
const CHARGER_POWER_KW = config.demoData.seedChargerPowerKw;
const HUB_LIMIT_KW = config.demoData.seedHubPowerLimitsKw;

export function seedDatabase() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM hubs').get().count;
  if (existing > 0) return { seeded: false, reason: 'Database already contains seed data.' };

  const now = nowIso();
  transaction(() => {
    const addUser = db.prepare('INSERT OR IGNORE INTO users (id, full_name, role, created_at) VALUES (?, ?, ?, ?)');
    [
      ['student-demo', 'Demo Student', 'Student'],
      ['operator-demo', 'Demo Operator', 'Operator'],
      ['simulation-demo', 'Demo Simulation Operator', 'Simulation Operator'],
      ['admin-demo', 'Demo Admin', 'Admin']
    ].forEach(user => addUser.run(...user, now));

    ensureDemoAccounts();

    const addHub = db.prepare(`INSERT INTO hubs
      (id, code, name, location, open_time, close_time, power_limit_kw, status, sensor_updated_at)
      VALUES (?, ?, ?, ?, '05:00', '23:00', ?, 'Open', ?)`);
    const hubs = [
      ['hub-central', 'HUB-01', 'Hub A', 'Main Campus', HUB_LIMIT_KW['hub-central']],
      ['hub-engineering', 'HUB-02', 'Hub B', 'Engineering Zone', HUB_LIMIT_KW['hub-engineering']],
      ['hub-library', 'HUB-03', 'Hub C', 'Library Area', HUB_LIMIT_KW['hub-library']]
    ];
    hubs.forEach(hub => addHub.run(...hub, now));

    const addSlot = db.prepare(`INSERT INTO parking_slots
      (id, hub_id, code, slot_type, supported_vehicle_types_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const occupySlot = db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=?`);
    const addVehicle = db.prepare(`INSERT INTO vehicles
      (id, plate, vehicle_type, connector_type, kind, hub_id, owner_id, battery_level, status, next_required_usage_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addCharger = db.prepare(`INSERT INTO chargers
      (id, hub_id, code, connector_types_json, power_kw, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'Available', ?)`);
    const SEED_SHARED_SLOTS = 20, SEED_PERSONAL_SLOTS = 10, SEED_HOLDING_SLOTS = 6, SEED_CHARGERS = 5, SEED_SHARED_VEHICLES = 15;
    const supported = JSON.stringify(['Motorcycle']);
    const slotCode = (letter, i) => `${letter}-${String(i).padStart(2, '0')}`;

    for (const [hubIndex, [hubId]] of hubs.entries()) {
      // Default per Hub: 30 parking slots (20 Shared + 10 Personal), 6 Holding slots, 5 chargers, 15 shared vehicles.
      for (let i = 1; i <= SEED_SHARED_SLOTS; i++) addSlot.run(`${hubId}-S${i}`, hubId, slotCode('S', i), 'Shared', supported, 'Available', now);
      for (let i = 1; i <= SEED_PERSONAL_SLOTS; i++) addSlot.run(`${hubId}-P${i}`, hubId, slotCode('P', i), 'Personal', supported, 'Available', now);
      for (let i = 1; i <= SEED_HOLDING_SLOTS; i++) addSlot.run(`${hubId}-H${i}`, hubId, slotCode('H', i), 'Holding', supported, 'Available', now);
      for (let i = 1; i <= SEED_CHARGERS; i++) {
        addCharger.run(`${hubId}-CH${i}`, hubId, `CH-${i}`, JSON.stringify(['Type2', 'GB/T']), CHARGER_POWER_KW, now);
      }
      for (let i = 1; i <= SEED_SHARED_VEHICLES; i++) {
        const battery = i === SEED_SHARED_VEHICLES && hubIndex === 1 ? 16 : 40 + ((i * 17 + hubIndex * 7) % 55);
        const status = battery < 20 ? 'Needs Charging' : 'Available';
        const vehicleId = `${hubId}-V${i}`;
        addVehicle.run(vehicleId, `EV-${hubIndex + 1}${String(i).padStart(3, '0')}`, 'Motorcycle', 'Type2', 'shared', hubId, null,
          battery, status, null, now);
        // Each seeded shared vehicle occupies a Shared slot, including the low-battery vehicle.
        occupySlot.run(vehicleId, now, `${hubId}-S${i}`);
      }
    }

    // Sensor data: six of ten Personal slots at Hub B are taken by vehicles that are not registered in the
    // system (60% occupancy). A small arrival surge in a what-if run then reaches the warning level.
    for (let i = 1; i <= 6; i++) occupySlot.run(null, now, 'hub-engineering-P' + i);

    // Five example Students (student1 ... student5), each with a registered motorcycle that is parked at Hub A right now.
    // The parking times differ: they arrived 10 minutes to 4 hours ago and booked 2 to 5 hours. Any other Student has no
    // vehicle and adds one with "Add a vehicle".
    const addReservation = db.prepare(`INSERT INTO parking_reservations
      (id, user_id, vehicle_id, hub_id, slot_id, status, start_at, end_at, expires_at, arrived_at, created_at)
      VALUES (?, ?, ?, 'hub-central', ?, 'In Progress', ?, ?, ?, ?, ?)`);
    const atMinutes = minutes => new Date(Date.parse(now) + minutes * 60000).toISOString();
    [
      // [plate, battery %, minutes since arrival, booked hours]
      ['51A-123.45', 72, 10, 2], ['52B-123.45', 58, 40, 2], ['53C-123.45', 85, 90, 3], ['54D-123.45', 35, 150, 4], ['55E-123.45', 64, 240, 5]
    ].forEach(([plate, battery, since, hours], index) => {
      const n = index + 1, vehicleId = `personal-student${n}`, slotId = `hub-central-P${n}`;
      addUser.run(`student${n}`, `student${n}`, 'Student', now);
      // An account with this name may already exist (an Admin can create it), so use the id it really has.
      const userId = db.prepare(`SELECT id FROM users WHERE full_name=? AND role='Student'`).get(`student${n}`).id;
      addVehicle.run(vehicleId, plate, 'Motorcycle', 'Type2', 'personal', 'hub-central', userId, battery, 'Parked', null, now);
      occupySlot.run(vehicleId, now, slotId);
      const start = atMinutes(-since);
      addReservation.run(`parking-seed-${n}`, userId, vehicleId, slotId, start, atMinutes(-since + hours * 60),
        atMinutes(-since + config.parking.arrivalGraceMinutes), start, start);
    });

    // The low-battery shared vehicle joins the charging queue automatically (BR-25). Its Next Required Usage Time is
    // unknown, as for any shared vehicle the Operator has not scheduled (OD-2).
    db.prepare(`INSERT INTO charging_requests
      (id, user_id, vehicle_id, hub_id, request_type, status, battery_level, next_required_usage_at,
       registered_at, estimated_start_at, created_at)
      VALUES ('charge-seed-shared', NULL, ?, 'hub-engineering', 'shared_automatic', 'Queued', 16, NULL, ?, ?, ?)`)
      .run(`hub-engineering-V${SEED_SHARED_VEHICLES}`, now, now, now);
  });
  return { seeded: true, hubs: 3, users: 9 };
}

// Runs the seed when this file is started directly (node seed.js); the comparison also works on Windows paths.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(seedDatabase());
}