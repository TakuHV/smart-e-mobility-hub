import { Router } from 'express';
import { asyncRoute, requireLogin } from '../middleware/requestContext.js';
import { listSlots, listReservations, createReservation, arriveReservation, completeReservation, cancelReservation } from '../services/parkingService.js';

const router = Router();
router.use(requireLogin);
router.get('/slots', asyncRoute((req, res) => res.json({ slots: listSlots({ hubId: req.query.hubId, slotType: req.query.slotType }) })));
router.get('/reservations', asyncRoute((req, res) => res.json({ reservations: listReservations(req.user) })));
router.post('/reservations', asyncRoute((req, res) => res.status(201).json({ reservation: createReservation({ ...req.body, user: req.user }) })));
router.post('/reservations/:reservationId/arrive', asyncRoute((req, res) => res.json({ reservation: arriveReservation({ user: req.user, reservationId: req.params.reservationId }) })));
router.post('/reservations/:reservationId/complete', asyncRoute((req, res) => res.json(completeReservation({ user: req.user, reservationId: req.params.reservationId }))));
router.post('/reservations/:reservationId/cancel', asyncRoute((req, res) => res.json({ reservation: cancelReservation({ user: req.user, reservationId: req.params.reservationId }) })));
export default router;
