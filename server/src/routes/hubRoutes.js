import { Router } from 'express';
import { asyncRoute } from '../middleware/requestContext.js';
import { listHubs, getHubStatus } from '../services/hubService.js';

const router = Router();
router.get('/', asyncRoute((req, res) => res.json({ hubs: listHubs({ q: req.query.q || '', resourceType: req.query.resourceType || '' }) })));
router.get('/:hubId/status', asyncRoute((req, res) => {
  const status = getHubStatus(req.params.hubId);
  if (!status) return res.status(404).json({ error: 'Hub not found.' });
  res.json({ status });
}));
export default router;
