#!/usr/bin/env bash
# verify-env-vars.sh — Check that new environment variables are properly wired
#
# Usage: verify-env-vars.sh <pr_diff_file> <repo_root>
#   pr_diff_file: path to file containing unified diff output (or "-" for stdin)
#   repo_root: path to the repository root
#
# Output: Structured findings (one per line, prefixed with severity)
#   BLOCKING: <message>  — must fix before merge
#   WARNING:  <message>  — likely issue, verify manually
#   OK:       <message>  — check passed
#
# Exit codes: 0 = all checks passed, 1 = blocking findings, 2 = warnings only

set -euo pipefail

DIFF_INPUT="${1:--}"
REPO_ROOT="${2:-.}"

if [ "$DIFF_INPUT" = "-" ]; then
    DIFF_CONTENT=$(cat)
else
    DIFF_CONTENT=$(cat "$DIFF_INPUT")
fi

BLOCKING=0
WARNINGS=0

# Extract new env var references from added lines in the diff (Python + Node.js)
NEW_ENVS=$(echo "$DIFF_CONTENT" | grep -E "^\+" | grep -oE 'os\.getenv\("[^"]+"\)|os\.environ\["[^"]+"\]|os\.environ\.get\("[^"]+"\)|process\.env\.[A-Z_]+' | sort -u)

# --- Docker Compose entrypoint/command env var wiring check ---
# When docker-compose files change entrypoint: or command: to reference shell vars,
# those vars must be available inside the container via environment: or env_file:.
# Compose interpolation (${VAR} in YAML) happens at parse time on the host.
# Shell vars (${VAR} in entrypoint scripts) need runtime injection via environment:.
# Mixing these up causes silent failures — the var is empty inside the container.
#
# This check was added after the Redis incident (forge #185): PR #14554 migrated Redis
# from command: args (Compose interpolation) to entrypoint.sh (container runtime),
# but never added environment: to pass REDIS_PASSWORD into the container.

COMPOSE_ENV_BLOCKING=0
COMPOSE_FILES=$(echo "$DIFF_CONTENT" | grep -E "^\+\+\+ b/" | grep -oE 'docker-compose[^[:space:]]*\.yml' | sort -u)

if [ -n "$COMPOSE_FILES" ]; then
    echo "=== Docker Compose Entrypoint/Command Env Var Wiring ==="

    for compose_file in $COMPOSE_FILES; do
        COMPOSE_PATH="$REPO_ROOT/$compose_file"
        [ -f "$COMPOSE_PATH" ] || continue

        # Find services that have entrypoint: or command: referencing scripts
        # (not inline ${VAR} which is Compose interpolation — those are fine)
        # We look for entrypoint lines pointing to .sh files
        ENTRYPOINT_SCRIPTS=$(grep -A1 'entrypoint:' "$COMPOSE_PATH" 2>/dev/null \
            | grep -oE '/[a-zA-Z0-9_./-]+\.sh' | sort -u)

        for script_ref in $ENTRYPOINT_SCRIPTS; do
            # Find the script file in the repo
            SCRIPT_PATH=$(find "$REPO_ROOT" -path "*${script_ref}" -type f 2>/dev/null | head -1)
            [ -n "$SCRIPT_PATH" ] || continue

            # Extract ${VAR} and $VAR references from the script (skip comments)
            SCRIPT_VARS=$(grep -v '^\s*#' "$SCRIPT_PATH" 2>/dev/null \
                | grep -oE '\$\{?[A-Z][A-Z_0-9]{2,}\}?' \
                | sed 's/[${}]//g' \
                | sort -u)

            [ -n "$SCRIPT_VARS" ] || continue

            # Determine which service this entrypoint belongs to
            # (search backward from the entrypoint line to find the service name)
            SERVICE_NAME=$(awk "/entrypoint:.*$(basename "$script_ref")/{found=1} found && /^  [a-z]/{print; exit}" "$COMPOSE_PATH" 2>/dev/null \
                | sed 's/://; s/^  //' || echo "unknown")
            # Fallback: extract service by finding the indented block containing this entrypoint
            if [ "$SERVICE_NAME" = "unknown" ] || [ -z "$SERVICE_NAME" ]; then
                SERVICE_NAME=$(awk '/^  [a-z_-]+:/{svc=$1} /entrypoint:.*'"$(basename "$script_ref")"'/{print svc; exit}' "$COMPOSE_PATH" 2>/dev/null \
                    | sed 's/://')
            fi

            # Extract vars from this service's environment: section
            SERVICE_ENV_VARS=$(awk "/^  ${SERVICE_NAME}:/,/^  [a-z]/" "$COMPOSE_PATH" 2>/dev/null \
                | awk '/environment:/,/^    [a-z]|^  [a-z]/' \
                | grep -oE '[A-Z][A-Z_0-9]{2,}' \
                | sort -u)

            # Also check env_file: — if present, vars come from .env or specified file
            HAS_ENV_FILE=$(awk "/^  ${SERVICE_NAME}:/,/^  [a-z]/" "$COMPOSE_PATH" 2>/dev/null \
                | grep -c 'env_file:' || true)

            for var in $SCRIPT_VARS; do
                # Skip common shell vars that aren't env config
                case "$var" in
                    PATH|HOME|USER|SHELL|PWD|TERM|HOSTNAME|LANG) continue ;;
                esac

                IN_ENV=$(echo "$SERVICE_ENV_VARS" | grep -cx "$var" || true)

                if [ "$IN_ENV" -eq 0 ] && [ "$HAS_ENV_FILE" -eq 0 ]; then
                    echo "BLOCKING: $var used in entrypoint $script_ref (service: ${SERVICE_NAME:-unknown}) but NOT in service environment: section of $compose_file — container will not receive this var at runtime"
                    COMPOSE_ENV_BLOCKING=$((COMPOSE_ENV_BLOCKING + 1))
                elif [ "$IN_ENV" -eq 0 ] && [ "$HAS_ENV_FILE" -gt 0 ]; then
                    echo "WARNING: $var used in entrypoint $script_ref (service: ${SERVICE_NAME:-unknown}) — not in explicit environment: but service has env_file: — verify var is in the referenced env file"
                    WARNINGS=$((WARNINGS + 1))
                else
                    echo "OK: $var — in environment: section of service ${SERVICE_NAME:-unknown}"
                fi
            done
        done
    done

    if [ "$COMPOSE_ENV_BLOCKING" -eq 0 ] && [ -n "$COMPOSE_FILES" ]; then
        echo "OK: No docker-compose entrypoint env var wiring issues found"
    fi
    echo ""
fi

BLOCKING=$((BLOCKING + COMPOSE_ENV_BLOCKING))

if [ -z "$NEW_ENVS" ] && [ "$COMPOSE_ENV_BLOCKING" -eq 0 ]; then
    echo "OK: No new environment variable references detected in diff"
    exit 0
fi

if [ -n "$NEW_ENVS" ]; then
    echo "=== New Environment Variable References ==="
    echo "$NEW_ENVS"
    echo ""
fi

# Extract just the variable names from Python/Node references
VAR_NAMES=$(echo "$NEW_ENVS" | grep -oE '[A-Z][A-Z_0-9]{2,}' | sort -u)

# If no Python/Node env vars found, skip to summary (compose checks already ran above)
if [ -z "$VAR_NAMES" ]; then
    echo ""
    echo "=== Summary ==="
    echo "Python/Node vars checked: 0"
    echo "Compose entrypoint vars blocking: $COMPOSE_ENV_BLOCKING"
    echo "Blocking: $BLOCKING"
    echo "Warnings: $WARNINGS"

    if [ "$BLOCKING" -gt 0 ]; then
        exit 1
    elif [ "$WARNINGS" -gt 0 ]; then
        exit 2
    fi
    exit 0
fi

for var in $VAR_NAMES; do
    echo "--- Checking: $var ---"
    FOUND_IN=""

    # Check .env.example
    if [ -f "$REPO_ROOT/.env.example" ] && grep -q "$var" "$REPO_ROOT/.env.example" 2>/dev/null; then
        FOUND_IN="${FOUND_IN} .env.example"
    fi

    # Check docker-compose.yml
    if [ -f "$REPO_ROOT/docker-compose.yml" ] && grep -q "$var" "$REPO_ROOT/docker-compose.yml" 2>/dev/null; then
        FOUND_IN="${FOUND_IN} docker-compose.yml"
    fi

    # Check docker-compose.prod.yml
    if [ -f "$REPO_ROOT/docker-compose.prod.yml" ] && grep -q "$var" "$REPO_ROOT/docker-compose.prod.yml" 2>/dev/null; then
        FOUND_IN="${FOUND_IN} docker-compose.prod.yml"
    fi

    # Check env_validation.py (Python API vars)
    if [ -f "$REPO_ROOT/services/api/app/core/env_validation.py" ] && grep -q "$var" "$REPO_ROOT/services/api/app/core/env_validation.py" 2>/dev/null; then
        FOUND_IN="${FOUND_IN} env_validation.py"
    fi

    # Check decrypt-secrets.sh (SOPS mapping)
    if [ -f "$REPO_ROOT/scripts/decrypt-secrets.sh" ] && grep -q "$var" "$REPO_ROOT/scripts/decrypt-secrets.sh" 2>/dev/null; then
        FOUND_IN="${FOUND_IN} decrypt-secrets.sh"
    fi

    if [ -z "$FOUND_IN" ]; then
        # Determine whether any of the optional surfaces exist in this repo.
        # If NONE of the known surfaces exist (not even .env.example), the repo
        # uses a layout we can't validate — emit SKIP instead of a false BLOCKING.
        # This is the verify-sops-chain.sh pattern: unknown layout → graceful skip,
        # not a spurious failure. <!-- Added: forge#1349 -->
        HAS_ANY_SURFACE=0
        [ -f "$REPO_ROOT/.env.example" ] && HAS_ANY_SURFACE=1
        [ -f "$REPO_ROOT/docker-compose.yml" ] && HAS_ANY_SURFACE=1
        [ -f "$REPO_ROOT/docker-compose.prod.yml" ] && HAS_ANY_SURFACE=1
        [ -f "$REPO_ROOT/services/api/app/core/env_validation.py" ] && HAS_ANY_SURFACE=1
        [ -f "$REPO_ROOT/scripts/decrypt-secrets.sh" ] && HAS_ANY_SURFACE=1

        if [ "$HAS_ANY_SURFACE" -eq 0 ]; then
            echo "SKIP: $var — no known env-wiring surfaces found in repo (no .env.example, docker-compose, env_validation.py, or SOPS mapping). Configure verification.env_check_surfaces in forge.yaml or add .env.example to enable this check."
        else
            echo "BLOCKING: $var — not found in any detected env-wiring surface (.env.example, docker-compose.yml, env_validation.py, or decrypt-secrets.sh)"
            BLOCKING=$((BLOCKING + 1))
        fi
    else
        echo "OK: $var — found in:$FOUND_IN"
    fi
done

echo ""
echo "=== Summary ==="
echo "Variables checked: $(echo "$VAR_NAMES" | wc -w)"
echo "Blocking: $BLOCKING"
echo "Warnings: $WARNINGS"

# --- Exit code ---
if [ "$BLOCKING" -gt 0 ]; then
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    exit 2
fi
exit 0
