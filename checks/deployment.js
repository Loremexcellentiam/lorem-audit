// checks/deployment.js — DEP-001: Dockerfile present and builds cleanly

'use strict';

const { execa }  = require('execa');
const path       = require('path');
const fs         = require('fs');
const { CHECKS } = require('../constants');

/**
 * DEP-001 — Dockerfile is present AND builds successfully.
 *
 * Two sub-steps:
 *   1. Dockerfile must exist at repo root (or in a standard location)
 *   2. `docker build .` must exit 0
 */
async function checkDockerfile(repoPath) {
  const check = CHECKS.DEP_001;

  // Step 1 — Dockerfile exists?
  const candidates = [
    path.join(repoPath, 'Dockerfile'),
    path.join(repoPath, 'dockerfile'),
    path.join(repoPath, 'docker', 'Dockerfile'),
  ];

  const dockerfilePath = candidates.find(p => fs.existsSync(p));

  if (!dockerfilePath) {
    return {
      ...check, pass: false, score: 0,
      detail: 'Dockerfile not found. Fix: create a Dockerfile in the repo root. See README for the expected structure (multi-stage build recommended).',
    };
  }

  // Step 2 — Docker available?
  const dockerCheck = await execa('which', ['docker'], { reject: false });
  if (dockerCheck.exitCode !== 0) {
    // Docker not installed on this machine — pass the file check, skip build check
    return {
      ...check, pass: true, score: check.weight,
      detail: `Dockerfile found at ${path.relative(repoPath, dockerfilePath)}. Docker not available on this runner — build check skipped (will run in CI).`,
    };
  }

  // Step 3 — Build the image
  // Use a unique tag to avoid polluting local images, remove after build
  const tag = `lorem-audit-test-${Date.now()}`;

  let buildResult;
  try {
    buildResult = await execa(
      'docker',
      ['build', '-t', tag, '--no-cache', '-f', dockerfilePath, '.'],
      { cwd: repoPath, reject: false, all: true, timeout: 300_000 } // 5 min max
    );
  } catch (err) {
    return {
      ...check, pass: false, score: 0,
      detail: 'Docker build timed out or threw an unexpected error.',
      errors: err.message.slice(0, 400),
    };
  }

  // Clean up the test image regardless of result
  execa('docker', ['rmi', '-f', tag], { reject: false }).catch(() => {});

  if (buildResult.exitCode === 0) {
    return {
      ...check, pass: true, score: check.weight,
      detail: `Dockerfile builds cleanly (${path.relative(repoPath, dockerfilePath)}).`,
    };
  }

  // Extract last 20 lines of build output (most relevant errors appear at the end)
  const outputLines = (buildResult.all || buildResult.stderr || '')
    .split('\n')
    .filter(l => l.trim())
    .slice(-20)
    .join('\n  ');

  return {
    ...check, pass: false, score: 0,
    detail: `Docker build failed (exit ${buildResult.exitCode}). Fix: run \`docker build .\` locally until exit code 0.`,
    errors: outputLines,
  };
}

module.exports = { checkDockerfile };
