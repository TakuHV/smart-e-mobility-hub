import { Router } from 'express';
import { asyncRoute, requireLogin, requireRoles, pick } from '../middleware/requestContext.js';
import { listSimulationRuns, getSimulationRun, runSimulation, compareSimulationRuns, getHubBaselineContext,
  applyRecommendation, declineRecommendation, listHandoffs, completeHandoff } from '../services/simulationService.js';
import { HttpError } from '../services/commonService.js';

const MAX_COMPARED_RUNS = 10;
// A stored run holds a baseline of the network (including vehicle plates), so only the roles that use simulation read it.
const canRead = requireRoles('Simulation Operator', 'Operator', 'Admin');

// The authenticated user and the ids in the URL always come last, so a request body can never replace them.
const router = Router();
router.use(requireLogin);

// Current state of one Hub for the scenario form (no vehicle plates, nothing stored).
router.get('/baseline/:hubId', canRead, asyncRoute((req, res) => res.json({ baseline: getHubBaselineContext(req.params.hubId) })));

router.get('/runs', canRead, asyncRoute((_req, res) => res.json({ runs: listSimulationRuns() })));
router.get('/runs/:runId', canRead, asyncRoute((req, res) => {
  const run = getSimulationRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Simulation run not found.' });
  res.json({ run });
}));

router.post('/runs', asyncRoute((req, res) => res.status(201).json({
  run: runSimulation({
    ...pick(req.body, ['hubId', 'scenarioType', 'demandDelta', 'chargerOutageCount', 'slotType',
      'powerLimitKw', 'label', 'startOccupancyPercent', 'outageChargerIds',
      'weights', 'urgentSharePercent', 'demandSeed']),
    user: req.user
  })
})));

router.post('/compare', asyncRoute((req, res) => {
  const runIds = req.body?.runIds;
  if (!Array.isArray(runIds) || runIds.length > MAX_COMPARED_RUNS) {
    throw new HttpError(400, `runIds must be a list of at most ${MAX_COMPARED_RUNS} run ids.`);
  }
  res.json({ comparison: compareSimulationRuns({ user: req.user, runIds }) });
}));

router.get('/handoffs', canRead, asyncRoute((_req, res) => res.json({ handoffs: listHandoffs() })));

router.post('/recommendations/:recommendationId/apply', asyncRoute((req, res) => res.json(
  applyRecommendation({ user: req.user, recommendationId: req.params.recommendationId })
)));
router.post('/recommendations/:recommendationId/decline', asyncRoute((req, res) => res.json({
  recommendation: declineRecommendation({ user: req.user, recommendationId: req.params.recommendationId })
})));
router.post('/handoffs/:handoffId/complete', asyncRoute((req, res) => res.json({
  handoff: completeHandoff({
    ...pick(req.body, ['completionNote']),
    user: req.user,
    handoffId: req.params.handoffId
  })
})));

export default router;