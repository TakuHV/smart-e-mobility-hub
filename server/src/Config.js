import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The single place that reads data/configuration.json. Missing keys fall back to the defaults below, and an invalid
 * value stops the server at start with one message that lists every problem. SMART_EMOBILITY_CONFIG points the tests
 * at another file.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const configPath = process.env.SMART_EMOBILITY_CONFIG
  ? resolve(process.env.SMART_EMOBILITY_CONFIG)
  : resolve(here, '../../data/configuration.json');

const defaults = {
  operatingHours: { open: '05:00', close: '23:00' },
  booking: { pickupHoldMinutes: 15, minimumBatteryToBookPercent: 20, maxTripHours: 3 },
  parking: { arrivalGraceMinutes: 15, overstayGraceMinutes: 15, sharedReturnReservePercent: 10 },
  thresholds: { parkingWarningPercent: 80, parkingCriticalPercent: 95, chargerUtilizationWarningPercent: 80, sharedVehicleShortagePercent: 20 },
  charging: {
    targetBatteryPercent: 90,
    personalRequestsPerVehiclePerDay: 2,
    personalConnectWindowMinutes: 15,
    scheduler: {
      weights: { need: 0.5, urgency: 0.3, waiting: 0.2 },
      classH: { batteryBelowPercent: 10, usageWithinMinutes: 60 },
      urgencyHorizonMinutes: 240,
      waitingDivisorMinutes: 3,
      estimatedSessionMinutes: 45
    }
  },
  status: { staleAfterMinutes: 2, refreshIntervalSeconds: 60 },
  demoData: {
    seedHubPowerLimitsKw: { 'hub-central': 7.2, 'hub-engineering': 14.4, 'hub-library': 14.4 },
    seedChargerPowerKw: 7.2
  }
};

const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return result;
}

function validate(c) {
  const problems = [];
  const number = (path, value, { min = 0, max = Infinity, minExclusive = false } = {}) => {
    const ok = typeof value === 'number' && Number.isFinite(value) && (minExclusive ? value > min : value >= min) && value <= max;
    if (!ok) problems.push(`${path} must be a number ${minExclusive ? 'above' : 'from'} ${min}${max === Infinity ? '' : ` up to ${max}`}`);
  };
  const clock = (path, value) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) problems.push(`${path} must be HH:MM`); };

  clock('operatingHours.open', c.operatingHours.open);
  clock('operatingHours.close', c.operatingHours.close);
  if (String(c.operatingHours.open) >= String(c.operatingHours.close)) problems.push('operatingHours.open must be earlier than operatingHours.close');
  number('booking.pickupHoldMinutes', c.booking.pickupHoldMinutes, { min: 0, minExclusive: true, max: 240 });
  number('booking.minimumBatteryToBookPercent', c.booking.minimumBatteryToBookPercent, { min: 0, max: 100 });
  number('booking.maxTripHours', c.booking.maxTripHours, { min: 0, minExclusive: true, max: 72 });
  number('parking.arrivalGraceMinutes', c.parking.arrivalGraceMinutes, { min: 0, max: 240 });
  number('parking.overstayGraceMinutes', c.parking.overstayGraceMinutes, { min: 0, max: 240 });
  number('parking.sharedReturnReservePercent', c.parking.sharedReturnReservePercent, { min: 0, max: 100 });
  for (const key of Object.keys(defaults.thresholds)) number(`thresholds.${key}`, c.thresholds[key], { min: 0, max: 100 });
  if (c.thresholds.parkingWarningPercent > c.thresholds.parkingCriticalPercent) problems.push('thresholds.parkingWarningPercent must not exceed parkingCriticalPercent');
  number('charging.targetBatteryPercent', c.charging.targetBatteryPercent, { min: 1, max: 100 });
  number('charging.personalRequestsPerVehiclePerDay', c.charging.personalRequestsPerVehiclePerDay, { min: 1, max: 50 });
  number('charging.personalConnectWindowMinutes', c.charging.personalConnectWindowMinutes, { min: 0, minExclusive: true, max: 240 });
  const s = c.charging.scheduler;
  for (const key of ['need', 'urgency', 'waiting']) number(`charging.scheduler.weights.${key}`, s.weights[key], { min: 0, max: 1000 });
  if (!(s.weights.need + s.weights.urgency + s.weights.waiting > 0)) problems.push('charging.scheduler.weights must not all be 0');
  number('charging.scheduler.classH.batteryBelowPercent', s.classH.batteryBelowPercent, { min: 0, max: 100 });
  number('charging.scheduler.classH.usageWithinMinutes', s.classH.usageWithinMinutes, { min: 0 });
  number('charging.scheduler.urgencyHorizonMinutes', s.urgencyHorizonMinutes, { min: 0, minExclusive: true });
  number('charging.scheduler.waitingDivisorMinutes', s.waitingDivisorMinutes, { min: 0, minExclusive: true });
  number('charging.scheduler.estimatedSessionMinutes', s.estimatedSessionMinutes, { min: 1, max: 600 });
  number('status.staleAfterMinutes', c.status.staleAfterMinutes, { min: 0, minExclusive: true });
  number('status.refreshIntervalSeconds', c.status.refreshIntervalSeconds, { min: 1 });
  number('demoData.seedChargerPowerKw', c.demoData.seedChargerPowerKw, { min: 0, minExclusive: true });
  for (const [hub, kw] of Object.entries(c.demoData.seedHubPowerLimitsKw)) number(`demoData.seedHubPowerLimitsKw.${hub}`, kw, { min: 0, minExclusive: true });
  return problems;
}

function load() {
  let fromFile = {};
  try { fromFile = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${configPath}: ${error.message}`, { cause: error });
  }
  const merged = merge(defaults, fromFile);
  const problems = validate(merged);
  if (problems.length) throw new Error(`Invalid ${configPath}:\n - ${problems.join('\n - ')}`);
  return merged;
}

export const config = load();