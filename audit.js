#!/usr/bin/env node
// audit.js — Lorem Audit main runner
// Usage: npx lorem-audit --repo <path> --env <staging|production>

'use strict';

const { program }           = require('commander');
const path                  = require('path');
const { CHECKS, getStatus, MAX_SCORE } = require('./constants');
const { runBuildChecks }    = require('./checks/build');
const { runSecurityChecks } = require('./checks/security');
const { runConfigChecks }   = require('./checks/config');
const { runQualityChecks }  = require('./checks/quality');
const { checkHeaders }      = require('./checks/headers');
const { checkDockerfile }   = require('./checks/deployment');
const { report }            = require('./reporter');

// ─── CLI ────────────────────────────────────────────────────────────────────
program
  .name('lorem-audit')
  .description('Production readiness audit tool — scores a repository 0–100')
  .option('--repo <path>',  'Path to the repository to audit', '.')
  .option('--env <name>',   'Target environment (staging | production)', 'staging')
  .option('--skip-quality', 'Skip Lighthouse quality checks (faster local runs)')
  .option('--skip-docker',  'Skip Docker build check')
  .option('--json',         'Output raw JSON to stdout (no colour)')
  .parse(process.argv);

const opts    = program.opts();
const repoPath = path.resolve(opts.repo);
const envName  = opts.env;

// ─── Timeout helper ─────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

/**
 * Wrap a check group so a single group failure doesn't abort the whole audit.
 */
async function safeRun(label, fn, fallbackChecks) {
  try {
    return await withTimeout(fn(), 120_000, label);
  } catch (err) {
    console.warn(`[audit] ${label} failed: ${err.message}`);
    return fallbackChecks.map(check => ({
      ...check,
      pass: false,
      score: 0,
      detail: `Check could not run: ${err.message}`,
    }));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!opts.json) {
    console.log(`\n[lorem-audit] Starting audit…`);
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Env:  ${envName}\n`);
  }

  // Run all check groups (in parallel where safe, sequential where order matters)
  const [
    buildResults,
    securityResults,
    configResults,
  ] = await Promise.all([
    safeRun('Build checks',    () => runBuildChecks(repoPath),    [CHECKS.BLD_001, CHECKS.BLD_002, CHECKS.BLD_003]),
    safeRun('Security checks', () => runSecurityChecks(repoPath), [CHECKS.SEC_001, CHECKS.SEC_002]),
    safeRun('Config checks',   () => runConfigChecks(repoPath, envName), [CHECKS.CFG_001, CHECKS.CFG_002]),
  ]);

  // Quality checks run after build (need build output), skip if flagged
  const qualityResults = opts.skipQuality
    ? [CHECKS.A11Y_001, CHECKS.PERF_001, CHECKS.SEO_001].map(c => ({
        ...c, pass: false, score: 0, detail: 'Skipped (--skip-quality flag)',
      }))
    : await safeRun('Quality checks', () => runQualityChecks(repoPath), [CHECKS.A11Y_001, CHECKS.PERF_001, CHECKS.SEO_001]);

  // Headers check (separate — spins up server)
  const headersResult = await safeRun('Headers check', () => checkHeaders(repoPath), [CHECKS.HDR_001]);
  const headerResults = Array.isArray(headersResult) ? headersResult : [headersResult];

  // Docker check (optional)
  const dockerResult = opts.skipDocker
    ? [{ ...CHECKS.DEP_001, pass: true, score: CHECKS.DEP_001.weight, detail: 'Skipped (Docker not used — non-containerized deployment)' }]
    : await safeRun('Deployment check', () => checkDockerfile(repoPath).then(r => [r]), [CHECKS.DEP_001]);

  // Flatten all results in rubric order
  const results = [
    ...buildResults,
    ...securityResults,
    ...configResults,
    ...qualityResults,
    ...headerResults,
    ...dockerResult,
  ];

  // ── Scoring ───────────────────────────────────────────────────────────────
  const totalScore = results.reduce((sum, r) => sum + (r.score || 0), 0);
  const status     = getStatus(totalScore);
  const timestamp  = new Date().toISOString();

  // Derive repo name from package.json or directory name
  let repoName = path.basename(repoPath);
  try {
    const pkg = require(path.join(repoPath, 'package.json'));
    if (pkg.name) repoName = pkg.name;
  } catch {}

  const auditResult = {
    repoName,
    env: envName,
    timestamp,
    totalScore,
    maxScore: MAX_SCORE,
    status,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    results,
  };

  // ── Output ────────────────────────────────────────────────────────────────
  if (opts.json) {
    console.log(JSON.stringify(auditResult, null, 2));
  } else {
    await report(auditResult, repoPath);
  }

  // ── Exit code ─────────────────────────────────────────────────────────────
  // In CI: exit 1 if score below 90 for staging/production gates
  // For dev gate: exit 1 if score below 70
  const exitThreshold = envName === 'dev' ? 70 : 90;
  if (totalScore < exitThreshold) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[lorem-audit] Fatal error:', err.message);
  process.exit(1);
});
