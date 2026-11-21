import { db } from '../database/db.js';
import { HttpError } from '../services/commonService.js';

export function attachUser(req, _res, next) {
  const id = req.header('x-user-id');
  if (!id) { req.user = null; return next(); }
  const user = db.prepare('SELECT id, full_name, role FROM users WHERE id=?').get(id);
  req.user = user || null;
  next();
}

export function requireLogin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in with a demo account.'));
  next();
}

export function asyncRoute(handler) {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (error) { next(error); }
  };
}
