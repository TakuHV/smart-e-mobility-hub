import { Router } from 'express';
import { asyncRoute, requireLogin } from '../middleware/requestContext.js';
import { createPersonalChargingRequest, listChargingData, connectPersonalVehicle, completeCharging,
  startMoveRequest, completeMoveRequest, cancelMoveRequest, runScheduler, updateNextRequiredUsage } from '../services/chargingService.js';
import { requireRole } from '../services/commonService.js';

const router = Router();
router.use(requireLogin);
router.get('/queue', asyncRoute((req, res) => res.json(listChargingData(req.user))));
router.post('/requests', asyncRoute((req, res) => res.status(201).json({ request: createPersonalChargingRequest({ ...req.body, user: req.user }) })));
router.post('/requests/:requestId/connect', asyncRoute((req, res) => res.json({ request: connectPersonalVehicle({ user: req.user, requestId: req.params.requestId }) })));
router.post('/requests/:requestId/complete', asyncRoute((req, res) => res.json(completeCharging({ user: req.user, requestId: req.params.requestId, ...req.body }))));
router.patch('/requests/:requestId/next-use', asyncRoute((req, res) => res.json({ request: updateNextRequiredUsage({ user: req.user, requestId: req.params.requestId, ...req.body }) })));
router.post('/run-scheduler', asyncRoute((req, res) => {
  requireRole(req.user, ['Operator','Admin']);
  res.json(runScheduler(req.body?.hubId || null, req.user.id));
}));
router.post('/move-requests/:moveRequestId/start', asyncRoute((req, res) => res.json({ moveRequest: startMoveRequest({ user: req.user, moveRequestId: req.params.moveRequestId }) })));
router.post('/move-requests/:moveRequestId/done', asyncRoute((req, res) => res.json({ moveRequest: completeMoveRequest({ user: req.user, moveRequestId: req.params.moveRequestId }) })));
router.post('/move-requests/:moveRequestId/cancel', asyncRoute((req, res) => res.json({ moveRequest: cancelMoveRequest({ user: req.user, moveRequestId: req.params.moveRequestId }) })));
export default router;
