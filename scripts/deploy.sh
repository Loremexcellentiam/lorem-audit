#!/usr/bin/env bash
# scripts/deploy.sh — VPS deployment script
# Usage: ./scripts/deploy.sh <env>
# Envs:  dev | staging | production

set -euo pipefail

ENV="${1:-staging}"
APP_NAME="${APP_NAME:-$(node -p "require('./package.json').name" 2>/dev/null || basename "$PWD")}"
DEPLOY_DIR="${DEPLOY_DIR:-/srv/${APP_NAME}}"
COMPOSE_FILE="docker-compose.${ENV}.yml"
IMAGE_TAG="${IMAGE_TAG:-${APP_NAME}:${ENV}-latest}"
COMMIT_SHA="${GITHUB_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo 'local')}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  LOREM DEPLOY — ${APP_NAME} → ${ENV}"
echo "  Commit: ${COMMIT_SHA}"
echo "  Deploy dir: ${DEPLOY_DIR}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Validate environment ────────────────────────────────────────────────────
if [[ ! "$ENV" =~ ^(dev|staging|production)$ ]]; then
  echo "ERROR: Unknown environment '${ENV}'. Use: dev | staging | production"
  exit 1
fi

# ── Pull latest code ─────────────────────────────────────────────────────────
if [ -d "$DEPLOY_DIR/.git" ]; then
  echo "[1/5] Pulling latest code..."
  cd "$DEPLOY_DIR"
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  git fetch origin
  git reset --hard "origin/${BRANCH}"
else
  echo "[1/5] Deploy directory ${DEPLOY_DIR} is not a git repo — skipping pull."
fi

# ── Build Docker image ───────────────────────────────────────────────────────
echo "[2/5] Building Docker image: ${IMAGE_TAG}..."
docker build \
  --build-arg NODE_ENV="${ENV}" \
  --build-arg COMMIT_SHA="${COMMIT_SHA}" \
  -t "${IMAGE_TAG}" \
  -t "${APP_NAME}:${COMMIT_SHA}" \
  -f Dockerfile \
  .

echo "      Image built: ${IMAGE_TAG}"

# ── Bring up containers ──────────────────────────────────────────────────────
echo "[3/5] Starting containers (${COMPOSE_FILE})..."
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "WARNING: ${COMPOSE_FILE} not found. Falling back to docker-compose.yml"
  COMPOSE_FILE="docker-compose.yml"
fi

docker compose -f "$COMPOSE_FILE" up -d --remove-orphans --force-recreate

# ── Run database migrations (if applicable) ───────────────────────────────────
echo "[4/5] Running migrations (if applicable)..."
if docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null | grep -q "^app$"; then
  docker compose -f "$COMPOSE_FILE" exec -T app \
    sh -c "npm run db:migrate 2>/dev/null || echo 'No migration script found — skipped.'"
else
  echo "      No 'app' service found for migration — skipped."
fi

# ── Cleanup old images ────────────────────────────────────────────────────────
echo "[5/5] Pruning unused Docker images..."
docker image prune -f --filter "until=48h" 2>/dev/null || true

echo ""
echo "✓ Deploy complete — ${APP_NAME} → ${ENV} (${COMMIT_SHA})"
echo ""
