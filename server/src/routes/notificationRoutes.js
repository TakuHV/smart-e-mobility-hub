import { Router } from 'express';
import { asyncRoute, requireLogin, pick } from '../middleware/requestContext.js';
import { listNotifications, markNotificationsRead } from '../services/notificationService.js';

const router = Router();
router.use(requireLogin);

router.get('/', asyncRoute((req, res) => res.json(listNotifications(req.user))));

// Without an id every notification of the user is marked as read.
router.post('/read', asyncRoute((req, res) => {
  const { id } = pick(req.body, ['id']);
  res.json(markNotificationsRead(req.user, typeof id === 'string' ? id : null));
}));

export default router;
