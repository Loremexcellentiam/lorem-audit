// constants.js — Single source of truth for all check IDs, weights, and thresholds

'use strict';

const CHECKS = {
  // BUILD
  BLD_001: { id: 'BLD-001', category: 'BUILD',       label: 'Build succeeds (zero errors)',    weight: 20 },
  BLD_002: { id: 'BLD-002', category: 'BUILD',       label: 'Lint passes (zero errors)',       weight: 5  },
  BLD_003: { id: 'BLD-003', category: 'BUILD',       label: 'Test suite passes',               weight: 10 },

  // SECURITY
  SEC_001: { id: 'SEC-001', category: 'SECURITY',    label: 'No high/critical CVEs',           weight: 15 },
  SEC_002: { id: 'SEC-002', category: 'SECURITY',    label: 'No secrets in source',            weight: 15 },

  // CONFIGURATION
  CFG_001: { id: 'CFG-001', category: 'CONFIG',      label: '.env.example present & complete', weight: 5  },
  CFG_002: { id: 'CFG-002', category: 'CONFIG',      label: 'All required env vars declared',  weight: 5  },

  // QUALITY
  A11Y_001: { id: 'A11Y-001', category: 'QUALITY',  label: 'Accessibility score ≥ 80',        weight: 5  },
  PERF_001: { id: 'PERF-001', category: 'QUALITY',  label: 'Performance score ≥ 70',          weight: 5  },
  SEO_001:  { id: 'SEO-001',  category: 'QUALITY',  label: 'SEO score ≥ 80',                  weight: 5  },
  HDR_001:  { id: 'HDR-001',  category: 'QUALITY',  label: 'Security headers present',        weight: 5  },

  // DEPLOYMENT
  DEP_001: { id: 'DEP-001', category: 'DEPLOYMENT', label: 'Dockerfile present & builds',     weight: 5  },
};

const THRESHOLDS = {
  PRODUCTION_READY: 90,  // deploy permitted
  FIX_REQUIRED: 70,      // deploy blocked, fixes listed
  REJECT: 0,             // pipeline fails immediately
};

const STATUS = {
  PRODUCTION_READY: 'PRODUCTION READY',
  FIX_REQUIRED:     'FIX REQUIRED',
  REJECT:           'REJECT',
};

/**
 * Derive status label from a numeric score.
 * @param {number} score
 * @returns {string}
 */
function getStatus(score) {
  if (score >= THRESHOLDS.PRODUCTION_READY) return STATUS.PRODUCTION_READY;
  if (score >= THRESHOLDS.FIX_REQUIRED)     return STATUS.FIX_REQUIRED;
  return STATUS.REJECT;
}

/**
 * Calculate total possible score (should always equal 100).
 */
const MAX_SCORE = Object.values(CHECKS).reduce((sum, c) => sum + c.weight, 0);

module.exports = { CHECKS, THRESHOLDS, STATUS, getStatus, MAX_SCORE };
