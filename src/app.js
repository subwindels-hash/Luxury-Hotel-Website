const express = require('express');
const path = require('node:path');
const { initDatabase } = require('./db/database');
const { seedDatabase } = require('./db/seed');
const {
  sanitizeMiddleware,
  securityHeadersMiddleware,
  csrfProtectionMiddleware,
  createRateLimiter
} = require('./middleware/security');
const apiRouter = require('./routes/api');

function createApp(customDbPath = null) {
  const db = initDatabase(customDbPath);
  seedDatabase(db);

  const app = express();
  app.disable('x-powered-by');

  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(sanitizeMiddleware);

  // Rate limiting on API routes
  app.use('/api', createRateLimiter({ windowMs: 60000, maxRequests: 500 }));
  app.use(csrfProtectionMiddleware);

  // Healthcheck
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'Maison Aurélia Grand Palace & Sanctuary Reservation Engine',
      timestamp: new Date().toISOString()
    });
  });

  // Main REST API
  app.use('/api', apiRouter);

  // Static frontend assets
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // SPA fallback for non-API routes
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `API endpoint ${req.method} ${req.path} not found.` });
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
