import { Router } from 'express';
import { asyncRoute, requireLogin } from '../middleware/requestContext.js';
import { listVehicles, createPersonalVehicle, listBookings, createBooking, pickupBooking, returnBooking, cancelBooking } from '../services/vehicleService.js';
import { runScheduler } from '../services/chargingService.js';

const router = Router();
router.use(requireLogin);
router.get('/', asyncRoute((req, res) => res.json({ vehicles: listVehicles({ kind: req.query.kind, hubId: req.query.hubId, user: req.user }) })));
router.post('/personal', asyncRoute((req, res) => res.status(201).json({ vehicle: createPersonalVehicle({ ...req.body, user: req.user }) })));
router.get('/bookings', asyncRoute((req, res) => res.json({ bookings: listBookings(req.user) })));
router.post('/bookings', asyncRoute((req, res) => res.status(201).json({ booking: createBooking({ ...req.body, user: req.user }) })));
router.post('/bookings/:bookingId/pickup', asyncRoute((req, res) => res.json({ booking: pickupBooking({ user: req.user, bookingId: req.params.bookingId }) })));
router.post('/bookings/:bookingId/return', asyncRoute((req, res) => {
  const result = returnBooking({ user: req.user, bookingId: req.params.bookingId, ...req.body });
  if (result.chargingQueued) runScheduler();
  res.json(result);
}));
router.post('/bookings/:bookingId/cancel', asyncRoute((req, res) => res.json({ booking: cancelBooking({ user: req.user, bookingId: req.params.bookingId }) })));
export default router;
