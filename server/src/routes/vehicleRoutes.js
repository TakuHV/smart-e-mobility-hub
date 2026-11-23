import { Router } from 'express';
import { asyncRoute, requireLogin, pick } from '../middleware/requestContext.js';
import { listVehicles, createPersonalVehicle, listBookings, createBooking, pickupBooking, returnBooking, cancelBooking } from '../services/vehicleService.js';
import { runScheduler } from '../services/chargingService.js';
import { HttpError } from '../services/commonService.js';

// The authenticated user and the ids in the URL always come last, so a request body can never replace them.
const router = Router();
router.use(requireLogin);

router.get('/', asyncRoute((req, res) => {
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  if (kind && !['shared', 'personal'].includes(kind)) throw new HttpError(400, 'kind must be shared or personal.');
  const hubId = req.query.hubId ? String(req.query.hubId) : undefined;
  res.json({ vehicles: listVehicles({ kind, hubId, user: req.user }) });
}));

router.post('/personal', asyncRoute((req, res) => res.status(201).json({
  vehicle: createPersonalVehicle({ ...pick(req.body, ['plate', 'vehicleType', 'connectorType', 'hubId']), user: req.user })
})));

router.get('/bookings', asyncRoute((req, res) => res.json({ bookings: listBookings(req.user) })));

router.post('/bookings', asyncRoute((req, res) => res.status(201).json({
  booking: createBooking({ ...pick(req.body, ['vehicleId']), user: req.user })
})));

router.post('/bookings/:bookingId/pickup', asyncRoute((req, res) => res.json({
  booking: pickupBooking({ user: req.user, bookingId: req.params.bookingId })
})));

router.post('/bookings/:bookingId/return', asyncRoute((req, res) => {
  const result = returnBooking({
    ...pick(req.body, ['returnSlotId', 'batteryLevel', 'problemNote']),
    reportProblem: [true, 'true'].includes(req.body?.reportProblem),
    user: req.user,
    bookingId: req.params.bookingId
  });
  // UC-007: a returned vehicle that needs charging is queued; run the Charging Scheduler so a free charger is used.
  // The return has already been saved, so a scheduler problem must not turn it into an error response.
  if (result.chargingQueued) {
    try { runScheduler(); }
    catch (error) { console.error('Charging Scheduler failed after a return:', error); }
  }
  res.json(result);
}));

router.post('/bookings/:bookingId/cancel', asyncRoute((req, res) => res.json({
  booking: cancelBooking({ user: req.user, bookingId: req.params.bookingId })
})));

export default router;