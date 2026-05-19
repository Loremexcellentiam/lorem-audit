// reporter.js — format audit results, post PR comment, upload CI artifact

'use strict';

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');

/**
 * Format a single check result as one report row.
 * Pad labels for monospace alignment.
 */
function formatRow(result, plain = false) {
  const id      = result.id.padEnd(10);
  const label   = result.label.padEnd(32);
  const icon    = result.pass ? '✓' : '✗';
  const scoreStr = `${result.score}/${result.weight}`.padStart(6);
  const detail  = result.detail ? `  → ${result.detail}` : '';
  const errors  = result.errors ? `\n     ${result.errors.replace(/\n/g, '\n     ')}` : '';

  if (plain) {
    return `${id}  ${label}  ${icon}  ${scoreStr}${detail}${errors}`;
  }

  const coloredIcon  = result.pass ? chalk.green(icon)  : chalk.red(icon);
  const coloredScore = result.pass ? chalk.green(scoreStr) : chalk.red(scoreStr);
  const coloredDetail = chalk.yellow(detail);
  const coloredErrors = errors ? chalk.gray(errors) : '';

  return `${chalk.cyan(id)}  ${label}  ${coloredIcon}  ${coloredScore}${coloredDetail}${coloredErrors}`;
}

/**
 * Print a human-readable report to stdout (with colour).
 */
function printToConsole(report) {
  const { repoName, env, results, totalScore, status } = report;
  const divider = '━'.repeat(65);

  console.log('');
  console.log(chalk.bold(`LOREM AUDIT — ${repoName}  [${env}]`));
  console.log(chalk.gray(divider));

  let lastCategory = null;
  for (const result of results) {
    if (result.category !== lastCategory) {
      lastCategory = result.category;
    }
    console.log(formatRow(result));
  }

  console.log(chalk.gray(divider));

  const statusColor =
    status === 'PRODUCTION READY' ? chalk.bold.green :
    status === 'FIX REQUIRED'     ? chalk.bold.yellow :
                                    chalk.bold.red;

  console.log(`SCORE: ${chalk.bold(totalScore + '/100')}   STATUS: ${statusColor(status)}`);

  const failedChecks = results.filter(r => !r.pass);
  if (failedChecks.length > 0) {
    const fixedScore = totalScore + failedChecks.reduce((s, r) => s + r.weight, 0);
    console.log(chalk.gray(`Fix ${failedChecks.length} check(s) → re-run audit → score will be ${fixedScore}/100`));
    if (fixedScore >= 90) {
      console.log(chalk.green('→ PRODUCTION READY after fixes'));
    }
  }

  console.log('');
}

/**
 * Generate Markdown report string.
 * Used for PR comment and .md artifact.
 */
function toMarkdown(report) {
  const { repoName, env, results, totalScore, status, timestamp } = report;

  const statusEmoji =
    status === 'PRODUCTION READY' ? '✅' :
    status === 'FIX REQUIRED'     ? '⚠️' : '❌';

  const rows = results.map(r => {
    const icon   = r.pass ? '✅' : '❌';
    const detail = r.detail || '';
    const errors = r.errors ? `<br><sub>${r.errors.replace(/\n/g, '<br>')}</sub>` : '';
    return `| ${r.id} | ${r.label} | ${icon} | ${r.score}/${r.weight} | ${detail}${errors} |`;
  }).join('\n');

  const failedChecks = results.filter(r => !r.pass);
  const fixNote = failedChecks.length > 0
    ? `\n> Fix ${failedChecks.length} check(s) and re-run: \`npx lorem-audit --repo . --env ${env}\``
    : '';

  return `## ${statusEmoji} Lorem Audit — \`${repoName}\` [\`${env}\`]

**Score: ${totalScore}/100 — ${status}**
${fixNote}

| Check ID | Description | Status | Score | Detail |
|----------|-------------|--------|-------|--------|
${rows}

<sub>Generated: ${timestamp} · [Full report artifact: audit-report.json]</sub>
`;
}

/**
 * Write audit-report.json and audit-report.md to the repo root.
 */
function writeReportFiles(report, repoPath) {
  const jsonPath = path.join(repoPath, 'audit-report.json');
  const mdPath   = path.join(repoPath, 'audit-report.md');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath,   toMarkdown(report),              'utf8');

  return { jsonPath, mdPath };
}

/**
 * Post audit results as a PR comment via GitHub API.
 * Requires: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER (or GITHUB_REF for PR events).
 */
async function postPRComment(report) {
  const token   = process.env.GITHUB_TOKEN;
  const repo    = process.env.GITHUB_REPOSITORY;
  const prNum   = process.env.PR_NUMBER || extractPRNumber(process.env.GITHUB_REF);

  if (!token || !repo || !prNum) {
    // Not in a PR context — skip silently
    return;
  }

  const fetch = require('node-fetch');
  const markdown = toMarkdown(report);
  const url = `https://api.github.com/repos/${repo}/issues/${prNum}/comments`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
      },
      body: JSON.stringify({ body: markdown }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[reporter] PR comment failed (${res.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[reporter] PR comment error:', err.message);
  }
}

/**
 * Upload audit-report.json as a GitHub Actions artifact.
 * Only works when running inside GitHub Actions.
 */
async function uploadArtifact(jsonPath) {
  if (!process.env.GITHUB_ACTIONS) return;

  try {
    const { DefaultArtifactClient } = require('@actions/artifact');
    const client = new DefaultArtifactClient();
    await client.uploadArtifact('audit-report', [jsonPath], path.dirname(jsonPath));
  } catch (err) {
    console.warn('[reporter] Artifact upload failed:', err.message);
  }
}

/**
 * Set GitHub Actions output variables.
 */
function setActionsOutputs(report) {
  if (!process.env.GITHUB_ACTIONS) return;
  try {
    const core = require('@actions/core');
    core.setOutput('score',  String(report.totalScore));
    core.setOutput('status', report.status);
    core.setOutput('passed', String(report.results.filter(r => r.pass).length));
    core.setOutput('failed', String(report.results.filter(r => !r.pass).length));
  } catch (err) {
    // @actions/core not available (local run)
  }
}

function extractPRNumber(ref) {
  if (!ref) return null;
  const m = ref.match(/refs\/pull\/(\d+)\/merge/);
  return m ? m[1] : null;
}

/**
 * Main reporter entry — run all reporting steps.
 */
async function report(auditResult, repoPath) {
  printToConsole(auditResult);
  const { jsonPath } = writeReportFiles(auditResult, repoPath);
  await postPRComment(auditResult);
  await uploadArtifact(jsonPath);
  setActionsOutputs(auditResult);
}

module.exports = { report, toMarkdown, writeReportFiles, printToConsole };
