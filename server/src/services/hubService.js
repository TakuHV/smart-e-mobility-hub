import { db } from '../database/db.js';
import { inHubOperatingHours } from './commonService.js';
import { rankQueue } from './chargingService.js';

// BR-27: status data older than 2 minutes is Stale.
const STALE_AFTER_MS = 2 * 60 * 1000;
// BR-26 default thresholds. A per-Hub override (UC-016) is not read in the MVP.
const WARNING_RATIO = 0.8;
const CRITICAL_RATIO = 0.95;
const CHARGER_UTILIZATION_RATIO = 0.8;
const SHORTAGE_RATIO = 0.2;
// BR-28: these resources are excluded from availability and capacity.
const UNUSABLE_STATUSES = new Set(['Out of Service', 'Connection Lost', 'Status Unknown']);
const IN_USE_CHARGER_STATUSES = new Set(['Assigned', 'Charging', 'Awaiting Removal']);

function isFresh(timestamp) {
  const age = Date.now() - Date.parse(timestamp);
  return Number.isFinite(age) && age <= STALE_AFTER_MS;
}

function levelOf(ratio) {
  if (ratio >= CRITICAL_RATIO) return 'Critical';
  if (ratio >= WARNING_RATIO) return 'Warning';
  return 'Normal';
}

const escapeLike = text => text.replace(/[\\%_]/g, '\\$&');

// Counts and flags of one Hub, from a handful of grouped queries (used by the list and by the detail view).
function summarizeHub(hub) {
  const slotRows = db.prepare('SELECT slot_type, status, COUNT(*) AS n FROM parking_slots WHERE hub_id=? GROUP BY slot_type, status').all(hub.id);
  const capacity = {};
  for (const type of ['Shared', 'Personal']) {
    const rows = slotRows.filter(r => r.slot_type === type);
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    const unavailable = rows.filter(r => UNUSABLE_STATUSES.has(r.status)).reduce((sum, r) => sum + r.n, 0);
    const available = rows.filter(r => r.status === 'Available').reduce((sum, r) => sum + r.n, 0);
    const usable = total - unavailable;
    const ratio = usable ? (usable - available) / usable : 0;
    capacity[type] = { total, usable, available, occupancyPercent: Math.round(ratio * 100), level: levelOf(ratio) };
  }

  const vehicleRows = db.prepare(`SELECT status, COUNT(*) AS n FROM vehicles WHERE hub_id=? AND kind='shared' GROUP BY status`).all(hub.id);
  const sharedTotal = vehicleRows.reduce((sum, r) => sum + r.n, 0);
  const sharedAvailable = vehicleRows.filter(r => r.status === 'Available').reduce((sum, r) => sum + r.n, 0);

  const chargerRows = db.prepare('SELECT status, COUNT(*) AS n FROM chargers WHERE hub_id=? GROUP BY status').all(hub.id);
  const chargersTotal = chargerRows.reduce((sum, r) => sum + r.n, 0);
  const chargersUsable = chargersTotal - chargerRows.filter(r => UNUSABLE_STATUSES.has(r.status)).reduce((sum, r) => sum + r.n, 0);
  const chargersAvailable = chargerRows.filter(r => r.status === 'Available').reduce((sum, r) => sum + r.n, 0);
  const chargersInUse = chargerRows.filter(r => IN_USE_CHARGER_STATUSES.has(r.status)).reduce((sum, r) => sum + r.n, 0);

  const queued = db.prepare(`SELECT estimated_start_at FROM charging_requests WHERE hub_id=? AND status='Queued'`).all(hub.id);
  const waits = queued.map(r => Math.max(0, Math.round((Date.parse(r.estimated_start_at) - Date.now()) / 60000))).filter(Number.isFinite);

  // Flags in the same wording as before.
  const warnings = [];
  const parkingRatio = Math.max(...['Shared', 'Personal'].map(t => (capacity[t].usable ? (capacity[t].usable - capacity[t].available) / capacity[t].usable : 0)));
  if (parkingRatio >= CRITICAL_RATIO) warnings.push('Critical parking capacity');
  else if (parkingRatio >= WARNING_RATIO) warnings.push('Warning parking capacity');
  if (chargersUsable && chargersInUse / chargersUsable >= CHARGER_UTILIZATION_RATIO) warnings.push('High charger utilization');
  // The Hub's shared-vehicle quota is approximated by the shared vehicles currently at the Hub.
  if (sharedTotal && sharedAvailable / sharedTotal <= SHORTAGE_RATIO) warnings.push('Shared vehicle shortage');

  return {
    capacity, warnings,
    availableSharedVehicles: sharedAvailable,
    availableSharedSlots: capacity.Shared.available,
    availablePersonalSlots: capacity.Personal.available,
    availableChargers: chargersAvailable,
    chargingQueueLength: queued.length,
    longestEstimatedWaitMinutes: waits.length ? Math.max(...waits) : 0
  };
}

// UC-003: search by name, location or code, and by the resource the student needs.
// resourceType: 'shared' (vehicles to book), 'parking' (Personal slots), 'return' (free Shared slots), 'charger'.
export function listHubs({ q = '', resourceType = '' } = {}) {
  const search = `%${escapeLike(String(q).trim())}%`;
  const hubs = db.prepare(`SELECT h.* FROM hubs h
    WHERE h.name LIKE ? ESCAPE '\\' OR h.location LIKE ? ESCAPE '\\' OR h.code LIKE ? ESCAPE '\\'
    ORDER BY h.name`).all(search, search, search);
  const nowIsoText = new Date().toISOString();
  return hubs.map(hub => {
    const s = summarizeHub(hub);
    const fresh = isFresh(hub.sensor_updated_at);
    return {
      ...hub,
      available_shared_vehicles: s.availableSharedVehicles,
      available_shared_slots: s.availableSharedSlots,
      available_personal_slots: s.availablePersonalSlots,
      available_chargers: s.availableChargers,
      charging_queue_length: s.chargingQueueLength,
      estimated_wait_minutes: s.longestEstimatedWaitMinutes,   // BR-43: an estimate
      capacity: s.capacity,                                      // BR-38: per slot type
      warnings: s.warnings,
      open_now: hub.status === 'Open' && inHubOperatingHours(hub, nowIsoText), // BR-42, UC-003 A4
      statusFreshness: fresh ? 'Fresh' : 'Stale'                 // BR-27
    };
  }).filter(h => {
    if (resourceType === 'shared') return h.available_shared_vehicles > 0;
    if (resourceType === 'parking') return h.available_personal_slots > 0;
    if (resourceType === 'return') return h.available_shared_slots > 0;
    if (resourceType === 'charger') return h.available_chargers > 0;
    return true;
  });
}

// UC-004. Pass `user` from the route: a Student sees the shared fleet and their own personal vehicles only (BR-07).
// Without `user` (internal calls) nothing is hidden.
export function getHubStatus(hubId, user = null) {
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  if (!hub) return null;
  const restricted = user?.role === 'Student';
  const mayShow = vehicle => !restricted || vehicle.kind === 'shared' || vehicle.owner_id === user.id;
  const s = summarizeHub(hub);

  const slotSummary = db.prepare(`SELECT slot_type, COUNT(*) AS total,
      SUM(CASE WHEN status='Available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status='Occupied' THEN 1 ELSE 0 END) AS occupied,
      SUM(CASE WHEN status='Reserved' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status='Out of Service' THEN 1 ELSE 0 END) AS out_of_service,
      SUM(CASE WHEN status IN ('Connection Lost','Status Unknown') THEN 1 ELSE 0 END) AS unverified
    FROM parking_slots WHERE hub_id=? GROUP BY slot_type`).all(hubId)
    .map(row => ({ ...row, ...(s.capacity[row.slot_type] ? {
      occupancy_percent: s.capacity[row.slot_type].occupancyPercent, level: s.capacity[row.slot_type].level } : {}) }));

  const vehicles = db.prepare(`SELECT id,plate,vehicle_type,kind,owner_id,battery_level,status FROM vehicles
    WHERE hub_id=? ORDER BY kind,plate`).all(hubId)
    .filter(mayShow).map(({ owner_id, ...vehicle }) => vehicle);

  const chargers = db.prepare(`SELECT c.id,c.code,c.power_kw,c.status,c.current_vehicle_id,v.plate,v.kind,v.owner_id
    FROM chargers c LEFT JOIN vehicles v ON v.id=c.current_vehicle_id WHERE c.hub_id=? ORDER BY c.code`).all(hubId)
    .map(({ kind, owner_id, ...charger }) => (charger.current_vehicle_id && !mayShow({ kind, owner_id })
      ? { ...charger, current_vehicle_id: null, plate: null } : charger));

  // The queue is shown in scheduler order (class, then score). Queued requests carry their live score;
  // the stored score only exists after an assignment (UC-004 / BR-43).
  const rank = new Map(rankQueue(hubId).map((r, index) => [r.id, { index, score: Math.round(r.score * 100) / 100, cls: r.cls }]));
  const queue = db.prepare(`SELECT r.id,r.status,r.battery_level,r.next_required_usage_at,r.estimated_start_at,
      r.priority_score,v.plate,v.kind,v.owner_id
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    WHERE r.hub_id=? AND r.status IN ('Queued','Assigned','Charging')`).all(hubId)
    .sort((a, b) => {
      const order = { Charging: 1, Assigned: 2, Queued: 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === 'Queued') return rank.get(a.id).index - rank.get(b.id).index;
      return (b.priority_score ?? 0) - (a.priority_score ?? 0);
    })
    .map(({ owner_id, ...r }) => {
      const live = rank.get(r.id);
      const entry = {
        ...r,
        priority_score: r.status === 'Queued' && live ? live.score : r.priority_score,
        priority_class: live?.cls ?? null,
        estimated_wait_minutes: r.status === 'Queued' && r.estimated_start_at
          ? Math.max(0, Math.round((Date.parse(r.estimated_start_at) - Date.now()) / 60000)) : null
      };
      return mayShow({ kind: r.kind, owner_id })
        ? entry
        : { ...entry, plate: null, battery_level: null, next_required_usage_at: null };
    });

  const activePower = Number(db.prepare(`SELECT COALESCE(SUM(power_kw),0) AS kw FROM chargers
    WHERE hub_id=? AND status IN ('Assigned','Charging')`).get(hubId).kw || 0);
  const fresh = isFresh(hub.sensor_updated_at);
  return {
    ...hub,
    statusFreshness: fresh ? 'Fresh' : 'Stale',                 // BR-27
    slotSummary, vehicles, chargers, queue,
    capacity: s.capacity,
    open_now: hub.status === 'Open' && inHubOperatingHours(hub, new Date().toISOString()),
    availableSharedVehicles: s.availableSharedVehicles,
    availableSharedSlots: s.availableSharedSlots,
    availablePersonalSlots: s.availablePersonalSlots,
    activePowerKw: activePower,
    powerLimitKw: hub.power_limit_kw,
    powerUtilizationPercent: hub.power_limit_kw ? Math.round((activePower / hub.power_limit_kw) * 100) : 0,
    warnings: s.warnings
  };
}