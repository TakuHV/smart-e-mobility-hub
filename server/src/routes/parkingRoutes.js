import { Router } from 'express';
import { asyncRoute, requireLogin, pick } from '../middleware/requestContext.js';
import { listSlots, listReservations, createReservation, arriveReservation, completeReservation, cancelReservation } from '../services/parkingService.js';
import { HttpError } from '../services/commonService.js';

const SLOT_TYPES = ['Shared', 'Personal', 'Holding'];
const text = value => (value === undefined || value === null || value === '' ? undefined : String(value));

// The authenticated user and the ids in the URL always come last, so a request body can never replace them.
const router = Router();
router.use(requireLogin);

// UC-008 step 4: pass startAt, endAt and vehicleType to get the compatible slots that are free for that period.
router.get('/slots', asyncRoute((req, res) => {
  const slotType = text(req.query.slotType);
  if (slotType && !SLOT_TYPES.includes(slotType)) throw new HttpError(400, `slotType must be one of: ${SLOT_TYPES.join(', ')}.`);
  const slots = listSlots({
    hubId: text(req.query.hubId), slotType,
    startAt: text(req.query.startAt), endAt: text(req.query.endAt), vehicleType: text(req.query.vehicleType),
    withOccupant: req.user.role !== 'Student'
  });
  // A student does not see which vehicle occupies a slot (BR-07).
  res.json({ slots: req.user.role === 'Student' ? slots.map(({ current_vehicle_id, ...slot }) => slot) : slots });
}));

router.get('/reservations', asyncRoute((req, res) => res.json({ reservations: listReservations(req.user) })));

router.post('/reservations', asyncRoute((req, res) => res.status(201).json({
  reservation: createReservation({ ...pick(req.body, ['vehicleId', 'hubId', 'slotId', 'startAt', 'endAt']), user: req.user })
})));

router.post('/reservations/:reservationId/arrive', asyncRoute((req, res) => res.json({
  reservation: arriveReservation({ user: req.user, reservationId: req.params.reservationId })
})));
router.post('/reservations/:reservationId/complete', asyncRoute((req, res) => res.json(
  completeReservation({ user: req.user, reservationId: req.params.reservationId })
)));
router.post('/reservations/:reservationId/cancel', asyncRoute((req, res) => res.json({
  reservation: cancelReservation({ user: req.user, reservationId: req.params.reservationId })
})));

export default router;