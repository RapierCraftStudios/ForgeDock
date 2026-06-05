#!/usr/bin/env bash
# verify-route-registration.sh — Check that route handlers and API routers are registered
#
# Usage: verify-route-registration.sh <changed_files_file> <repo_root>
#   changed_files_file: path to a file listing changed files (one per line)
#   repo_root: path to the repository root
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

BLOCKING=0
WARNINGS=0

# --- Next.js Route Handler registration check ---
echo "$FILES" | grep -E "^web/src/app/api/.*route\.ts$" | while read -r f; do
    URL_PATH=$(echo "$f" | sed 's|^web/src/app||; s|/route\.ts$||; s|\[.*\]|*|g')
    ROUTE_SEGMENT=$(echo "$URL_PATH" | sed 's|/api/v1/||; s|/.*||')

    # Check if next.config.js has a rewrite that might shadow this route
    if [ -f "$REPO_ROOT/web/next.config.js" ]; then
        if grep -q "$ROUTE_SEGMENT" "$REPO_ROOT/web/next.config.js" 2>/dev/null; then
            echo "WARNING: Route handler $f ($URL_PATH) — next.config.js references '$ROUTE_SEGMENT', may shadow this route"
            WARNINGS=$((WARNINGS + 1))
        else
            echo "OK: Route handler $f ($URL_PATH) — no shadowing rewrites found in next.config.js"
        fi
    fi

    # Check if nginx routes this path to Next.js or directly to backend
    if [ -f "$REPO_ROOT/infra/nginx/nginx.conf" ]; then
        if grep -q "location.*$ROUTE_SEGMENT" "$REPO_ROOT/infra/nginx/nginx.conf" 2>/dev/null; then
            echo "WARNING: Route handler $f ($URL_PATH) — nginx.conf has a location block for '$ROUTE_SEGMENT', may bypass Next.js"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
done || true

# --- Python API Router registration check ---
echo "$FILES" | grep -E "^services/api/app/routers/.*\.py$" | while read -r f; do
    ROUTER_NAME=$(basename "$f" .py)
    MAIN_PY="$REPO_ROOT/services/api/app/main.py"

    if [ -f "$MAIN_PY" ]; then
        if grep -q "$ROUTER_NAME" "$MAIN_PY" 2>/dev/null; then
            echo "OK: API Router '$ROUTER_NAME' ($f) — registered in main.py"
        else
            echo "BLOCKING: API Router '$ROUTER_NAME' ($f) — NOT found in main.py. Router will not be reachable."
            BLOCKING=$((BLOCKING + 1))
        fi
    else
        echo "WARNING: Cannot verify router registration — main.py not found at $MAIN_PY"
        WARNINGS=$((WARNINGS + 1))
    fi
done || true

# --- Python Middleware registration check ---
echo "$FILES" | grep -E "^services/api/app/middleware/.*\.py$" | while read -r f; do
    MIDDLEWARE_NAME=$(basename "$f" .py)
    MAIN_PY="$REPO_ROOT/services/api/app/main.py"

    if [ -f "$MAIN_PY" ]; then
        if grep -q "$MIDDLEWARE_NAME" "$MAIN_PY" 2>/dev/null; then
            echo "OK: Middleware '$MIDDLEWARE_NAME' ($f) — registered in main.py"
        else
            echo "WARNING: Middleware '$MIDDLEWARE_NAME' ($f) — not found in main.py. May not be active."
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
done || true

# --- Shared module import check ---
echo "$FILES" | grep -E "^shared/.*\.py$" | while read -r f; do
    MODULE_NAME=$(basename "$f" .py)

    IMPORTERS=$(grep -rl "$MODULE_NAME" "$REPO_ROOT/services/api/" "$REPO_ROOT/services/worker/" 2>/dev/null | head -5)
    if [ -n "$IMPORTERS" ]; then
        echo "OK: Shared module '$MODULE_NAME' ($f) — imported by services"
    else
        echo "WARNING: Shared module '$MODULE_NAME' ($f) — no imports found in services/api/ or services/worker/"
        WARNINGS=$((WARNINGS + 1))
    fi
done || true

# --- Component import check ---
echo "$FILES" | grep -E "^web/src/components/.*\.tsx$" | while read -r f; do
    COMPONENT_NAME=$(basename "$f" .tsx)

    IMPORTERS=$(grep -rl "$COMPONENT_NAME" "$REPO_ROOT/web/src/app/" "$REPO_ROOT/web/src/components/" 2>/dev/null | grep -v "$f" | head -3)
    if [ -n "$IMPORTERS" ]; then
        echo "OK: Component '$COMPONENT_NAME' ($f) — imported by other files"
    else
        echo "WARNING: Component '$COMPONENT_NAME' ($f) — no imports found. May be unused or new."
        WARNINGS=$((WARNINGS + 1))
    fi
done || true

# --- Exit code ---
if [ "$BLOCKING" -gt 0 ]; then
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    exit 2
fi
exit 0
