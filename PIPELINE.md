# PIPELINE.md — Developer Onboarding Guide
## Lorem Governed Deploy — Node/Express · React · Next.js · VPS

---

## What This Is

Every push to `develop`, `staging`, or `main` runs through a governed pipeline:

```
Push → Audit (score 0–100) → Build & Test → Deploy → Smoke Test
         ↓ blocked if score < 90 (staging/prod)
```

No code reaches staging or production unless it scores 90/100 on the audit rubric.

---

## Quickstart — Plug Into a New Repo

### 1. Copy these files into your repo root

```
.env.example                     ← fill in your keys (values masked)
Dockerfile.backend               ← rename to Dockerfile for Express apps
Dockerfile.frontend              ← rename to Dockerfile for React apps
Dockerfile.nextjs                ← rename to Dockerfile for Next.js apps
nginx.conf                       ← security headers config (HDR-001)
docker-compose.staging.yml
docker-compose.prod.yml
scripts/deploy.sh
scripts/smoke-test.sh
src/routes/health.js             ← mount this in your Express app
.github/
  workflows/deploy.yml
  actions/lorem-audit/action.yml
```

### 2. Mount the health endpoint in Express

```js
// In your main app.js or server.js:
app.use('/health', require('./routes/health'));
```

### 3. Set up GitHub Environments

In your repo: **Settings → Environments → New environment**

| Environment | Branch | Requires Approval? |
|---|---|---|
| `dev`        | `develop` | No  |
| `staging`    | `staging` | No  |
| `production` | `main`    | Yes — add reviewer |

### 4. Add GitHub Secrets

**Repo-level secrets** (Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `SSH_HOST`        | Your VPS hostname or IP |
| `SSH_USER`        | Deploy user (e.g. `deploy`) |
| `SSH_PRIVATE_KEY` | Private key for deploy user |
| `SSH_PORT`        | SSH port (default: 22) |

**Environment-level secrets** (per environment):
Add every key from your `.env.example` with real values.

### 5. Push and watch it run

```bash
git push origin develop     # → deploys to dev (score ≥ 70)
git push origin staging     # → deploys to staging (score ≥ 90)
git push origin main        # → requires approval + score ≥ 90
```

---

## Running the Audit Locally

```bash
# Install audit tool
npm install   # inside lorem-audit directory

# Run against your repo
npx lorem-audit --repo /path/to/your/repo --env staging

# Skip slow checks for a quick local run
npx lorem-audit --repo . --env staging --skip-quality --skip-docker
```

---

## Reading the Audit Report

```
BLD-001  Build succeeds      ✓  20/20
BLD-002  Lint passes         ✓   5/5
BLD-003  Test suite passes   ✗   0/10   → 3 tests failing: auth.test.js:42
SEC-001  No CVEs             ✓  15/15
SEC-002  No secrets          ✗   0/15   → src/config/db.js:14
...
SCORE: 60/100   STATUS: REJECT
```

Every failed check tells you the exact file, line, and what to fix.

---

## Fix Guide — Per Check ID

### BLD-001 — Build fails
```bash
npm run build
# Fix all errors in the output until exit code 0
```

### BLD-002 — Lint errors
```bash
npm run lint
# Fix all reported errors (warnings are allowed)
# Common fixes: unused variables, missing semicolons, wrong import order
```

### BLD-003 — Tests failing
```bash
npm test -- --watchAll=false
# Fix each failing test. File:line references are in the audit output.
# Add tests for any untested API routes.
```

### SEC-001 — CVEs in dependencies
```bash
npm audit --audit-level=high
# For each flagged package: npm update <package>
# If no update available: npm audit fix --force (review changes)
# Replace packages with no fix available
```

### SEC-002 — Secrets in source
```bash
# Install gitleaks (Mac): brew install gitleaks
# Install gitleaks (Linux): https://github.com/gitleaks/gitleaks/releases
gitleaks detect --source . --verbose
# For each finding: remove the secret, move to .env (gitignored) or GitHub Secrets
# Rotate any exposed credentials immediately
```

### CFG-001 — .env.example missing
Create `.env.example` in the repo root:
```bash
# List every env var your app needs, with masked values:
DATABASE_URL=
JWT_SECRET=
SMTP_PASS=
```

### CFG-002 — Env vars missing from GitHub Secrets
Go to: **repo → Settings → Environments → [environment] → Add secret**
Add every key from `.env.example` with the real value for that environment.

### A11Y-001 — Accessibility score < 80
```bash
npx lhci autorun --collect.url=http://localhost:3000
# Most common fixes:
# • Add alt="" to all <img> tags
# • Fix colour contrast (use https://webaim.org/resources/contrastchecker)
# • Add aria-label to icon-only buttons
# • Add <label> to all form inputs
```

### PERF-001 — Performance score < 70
Most common fixes:
- Compress hero/background images (target < 200KB): `npx imagemin-cli images/* --out-dir=images`
- Lazy load below-fold images: add `loading="lazy"` attribute
- Lazy load heavy chart/dashboard components: `const Chart = React.lazy(() => import('./Chart'))`
- Check bundle size: `npx source-map-explorer dist/assets/*.js`

### SEO-001 — SEO score < 80
```jsx
// Add to every page — React example (react-helmet or Next.js Head):
<Head>
  <title>Page Title | App Name</title>
  <meta name="description" content="150–160 char description" />
  <link rel="canonical" href="https://yourapp.com/current-page" />
</Head>
```

### HDR-001 — Security headers missing
The `nginx.conf` in this repo adds all required headers.  
If you're using Express directly (not NGINX in front):
```js
// Install: npm install helmet
const helmet = require('helmet');
app.use(helmet()); // Adds CSP, HSTS, X-Frame-Options, X-Content-Type-Options
```

### DEP-001 — Dockerfile missing or failing
```bash
# Use Dockerfile.backend, Dockerfile.frontend, or Dockerfile.nextjs from this repo
# Rename to Dockerfile:
cp Dockerfile.backend Dockerfile   # for Express app

# Test it builds:
docker build .
# Fix any errors in the output until exit code 0
```

---

## Pipeline Troubleshooting

| Symptom | Fix |
|---|---|
| Audit score not output in workflow | Check `@actions/core` is installed in audit tool |
| PR comment not posted | Verify `GITHUB_TOKEN` has `issues: write` permission |
| Smoke test fails immediately | Check `vars.STAGING_URL` / `vars.PROD_URL` are set in environment variables |
| Deploy hangs at manual approval | Add required reviewer in Settings → Environments → production |
| Docker build fails in CI but passes locally | Check for hardcoded absolute paths; use relative paths in Dockerfile COPY |
| Lighthouse times out | Add `--skip-quality` for PRs; ensure build output exists before audit |

---

## Deployment Architecture (VPS)

```
Internet → VPS (Ubuntu)
             ├── NGINX (port 80/443) — TLS termination, reverse proxy
             │     └── nginx.conf (security headers, SPA fallback)
             ├── Frontend container (React/Next.js) — port 80 internal
             ├── Backend container (Express) — port 3000 internal (localhost only)
             └── PostgreSQL container — no external port
```

For TLS on VPS: `sudo certbot --nginx -d yourdomain.com`

---

*Generated by Lorem Audit. Questions: see Gbolahan Adegoke or Dayo Amusu (CTO).*
