import { db, transaction, makeId, nowIso } from '../database/db.js';
import { HttpError, requireValue, requireRole, auditChange, parseJson } from './commonService.js';
import { config } from '../config.js';
import { enqueueSharedVehicle, handleChargerFailure, restoreCharger, runScheduler } from './chargingService.js';

/*
 * Admin configuration of the Hub network: Hub settings, parking slots, chargers, shared and personal vehicles.
 * Everything is validated here, runs in a transaction and is written to the audit log.
 * Rows that already have history cannot be deleted (foreign keys), so they are taken out of service or retired instead.
 */
const VEHICLE_TYPES = ['Car', 'Motorcycle'];
const CONNECTORS = ['Type2', 'GB/T'];
const SLOT_TYPES = ['Shared', 'Personal', 'Holding'];
const SLOT_PREFIX = { Shared: 'S', Personal: 'P', Holding: 'H' };
const admin = user => requireRole(user, ['Admin']);
const isForeignKeyError = error => /FOREIGN KEY/i.test(String(error?.message));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function number(value, name, { min, max, integer = false }) {
  const n = Number(value);
  requireValue(Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)), 400,
    `${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  return n;
}
function oneOf(value, list, name) {
  requireValue(list.includes(value), 400, `${name} must be one of: ${list.join(', ')}.`);
  return value;
}
function plateOf(value) {
  const plate = String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
  requireValue(plate.length >= 4 && plate.length <= 20, 400, 'Enter a valid license plate (4 to 20 characters).');
  return plate;
}
const hubOf = hubId => {
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  requireValue(hub, 404, 'Hub not found.');
  return hub;
};

/* ---------- Overview ---------- */
export function adminOverview(user) {
  admin(user);
  const hubs = db.prepare('SELECT * FROM hubs ORDER BY code').all().map(hub => {
    const slots = db.prepare('SELECT id, code, slot_type, status, current_vehicle_id FROM parking_slots WHERE hub_id=? ORDER BY slot_type, code').all(hub.id);
    const slotCounts = {};
    for (const type of SLOT_TYPES) {
      const own = slots.filter(slot => slot.slot_type === type);
      slotCounts[type] = { total: own.length, available: own.filter(s => s.status === 'Available').length, outOfService: own.filter(s => s.status === 'Out of Service').length };
    }
    return {
      ...hub,
      slots, slotCounts,
      chargers: db.prepare(`SELECT c.id, c.code, c.power_kw, c.status, c.connector_types_json, v.plate FROM chargers c
        LEFT JOIN vehicles v ON v.id=c.current_vehicle_id WHERE c.hub_id=? ORDER BY c.code`).all(hub.id)
        .map(({ connector_types_json, ...c }) => ({ ...c, connector_types: parseJson(connector_types_json, []) })),
      sharedVehicles: db.prepare(`SELECT id, plate, vehicle_type, connector_type, battery_level, status FROM vehicles
        WHERE hub_id=? AND kind='shared' ORDER BY plate`).all(hub.id)
    };
  });
  const personalVehicles = db.prepare(`SELECT v.id, v.plate, v.vehicle_type, v.connector_type, v.status, v.battery_level, v.hub_id, u.full_name AS owner_name, v.owner_id
    FROM vehicles v JOIN users u ON u.id=v.owner_id WHERE v.kind='personal' AND v.status<>'Retired' ORDER BY u.full_name, v.plate`).all();
  const students = db.prepare(`SELECT id, full_name FROM users WHERE role='Student' AND id NOT LIKE 'test-%' ORDER BY full_name`).all();
  return { hubs, personalVehicles, students, vehicleTypes: VEHICLE_TYPES, connectorTypes: CONNECTORS };
}

/* ---------- Hub ---------- */
export function updateHub({ user, hubId, name, powerLimitKw, openTime, closeTime, status }) {
  admin(user);
  const hub = hubOf(hubId);
  const next = {
    name: name === undefined ? hub.name : String(name).trim(),
    power: powerLimitKw === undefined ? hub.power_limit_kw : number(powerLimitKw, 'Hub Power Limit (kW)', { min: 0.1, max: 1000 }),
    open: openTime === undefined ? hub.open_time : openTime,
    close: closeTime === undefined ? hub.close_time : closeTime,
    status: status === undefined ? hub.status : oneOf(status, ['Open', 'Closed'], 'status')
  };
  requireValue(next.name.length >= 2 && next.name.length <= 60, 400, 'The Hub name must have 2 to 60 characters.');
  requireValue(HHMM.test(next.open) && HHMM.test(next.close), 400, 'Operating hours must be written as HH:MM.');
  requireValue(next.open < next.close, 400, 'The opening time must be earlier than the closing time (same day).');
  db.prepare('UPDATE hubs SET name=?, power_limit_kw=?, open_time=?, close_time=?, status=? WHERE id=?')
    .run(next.name, next.power, next.open, next.close, next.status, hubId);
  auditChange('Hub', hubId, 'HUB_CONFIGURATION_CHANGED', next, user.id);
  runScheduler(hubId, user.id); // a higher power limit may let a queued vehicle start
  return db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
}

/* ---------- Parking slots ---------- */
export function addSlots({ user, hubId, slotType, count = 1, supportedVehicleTypes }) {
  admin(user);
  hubOf(hubId);
  oneOf(slotType, SLOT_TYPES, 'slotType');
  const amount = number(count, 'count', { min: 1, max: 20, integer: true });
  const supported = Array.isArray(supportedVehicleTypes) && supportedVehicleTypes.length ? supportedVehicleTypes : VEHICLE_TYPES;
  requireValue(supported.every(type => VEHICLE_TYPES.includes(type)), 400, `Supported vehicle types must be from: ${VEHICLE_TYPES.join(', ')}.`);
  const created = [];
  transaction(() => {
    const codes = db.prepare('SELECT code FROM parking_slots WHERE hub_id=? AND slot_type=?').all(hubId, slotType).map(row => row.code);
    let next = codes.reduce((max, code) => Math.max(max, Number(code.split('-')[1]) || 0), 0);
    const insert = db.prepare(`INSERT INTO parking_slots (id,hub_id,code,slot_type,supported_vehicle_types_json,status,updated_at)
      VALUES (?,?,?,?,?,'Available',?)`);
    for (let i = 0; i < amount; i++) {
      next += 1;
      const code = `${SLOT_PREFIX[slotType]}-${String(next).padStart(2, '0')}`;
      const id = makeId('slot');
      insert.run(id, hubId, code, slotType, JSON.stringify(supported), nowIso());
      created.push({ id, code });
    }
    auditChange('Hub', hubId, 'SLOTS_ADDED', { slotType, count: amount, codes: created.map(c => c.code) }, user.id);
  });
  return created;
}

// A free slot without history is deleted; one that appears in past reservations is taken out of service (it cannot be deleted).
export function removeSlot({ user, slotId }) {
  admin(user);
  const slot = db.prepare('SELECT * FROM parking_slots WHERE id=?').get(slotId);
  requireValue(slot, 404, 'Slot not found.');
  requireValue(slot.status === 'Available' || slot.status === 'Out of Service', 409, 'Only a free slot can be removed. Wait until the vehicle has left or the reservation has ended.');
  let result = 'deleted';
  try {
    db.prepare('DELETE FROM parking_slots WHERE id=?').run(slotId);
  } catch (error) {
    if (!isForeignKeyError(error)) throw error;
    db.prepare(`UPDATE parking_slots SET status='Out of Service', updated_at=? WHERE id=?`).run(nowIso(), slotId);
    result = 'out_of_service';
  }
  auditChange('ParkingSlot', slotId, result === 'deleted' ? 'SLOT_REMOVED' : 'SLOT_RETIRED', { code: slot.code, hubId: slot.hub_id }, user.id);
  return { result };
}

export function setSlotStatus({ user, slotId, status }) {
  admin(user);
  oneOf(status, ['Available', 'Out of Service'], 'status');
  const slot = db.prepare('SELECT * FROM parking_slots WHERE id=?').get(slotId);
  requireValue(slot, 404, 'Slot not found.');
  requireValue(['Available', 'Out of Service'].includes(slot.status), 409, 'This slot is in use. Wait until it is free.');
  db.prepare('UPDATE parking_slots SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), slotId);
  auditChange('ParkingSlot', slotId, 'SLOT_STATUS_CHANGED', { status }, user.id);
  return db.prepare('SELECT * FROM parking_slots WHERE id=?').get(slotId);
}

/* ---------- Chargers ---------- */
function connectorsOf(value) {
  const list = Array.isArray(value) && value.length ? value : CONNECTORS;
  requireValue(list.every(c => CONNECTORS.includes(c)), 400, `Connector types must be from: ${CONNECTORS.join(', ')}.`);
  return [...new Set(list)];
}

export function addCharger({ user, hubId, powerKw, connectorTypes }) {
  admin(user);
  hubOf(hubId);
  const power = number(powerKw ?? config.demoData.seedChargerPowerKw, 'Charger power (kW)', { min: 0.1, max: 350 });
  const connectors = connectorsOf(connectorTypes);
  const id = makeId('charger');
  transaction(() => {
    const next = db.prepare('SELECT code FROM chargers WHERE hub_id=?').all(hubId)
      .reduce((max, row) => Math.max(max, Number(row.code.split('-')[1]) || 0), 0) + 1;
    db.prepare(`INSERT INTO chargers (id,hub_id,code,connector_types_json,power_kw,status,updated_at) VALUES (?,?,?,?,?,'Available',?)`)
      .run(id, hubId, `CH-${next}`, JSON.stringify(connectors), power, nowIso());
    auditChange('Charger', id, 'CHARGER_ADDED', { hubId, powerKw: power, connectors }, user.id);
  });
  runScheduler(hubId, user.id);
  return db.prepare('SELECT * FROM chargers WHERE id=?').get(id);
}

export function updateCharger({ user, chargerId, powerKw, connectorTypes, status }) {
  admin(user);
  const charger = db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
  requireValue(charger, 404, 'Charger not found.');
  if (powerKw !== undefined || connectorTypes !== undefined) {
    requireValue(['Available', 'Out of Service'].includes(charger.status), 409, 'Power and connectors can be changed only while no vehicle uses the charger.');
    const power = powerKw === undefined ? charger.power_kw : number(powerKw, 'Charger power (kW)', { min: 0.1, max: 350 });
    const connectors = connectorTypes === undefined ? parseJson(charger.connector_types_json, CONNECTORS) : connectorsOf(connectorTypes);
    db.prepare('UPDATE chargers SET power_kw=?, connector_types_json=?, updated_at=? WHERE id=?').run(power, JSON.stringify(connectors), nowIso(), chargerId);
    auditChange('Charger', chargerId, 'CHARGER_CONFIGURATION_CHANGED', { powerKw: power, connectors }, user.id);
  }
  if (status !== undefined) {
    oneOf(status, ['Available', 'Out of Service'], 'status');
    if (status === 'Out of Service') handleChargerFailure({ chargerId, actorId: user.id });
    else restoreCharger({ chargerId, actorId: user.id });
  }
  runScheduler(charger.hub_id, user.id);
  return db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
}

export function removeCharger({ user, chargerId }) {
  admin(user);
  const charger = db.prepare('SELECT * FROM chargers WHERE id=?').get(chargerId);
  requireValue(charger, 404, 'Charger not found.');
  requireValue(['Available', 'Out of Service'].includes(charger.status) && !charger.current_vehicle_id, 409,
    'This charger is in use. Wait until the vehicle has been moved away.');
  let result = 'deleted';
  try {
    db.prepare('DELETE FROM chargers WHERE id=?').run(chargerId);
  } catch (error) {
    if (!isForeignKeyError(error)) throw error;
    // It appears in past charging sessions, so it stays in the database but is no longer used.
    db.prepare(`UPDATE chargers SET status='Out of Service', updated_at=? WHERE id=?`).run(nowIso(), chargerId);
    result = 'out_of_service';
  }
  auditChange('Charger', chargerId, result === 'deleted' ? 'CHARGER_REMOVED' : 'CHARGER_RETIRED', { code: charger.code, hubId: charger.hub_id }, user.id);
  return { result };
}

/* ---------- Vehicles ---------- */
function fitFields({ plate, vehicleType, connectorType }) {
  return { plate: plateOf(plate), vehicleType: oneOf(vehicleType, VEHICLE_TYPES, 'vehicleType'), connectorType: oneOf(connectorType, CONNECTORS, 'connectorType') };
}
function insertVehicle(fields, columns) {
  try {
    db.prepare(`INSERT INTO vehicles (id,plate,vehicle_type,connector_type,kind,hub_id,owner_id,battery_level,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(columns.id, fields.plate, fields.vehicleType, fields.connectorType, columns.kind, columns.hubId, columns.ownerId, columns.battery, columns.status, nowIso());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'This license plate is already registered.');
    throw error;
  }
}

export function addSharedVehicle({ user, hubId, plate, vehicleType, connectorType, batteryLevel = 80 }) {
  admin(user);
  hubOf(hubId);
  const fields = fitFields({ plate, vehicleType, connectorType });
  const battery = number(batteryLevel, 'Battery level', { min: 0, max: 100, integer: true });
  const id = makeId('vehicle');
  const low = battery < config.booking.minimumBatteryToBookPercent;
  transaction(() => {
    const slot = db.prepare(`SELECT * FROM parking_slots WHERE hub_id=? AND slot_type='Shared' AND status='Available' ORDER BY code`).all(hubId)
      .find(s => parseJson(s.supported_vehicle_types_json, []).includes(fields.vehicleType));
    requireValue(slot, 409, 'This Hub has no free Shared slot for that vehicle type. Add a Shared slot first.');
    insertVehicle(fields, { id, kind: 'shared', hubId, ownerId: null, battery, status: low ? 'Needs Charging' : 'Available' });
    db.prepare(`UPDATE parking_slots SET status='Occupied', current_vehicle_id=?, updated_at=? WHERE id=?`).run(id, nowIso(), slot.id);
    if (low) enqueueSharedVehicle(id, hubId);
    auditChange('Vehicle', id, 'SHARED_VEHICLE_ADDED', { plate: fields.plate, hubId, slotId: slot.id }, user.id);
  });
  if (low) runScheduler(hubId, user.id);
  return db.prepare('SELECT * FROM vehicles WHERE id=?').get(id);
}

export function addPersonalVehicle({ user, ownerId, hubId, plate, vehicleType, connectorType, batteryLevel = 50 }) {
  admin(user);
  hubOf(hubId);
  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(ownerId);
  requireValue(owner?.role === 'Student', 400, 'A personal vehicle must belong to a student.');
  const fields = fitFields({ plate, vehicleType, connectorType });
  const battery = number(batteryLevel, 'Battery level', { min: 0, max: 100, integer: true });
  const id = makeId('vehicle');
  insertVehicle(fields, { id, kind: 'personal', hubId, ownerId, battery, status: 'Available' });
  auditChange('Vehicle', id, 'PERSONAL_VEHICLE_ADDED', { plate: fields.plate, ownerId }, user.id);
  return db.prepare('SELECT * FROM vehicles WHERE id=?').get(id);
}

// Takes a vehicle out of the network for good. Only an idle vehicle can be retired; its history stays.
export function retireVehicle({ user, vehicleId }) {
  admin(user);
  transaction(() => {
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(vehicleId);
    requireValue(vehicle && vehicle.status !== 'Retired', 404, 'Vehicle not found.');
    requireValue(['Available', 'Needs Charging', 'Out of Service', 'Parked'].includes(vehicle.status), 409,
      `A vehicle that is ${vehicle.status} cannot be removed now. Wait until the booking, trip, charging or transfer has ended.`);
    const open = db.prepare(`SELECT
      (SELECT COUNT(*) FROM bookings WHERE vehicle_id=@id AND status IN ('Confirmed','In Progress','Overdue')) +
      (SELECT COUNT(*) FROM parking_reservations WHERE vehicle_id=@id AND status IN ('Confirmed','In Progress')) +
      (SELECT COUNT(*) FROM charging_requests WHERE vehicle_id=@id AND status IN ('Assigned','Charging')) AS n`).get({ id: vehicleId }).n;
    requireValue(open === 0, 409, 'This vehicle still has an active booking, reservation or charging session.');
    const now = nowIso();
    db.prepare(`UPDATE charging_requests SET status='Cancelled' WHERE vehicle_id=? AND status='Queued'`).run(vehicleId);
    db.prepare(`UPDATE parking_slots SET status='Available', current_vehicle_id=NULL, updated_at=? WHERE current_vehicle_id=?`).run(now, vehicleId);
    db.prepare(`UPDATE vehicles SET status='Retired', hub_id=NULL, updated_at=? WHERE id=?`).run(now, vehicleId);
    auditChange('Vehicle', vehicleId, 'VEHICLE_RETIRED', { plate: vehicle.plate, kind: vehicle.kind }, user.id);
  });
  return { retired: true };
}
