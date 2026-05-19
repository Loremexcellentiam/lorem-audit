// checks/security.js — SEC-001 (CVEs via npm audit), SEC-002 (secrets via gitleaks)

'use strict';

const { execa } = require('execa');
const path = require('path');
const fs = require('fs');
const { CHECKS } = require('../constants');

async function run(cmd, args, cwd) {
  try {
    const result = await execa(cmd, args, { cwd, reject: false, all: true });
    return { exitCode: result.exitCode, stdout: result.stdout || '', stderr: result.stderr || '', all: result.all || '' };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: err.message, all: err.message };
  }
}

/**
 * SEC-001 — No high or critical CVEs in dependencies.
 * Uses `npm audit --json` and parses severity counts.
 */
async function checkCVEs(repoPath) {
  const check = CHECKS.SEC_001;
  const result = await run('npm', ['audit', '--json', '--audit-level=high'], repoPath);

  let auditData;
  try {
    auditData = JSON.parse(result.stdout);
  } catch {
    // npm audit returned non-JSON (network error, no package-lock, etc.)
    return {
      ...check, pass: false, score: 0,
      detail: 'Could not run npm audit. Ensure package-lock.json exists and registry is reachable.',
      errors: result.stderr.slice(0, 300),
    };
  }

  // npm audit v7+ uses auditReportVersion:2 structure
  const vulns = auditData.vulnerabilities || {};
  const metadata = auditData.metadata || {};
  const severities = metadata.vulnerabilities || {};

  const highCount     = (severities.high     || 0);
  const criticalCount = (severities.critical  || 0);
  const total         = highCount + criticalCount;

  if (total === 0) {
    return { ...check, pass: true, score: check.weight, detail: 'No high or critical CVEs found.' };
  }

  // Collect affected package names
  const affected = Object.entries(vulns)
    .filter(([, v]) => ['high', 'critical'].includes(v.severity))
    .map(([name, v]) => `${name} (${v.severity})`)
    .slice(0, 8);

  return {
    ...check,
    pass: false,
    score: 0,
    detail: `${total} high/critical CVE(s) found. Fix: run \`npm audit --audit-level=high\` and update/replace flagged packages.`,
    errors: affected.join(', '),
  };
}

/**
 * SEC-002 — No secrets in source code.
 * Uses gitleaks if available, falls back to basic regex scan.
 */
async function checkSecrets(repoPath) {
  const check = CHECKS.SEC_002;

  // Try gitleaks first
  const glCheck = await run('which', ['gitleaks'], repoPath);
  if (glCheck.exitCode === 0) {
    return await checkSecretsWithGitleaks(repoPath, check);
  }

  // Fallback: basic regex scan for common secret patterns
  return await checkSecretsBasic(repoPath, check);
}

async function checkSecretsWithGitleaks(repoPath, check) {
  const reportPath = path.join(repoPath, '.gitleaks-report.json');
  const result = await run(
    'gitleaks',
    ['detect', '--source', '.', '--report-format', 'json', '--report-path', reportPath, '--no-banner'],
    repoPath
  );

  // gitleaks exits 1 if leaks found, 0 if clean
  if (result.exitCode === 0) {
    // Clean up report file
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    return { ...check, pass: true, score: check.weight, detail: 'No secrets detected (gitleaks).' };
  }

  let findings = [];
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(raw);
    findings = (parsed || []).slice(0, 6).map(f => `${f.File}:${f.StartLine} (${f.RuleID})`);
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  } catch {
    // Could not parse report
  }

  return {
    ...check,
    pass: false,
    score: 0,
    detail: 'Secrets found in source. Fix: move all secrets to GitHub Secrets or .env (gitignored). Never commit credentials.',
    errors: findings.join('\n  ') || result.stderr.slice(0, 300),
  };
}

async function checkSecretsBasic(repoPath, check) {
  // Patterns: common secret shapes in JS/TS/env files
  const PATTERNS = [
    { label: 'AWS key',         regex: /AKIA[0-9A-Z]{16}/g },
    { label: 'Private key',     regex: /-----BEGIN (RSA |EC )?PRIVATE KEY/g },
    { label: 'Hardcoded password', regex: /password\s*[:=]\s*['"][^'"]{6,}/gi },
    { label: 'JWT secret',      regex: /jwt[_-]?secret\s*[:=]\s*['"][^'"]{8,}/gi },
    { label: 'DB connection',   regex: /mongodb\+srv:\/\/[^:]+:[^@]+@/gi },
    { label: 'Generic token',   regex: /token\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}/gi },
  ];

  const SKIP_DIRS  = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];
  const EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.env', '.json', '.yml', '.yaml'];
  const findings   = [];

  function walkDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;
      const full = path.join(dir, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walkDir(full);
      } else if (EXTENSIONS.some(e => full.endsWith(e))) {
        let content;
        try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          for (const { label, regex } of PATTERNS) {
            if (regex.test(line)) {
              findings.push(`${path.relative(repoPath, full)}:${i + 1} (${label})`);
            }
            regex.lastIndex = 0;
          }
        });
      }
    }
  }

  walkDir(repoPath);

  if (findings.length === 0) {
    return { ...check, pass: true, score: check.weight, detail: 'No secrets detected (basic scan — install gitleaks for full coverage).' };
  }

  return {
    ...check,
    pass: false,
    score: 0,
    detail: `${findings.length} potential secret(s) found. Fix: move to GitHub Secrets or .env (gitignored). Install gitleaks for authoritative scanning.`,
    errors: findings.slice(0, 6).join('\n  '),
  };
}

async function runSecurityChecks(repoPath) {
  const [cves, secrets] = await Promise.all([checkCVEs(repoPath), checkSecrets(repoPath)]);
  return [cves, secrets];
}

module.exports = { runSecurityChecks, checkCVEs, checkSecrets };
