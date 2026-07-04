#!/usr/bin/env bash
# verify-route-registration.sh — Check that route handlers and API routers are registered
#
# Usage: verify-route-registration.sh <changed_files_file> <repo_root>
#   changed_files_file: path to a file listing changed files (one per line)
#   repo_root: path to the repository root
#
# Layout path overrides (env vars — override defaults for project-specific layouts):
#   FORGE_PAGES_ROOT          Root of Next.js App Router pages dir (default: web/src/app)
#   FORGE_API_ROUTERS_DIR     Dir containing FastAPI router .py files (default: services/api/app/routers)
#   FORGE_API_MAIN            Path to API app entrypoint, relative to repo root (default: services/api/app/main.py)
#   FORGE_API_MIDDLEWARE_DIR  Dir containing API middleware .py files (default: services/api/app/middleware)
#   FORGE_API_SERVICES_DIR    Root of the backend API service dir (default: services/api)
#   FORGE_WORKER_DIR          Root of the background worker service dir (default: services/worker)
#   FORGE_COMPONENTS_DIR      Root of shared frontend component library (default: web/src/components)
#
# Set these from forge.yaml review.layout fields before invoking, e.g.:
#   export FORGE_PAGES_ROOT=$(yq '.review.layout.pages // "web/src/app"' forge.yaml)
#
# Output: Structured findings (one per line, prefixed with severity)
#   BLOCKING: <message>  — must fix before merge
#   WARNING:  <message>  — likely issue, verify manually
#   OK:       <message>  — check passed
#
# Exit codes: 0 = all checks passed, 1 = blocking findings, 2 = warnings only

set -euo pipefail

CHANGED_FILES="${1:--}"
REPO_ROOT="${2:-.}"

if [ "$CHANGED_FILES" = "-" ]; then
    FILES=$(cat)
else
    FILES=$(cat "$CHANGED_FILES")
fi

# Layout path configuration — read from env vars, fall back to project defaults
FORGE_PAGES_ROOT="${FORGE_PAGES_ROOT:-web/src/app}"
FORGE_API_ROUTERS_DIR="${FORGE_API_ROUTERS_DIR:-services/api/app/routers}"
FORGE_API_MAIN="${FORGE_API_MAIN:-services/api/app/main.py}"
FORGE_API_MIDDLEWARE_DIR="${FORGE_API_MIDDLEWARE_DIR:-services/api/app/middleware}"
FORGE_API_SERVICES_DIR="${FORGE_API_SERVICES_DIR:-services/api}"
FORGE_WORKER_DIR="${FORGE_WORKER_DIR:-services/worker}"
FORGE_COMPONENTS_DIR="${FORGE_COMPONENTS_DIR:-web/src/components}"

BLOCKING=0
WARNINGS=0

# --- Next.js Route Handler registration check ---
while read -r f; do
    # Use shell parameter expansion instead of sed to avoid interpreting FORGE_PAGES_ROOT
    # as a sed pattern (values containing | or other metacharacters break the substitution).
    stripped="${f#${FORGE_PAGES_ROOT}/}"
    stripped="${stripped%/route.ts}"
    # Replace dynamic segments [param] with * using a loop (no regex needed)
    URL_PATH=""
    IFS='/' read -ra SEGMENTS <<< "$stripped"
    for seg in "${SEGMENTS[@]}"; do
        case "$seg" in
            \[*\]) URL_PATH="${URL_PATH}/*" ;;
            *)     URL_PATH="${URL_PATH}/${seg}" ;;
        esac
    done
    ROUTE_SEGMENT=$(echo "$URL_PATH" | sed 's|/api/v1/||; s|/.*||')

    # Guard: skip shadow checks when ROUTE_SEGMENT is empty (e.g. /api/ root handlers).
    # An empty ROUTE_SEGMENT causes grep -qF "" to match every line — false-positive WARNINGs.
    if [ -z "$ROUTE_SEGMENT" ]; then
        echo "OK: Route handler $f ($URL_PATH) — root handler, no segment to match, skipping shadow checks"
    else
        # Check if next.config.js has a rewrite that might shadow this route
        if [ -f "$REPO_ROOT/web/next.config.js" ]; then
            # Use -F (fixed string) so ROUTE_SEGMENT is not interpreted as a regex pattern
            if grep -qF "$ROUTE_SEGMENT" "$REPO_ROOT/web/next.config.js" 2>/dev/null; then
                echo "WARNING: Route handler $f ($URL_PATH) — next.config.js references '$ROUTE_SEGMENT', may shadow this route"
                WARNINGS=$((WARNINGS + 1))
            else
                echo "OK: Route handler $f ($URL_PATH) — no shadowing rewrites found in next.config.js"
            fi
        fi

        # Check if nginx routes this path to Next.js or directly to backend
        if [ -f "$REPO_ROOT/infra/nginx/nginx.conf" ]; then
            # Check for location blocks mentioning ROUTE_SEGMENT — use two -F searches to avoid
            # embedding the variable in a regex: first find lines with "location", then filter
            # for the literal segment. This avoids ROUTE_SEGMENT being interpreted as a BRE.
            if grep -F "location" "$REPO_ROOT/infra/nginx/nginx.conf" 2>/dev/null | grep -qF "$ROUTE_SEGMENT"; then
                echo "WARNING: Route handler $f ($URL_PATH) — nginx.conf has a location block for '$ROUTE_SEGMENT', may bypass Next.js"
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    fi
done < <(echo "$FILES" | while IFS= read -r line; do
    case "$line" in
        "${FORGE_PAGES_ROOT}/api/"*"route.ts") echo "$line" ;;
    esac
done) || true

# --- Python API Router registration check ---
while read -r f; do
    ROUTER_NAME=$(basename "$f" .py)
    MAIN_PY="$REPO_ROOT/${FORGE_API_MAIN}"

    if [ -f "$MAIN_PY" ]; then
        # Use -F (fixed string) so ROUTER_NAME is not interpreted as a regex pattern
        if grep -qF "$ROUTER_NAME" "$MAIN_PY" 2>/dev/null; then
            echo "OK: API Router '$ROUTER_NAME' ($f) — registered in $(basename "$MAIN_PY")"
        else
            echo "BLOCKING: API Router '$ROUTER_NAME' ($f) — NOT found in $(basename "$MAIN_PY"). Router will not be reachable."
            BLOCKING=$((BLOCKING + 1))
        fi
    else
        echo "WARNING: Cannot verify router registration — API main not found at $MAIN_PY"
        WARNINGS=$((WARNINGS + 1))
    fi
done < <(echo "$FILES" | grep -E "^${FORGE_API_ROUTERS_DIR}/.*\\.py$") || true

# --- Python Middleware registration check ---
while read -r f; do
    MIDDLEWARE_NAME=$(basename "$f" .py)
    MAIN_PY="$REPO_ROOT/${FORGE_API_MAIN}"

    if [ -f "$MAIN_PY" ]; then
        # Use -F (fixed string) so MIDDLEWARE_NAME is not interpreted as a regex pattern
        if grep -qF "$MIDDLEWARE_NAME" "$MAIN_PY" 2>/dev/null; then
            echo "OK: Middleware '$MIDDLEWARE_NAME' ($f) — registered in $(basename "$MAIN_PY")"
        else
            echo "WARNING: Middleware '$MIDDLEWARE_NAME' ($f) — not found in $(basename "$MAIN_PY"). May not be active."
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
done < <(echo "$FILES" | grep -E "^${FORGE_API_MIDDLEWARE_DIR}/.*\\.py$") || true

# --- Shared module import check ---
while read -r f; do
    MODULE_NAME=$(basename "$f" .py)

    # Use -F (fixed string) so MODULE_NAME is not interpreted as a regex pattern
    IMPORTERS=$(grep -rlF "$MODULE_NAME" "$REPO_ROOT/${FORGE_API_SERVICES_DIR}/" "$REPO_ROOT/${FORGE_WORKER_DIR}/" 2>/dev/null | head -5)
    if [ -n "$IMPORTERS" ]; then
        echo "OK: Shared module '$MODULE_NAME' ($f) — imported by services"
    else
        echo "WARNING: Shared module '$MODULE_NAME' ($f) — no imports found in ${FORGE_API_SERVICES_DIR}/ or ${FORGE_WORKER_DIR}/"
        WARNINGS=$((WARNINGS + 1))
    fi
done < <(echo "$FILES" | grep -E "^shared/.*\.py$") || true

# --- Component import check ---
while read -r f; do
    COMPONENT_NAME=$(basename "$f" .tsx)

    # Use -F (fixed string) for both the component name search and the self-exclusion
    # to prevent file paths and component names from being interpreted as regex patterns
    IMPORTERS=$(grep -rlF "$COMPONENT_NAME" "$REPO_ROOT/${FORGE_PAGES_ROOT}/" "$REPO_ROOT/${FORGE_COMPONENTS_DIR}/" 2>/dev/null | grep -vF "$f" | head -3)
    if [ -n "$IMPORTERS" ]; then
        echo "OK: Component '$COMPONENT_NAME' ($f) — imported by other files"
    else
        echo "WARNING: Component '$COMPONENT_NAME' ($f) — no imports found. May be unused or new."
        WARNINGS=$((WARNINGS + 1))
    fi
done < <(echo "$FILES" | grep -E "^${FORGE_COMPONENTS_DIR}/.*\\.tsx$") || true

# --- Exit code ---
if [ "$BLOCKING" -gt 0 ]; then
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    exit 2
fi
exit 0
