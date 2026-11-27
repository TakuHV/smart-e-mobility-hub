import { config } from '../config.js';

/*
 * Battery model for the demo. Percent change follows from energy: kW x hours / vehicle capacity.
 * Capacities and trip consumption are demo assumptions (configuration.json, "battery"), not project requirements.
 */
const B = config.battery;

export const capacityKwh = vehicleType => B.capacityKwhByVehicleType[vehicleType] ?? B.defaultCapacityKwh;
export const tripConsumptionKw = vehicleType => B.tripConsumptionKwByVehicleType[vehicleType] ?? B.defaultTripConsumptionKw;

const HOUR_MS = 3600000;

// Battery percent while charging at powerKw, elapsedMs after the session started.
export function chargedBattery(startPercent, powerKw, vehicleType, elapsedMs) {
  const gain = ((powerKw * Math.max(0, elapsedMs)) / HOUR_MS / capacityKwh(vehicleType)) * 100;
  return Math.min(100, Number(startPercent) + gain);
}

// Minutes until currentPercent reaches targetPercent (0 when already there).
export function minutesToReach(targetPercent, currentPercent, powerKw, vehicleType) {
  if (currentPercent >= targetPercent) return 0;
  return (((targetPercent - currentPercent) / 100) * capacityKwh(vehicleType) / powerKw) * 60;
}

// Battery percent during a trip, elapsedMs after pickup.
export function tripBattery(startPercent, vehicleType, elapsedMs) {
  const drop = ((tripConsumptionKw(vehicleType) * Math.max(0, elapsedMs)) / HOUR_MS / capacityKwh(vehicleType)) * 100;
  return Math.max(0, Number(startPercent) - drop);
}
