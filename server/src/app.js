import express from 'express';
import cors from 'cors';
import { db, databasePath, closeDatabase } from './database/db.js';
import { seedDatabase } from './database/seed.js';
import { attachUser } from './middleware/requestContext.js';
import { HttpError } from './services/commonService.js';
import { runMaintenance } from './services/chargingService.js';
import authRoutes from './routes/authRoutes.js';
import hubRoutes from './routes/hubRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import parkingRoutes from './routes/parkingRoutes.js';
import chargingRoutes from './routes/chargingRoutes.js';
import simulationRoutes from './routes/simulationRoutes.js';

const isTest = process.env.NODE_ENV === 'test';

seedDatabase();

const app = express();
app.disable('x-powered-by');
// Local demo only: without CLIENT_ORIGIN any origin is allowed. Set CLIENT_ORIGIN before exposing the API.
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', service: 'Smart E-Mobility Hub MVP', database: 'SQLite', now: new Date().toISOString() });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'error', service: 'Smart E-Mobility Hub MVP', database: 'unavailable' });
  }
});
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
  // Request-body problems raised by express.json().
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large.' });
  // Database rules (schema.sql) that fired before a service check did.
  const message = String(error?.message ?? '');
  if (message.includes('UNIQUE constraint failed')) {
    return res.status(409).json({ error: 'Another request changed the same resource first. Please reload and try again.' });
  }
  if (/(CHECK|FOREIGN KEY|NOT NULL) constraint failed/.test(message)) {
    return res.status(400).json({ error: 'The request contains a value that is not allowed. Nothing was changed.' });
  }
  console.error(error);
  res.status(500).json({ error: 'Unexpected server error. Existing data was not reported as successfully changed.' });
});

// NI-01 / NI-02 / NI-04: one periodic cycle. runMaintenance() expires holds, refreshes the simulated status feed
// and runs the Charging Scheduler, so it is the only call needed here.
function runCycle() {
  try { runMaintenance(); }
  catch (error) { console.error('Background maintenance failed:', error); }
}

let maintenanceTimer;
let server;
if (!isTest) {
  const intervalMs = Math.max(1000, Number(process.env.MAINTENANCE_INTERVAL_MS) || 60_000);
  runCycle();
  maintenanceTimer = setInterval(runCycle, intervalMs);
  maintenanceTimer.unref?.();

  const port = Number(process.env.PORT || 4000);
  server = app.listen(port, () => {
    console.log(`Smart E-Mobility Hub API listening on http://localhost:${port}`);
    console.log(`SQLite database: ${databasePath}`);
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another value.` : error);
    process.exit(1);
  });

  const shutdown = () => {
    clearInterval(maintenanceTimer);
    const forced = setTimeout(() => process.exit(1), 5000); // do not wait forever for open connections
    forced.unref?.();
    server.close(() => { closeDatabase(); process.exit(0); });
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default app;