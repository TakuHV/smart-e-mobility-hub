import { db, transaction, nowIso } from './db.js';

export function seedDatabase() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM hubs').get().count;
  if (existing > 0) return { seeded: false, reason: 'Database already contains seed data.' };

  const now = nowIso();
  transaction(() => {
    const users = [
      ['student-demo', 'Demo Student', 'Student'],
      ['operator-demo', 'Demo Operator', 'Operator'],
      ['simulation-demo', 'Demo Simulation Operator', 'Simulation Operator'],
      ['admin-demo', 'Demo Admin', 'Admin']
    ];
    const addUser = db.prepare('INSERT INTO users (id, full_name, role, created_at) VALUES (?, ?, ?, ?)');
    users.forEach(u => addUser.run(...u, now));

    const hubs = [
      ['hub-central', 'HUB-01', 'Central Campus Hub', 'Main Campus', 30, 'Open'],
      ['hub-engineering', 'HUB-02', 'Engineering Hub', 'Engineering Zone', 30, 'Open'],
      ['hub-library', 'HUB-03', 'Library Hub', 'Library Area', 30, 'Open']
    ];
    const addHub = db.prepare(`INSERT INTO hubs
      (id, code, name, location, open_time, close_time, power_limit_kw, status, sensor_updated_at)
      VALUES (?, ?, ?, ?, '05:00', '23:00', ?, ?, ?)`);
    hubs.forEach(h => addHub.run(...h, now));

    const addSlot = db.prepare(`INSERT INTO parking_slots
      (id, hub_id, code, slot_type, supported_vehicle_types_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'Available', ?)`);
    const addVehicle = db.prepare(`INSERT INTO vehicles
      (id, plate, vehicle_type, connector_type, kind, hub_id, owner_id, battery_level, status, next_required_usage_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addCharger = db.prepare(`INSERT INTO chargers
      (id, hub_id, code, connector_types_json, power_kw, status, updated_at)
      VALUES (?, ?, ?, ?, 7.2, 'Available', ?)`);

    const hubIds = ['hub-central', 'hub-engineering', 'hub-library'];
    for (const [hubIndex, hubId] of hubIds.entries()) {
      for (let i = 1; i <= 5; i++) {
        addSlot.run(`${hubId}-S${i}`, hubId, `S-${String(i).padStart(2, '0')}`, 'Shared', JSON.stringify(['Motorcycle', 'Car']), now);
        addSlot.run(`${hubId}-P${i}`, hubId, `P-${String(i).padStart(2, '0')}`, 'Personal', JSON.stringify(['Motorcycle', 'Car']), now);
      }
      for (let i = 1; i <= 2; i++) {
        addSlot.run(`${hubId}-H${i}`, hubId, `H-${String(i).padStart(2, '0')}`, 'Holding', JSON.stringify(['Motorcycle', 'Car']), now);
      }
      for (let i = 1; i <= 2; i++) {
        addCharger.run(`${hubId}-CH${i}`, hubId, `CH-${i}`, JSON.stringify(['Type2', 'GB/T']), now);
      }
      for (let i = 1; i <= 3; i++) {
        const battery = i === 3 && hubIndex === 1 ? 16 : 72 - i * 8 + hubIndex * 3;
        const status = battery < 20 ? 'Needs Charging' : 'Available';
        const vehicleId = `${hubId}-V${i}`;
        addVehicle.run(vehicleId, `EV-${hubIndex + 1}${String(i).padStart(3, '0')}`, 'Car', 'Type2', 'shared', hubId, null,
          battery, status, null, now);
        // Each seeded shared vehicle occupies a Shared slot, including the low-battery vehicle.
        db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=?`)
          .run(vehicleId, now, `${hubId}-S${i}`);
      }
    }

    // Demo Student's personal vehicles, available at the Central Campus Hub.
    addVehicle.run('personal-demo-1', '51A-123.45', 'Car', 'Type2', 'personal', 'hub-central', 'student-demo', 54, 'Available', null, now);
    addVehicle.run('personal-demo-2', '59A-678.90', 'Motorcycle', 'GB/T', 'personal', 'hub-central', 'student-demo', 68, 'Available', null, now);

    // One shared vehicle with a low battery joins the charging queue automatically (BR-25).
    const requestId = 'charge-seed-shared';
    db.prepare(`INSERT INTO charging_requests
      (id, user_id, vehicle_id, hub_id, request_type, status, battery_level, next_required_usage_at,
       registered_at, estimated_start_at, created_at)
      VALUES (?, NULL, ?, ?, 'shared_automatic', 'Queued', 16, ?, ?, ?, ?)`)
      .run(requestId, 'hub-engineering-V3', 'hub-engineering',
        new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), now, now, now);
  });
  return { seeded: true, hubs: 3, users: 4 };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  console.log(seedDatabase());
}
