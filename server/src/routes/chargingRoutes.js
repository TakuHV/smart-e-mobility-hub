import { Router } from 'express';
import { asyncRoute, requireLogin, requireRoles, pick } from '../middleware/requestContext.js';
import { createPersonalChargingRequest, previewPersonalCharging, listChargingData, connectPersonalVehicle, completeCharging,
  startMoveRequest, completeMoveRequest, cancelMoveRequest, runScheduler, updateNextRequiredUsage, stopAutoMove, resumeAutoMove, releaseHolding } from '../services/chargingService.js';
import { HttpError } from '../services/commonService.js';

// The authenticated user and the ids in the URL always come last, so a request body can never replace them.
const router = Router();
router.use(requireLogin);

router.get('/queue', asyncRoute((req, res) => res.json(listChargingData(req.user))));

router.post('/preview', asyncRoute((req, res) => res.json(
  previewPersonalCharging(pick(req.body, ['vehicleId', 'hubId', 'batteryLevel', 'nextRequiredUsageAt', 'startInMinutes']))
)));

router.post('/requests', asyncRoute((req, res) => res.status(201).json({
  request: createPersonalChargingRequest({
    ...pick(req.body, ['vehicleId', 'hubId', 'batteryLevel', 'nextRequiredUsageAt', 'startInMinutes']),
    user: req.user
  })
})));

router.post('/requests/:requestId/connect', asyncRoute((req, res) => res.json({
  request: connectPersonalVehicle({ user: req.user, requestId: req.params.requestId })
})));

router.post('/requests/:requestId/complete', asyncRoute((req, res) => res.json(completeCharging({
  ...pick(req.body, ['finalBatteryLevel']),
  user: req.user,
  requestId: req.params.requestId
}))));

router.patch('/requests/:requestId/next-use', asyncRoute((req, res) => res.json({
  request: updateNextRequiredUsage({
    ...pick(req.body, ['nextRequiredUsageAt']),
    user: req.user,
    requestId: req.params.requestId
  })
})));

router.post('/run-scheduler', requireRoles('Operator', 'Admin'), asyncRoute((req, res) => {
  const hubId = req.body?.hubId ?? null;
  if (hubId !== null && typeof hubId !== 'string') throw new HttpError(400, 'hubId must be a text value.');
  res.json(runScheduler(hubId, req.user.id));
}));

// Operations staff, or the owner of a personal vehicle for their own vehicle: the service decides.
router.post('/move-requests/:moveRequestId/start', asyncRoute((req, res) => res.json({
  moveRequest: startMoveRequest({ user: req.user, moveRequestId: req.params.moveRequestId })
})));
router.post('/move-requests/:moveRequestId/done', asyncRoute((req, res) => res.json({
  moveRequest: completeMoveRequest({ user: req.user, moveRequestId: req.params.moveRequestId })
})));
router.post('/holding/:slotId/release', asyncRoute((req, res) => res.json(releaseHolding({ user: req.user, slotId: req.params.slotId }))));
router.post('/move-requests/:moveRequestId/stop', asyncRoute((req, res) => res.json({
  moveRequest: stopAutoMove({ user: req.user, moveRequestId: req.params.moveRequestId })
})));
// Pause = the old "stop" (the countdown is frozen and the request waits); resume starts the countdown again.
router.post('/move-requests/:moveRequestId/pause', asyncRoute((req, res) => res.json({
  moveRequest: stopAutoMove({ user: req.user, moveRequestId: req.params.moveRequestId })
})));
router.post('/move-requests/:moveRequestId/resume', asyncRoute((req, res) => res.json({
  moveRequest: resumeAutoMove({ user: req.user, moveRequestId: req.params.moveRequestId })
})));
router.post('/move-requests/:moveRequestId/cancel', asyncRoute((req, res) => res.json({
  moveRequest: cancelMoveRequest({ user: req.user, moveRequestId: req.params.moveRequestId })
})));

export default router;