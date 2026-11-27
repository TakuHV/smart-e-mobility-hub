import { Router } from 'express';
import { resetDemoData } from '../services/demoResetService.js';
import { listUsers, createUser, setUserStatus, setUserRole, accessOverview, ROLES } from '../services/userAdminService.js';
import { asyncRoute, requireLogin, requireRoles, pick } from '../middleware/requestContext.js';
import { adminOverview, updateHub, addSlots, removeSlot, setSlotStatus, addCharger, updateCharger, removeCharger,
  addSharedVehicle, addPersonalVehicle, retireVehicle } from '../services/adminService.js';
import { getSettings, saveSettings, resetSettings } from '../services/settingsService.js';
import { HttpError } from '../services/commonService.js';

// Admin configuration area. Every route needs the Admin role; the services check it again.
const router = Router();
router.use(requireLogin, requireRoles('Admin'));

router.get('/overview', asyncRoute((req, res) => res.json({ ...adminOverview(req.user), settings: getSettings() })));

router.get('/users', asyncRoute((req, res) => res.json({ users: listUsers(req.user), roles: ROLES })));
router.post('/users', asyncRoute((req, res) => res.status(201).json({ user: createUser({ ...pick(req.body, ['fullName', 'role']), user: req.user }) })));
router.patch('/users/:userId', asyncRoute((req, res) => {
  const { status, role } = pick(req.body, ['status', 'role']);
  if (status === undefined && role === undefined) throw new HttpError(400, 'Send a status or a role to change.');
  let result;
  if (status !== undefined) result = setUserStatus({ user: req.user, userId: req.params.userId, status });
  if (role !== undefined) result = setUserRole({ user: req.user, userId: req.params.userId, role });
  res.json({ user: result });
}));
router.get('/access', asyncRoute((req, res) => res.json(accessOverview(req.user))));

// DEMO ONLY (not part of the project scope): put the sample data back to its starting state.
router.post('/reset-demo', asyncRoute((req, res) => {
  if (req.body?.confirm !== 'RESET') throw new HttpError(400, 'Confirm the reset by sending { "confirm": "RESET" }.');
  res.json(resetDemoData({ user: req.user }));
}));

router.get('/settings', asyncRoute((_req, res) => res.json(getSettings())));
router.patch('/settings', asyncRoute((req, res) => {
  if (!req.body || typeof req.body.patch !== 'object' || Array.isArray(req.body.patch)) throw new HttpError(400, 'Send the changed values as { "patch": { ... } }.');
  res.json(saveSettings({ user: req.user, patch: req.body.patch }));
}));
router.post('/settings/reset', asyncRoute((req, res) => res.json(resetSettings({ user: req.user }))));

router.patch('/hubs/:hubId', asyncRoute((req, res) => res.json({
  hub: updateHub({ ...pick(req.body, ['name', 'powerLimitKw', 'openTime', 'closeTime', 'status']), user: req.user, hubId: req.params.hubId })
})));
router.post('/hubs/:hubId/slots', asyncRoute((req, res) => res.status(201).json({
  slots: addSlots({ ...pick(req.body, ['slotType', 'count', 'supportedVehicleTypes']), user: req.user, hubId: req.params.hubId })
})));
router.post('/hubs/:hubId/chargers', asyncRoute((req, res) => res.status(201).json({
  charger: addCharger({ ...pick(req.body, ['powerKw', 'connectorTypes']), user: req.user, hubId: req.params.hubId })
})));
router.post('/hubs/:hubId/shared-vehicles', asyncRoute((req, res) => res.status(201).json({
  vehicle: addSharedVehicle({ ...pick(req.body, ['plate', 'vehicleType', 'connectorType', 'batteryLevel']), user: req.user, hubId: req.params.hubId })
})));

router.patch('/slots/:slotId', asyncRoute((req, res) => res.json({
  slot: setSlotStatus({ ...pick(req.body, ['status']), user: req.user, slotId: req.params.slotId })
})));
router.delete('/slots/:slotId', asyncRoute((req, res) => res.json(removeSlot({ user: req.user, slotId: req.params.slotId }))));

router.patch('/chargers/:chargerId', asyncRoute((req, res) => res.json({
  charger: updateCharger({ ...pick(req.body, ['powerKw', 'connectorTypes', 'status']), user: req.user, chargerId: req.params.chargerId })
})));
router.delete('/chargers/:chargerId', asyncRoute((req, res) => res.json(removeCharger({ user: req.user, chargerId: req.params.chargerId }))));

router.post('/personal-vehicles', asyncRoute((req, res) => res.status(201).json({
  vehicle: addPersonalVehicle({ ...pick(req.body, ['ownerId', 'hubId', 'plate', 'vehicleType', 'connectorType', 'batteryLevel']), user: req.user })
})));
router.delete('/vehicles/:vehicleId', asyncRoute((req, res) => res.json(retireVehicle({ user: req.user, vehicleId: req.params.vehicleId }))));

export default router;
