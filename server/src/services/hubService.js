import { db } from '../database/db.js';
import { parseJson } from './commonService.js';

export function listHubs({ q = '', resourceType = '' } = {}) {
  const search = `%${String(q).trim()}%`;
  const hubs = db.prepare(`SELECT h.*,
    (SELECT COUNT(*) FROM vehicles v WHERE v.hub_id=h.id AND v.kind='shared' AND v.status='Available') AS available_shared_vehicles,
    (SELECT COUNT(*) FROM parking_slots s WHERE s.hub_id=h.id AND s.slot_type='Shared' AND s.status='Available') AS available_shared_slots,
    (SELECT COUNT(*) FROM parking_slots s WHERE s.hub_id=h.id AND s.slot_type='Personal' AND s.status='Available') AS available_personal_slots,
    (SELECT COUNT(*) FROM chargers c WHERE c.hub_id=h.id AND c.status='Available') AS available_chargers,
    (SELECT COUNT(*) FROM charging_requests r WHERE r.hub_id=h.id AND r.status='Queued') AS charging_queue_length
    FROM hubs h WHERE h.name LIKE ? OR h.location LIKE ? OR h.code LIKE ? ORDER BY h.name`).all(search, search, search);
  return hubs.map(h => ({
    ...h,
    warnings: calculateHubWarnings(h),
    statusFreshness: isFresh(h.sensor_updated_at) ? 'Fresh' : 'Stale'
  })).filter(h => {
    if (resourceType === 'shared') return h.available_shared_vehicles > 0;
    if (resourceType === 'parking') return h.available_personal_slots > 0;
    if (resourceType === 'charger') return h.available_chargers > 0;
    return true;
  });
}

function isFresh(timestamp) {
  const staleAfterMs = 2 * 60 * 1000;
  return Date.now() - new Date(timestamp).getTime() <= staleAfterMs;
}

function calculateHubWarnings(hub) {
  const totalSharedVehicles = db.prepare(`SELECT COUNT(*) AS n FROM vehicles WHERE hub_id=? AND kind='shared'`).get(hub.id).n;
  const sharedRatio = totalSharedVehicles ? hub.available_shared_vehicles / totalSharedVehicles : 0;
  const sharedSlotsTotal = db.prepare(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND slot_type='Shared'`).get(hub.id).n;
  const personalSlotsTotal = db.prepare(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND slot_type='Personal'`).get(hub.id).n;
  const sharedOccupancy = sharedSlotsTotal ? 1 - (hub.available_shared_slots / sharedSlotsTotal) : 0;
  const personalOccupancy = personalSlotsTotal ? 1 - (hub.available_personal_slots / personalSlotsTotal) : 0;
  const chargersTotal = db.prepare('SELECT COUNT(*) AS n FROM chargers WHERE hub_id=?').get(hub.id).n;
  const activeChargers = chargersTotal - hub.available_chargers;
  const warnings = [];
  if (sharedOccupancy >= 0.95 || personalOccupancy >= 0.95) warnings.push('Critical parking capacity');
  else if (sharedOccupancy >= 0.8 || personalOccupancy >= 0.8) warnings.push('Warning parking capacity');
  if (chargersTotal && activeChargers / chargersTotal >= 0.8) warnings.push('High charger utilization');
  if (totalSharedVehicles && sharedRatio <= 0.2) warnings.push('Shared vehicle shortage');
  return warnings;
}

export function getHubStatus(hubId) {
  const hub = db.prepare('SELECT * FROM hubs WHERE id=?').get(hubId);
  if (!hub) return null;
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;
  const slotSummary = db.prepare(`SELECT slot_type, COUNT(*) AS total,
      SUM(CASE WHEN status='Available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status='Occupied' THEN 1 ELSE 0 END) AS occupied,
      SUM(CASE WHEN status='Reserved' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status='Out of Service' THEN 1 ELSE 0 END) AS out_of_service
    FROM parking_slots WHERE hub_id=? GROUP BY slot_type`).all(hubId);
  const vehicles = db.prepare(`SELECT id,plate,vehicle_type,kind,battery_level,status FROM vehicles
    WHERE hub_id=? ORDER BY kind,plate`).all(hubId);
  const chargers = db.prepare(`SELECT c.id,c.code,c.power_kw,c.status,c.current_vehicle_id,v.plate
    FROM chargers c LEFT JOIN vehicles v ON v.id=c.current_vehicle_id WHERE c.hub_id=? ORDER BY c.code`).all(hubId);
  const queue = db.prepare(`SELECT r.id,r.status,r.battery_level,r.next_required_usage_at,r.estimated_start_at,
      r.priority_score,v.plate,v.kind
    FROM charging_requests r JOIN vehicles v ON v.id=r.vehicle_id
    WHERE r.hub_id=? AND r.status IN ('Queued','Assigned','Charging')
    ORDER BY CASE r.status WHEN 'Charging' THEN 1 WHEN 'Assigned' THEN 2 ELSE 3 END,r.priority_score DESC`).all(hubId);
  const availableSharedVehicles = count(`SELECT COUNT(*) AS n FROM vehicles WHERE hub_id=? AND kind='shared' AND status='Available'`, hubId);
  const availableSharedSlots = count(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND slot_type='Shared' AND status='Available'`, hubId);
  const availablePersonalSlots = count(`SELECT COUNT(*) AS n FROM parking_slots WHERE hub_id=? AND slot_type='Personal' AND status='Available'`, hubId);
  const activePower = Number(db.prepare(`SELECT COALESCE(SUM(power_kw),0) AS kw FROM chargers
    WHERE hub_id=? AND status IN ('Assigned','Charging')`).get(hubId).kw || 0);
  return {
    ...hub,
    statusFreshness: isFresh(hub.sensor_updated_at) ? 'Fresh' : 'Stale',
    slotSummary, vehicles, chargers, queue,
    availableSharedVehicles, availableSharedSlots, availablePersonalSlots,
    activePowerKw: activePower,
    powerLimitKw: hub.power_limit_kw,
    powerUtilizationPercent: hub.power_limit_kw ? Math.round(activePower / hub.power_limit_kw * 100) : 0,
    warnings: calculateHubWarnings({ ...hub,
      available_shared_vehicles: availableSharedVehicles,
      available_shared_slots: availableSharedSlots,
      available_personal_slots: availablePersonalSlots,
      available_chargers: chargers.filter(c => c.status === 'Available').length
    })
  };
}
