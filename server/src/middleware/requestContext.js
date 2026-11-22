import { db } from '../database/db.js';
import { HttpError, requireRole } from '../services/commonService.js';

/*
 * DEMO identity only: the client sends the id of a demo account in the x-user-id header. Anyone who knows an id can
 * act as that user, so this must stay on localhost (see README). It does not model the university SSO (BR-01), the
 * 30-minute session timeout (BR-04) or deactivated accounts (BR-07).
 */
export function attachUser(req, _res, next) {
  const id = req.header('x-user-id');
  if (typeof id !== 'string' || !id || id.length > 100) { req.user = null; return next(); }
  // An unknown id (for example after the demo database was recreated) is treated as not signed in.
  req.user = db.prepare('SELECT id, full_name, role FROM users WHERE id=?').get(id) || null;
  next();
}

export function requireLogin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in with a demo account.'));
  next();
}

// Route-level permission (BR-05): requireRoles('Operator', 'Admin') answers 401 when not signed in, 403 for another role.
export function requireRoles(...roles) {
  return (req, _res, next) => {
    try { requireRole(req.user, roles); next(); }
    catch (error) { next(error); }
  };
}

/**
 * Copies only the listed fields from a request body. Routes must use this instead of spreading req.body into a
 * service call: a spread lets the client send its own `user` or `requestId` and replace the authenticated ones.
 */
export function pick(source, keys) {
  const result = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const key of keys) {
      if (Object.hasOwn(source, key) && source[key] !== undefined) result[key] = source[key];
    }
  }
  return result;
}

export function asyncRoute(handler) {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (error) { next(error); }
  };
}