import { Router } from 'express';
import { asyncRoute, requireLogin, requireRoles, pick } from '../middleware/requestContext.js';
import { listIncidents, incidentHistory, reportIncident, acknowledgeIncident, resolveIncident, attentionItems, CATEGORIES, SEVERITIES } from '../services/incidentService.js';
import { HttpError } from '../services/commonService.js';

// UC-019. A student sees and reports their own problems; Operators and Admins handle all of them.
const router = Router();
router.use(requireLogin);

router.get('/', asyncRoute((req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  if (status && !['Open', 'In Progress', 'Resolved'].includes(status)) throw new HttpError(400, 'status must be Open, In Progress or Resolved.');
  res.json({ incidents: listIncidents({ user: req.user, status }), categories: CATEGORIES, severities: SEVERITIES });
}));
router.get('/attention', requireRoles('Operator', 'Admin'), asyncRoute((req, res) => res.json({ items: attentionItems(req.user) })));
router.get('/:incidentId/history', requireRoles('Operator', 'Admin'), asyncRoute((req, res) => res.json({ history: incidentHistory(req.user, req.params.incidentId) })));

router.post('/', asyncRoute((req, res) => res.status(201).json(reportIncident({
  ...pick(req.body, ['category', 'severity', 'summary', 'vehicleId', 'chargerId', 'slotId', 'hubId']), user: req.user
}))));
router.post('/:incidentId/acknowledge', asyncRoute((req, res) => res.json({ incident: acknowledgeIncident({ user: req.user, incidentId: req.params.incidentId }) })));
router.post('/:incidentId/resolve', asyncRoute((req, res) => res.json(resolveIncident({
  note: req.body?.note, restore: req.body?.restore !== false, user: req.user, incidentId: req.params.incidentId
}))));

export default router;
