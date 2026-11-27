import { Router } from 'express';
import { asyncRoute, requireLogin, requireRoles, pick } from '../middleware/requestContext.js';
import { userRedirectOverview, createUserRedirect, endUserRedirect } from '../services/userRedirectService.js';
import { redistributionOverview, createTask, startTask, completeTask, cancelTask, planFromHandoff } from '../services/redistributionService.js';

// UC-018 Coordinate Vehicle Redistribution: Operators and Admins only.
const router = Router();
router.use(requireLogin, requireRoles('Operator', 'Admin'));

router.get('/overview', asyncRoute((req, res) => res.json(redistributionOverview(req.user))));
router.post('/tasks', asyncRoute((req, res) => res.status(201).json({
  task: createTask({ ...pick(req.body, ['vehicleId', 'toHubId', 'reason']), user: req.user })
})));
router.post('/tasks/:taskId/start', asyncRoute((req, res) => res.json({ task: startTask({ user: req.user, taskId: req.params.taskId }) })));
router.post('/tasks/:taskId/done', asyncRoute((req, res) => res.json({ task: completeTask({ user: req.user, taskId: req.params.taskId }) })));
router.post('/tasks/:taskId/cancel', asyncRoute((req, res) => res.json({ task: cancelTask({ user: req.user, taskId: req.params.taskId }) })));
router.post('/handoffs/:handoffId/plan', asyncRoute((req, res) => res.status(201).json({
  tasks: planFromHandoff({ user: req.user, handoffId: req.params.handoffId })
})));

// User redistribution: ask students to use another Hub while one is busy.
router.get('/user-redirects', asyncRoute((req, res) => res.json(userRedirectOverview(req.user))));
router.post('/user-redirects', asyncRoute((req, res) => res.status(201).json({
  redirect: createUserRedirect({ ...pick(req.body, ['fromHubId', 'toHubId', 'reason']), user: req.user })
})));
router.post('/user-redirects/:id/end', asyncRoute((req, res) => res.json({ redirect: endUserRedirect({ user: req.user, redirectId: req.params.id }) })));

export default router;
