// checks/build.js — BLD-001 (build), BLD-002 (lint), BLD-003 (tests)

'use strict';

const { execa } = require('execa');
const path = require('path');
const { CHECKS } = require('../constants');

/**
 * Run a shell command in the target repo directory.
 * Returns { exitCode, stdout, stderr }
 */
async function run(cmd, args, cwd) {
  try {
    const result = await execa(cmd, args, { cwd, reject: false, all: true });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      all: result.all || '',
    };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: err.message, all: err.message };
  }
}

/**
 * BLD-001 — Build succeeds with zero errors.
 * Runs `npm run build`. Passes if exit code is 0.
 */
async function checkBuild(repoPath) {
  const check = CHECKS.BLD_001;
  const result = await run('npm', ['run', 'build', '--if-present'], repoPath);

  if (result.exitCode === 0) {
    return { ...check, pass: true, score: check.weight, detail: 'Build succeeded.' };
  }

  // Extract first meaningful error lines (up to 5)
  const errorLines = result.all
    .split('\n')
    .filter(l => /error|Error|ERROR/.test(l))
    .slice(0, 5)
    .join('\n  ');

  return {
    ...check,
    pass: false,
    score: 0,
    detail: `Build failed (exit ${result.exitCode}). Fix: run \`npm run build\` locally until exit code 0.`,
    errors: errorLines || result.stderr.slice(0, 400),
  };
}

/**
 * BLD-002 — Lint passes (zero errors).
 * Runs `npm run lint`. Warnings are allowed; errors are not.
 */
async function checkLint(repoPath) {
  const check = CHECKS.BLD_002;
  const result = await run('npm', ['run', 'lint', '--if-present'], repoPath);

  if (result.exitCode === 0) {
    return { ...check, pass: true, score: check.weight, detail: 'Lint passed (zero errors).' };
  }

  const errorLines = result.all
    .split('\n')
    .filter(l => /\berror\b/i.test(l))
    .slice(0, 8)
    .join('\n  ');

  return {
    ...check,
    pass: false,
    score: 0,
    detail: 'Lint failed. Fix: run `npm run lint` and resolve all errors (warnings are allowed).',
    errors: errorLines || result.stderr.slice(0, 400),
  };
}

/**
 * BLD-003 — Test suite passes.
 * Runs `npm test`. All tests must pass.
 * Extracts failing test names and file:line references.
 */
async function checkTests(repoPath) {
  const check = CHECKS.BLD_003;
  // CI=true prevents interactive watch mode
  const result = await run('npm', ['test', '--', '--watchAll=false', '--forceExit'], repoPath);

  if (result.exitCode === 0) {
    // Try to extract test count
    const match = result.all.match(/(\d+)\s+passed/);
    const detail = match ? `All tests passed (${match[1]} tests).` : 'All tests passed.';
    return { ...check, pass: true, score: check.weight, detail };
  }

  // Extract failing test references: "● TestSuite › test name" and file:line patterns
  const failLines = result.all
    .split('\n')
    .filter(l => /●|FAIL|✕|✗|×/.test(l))
    .slice(0, 10)
    .map(l => l.trim())
    .join('\n  ');

  const fileRefs = [...result.all.matchAll(/(\w[\w./]+\.(test|spec)\.[jt]sx?:\d+)/g)]
    .map(m => m[1])
    .slice(0, 6)
    .join(', ');

  return {
    ...check,
    pass: false,
    score: 0,
    detail: `Tests failing. Fix: run \`npm test\` — all tests must pass. Add missing tests for untested routes.`,
    errors: fileRefs ? `Failing references: ${fileRefs}\n  ${failLines}` : failLines || result.stderr.slice(0, 400),
  };
}

/**
 * Run all build checks and return array of results.
 * @param {string} repoPath — absolute path to target repo
 */
async function runBuildChecks(repoPath) {
  const [build, lint, tests] = await Promise.all([
    checkBuild(repoPath),
    checkLint(repoPath),
    checkTests(repoPath),
  ]);
  return [build, lint, tests];
}

module.exports = { runBuildChecks, checkBuild, checkLint, checkTests };
