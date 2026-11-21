import { Router } from 'express';
import { asyncRoute, requireLogin } from '../middleware/requestContext.js';
import { listSimulationRuns, getSimulationRun, runSimulation, compareSimulationRuns,
  applyRecommendation, declineRecommendation, listHandoffs, completeHandoff } from '../services/simulationService.js';

const router = Router();
router.use(requireLogin);
router.get('/runs', asyncRoute((_req, res) => res.json({ runs: listSimulationRuns() })));
router.get('/runs/:runId', asyncRoute((req, res) => {
  const run = getSimulationRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Simulation run not found.' });
  res.json({ run });
}));
router.post('/runs', asyncRoute((req, res) => res.status(201).json({ run: runSimulation({ user: req.user, ...req.body }) })));
router.post('/compare', asyncRoute((req, res) => res.json({ comparison: compareSimulationRuns({ user: req.user, runIds: req.body?.runIds }) })));
router.get('/handoffs', asyncRoute((_req, res) => res.json({ handoffs: listHandoffs() })));
router.post('/recommendations/:recommendationId/apply', asyncRoute((req, res) => res.json(applyRecommendation({ user: req.user, recommendationId: req.params.recommendationId }))));
router.post('/recommendations/:recommendationId/decline', asyncRoute((req, res) => res.json({ recommendation: declineRecommendation({ user: req.user, recommendationId: req.params.recommendationId }) })));
router.post('/handoffs/:handoffId/complete', asyncRoute((req, res) => res.json({ handoff: completeHandoff({ user: req.user, handoffId: req.params.handoffId, ...req.body }) })));
export default router;
