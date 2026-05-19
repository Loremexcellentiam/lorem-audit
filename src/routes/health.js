// src/routes/health.js
// Health check endpoint — required for:
//   • Docker HEALTHCHECK (Dockerfile)
//   • Smoke test (scripts/smoke-test.sh)
//   • Audit tool headers check (checks/headers.js)
//
// Mount in your Express app: app.use('/health', require('./routes/health'))
// or:                         app.use('/api/health', require('./routes/health'))

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * GET /health
 * Returns HTTP 200 when the app is up.
 * Optionally checks DB connectivity (Sequelize) — useful for deep health checks.
 */
router.get('/', async (req, res) => {
  const response = {
    status:    'ok',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'unknown',
    version:   process.env.npm_package_version || '0.0.0',
    commit:    process.env.COMMIT_SHA || 'unknown',
  };

  // ── Optional: Sequelize DB ping ────────────────────────────────────────────
  // Uncomment to add DB connectivity to the health check.
  // A failed DB ping returns HTTP 503 (keeps the container healthy flag accurate).
  //
  // try {
  //   const { sequelize } = require('../models');   // adjust path to your models index
  //   await sequelize.authenticate();
  //   response.db = 'connected';
  // } catch (err) {
  //   response.db     = 'disconnected';
  //   response.dbError = err.message;
  //   return res.status(503).json(response);
  // }

  return res.status(200).json(response);
});

module.exports = router;
