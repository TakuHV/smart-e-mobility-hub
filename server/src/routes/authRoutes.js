import { Router } from 'express';
import { asyncRoute, requireLogin, pick } from '../middleware/requestContext.js';
import { demoLogin } from '../services/authService.js';

const router = Router();

router.post('/demo-login', asyncRoute((req, res) => {
  res.json({
    user: demoLogin(pick(req.body, ['displayName', 'role'])),
    demo: true,
    notice: 'Demo identity only. This is not production authentication or live University SSO.'
  });
}));

// Lets the client check a stored demo id: after the demo database is recreated an old id is no longer known (401).
router.get('/me', requireLogin, asyncRoute((req, res) => res.json({ user: req.user, demo: true })));

export default router;