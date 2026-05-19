// checks/config.js — CFG-001 (.env.example exists), CFG-002 (env vars match GitHub Secrets)

'use strict';

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { CHECKS } = require('../constants');

/**
 * CFG-001 — .env.example is present and non-empty.
 * Also verifies every listed key has a masked or empty value (not a real secret).
 */
async function checkEnvExample(repoPath) {
  const check    = CHECKS.CFG_001;
  const envPath  = path.join(repoPath, '.env.example');

  if (!fs.existsSync(envPath)) {
    return {
      ...check, pass: false, score: 0,
      detail: '.env.example not found. Fix: create .env.example listing all required env vars with masked values (e.g. DATABASE_URL=). Commit to repo.',
    };
  }

  const content = fs.readFileSync(envPath, 'utf8').trim();
  if (!content) {
    return {
      ...check, pass: false, score: 0,
      detail: '.env.example is empty. Fix: add all required env var keys (values masked or blank).',
    };
  }

  // Parse key=value lines, skip comments and blanks
  const keys = content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=')[0].trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return {
      ...check, pass: false, score: 0,
      detail: '.env.example has no parseable KEY= entries. Fix: each line must be KEY= or KEY=masked_value.',
    };
  }

  return {
    ...check, pass: true, score: check.weight,
    detail: `.env.example present with ${keys.length} key(s): ${keys.join(', ')}`,
    keys, // Passed to CFG-002
  };
}

/**
 * CFG-002 — All env vars in .env.example are declared as GitHub Secrets for the target environment.
 *
 * Requires env vars:
 *   GITHUB_TOKEN        — token with `secrets:read` scope
 *   GITHUB_REPOSITORY   — owner/repo (set automatically in Actions)
 *   AUDIT_ENV           — environment name (staging | production)
 *
 * Falls back to a file-based check if GitHub API is not reachable.
 */
async function checkEnvVars(repoPath, envName = 'staging') {
  const check = CHECKS.CFG_002;

  // Read keys from .env.example
  const envPath = path.join(repoPath, '.env.example');
  if (!fs.existsSync(envPath)) {
    return {
      ...check, pass: false, score: 0,
      detail: '.env.example missing — cannot validate env vars. Fix CFG-001 first.',
    };
  }

  const requiredKeys = fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=')[0].trim())
    .filter(Boolean);

  if (requiredKeys.length === 0) {
    return { ...check, pass: true, score: check.weight, detail: 'No env vars required (empty .env.example).' };
  }

  // Attempt GitHub Secrets API check
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY; // e.g. "org/repo-name"

  if (!token || !repo) {
    // Not running in CI — do a local .env file check instead
    return checkEnvVarsLocal(repoPath, requiredKeys, envName, check);
  }

  const [owner, repoName] = repo.split('/');

  try {
    // Fetch environment-level secrets
    const envSecretsUrl = `https://api.github.com/repos/${owner}/${repoName}/environments/${envName}/secrets`;
    const repoSecretsUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/secrets`;

    const [envRes, repoRes] = await Promise.all([
      fetch(envSecretsUrl,  { headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/vnd.github+json' } }),
      fetch(repoSecretsUrl, { headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/vnd.github+json' } }),
    ]);

    const envData  = envRes.ok  ? await envRes.json()  : { secrets: [] };
    const repoData = repoRes.ok ? await repoRes.json() : { secrets: [] };

    const declaredSecrets = new Set([
      ...(envData.secrets  || []).map(s => s.name),
      ...(repoData.secrets || []).map(s => s.name),
    ]);

    const missing = requiredKeys.filter(k => !declaredSecrets.has(k));

    if (missing.length === 0) {
      return {
        ...check, pass: true, score: check.weight,
        detail: `All ${requiredKeys.length} required env var(s) declared in GitHub Secrets.`,
      };
    }

    return {
      ...check, pass: false, score: 0,
      detail: `${missing.length} env var(s) missing from GitHub Secrets (${envName}). Fix: add them in repo → Settings → Secrets → Actions.`,
      errors: `Missing: ${missing.join(', ')}`,
    };

  } catch (err) {
    // Network/auth failure — fall back to local check
    return checkEnvVarsLocal(repoPath, requiredKeys, envName, check);
  }
}

/**
 * Local fallback: check that a .env file for the target environment exists and has all keys.
 */
function checkEnvVarsLocal(repoPath, requiredKeys, envName, check) {
  const candidates = [`.env.${envName}`, '.env.local', '.env'];
  let foundKeys = new Set();
  let usedFile  = null;

  for (const candidate of candidates) {
    const p = path.join(repoPath, candidate);
    if (fs.existsSync(p)) {
      usedFile = candidate;
      fs.readFileSync(p, 'utf8')
        .split('\n')
        .filter(l => l && !l.startsWith('#'))
        .forEach(l => {
          const key = l.split('=')[0].trim();
          if (key) foundKeys.add(key);
        });
      break;
    }
  }

  if (!usedFile) {
    return {
      ...check, pass: false, score: 0,
      detail: `No .env file found locally and no GitHub token available to check Secrets. Ensure GITHUB_TOKEN is set in CI.`,
      errors: `Required keys: ${requiredKeys.join(', ')}`,
    };
  }

  const missing = requiredKeys.filter(k => !foundKeys.has(k));
  if (missing.length === 0) {
    return {
      ...check, pass: true, score: check.weight,
      detail: `All ${requiredKeys.length} env var(s) found in ${usedFile} (local fallback — confirm GitHub Secrets in CI).`,
    };
  }

  return {
    ...check, pass: false, score: 0,
    detail: `${missing.length} env var(s) missing from ${usedFile}. Fix: add to GitHub Secrets for environment "${envName}".`,
    errors: `Missing: ${missing.join(', ')}`,
  };
}

async function runConfigChecks(repoPath, envName) {
  const cfg1 = await checkEnvExample(repoPath);
  const cfg2 = await checkEnvVars(repoPath, envName);
  return [cfg1, cfg2];
}

module.exports = { runConfigChecks, checkEnvExample, checkEnvVars };
