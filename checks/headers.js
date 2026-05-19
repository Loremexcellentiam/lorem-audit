// checks/headers.js — HDR-001: verify required security headers are present

'use strict';

const { execa }  = require('execa');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const { CHECKS } = require('../constants');

const REQUIRED_HEADERS = [
  {
    name:    'content-security-policy',
    label:   'Content-Security-Policy',
    fix:     'Add a CSP header to your server/NGINX config. Minimum: Content-Security-Policy: default-src \'self\'',
  },
  {
    name:    'x-frame-options',
    label:   'X-Frame-Options',
    fix:     'Add X-Frame-Options: DENY or SAMEORIGIN to your server/NGINX config.',
  },
  {
    name:    'strict-transport-security',
    label:   'Strict-Transport-Security (HSTS)',
    fix:     'Add Strict-Transport-Security: max-age=31536000; includeSubDomains to your server config. Requires HTTPS.',
  },
  {
    name:    'x-content-type-options',
    label:   'X-Content-Type-Options',
    fix:     'Add X-Content-Type-Options: nosniff to your server/NGINX config.',
  },
];

/**
 * Attempt to detect the app's port from package.json or environment.
 */
function detectPort(repoPath) {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    const startScript = (pkg.scripts?.start || '');
    const portMatch = startScript.match(/(?:PORT=|--port\s+|:)(\d{4,5})/);
    if (portMatch) return Number(portMatch[1]);
  } catch {}
  return 3000; // Express/Next.js default
}

/**
 * Check if a server is already running on a given URL.
 */
async function serverRunning(url) {
  try {
    await fetch(url, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to spin up the app briefly, fetch headers, then kill it.
 * Returns { headers: Object, started: boolean, error: string|null }
 */
async function fetchHeaders(repoPath) {
  const port = detectPort(repoPath);
  const url  = `http://localhost:${port}`;

  // If already running (e.g. called from quality.js in the same pipeline run), just fetch
  if (await serverRunning(url)) {
    try {
      const res = await fetch(url, { timeout: 5000 });
      return { headers: Object.fromEntries(res.headers.entries()), started: false, error: null };
    } catch (e) {
      return { headers: {}, started: false, error: e.message };
    }
  }

  // Try to start the app
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')); } catch {}

  const startScript = pkg.scripts?.start || pkg.scripts?.preview || null;
  if (!startScript) {
    return {
      headers: {},
      started: false,
      error: `No "start" script found in package.json and app is not running on port ${port}. ` +
             `Headers check skipped. Add a "start" script or run the app before auditing.`,
    };
  }

  const serverProc = execa('npm', ['run', 'start'], {
    cwd: repoPath,
    env: { ...process.env, PORT: String(port) },
    reject: false,
  });

  // Wait for server (up to 20s)
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (await serverRunning(url)) { ready = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!ready) {
    serverProc.kill();
    return { headers: {}, started: true, error: `Server did not start within 20s on port ${port}.` };
  }

  let headers = {};
  try {
    const res = await fetch(url, { timeout: 5000 });
    headers = Object.fromEntries(res.headers.entries());
  } catch (e) {
    serverProc.kill();
    return { headers: {}, started: true, error: e.message };
  }

  serverProc.kill();
  return { headers, started: true, error: null };
}

/**
 * HDR-001 — Check that all required security headers are present.
 */
async function checkHeaders(repoPath) {
  const check = CHECKS.HDR_001;
  const { headers, error } = await fetchHeaders(repoPath);

  if (error) {
    // Non-fatal: log as warning, award 0 pts since we can't verify
    return {
      ...check, pass: false, score: 0,
      detail: `Could not verify headers: ${error} Fix: ensure the app can be started with \`npm start\` and returns HTTP headers.`,
    };
  }

  const missing = REQUIRED_HEADERS.filter(h => !headers[h.name]);

  if (missing.length === 0) {
    return { ...check, pass: true, score: check.weight, detail: 'All required security headers present.' };
  }

  const fixes = missing.map(h => `  • ${h.label}: ${h.fix}`).join('\n');

  return {
    ...check,
    pass: false,
    score: 0,
    detail: `${missing.length} required security header(s) missing.`,
    errors: `Missing headers:\n${missing.map(h => h.label).join(', ')}\n\nFixes:\n${fixes}`,
  };
}

module.exports = { checkHeaders };
