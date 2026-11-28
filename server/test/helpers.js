import '../testSetup.js';
import { db, makeId, nowIso } from '../src/database/db.js';
import { seedDatabase } from '../src/database/seed.js';
import { now as clockNow } from '../src/clock.js';

seedDatabase();

export const addUser = role => {
  const user = { id: makeId('test-user'), full_name: `Test ${role} ${makeId('n').slice(-6)}`, role };
  db.prepare('INSERT INTO users (id,full_name,role,created_at) VALUES (?,?,?,?)').run(user.id, user.full_name, user.role, nowIso());
  return user;
};

// A Hub of its own that is open all day, so the tests do not depend on the time of day.
export const makeHub = ({ power = 30 } = {}) => {
  const id = makeId('test-hub');
  db.prepare(`INSERT INTO hubs (id,code,name,location,open_time,close_time,power_limit_kw,status,sensor_updated_at)
    VALUES (?,?,?,?,'00:00','23:59',?,'Open',?)`).run(id, `T-${id.slice(-8)}`, `Test Hub ${id.slice(-4)}`, 'Automated test', power, nowIso());
  return id;
};

export const addSlot = (hubId, type = 'Shared', code = null) => {
  const id = makeId('test-slot');
  db.prepare(`INSERT INTO parking_slots (id,hub_id,code,slot_type,supported_vehicle_types_json,status,updated_at)
    VALUES (?,?,?,?,?,'Available',?)`).run(id, hubId, code ?? `${type[0]}-${id.slice(-5)}`, type, JSON.stringify(['Motorcycle']), nowIso());
  return id;
};

// Test chargers are fast (7.2 kW) so that a charging session takes only minutes on the demo clock. The demo data uses the realistic power
// from data/configuration.json (demoData.seedChargerPowerKw, 1 kW).
export const addCharger = (hubId, powerKw = 7.2, code = null) => {
  const id = makeId('test-charger');
  db.prepare(`INSERT INTO chargers (id,hub_id,code,connector_types_json,power_kw,status,updated_at)
    VALUES (?,?,?,?,?,'Available',?)`).run(id, hubId, code ?? `CH-${id.slice(-4)}`, JSON.stringify(['Type2', 'GB/T']), powerKw, nowIso());
  return id;
};

export const addVehicle = ({ kind, hubId, ownerId = null, battery = 64, connector = 'Type2', slotId = null }) => {
  const id = makeId('test-vehicle');
  db.prepare(`INSERT INTO vehicles (id,plate,vehicle_type,connector_type,kind,hub_id,owner_id,battery_level,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `TEST-${id.slice(-8)}`, 'Motorcycle', connector, kind, hubId, ownerId, battery, battery < 30 ? 'Needs Charging' : 'Available', nowIso());
  if (slotId) db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=? WHERE id=?`).run(id, slotId);
  return db.prepare('SELECT * FROM vehicles WHERE id=?').get(id);
};

export const row = (sql, ...params) => db.prepare(sql).get(...params);
export const notificationKinds = (userId, role = null) =>
  db.prepare(`SELECT kind FROM notifications WHERE user_id=? OR audience_role=?`).all(userId, role).map(r => r.kind);

// A time `hours` from now on the demo clock (earlier tests move the clock forward, so Date.now() would be in the past).
export const later = hours => new Date(clockNow() + hours * 3600000).toISOString();
