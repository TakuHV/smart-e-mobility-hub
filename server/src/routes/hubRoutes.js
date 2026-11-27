import { Router } from 'express';
import { asyncRoute, requireLogin, requireRoles } from '../middleware/requestContext.js';
import { listHubs, getHubStatus } from '../services/hubService.js';
import { setSimulatedSensorFeed } from '../services/chargingService.js';
import { activeRedirects } from '../services/userRedirectService.js';
import { HttpError } from '../services/commonService.js';

const RESOURCE_TYPES = ['', 'shared', 'parking', 'return', 'charger'];

const router = Router();
router.use(requireLogin); // UC-003 and UC-004 need a signed-in user

router.get('/', asyncRoute((req, res) => {
  const resourceType = String(req.query.resourceType || '');
  if (!RESOURCE_TYPES.includes(resourceType)) throw new HttpError(400, `resourceType must be one of: ${RESOURCE_TYPES.filter(Boolean).join(', ')}.`);
  res.json({ hubs: listHubs({ q: String(req.query.q || ''), resourceType }) });
}));

// Notices for students: Hubs that currently ask users to go to another Hub.
router.get('/redirects', asyncRoute((_req, res) => res.json({ redirects: activeRedirects() })));

router.get('/:hubId/status', asyncRoute((req, res) => {
  // The user is passed on so that a Student does not see other students' personal vehicles (BR-07).
  const status = getHubStatus(req.params.hubId, req.user);
  if (!status) return res.status(404).json({ error: 'Hub not found.' });
  res.json({ status });
}));

// Demo control for NI-02: pause or resume the simulated status feed. While it is paused, Hub data turns Stale after 2 minutes.
router.post('/sensor-feed', requireRoles('Operator', 'Admin'), asyncRoute((req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.');
  res.json({ sensorFeedEnabled: setSimulatedSensorFeed(req.body.enabled) });
}));

export default router;