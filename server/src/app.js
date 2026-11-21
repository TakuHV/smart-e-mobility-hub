import express from 'express';
import cors from 'cors';
import { db } from './database/db.js';
import { seedDatabase } from './database/seed.js';
import { attachUser } from './middleware/requestContext.js';
import { HttpError } from './services/commonService.js';
import { runMaintenance, runScheduler } from './services/chargingService.js';
import authRoutes from './routes/authRoutes.js';
import hubRoutes from './routes/hubRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import parkingRoutes from './routes/parkingRoutes.js';
import chargingRoutes from './routes/chargingRoutes.js';
import simulationRoutes from './routes/simulationRoutes.js';

seedDatabase();

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', service: 'Smart E-Mobility Hub MVP', database: 'SQLite',
  now: new Date().toISOString()
}));
app.use('/api/auth', authRoutes);
app.use('/api/hubs', hubRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/parking', parkingRoutes);
app.use('/api/charging', chargingRoutes);
app.use('/api/simulation', simulationRoutes);

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message, details: error.details });
  }
  console.error(error);
  res.status(500).json({ error: 'Unexpected server error. Existing data was not reported as successfully changed.' });
});

// NI-01 / NI-02 / NI-04: the MVP runs periodic expiry, simulated status refresh and scheduling cycles.
runMaintenance();
runScheduler();
const maintenanceTimer = setInterval(() => {
  try { runMaintenance(); runScheduler(); }
  catch (error) { console.error('Background maintenance failed:', error); }
}, 60_000);
maintenanceTimer.unref?.();

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => {
  console.log(`Smart E-Mobility Hub API listening on http://localhost:${port}`);
  console.log(`SQLite database: ${new URL('../../data/smart_e_mobility.sqlite', import.meta.url).pathname}`);
});

function shutdown() {
  clearInterval(maintenanceTimer);
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
