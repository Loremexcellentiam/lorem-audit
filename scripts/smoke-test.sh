#!/usr/bin/env bash
# scripts/smoke-test.sh — health check after deploy
# Usage: ./scripts/smoke-test.sh <base_url>
# Exits 0 (pass) or 1 (fail — triggers rollback in deploy.yml)

set -euo pipefail

BASE_URL="${1:-}"
MAX_RETRIES="${SMOKE_RETRIES:-5}"
RETRY_DELAY="${SMOKE_DELAY:-5}"    # seconds between retries
TIMEOUT="${SMOKE_TIMEOUT:-10}"     # curl timeout per request

if [ -z "$BASE_URL" ]; then
  echo "ERROR: Usage: smoke-test.sh <base_url>"
  echo "       Example: smoke-test.sh https://staging.example.com"
  exit 1
fi

# Strip trailing slash
BASE_URL="${BASE_URL%/}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SMOKE TEST — ${BASE_URL}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Endpoints to check ────────────────────────────────────────────────────────
# Customise HEALTH_ENDPOINTS for your app's actual health check paths.
HEALTH_ENDPOINTS=(
  "/health"        # Primary health check (add this to your Express app — see README)
  "/api/health"    # API health check
  "/"              # Root (last resort)
)

PASS_CODES="200,201,204,301,302"   # Acceptable HTTP response codes

# ── Check function ────────────────────────────────────────────────────────────
check_endpoint() {
  local url="${BASE_URL}${1}"
  local attempt=0

  echo "  Checking: ${url}"

  while [ $attempt -lt $MAX_RETRIES ]; do
    attempt=$((attempt + 1))
    HTTP_CODE=$(curl \
      --silent \
      --output /dev/null \
      --write-out "%{http_code}" \
      --max-time "$TIMEOUT" \
      --location \
      "$url" 2>/dev/null || echo "000")

    if echo "$PASS_CODES" | grep -qw "$HTTP_CODE"; then
      echo "  ✓ ${url} → HTTP ${HTTP_CODE} (attempt ${attempt})"
      return 0
    fi

    if [ $attempt -lt $MAX_RETRIES ]; then
      echo "  ✗ ${url} → HTTP ${HTTP_CODE} (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${RETRY_DELAY}s..."
      sleep "$RETRY_DELAY"
    fi
  done

  echo "  ✗ ${url} → HTTP ${HTTP_CODE} after ${MAX_RETRIES} attempts"
  return 1
}

# ── Run checks ────────────────────────────────────────────────────────────────
PASSED=false

for endpoint in "${HEALTH_ENDPOINTS[@]}"; do
  if check_endpoint "$endpoint"; then
    PASSED=true
    break
  fi
done

echo ""
if [ "$PASSED" = true ]; then
  echo "✓ Smoke test PASSED — ${BASE_URL} is responding"
  echo ""
  exit 0
else
  echo "✗ Smoke test FAILED — ${BASE_URL} did not respond on any health endpoint"
  echo "  Checked: ${HEALTH_ENDPOINTS[*]}"
  echo "  Action: rollback will be triggered by deploy pipeline"
  echo ""
  exit 1
fi
