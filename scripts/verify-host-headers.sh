#!/usr/bin/env bash
# verify-host-headers.sh — Check that shell scripts using curl/wget set proper Host headers
#
# Usage: verify-host-headers.sh <changed_files_file> <repo_root>
#   changed_files_file: path to a file listing changed shell scripts (one per line), or "-" for stdin
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

# Filter to only shell scripts
SHELL_FILES=$(echo "$FILES" | grep -E '\.(sh|bash)$' || true)

if [ -z "$SHELL_FILES" ]; then
    echo "OK: No shell scripts in changed files"
    exit 0
fi

BLOCKING=0
WARNINGS=0

# Internal service patterns — requests to these need explicit Host headers
# Generic defaults cover localhost, RFC 1918 addresses, common service name prefixes, and IP env vars.
# Project-specific prefixes (e.g. "myapp-") can be added via FORGE_INTERNAL_PATTERNS (pipe-separated).
INTERNAL_PATTERNS="localhost|127\.0\.0\.1|api-|worker-|172\.[0-9]+\.[0-9]+\.[0-9]+|\\\$\{?[a-z_]*ip|\\\$\{?[A-Z_]*IP"
if [ -n "${FORGE_INTERNAL_PATTERNS:-}" ]; then
    INTERNAL_PATTERNS="${INTERNAL_PATTERNS}|${FORGE_INTERNAL_PATTERNS}"
fi

echo "$SHELL_FILES" | while read -r f; do
    FILEPATH="$REPO_ROOT/$f"
    if [ ! -f "$FILEPATH" ]; then
        continue
    fi

    # Find curl/wget commands targeting internal services
    CURL_LINES=$(grep -nE "(curl|wget)" "$FILEPATH" 2>/dev/null | grep -E "$INTERNAL_PATTERNS" || true)

    if [ -z "$CURL_LINES" ]; then
        echo "OK: $f — no internal service HTTP calls found"
        continue
    fi

    echo "=== Checking: $f ==="
    echo "$CURL_LINES" | while IFS= read -r line; do
        LINENO=$(echo "$line" | cut -d: -f1)
        CONTENT=$(echo "$line" | cut -d: -f2-)

        # Check if a Host header is explicitly set
        if echo "$CONTENT" | grep -qE "\-H\s+[\"']Host:"; then
            echo "OK: $f:$LINENO — Host header explicitly set"
        elif echo "$CONTENT" | grep -qE "\-\-header\s+[\"']Host:"; then
            echo "OK: $f:$LINENO — Host header explicitly set (--header)"
        else
            echo "BLOCKING: $f:$LINENO — curl/wget to internal service without explicit Host header. TrustedHostMiddleware will reject raw IP as Host value."
            echo "  Line: $CONTENT"
            echo "  Fix: Add -H 'Host: localhost' (or appropriate allowed host from services/api/app/main.py allowed_hosts)"
            BLOCKING=$((BLOCKING + 1))
        fi
    done
done || true

# --- Client-side proxy bypass check ---
# Check frontend files for direct /api/v1/ calls (bypasses Next.js auth proxy)
FRONTEND_FILES=$(echo "$FILES" | grep -E '\.(tsx?|jsx?)$' | grep -v 'route\.ts$' | grep -v '\.d\.ts$' || true)

if [ -n "$FRONTEND_FILES" ]; then
    echo ""
    echo "=== Client-Side Proxy Bypass Check ==="
    echo "$FRONTEND_FILES" | while read -r f; do
        FILEPATH="$REPO_ROOT/$f"
        if [ ! -f "$FILEPATH" ]; then
            continue
        fi

        # Check for direct /api/v1/ calls in fetch/useSWR/apiFetch
        DIRECT_CALLS=$(grep -nE "(fetch|useSWR|apiFetch|adminFetcher)\s*[(<]\s*[\`\"']/api/v1/" "$FILEPATH" 2>/dev/null || true)
        if [ -z "$DIRECT_CALLS" ]; then
            # Also check template literals
            DIRECT_CALLS=$(grep -nE '`/api/v1/' "$FILEPATH" 2>/dev/null | grep -vE '^\s*//' || true)
        fi

        if [ -n "$DIRECT_CALLS" ]; then
            echo "BLOCKING: $f — direct /api/v1/ call bypasses Next.js proxy (auth will fail)"
            echo "$DIRECT_CALLS" | while IFS= read -r match; do
                echo "  $match"
            done
            echo "  Fix: Use /api/* proxy routes instead of /api/v1/* direct FastAPI calls"
            BLOCKING=$((BLOCKING + 1))
        else
            echo "OK: $f — no direct backend calls"
        fi
    done
fi

echo ""
echo "=== Summary ==="
echo "Blocking: $BLOCKING"
echo "Warnings: $WARNINGS"

# --- Exit code ---
if [ "$BLOCKING" -gt 0 ]; then
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    exit 2
fi
exit 0
