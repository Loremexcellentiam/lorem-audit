// checks/quality.js — A11Y-001, PERF-001, SEO-001 via Lighthouse CI

'use strict';

const { execa }  = require('execa');
const path       = require('path');
const fs         = require('fs');
const { CHECKS } = require('../constants');

const THRESHOLDS = {
  A11Y: 0.80, // ≥ 80
  PERF: 0.70, // ≥ 70
  SEO:  0.80, // ≥ 80
};

/**
 * Detect how to serve this project locally.
 * Priority: `npm run preview` → `npm run serve` → `npx serve ./dist` → `npx serve ./out` → `npx serve .`
 */
function detectServeCommand(repoPath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};

  if (scripts.preview) return { cmd: 'npm', args: ['run', 'preview'] };
  if (scripts.serve)   return { cmd: 'npm', args: ['run', 'serve'] };

  // Static export targets (Next.js static export → /out; React → /build or /dist)
  for (const dir of ['out', 'build', 'dist']) {
    if (fs.existsSync(path.join(repoPath, dir))) {
      return { cmd: 'npx', args: ['serve', dir, '-l', '3333', '--no-clipboard'] };
    }
  }

  return { cmd: 'npx', args: ['serve', '.', '-l', '3333', '--no-clipboard'] };
}

/**
 * Find a free port (try 3333..3340)
 */
async function getFreePort(start = 3333) {
  const net = require('net');
  for (let p = start; p < start + 8; p++) {
    const free = await new Promise(res => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p);
    });
    if (free) return p;
  }
  return start;
}

/**
 * Wait for a local server to respond (up to 30s).
 */
async function waitForServer(url, maxMs = 30000) {
  const fetch = require('node-fetch');
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { timeout: 2000 });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

/**
 * Run Lighthouse CI headless against a URL.
 * Returns parsed category scores.
 */
async function runLighthouse(url, repoPath) {
  const reportPath = path.join(repoPath, '.lhci-report.json');

  const result = await execa(
    'npx',
    [
      'lhci', 'autorun',
      '--collect.url=' + url,
      '--collect.numberOfRuns=1',
      '--collect.settings.chromeFlags=--no-sandbox --headless',
      '--output=json',
      '--outputPath=' + reportPath,
    ],
    { cwd: repoPath, reject: false, all: true }
  ).catch(err => ({ exitCode: 1, all: err.message }));

  // Try lhci collect + report manually if autorun not available
  if (!fs.existsSync(reportPath)) {
    // Try direct lighthouse CLI
    const lhResult = await execa(
      'npx',
      ['lighthouse', url, '--output=json', '--output-path=' + reportPath,
       '--chrome-flags=--headless --no-sandbox', '--only-categories=accessibility,performance,seo',
       '--quiet'],
      { cwd: repoPath, reject: false }
    ).catch(() => ({ exitCode: 1 }));

    if (!fs.existsSync(reportPath)) {
      return { error: 'Lighthouse report not generated. Ensure Chromium is available. Result: ' + (result.all || '').slice(0, 200) };
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    fs.unlinkSync(reportPath);

    // Lighthouse direct report shape
    if (raw.categories) {
      return {
        accessibility: raw.categories.accessibility?.score ?? null,
        performance:   raw.categories.performance?.score   ?? null,
        seo:           raw.categories.seo?.score           ?? null,
      };
    }
    // LHCI autorun shape (array of runs)
    if (Array.isArray(raw) && raw[0]?.categories) {
      return {
        accessibility: raw[0].categories.accessibility?.score ?? null,
        performance:   raw[0].categories.performance?.score   ?? null,
        seo:           raw[0].categories.seo?.score           ?? null,
      };
    }
    return { error: 'Unrecognised Lighthouse report format.' };
  } catch (e) {
    return { error: 'Failed to parse Lighthouse report: ' + e.message };
  }
}

/**
 * Run A11Y, PERF, SEO checks — starts local server, runs Lighthouse, stops server.
 */
async function runQualityChecks(repoPath) {
  const a11yCheck = CHECKS.A11Y_001;
  const perfCheck = CHECKS.PERF_001;
  const seoCheck  = CHECKS.SEO_001;

  // Ensure there's something to serve (app must be built first)
  const hasBuildOutput = ['dist', 'build', 'out', '.next'].some(d =>
    fs.existsSync(path.join(repoPath, d))
  );

  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')); } catch {}

  if (!hasBuildOutput && !pkg.scripts?.preview && !pkg.scripts?.serve) {
    const noServerResult = (check) => ({
      ...check, pass: false, score: 0,
      detail: `No build output or serve script found. Run \`npm run build\` before audit, or add a "preview" script to package.json.`,
    });
    return [noServerResult(a11yCheck), noServerResult(perfCheck), noServerResult(seoCheck)];
  }

  const port = await getFreePort(3333);
  const url  = `http://localhost:${port}`;

  // Start server
  const serveCmd = detectServeCommand(repoPath);
  const serverEnv = { ...process.env, PORT: String(port) };

  // Patch args to use detected port if using npx serve
  if (serveCmd.cmd === 'npx') {
    const portFlag = serveCmd.args.indexOf('-l');
    if (portFlag !== -1) serveCmd.args[portFlag + 1] = String(port);
    else serveCmd.args.push('-l', String(port));
  }

  let serverProc;
  try {
    serverProc = execa(serveCmd.cmd, serveCmd.args, { cwd: repoPath, env: serverEnv, reject: false });
  } catch (e) {
    const errResult = (check) => ({ ...check, pass: false, score: 0, detail: `Could not start local server: ${e.message}` });
    return [errResult(a11yCheck), errResult(perfCheck), errResult(seoCheck)];
  }

  const ready = await waitForServer(url);
  if (!ready) {
    serverProc.kill();
    const timeoutResult = (check) => ({
      ...check, pass: false, score: 0,
      detail: `Server did not start within 30s. Check your "preview" script starts on PORT env var or port ${port}.`,
    });
    return [timeoutResult(a11yCheck), timeoutResult(perfCheck), timeoutResult(seoCheck)];
  }

  // Run Lighthouse
  const scores = await runLighthouse(url, repoPath);
  serverProc.kill();

  if (scores.error) {
    const lhErr = (check) => ({ ...check, pass: false, score: 0, detail: `Lighthouse error: ${scores.error}` });
    return [lhErr(a11yCheck), lhErr(perfCheck), lhErr(seoCheck)];
  }

  // Score each category
  const a11y = scores.accessibility !== null ? Math.round(scores.accessibility * 100) : null;
  const perf = scores.performance   !== null ? Math.round(scores.performance   * 100) : null;
  const seo  = scores.seo           !== null ? Math.round(scores.seo           * 100) : null;

  const a11yResult = a11y === null
    ? { ...a11yCheck, pass: false, score: 0, detail: 'Accessibility score unavailable from Lighthouse.' }
    : a11y >= 80
      ? { ...a11yCheck, pass: true,  score: a11yCheck.weight, detail: `Score: ${a11y}` }
      : { ...a11yCheck, pass: false, score: 0, detail: `Score: ${a11y} (need ≥ 80). Fix: missing alt text, low contrast, missing aria labels.` };

  const perfResult = perf === null
    ? { ...perfCheck, pass: false, score: 0, detail: 'Performance score unavailable from Lighthouse.' }
    : perf >= 70
      ? { ...perfCheck, pass: true,  score: perfCheck.weight, detail: `Score: ${perf}` }
      : { ...perfCheck, pass: false, score: 0, detail: `Score: ${perf} (need ≥ 70). Fix: compress images, add lazy loading, reduce bundle size.` };

  const seoResult = seo === null
    ? { ...seoCheck, pass: false, score: 0, detail: 'SEO score unavailable from Lighthouse.' }
    : seo >= 80
      ? { ...seoCheck, pass: true,  score: seoCheck.weight, detail: `Score: ${seo}` }
      : { ...seoCheck, pass: false, score: 0, detail: `Score: ${seo} (need ≥ 80). Fix: add meta tags, canonical URLs, structured data.` };

  return [a11yResult, perfResult, seoResult];
}

module.exports = { runQualityChecks };
