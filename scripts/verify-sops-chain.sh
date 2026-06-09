#!/usr/bin/env bash
# verify-sops-chain.sh — Trace SOPS secrets through the full deploy chain
#
# Usage: verify-sops-chain.sh <pr_diff_file> <changed_files_file> <repo_root>
#   pr_diff_file: path to file containing unified diff output (or "-" for stdin on first arg)
#   changed_files_file: path to file listing changed files (one per line)
#   repo_root: path to the repository root
#
# Verifies:
#   1. ENV_MAPPING entries in decrypt-secrets.sh have matching SOPS keys
#   2. Deploy workflow SCP target and merge path are consistent
#   3. Hotfix workflow paths match main deploy workflow
#
# Output: Structured findings (one per line, prefixed with severity)
#   BLOCKING: <message>  — must fix before merge
#   WARNING:  <message>  — likely issue, verify manually
#   OK:       <message>  — check passed
#
# Exit codes: 0 = all checks passed, 1 = blocking findings, 2 = warnings only

set -euo pipefail

DIFF_INPUT="${1:--}"
CHANGED_FILES_INPUT="${2:--}"
REPO_ROOT="${3:-.}"

# --- Secrets backend guard ---
# This script only applies when the project uses SOPS as its secrets backend.
# Read the configured backend from the FORGE_SECRETS_BACKEND env var (set by the
# calling pipeline) or fall back to parsing forge.yaml in the repo root.
#
# If the backend is not "sops" (or is unset), exit 0 with a skip message.
# This is a clean no-op — not a false-pass — so callers can distinguish
# "SOPS configured and passed" from "SOPS not in use on this project".
_SECRETS_BACKEND="${FORGE_SECRETS_BACKEND:-}"
if [ -z "$_SECRETS_BACKEND" ] && [ -f "$REPO_ROOT/forge.yaml" ]; then
    _SECRETS_BACKEND=$(grep -E '^\s*secrets_backend:' "$REPO_ROOT/forge.yaml" \
        | head -1 | sed 's/.*secrets_backend:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
fi
if [ "$_SECRETS_BACKEND" != "sops" ]; then
    echo "SKIP: verify-sops-chain — secrets_backend is '${_SECRETS_BACKEND:-none}' (not sops). Configure deploy.secrets_backend: sops in forge.yaml to enable SOPS chain verification."
    exit 0
fi

if [ "$DIFF_INPUT" = "-" ]; then
    DIFF_CONTENT=$(cat)
else
    DIFF_CONTENT=$(cat "$DIFF_INPUT")
fi

if [ "$CHANGED_FILES_INPUT" = "-" ]; then
    CHANGED_FILES=""
else
    CHANGED_FILES=$(cat "$CHANGED_FILES_INPUT")
fi

BLOCKING=0
WARNINGS=0

# Check if any SOPS/deploy chain files are in the changeset
SOPS_CHAIN_FILES=$(echo "$CHANGED_FILES" | grep -E "(decrypt-secrets\.sh|prod\.enc\.yaml|deploy-production\.yml|hotfix-deploy\.yml)" || true)

if [ -z "$SOPS_CHAIN_FILES" ]; then
    echo "OK: No SOPS deploy chain files in changeset"
    exit 0
fi

echo "=== SOPS Deploy Chain Verification ==="
echo "Changed files in deploy chain: $SOPS_CHAIN_FILES"
echo ""

# --- Check 1: ENV_MAPPING → SOPS key consistency ---
echo "--- Check 1: ENV_MAPPING → SOPS key consistency ---"
NEW_MAPPINGS=$(echo "$DIFF_CONTENT" | grep -E "^\+.*\": \(\"" | grep -oE '"[A-Z_]+": \("([a-z_]+)", "([a-z_]+)"\)' || true)

if [ -n "$NEW_MAPPINGS" ]; then
    echo "New ENV_MAPPING entries found:"
    echo "$NEW_MAPPINGS"
    echo ""

    # For each new mapping, verify the SOPS path structure exists
    # (We can't decrypt SOPS to verify values, but we can check the mapping format is valid)
    # Use process substitution instead of a pipe so WARNINGS increments persist in the parent shell.
    # (echo ... | while read creates a subshell — counter changes are lost on subshell exit.)
    while IFS= read -r mapping; do
        VAR_NAME=$(echo "$mapping" | grep -oE '^"[A-Z_]+"' | tr -d '"')
        SOPS_SECTION=$(echo "$mapping" | grep -oE '\("([a-z_]+)"' | head -1 | tr -d '("')
        SOPS_KEY=$(echo "$mapping" | grep -oE ', "([a-z_]+)"\)' | tr -d ', ")')

        if [ -n "$VAR_NAME" ] && [ -n "$SOPS_SECTION" ] && [ -n "$SOPS_KEY" ]; then
            echo "OK: $VAR_NAME → sops[$SOPS_SECTION][$SOPS_KEY] — mapping format valid"
        else
            echo "WARNING: Malformed ENV_MAPPING entry: $mapping"
            WARNINGS=$((WARNINGS + 1))
        fi
    done < <(echo "$NEW_MAPPINGS")
else
    echo "OK: No new ENV_MAPPING entries in diff"
fi

echo ""

# --- Check 2: Deploy workflow path consistency ---
echo "--- Check 2: Deploy workflow path consistency ---"
DEPLOY_WORKFLOW="$REPO_ROOT/.github/workflows/deploy-production.yml"

if [ -f "$DEPLOY_WORKFLOW" ]; then
    SCP_TARGET=$(grep -oE "target:.*PRODUCTION_PROJECT_PATH[^\"]*" "$DEPLOY_WORKFLOW" 2>/dev/null | head -1 || true)
    MERGE_PROJECT=$(grep -oE "PROJECT=.*PRODUCTION_PROJECT_PATH[^}]*}[^ ]*" "$DEPLOY_WORKFLOW" 2>/dev/null | head -1 || true)

    echo "SCP target:    ${SCP_TARGET:-<not found>}"
    echo "Merge PROJECT: ${MERGE_PROJECT:-<not found>}"

    # Check for double-path risk
    if echo "$SCP_TARGET" | grep -qE "PRODUCTION_PROJECT_PATH.*\}/app" 2>/dev/null; then
        echo "BLOCKING: SCP target appends /app to PRODUCTION_PROJECT_PATH — if the path already includes /app, secrets go to /app/app/"
        BLOCKING=$((BLOCKING + 1))
    fi
    if echo "$MERGE_PROJECT" | grep -qE "PRODUCTION_PROJECT_PATH.*\}/app" 2>/dev/null; then
        echo "BLOCKING: Merge PROJECT appends /app — same double-path risk"
        BLOCKING=$((BLOCKING + 1))
    fi

    if [ "$BLOCKING" -eq 0 ]; then
        echo "OK: No double-path risk detected in deploy workflow"
    fi
else
    echo "WARNING: Deploy workflow not found at $DEPLOY_WORKFLOW — cannot verify paths"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""

# --- Check 3: Hotfix workflow consistency ---
echo "--- Check 3: Hotfix workflow consistency ---"
HOTFIX_WORKFLOW="$REPO_ROOT/.github/workflows/hotfix-deploy.yml"

if [ -f "$HOTFIX_WORKFLOW" ] && [ -f "$DEPLOY_WORKFLOW" ]; then
    HOTFIX_SCP=$(grep -oE "target:.*PRODUCTION_PROJECT_PATH[^\"]*" "$HOTFIX_WORKFLOW" 2>/dev/null | head -1 || true)
    MAIN_SCP=$(grep -oE "target:.*PRODUCTION_PROJECT_PATH[^\"]*" "$DEPLOY_WORKFLOW" 2>/dev/null | head -1 || true)

    echo "Main deploy SCP:   ${MAIN_SCP:-<not found>}"
    echo "Hotfix deploy SCP: ${HOTFIX_SCP:-<not found>}"

    if [ -n "$MAIN_SCP" ] && [ -n "$HOTFIX_SCP" ] && [ "$MAIN_SCP" != "$HOTFIX_SCP" ]; then
        echo "WARNING: Hotfix SCP target differs from main deploy — path drift risk"
        WARNINGS=$((WARNINGS + 1))
    elif [ -n "$MAIN_SCP" ] && [ -n "$HOTFIX_SCP" ]; then
        echo "OK: Hotfix and main deploy SCP targets match"
    fi
else
    echo "OK: Hotfix workflow comparison skipped (file not found)"
fi

echo ""

# --- Check 4: docker-compose.prod.yml env_file consistency ---
echo "--- Check 4: Compose env_file path ---"
COMPOSE_PROD="$REPO_ROOT/docker-compose.prod.yml"

if [ -f "$COMPOSE_PROD" ]; then
    COMPOSE_ENV=$(grep -A1 "env_file:" "$COMPOSE_PROD" 2>/dev/null | grep -oE '\.env[a-z.]*' | head -1 || true)
    echo "Compose env_file: ${COMPOSE_ENV:-<not found>}"

    if [ -n "$COMPOSE_ENV" ]; then
        echo "OK: Production compose uses env_file: $COMPOSE_ENV"
    fi
else
    echo "OK: No docker-compose.prod.yml — skipping compose check"
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
