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
  booking: { pickupHoldMinutes: 15, minimumBatteryToBookPercent: 30, maxTripHours: 3 },
  parking: { maxStayHours: 8, arrivalGraceMinutes: 15, overstayGraceMinutes: 15, sharedReturnReservePercent: 10, holdingFreeReservePercent: 40 },
  thresholds: { parkingWarningPercent: 80, parkingCriticalPercent: 95, chargerUtilizationWarningPercent: 80, sharedVehicleShortagePercent: 20 },
  charging: {
    targetBatteryPercent: 100,
    pickupNoticePercent: 90,          // the owner is told that the vehicle is ready to be collected (charging continues to the target)
    pickupGraceMinutes: 5,            // after the target is reached; then the vehicle is moved to Holding
    moveAutoSendSeconds: 15,          // a Move Vehicle Request is sent by itself after this time; an Operator can stop it
    fieldMoveSeconds: 30,             // simulated time Field Staff need to move a vehicle
    returnLeadMinutes: 2,             // a booked shared vehicle leaves its charger this long before the pickup time
    stopCooldownMinutes: 15,          // a stopped automatic move is not planned again for this long
    sharedMandatoryBelowPercent: 60,  // a shared vehicle below this always charges (it may take the charger of a vehicle charging only to use idle time)
    sharedStopPercent: 90,            // a shared vehicle stops here when someone is waiting; otherwise it goes on to the target
    sharedRestMinutes: 10,            // a shared vehicle at or above sharedMandatoryBelowPercent is not charged again this soon after it left a charger
    personalRequestsPerVehiclePerDay: 2,
    personalConnectWindowMinutes: 15,
    maxSessionMinutes: null,
    scheduler: {
      weights: { need: 0.5, urgency: 0.3, waiting: 0.2 },
      classH: { batteryBelowPercent: 10, slackWithinMinutes: 0 },
      hopelessSlackMinutes: -30,        // slack below this: the vehicle cannot be ready in time any more (class X, ranked behind class L)
      preemptMarginPoints: 10,          // a personal request displaces a shared vehicle only if its score is higher by this much (same class)
      preemptMaxBatteryPercent: 90,     // a shared vehicle at or above this level is never displaced
      urgencyHorizonMinutes: 240,
      waitingDivisorMinutes: 3,
      estimatedSessionMinutes: 120
    }
  },
  status: { staleAfterMinutes: 2, refreshIntervalSeconds: 60 },
  reminders: { tripReminderMinutes: 150, parkingReminderBeforeEndMinutes: 10, lowBatteryWarningPercent: 15 },
  battery: {
    capacityKwhByVehicleType: { Motorcycle: 3.5 },
    defaultCapacityKwh: 10,
    tripConsumptionKwByVehicleType: { Motorcycle: 1.2 },
    defaultTripConsumptionKw: 3,
    tripDropPercent: 20,              // average battery used by a trip between two Hubs
    tripDropMinutes: 20               // the drop is spread over this time
  },
  demoData: {
    seedHubPowerLimitsKw: { 'hub-central': 5, 'hub-engineering': 5, 'hub-library': 5 },
    seedChargerPowerKw: 1
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
  number('parking.holdingFreeReservePercent', c.parking.holdingFreeReservePercent, { min: 0, max: 100 });
  for (const key of ['pickupNoticePercent', 'pickupGraceMinutes', 'moveAutoSendSeconds', 'fieldMoveSeconds', 'returnLeadMinutes', 'stopCooldownMinutes', 'sharedMandatoryBelowPercent', 'sharedStopPercent', 'sharedRestMinutes']) number(`charging.${key}`, c.charging[key], { min: 0, max: 1000 });
  number('battery.tripDropPercent', c.battery.tripDropPercent, { min: 0, max: 100 });
  number('battery.tripDropMinutes', c.battery.tripDropMinutes, { min: 0, minExclusive: true, max: 600 });
  number('booking.maxTripHours', c.booking.maxTripHours, { min: 0, minExclusive: true, max: 72 });
  number('parking.maxStayHours', c.parking.maxStayHours, { min: 1, max: 24 });
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
  number('charging.scheduler.classH.slackWithinMinutes', s.classH.slackWithinMinutes, { min: -1440, max: 1440 });
  number('charging.scheduler.hopelessSlackMinutes', s.hopelessSlackMinutes, { min: -1440, max: 0 });
  number('charging.scheduler.preemptMarginPoints', s.preemptMarginPoints, { min: 0, max: 100 });
  number('charging.scheduler.preemptMaxBatteryPercent', s.preemptMaxBatteryPercent, { min: 0, max: 100 });
  number('charging.scheduler.urgencyHorizonMinutes', s.urgencyHorizonMinutes, { min: 0, minExclusive: true });
  number('charging.scheduler.waitingDivisorMinutes', s.waitingDivisorMinutes, { min: 0, minExclusive: true });
  number('charging.scheduler.estimatedSessionMinutes', s.estimatedSessionMinutes, { min: 1, max: 600 });
  number('reminders.tripReminderMinutes', c.reminders.tripReminderMinutes, { min: 0, minExclusive: true });
  if (c.reminders.tripReminderMinutes >= c.booking.maxTripHours * 60) problems.push('reminders.tripReminderMinutes must be shorter than booking.maxTripHours');
  number('reminders.parkingReminderBeforeEndMinutes', c.reminders.parkingReminderBeforeEndMinutes, { min: 0, max: 240 });
  number('reminders.lowBatteryWarningPercent', c.reminders.lowBatteryWarningPercent, { min: 0, max: 100 });
  number('battery.defaultCapacityKwh', c.battery.defaultCapacityKwh, { min: 0, minExclusive: true });
  number('battery.defaultTripConsumptionKw', c.battery.defaultTripConsumptionKw, { min: 0, minExclusive: true });
  for (const [type, kwh] of Object.entries(c.battery.capacityKwhByVehicleType)) number(`battery.capacityKwhByVehicleType.${type}`, kwh, { min: 0, minExclusive: true });
  for (const [type, kw] of Object.entries(c.battery.tripConsumptionKwByVehicleType)) number(`battery.tripConsumptionKwByVehicleType.${type}`, kw, { min: 0, minExclusive: true });
  if (c.charging.maxSessionMinutes !== null) number('charging.maxSessionMinutes', c.charging.maxSessionMinutes, { min: 1, max: 1440 });
  number('status.staleAfterMinutes', c.status.staleAfterMinutes, { min: 0, minExclusive: true });
  number('status.refreshIntervalSeconds', c.status.refreshIntervalSeconds, { min: 1 });
  number('demoData.seedChargerPowerKw', c.demoData.seedChargerPowerKw, { min: 0, minExclusive: true });
  for (const [hub, kw] of Object.entries(c.demoData.seedHubPowerLimitsKw)) number(`demoData.seedHubPowerLimitsKw.${hub}`, kw, { min: 0, minExclusive: true });
  return problems;
}

const clone = value => JSON.parse(JSON.stringify(value));

// Copies `source` into `target` in place, so every module that kept a reference such as config.charging.scheduler sees the new values.
function assignDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) assignDeep(target[key], value);
    else target[key] = value;
  }
}

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid settings: ${problems.join('; ')}`);
    this.problems = problems;
  }
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

// The values as read from the file, before any change made in the Admin area (used by "reset to defaults").
const baseConfig = clone(config);

// Sections the Admin area may change while the server runs. demoData and the file's note fields stay read-only.
export const EDITABLE_SECTIONS = ['booking', 'parking', 'thresholds', 'charging', 'reminders', 'status', 'battery'];

/*
 * Applies a partial change (same shape as configuration.json) to the running configuration. The whole result is validated
 * first; if anything is invalid nothing changes. Returns the new configuration.
 */
export function updateConfig(patch) {
  if (!isPlainObject(patch)) throw new ConfigError(['the change must be an object']);
  const unknown = Object.keys(patch).filter(key => !EDITABLE_SECTIONS.includes(key));
  if (unknown.length) throw new ConfigError([`these sections cannot be changed here: ${unknown.join(', ')}`]);
  const next = merge(clone(config), patch);
  const problems = validate(next);
  if (problems.length) throw new ConfigError(problems);
  assignDeep(config, next);
  return config;
}

// Removes keys from `target` that `source` does not have (for example a vehicle type added in the Admin area).
function prune(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
    else if (isPlainObject(target[key]) && isPlainObject(source[key])) prune(target[key], source[key]);
  }
}

export function resetConfig() {
  const base = clone(baseConfig);
  assignDeep(config, base);
  prune(config, base);
  return config;
}

export const editableConfig = () => Object.fromEntries(EDITABLE_SECTIONS.map(key => [key, clone(config[key])]));
export const fileConfig = () => Object.fromEntries(EDITABLE_SECTIONS.map(key => [key, clone(baseConfig[key])]));
