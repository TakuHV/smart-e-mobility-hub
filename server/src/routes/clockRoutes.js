import { Router } from 'express';
import { asyncRoute, requireLogin, requireRoles, pick } from '../middleware/requestContext.js';
import { clockStatus, setSpeed, setPaused, jump, SPEEDS, MAX_JUMP_MINUTES } from '../clock.js';
import { runCycle, maintenanceStatus } from '../services/timerService.js';
import { recentSchedulerRuns, isSimulatedSensorFeedEnabled } from '../services/chargingService.js';
import { HttpError, auditChange } from '../services/commonService.js';
import { config } from '../config.js';

const DEMO_SKIP_SECONDS = 45;

// The limits the screens count against (all read from configuration.json).
const limits = () => ({
  pickupHoldMinutes: config.booking.pickupHoldMinutes,
  maxTripHours: config.booking.maxTripHours,
  tripReminderMinutes: config.reminders.tripReminderMinutes,
  lowBatteryWarningPercent: config.reminders.lowBatteryWarningPercent,
  arrivalGraceMinutes: config.parking.arrivalGraceMinutes,
  maxStayHours: config.parking.maxStayHours,
  overstayGraceMinutes: config.parking.overstayGraceMinutes,
  parkingReminderBeforeEndMinutes: config.reminders.parkingReminderBeforeEndMinutes,
  connectWindowMinutes: config.charging.personalConnectWindowMinutes,
  targetBatteryPercent: config.charging.targetBatteryPercent,
  maxSessionMinutes: config.charging.maxSessionMinutes,
  minimumBatteryToBookPercent: config.booking.minimumBatteryToBookPercent,
  pickupNoticePercent: config.charging.pickupNoticePercent,
  pickupGraceMinutes: config.charging.pickupGraceMinutes
});

const snapshot = () => ({
  ...clockStatus(),
  limits: limits(),
  maxJumpMinutes: MAX_JUMP_MINUTES,
  maintenance: maintenanceStatus(),
  scheduler: { recent: recentSchedulerRuns() },
  sensorFeedEnabled: isSimulatedSensorFeedEnabled()
});

// The demo clock (see server/src/clock.js). Everyone signed in can read it; Operators and Admins control it.
const router = Router();
router.use(requireLogin);

router.get('/', asyncRoute((_req, res) => res.json(snapshot())));

router.post('/', requireRoles('Operator', 'Admin'), asyncRoute((req, res) => {
  const { speed, paused, jumpMinutes } = pick(req.body, ['speed', 'paused', 'jumpMinutes']);
  if (speed !== undefined && !SPEEDS.includes(speed)) throw new HttpError(400, `speed must be one of: ${SPEEDS.join(', ')}.`);
  if (paused !== undefined && typeof paused !== 'boolean') throw new HttpError(400, 'paused must be true or false.');
  if (jumpMinutes !== undefined && !(typeof jumpMinutes === 'number' && jumpMinutes > 0 && jumpMinutes <= MAX_JUMP_MINUTES)) {
    throw new HttpError(400, `jumpMinutes must be a number above 0 and at most ${MAX_JUMP_MINUTES}.`);
  }
  if (speed !== undefined) setSpeed(speed);
  if (paused !== undefined) setPaused(paused);
  if (jumpMinutes !== undefined) jump(jumpMinutes);
  auditChange('DemoClock', 'clock', 'DEMO_CLOCK_CHANGED', { speed, paused, jumpMinutes }, req.user.id);
  try { runCycle(); } catch (error) { console.error('Catch-up cycle failed after a clock change:', error); } // events due after a skip happen at once
  res.json(snapshot());
}));

// Demo only: any signed-in user (a Student during a demo) can move the demo clock ahead by 45 seconds.
router.post('/demo-skip', asyncRoute((req, res) => {
  jump(DEMO_SKIP_SECONDS / 60);
  auditChange('DemoClock', 'clock', 'DEMO_CLOCK_SKIPPED', { seconds: DEMO_SKIP_SECONDS }, req.user.id);
  try { runCycle(); } catch (error) { console.error('Catch-up cycle failed after a clock change:', error); }
  res.json(snapshot());
}));

export default router;
