import { Router } from 'express';
import { asyncRoute } from '../middleware/requestContext.js';
import { demoLogin } from '../services/authService.js';

const router = Router();
router.post('/demo-login', asyncRoute((req, res) => {
  res.json({ user: demoLogin(req.body || {}), demo: true,
    notice: 'Demo identity only. This is not production authentication or live University SSO.' });
}));
export default router;
