---
description: review-pr fragment — Step 2.5B assumption verification scripts (read by /review-pr when its trigger holds; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

### Step 2.5B: Run Verification

For each changed file, execute the relevant checks using the standalone verification scripts in `${FORGE_HOME:-$SCRIPTS_HOME}/scripts/`. These scripts can also be run independently outside the review context (e.g., from `/quality-gate` or `/work-on` builder steps).

**Platform note**: The verify-*.sh scripts require bash and standard POSIX tools. On Windows without bash (Git Bash / WSL / MSYS2), these checks are skipped with an explicit message — the review continues without them.

```bash
CHANGED_FILES=$(gh pr diff "$PR_NUMBER" -R "$REPO" --name-only)
REPO_ROOT="."  # Assumes cwd is the repo root

# Resolve the verify-*.sh scripts source directory with the same deterministic
# fallback as the Phase 3C TEMPLATE_BASE guard: $FORGE_HOME first (the installed
# ForgeDock location), then this repo's own root (forge.yaml -> paths.root, or
# git top-level). A bare/unset $FORGE_HOME must never be used directly in a path —
# that degrades to a root-anchored path (/scripts/verify-*.sh) and silently skips
# every check below. Never fall back to a filesystem-wide `find`.
# <!-- Added: forge#2035 -->
_PLUGIN_ROOT='${CLAUDE_PLUGIN_ROOT}'; case "$_PLUGIN_ROOT" in /*) ;; *) _PLUGIN_ROOT="" ;; esac
if [ -n "$_PLUGIN_ROOT" ] && [ -f "$_PLUGIN_ROOT/scripts/verify-route-registration.sh" ]; then
    SCRIPTS_HOME="$_PLUGIN_ROOT"   # running plugin's own root first (see Phase 3C Tier 0)
elif [ -n "$FORGE_HOME" ] && [ -f "$FORGE_HOME/scripts/verify-route-registration.sh" ]; then
    SCRIPTS_HOME="$FORGE_HOME"
else
    FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
    SCRIPTS_HOME=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

# --- Platform / bash capability guard ---
# The verify-*.sh scripts require bash. Detect availability before invoking.
# On Windows without Git Bash/WSL, skip gracefully rather than crash.
BASH_AVAILABLE=false
if command -v bash >/dev/null 2>&1 && bash -c 'echo ok' >/dev/null 2>&1; then
    BASH_AVAILABLE=true
fi

if [ "$BASH_AVAILABLE" = "true" ]; then
    # Write changed files and diff to temp files for script consumption.
    # Use PID-based names instead of mktemp for cross-platform compatibility.
    CHANGED_FILES_TMP="/tmp/forge-review-changed-$$.tmp"
    DIFF_TMP="/tmp/forge-review-diff-$$.tmp"
    echo "$CHANGED_FILES" > "$CHANGED_FILES_TMP"
    gh pr diff "$PR_NUMBER" -R "$REPO" > "$DIFF_TMP"

    # --- Script-based checks (reusable, testable, deterministic) ---
    # Each script exits 0 (pass), 1 (blocking findings), or 2 (warnings only).
    # Output is structured: "BLOCKING: ...", "WARNING: ...", "OK: ..." per line.

    # 1. Route/router/middleware/shared-module/component registration
    # Export forge.yaml layout overrides so verify-route-registration.sh uses project-configured
    # paths instead of project defaults. The script supports these env vars (lines 36-44 of
    # verify-route-registration.sh) but requires the caller to set them. <!-- Added: forge#1349 -->
    if [ -f "$REPO_ROOT/forge.yaml" ]; then
        _PAGES_ROOT=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*pages:' | head -1 | sed 's/.*pages:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        _API_ROUTERS=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*api_routers_dir:' | head -1 | sed 's/.*api_routers_dir:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        _API_MAIN=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*api_main:' | head -1 | sed 's/.*api_main:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        _API_MIDDLEWARE=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*api_middleware_dir:' | head -1 | sed 's/.*api_middleware_dir:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        [ -n "$_PAGES_ROOT" ] && export FORGE_PAGES_ROOT="$_PAGES_ROOT"
        [ -n "$_API_ROUTERS" ] && export FORGE_API_ROUTERS_DIR="$_API_ROUTERS"
        [ -n "$_API_MAIN" ] && export FORGE_API_MAIN="$_API_MAIN"
        [ -n "$_API_MIDDLEWARE" ] && export FORGE_API_MIDDLEWARE_DIR="$_API_MIDDLEWARE"
    fi
    echo "=== Running: verify-route-registration.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-route-registration.sh" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # 2. Environment variable wiring (checks .env.example, docker-compose, env_validation, SOPS mapping)
    echo "=== Running: verify-env-vars.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-env-vars.sh" "$DIFF_TMP" "$REPO_ROOT" || true

    # 3. Host headers in shell scripts + client-side proxy bypass check
    # Read project-specific internal service patterns from forge.yaml (if present)
    FORGE_INTERNAL_PATTERNS=""
    if [ -f "$REPO_ROOT/forge.yaml" ]; then
        FORGE_INTERNAL_PATTERNS=$(grep -A 999 'internal_service_patterns:' "$REPO_ROOT/forge.yaml" \
            | grep -E '^\s*-\s+' \
            | sed 's/^\s*-\s*//' \
            | tr -d '"'"'" \
            | awk 'NR>1{printf "|"}{printf "%s", $(0)}END{print ""}')
    fi
    export FORGE_INTERNAL_PATTERNS
    echo "=== Running: verify-host-headers.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-host-headers.sh" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # 4. SOPS deploy chain (ENV_MAPPING consistency, deploy path drift, hotfix sync)
    echo "=== Running: verify-sops-chain.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-sops-chain.sh" "$DIFF_TMP" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # Cleanup temp files
    rm -f "$CHANGED_FILES_TMP" "$DIFF_TMP"
else
    echo "=== Phase 2.5B: verify-*.sh skipped — bash not available on this platform ==="
    echo "    The verify-*.sh scripts require bash (POSIX shell)."
    echo "    Install Git Bash (Windows) or WSL to enable these checks."
    echo "    The review continues — integration assumptions should be verified manually."
fi

# --- Inline checks (not yet extracted to scripts) ---

# Python scoping hazard check — local imports that shadow module-level names
# A local `import X` makes X a local variable for the ENTIRE function scope.
# Any reference to X ABOVE the local import will crash with UnboundLocalError.
echo "$CHANGED_FILES" | grep -E '\.py$' | while IFS= read -r f; do
    echo "=== Python Scoping Check: $f ==="
    # Find function-scoped imports (indented import statements)
    grep -nE "^\s+import [a-z]" "$f" 2>/dev/null | while read line; do
        LINENO=$(echo "$line" | cut -d: -f1)
        MODULE=$(echo "$line" | grep -oE "import [a-z_]+" | awk '{print $(2)}')
        # Check if the same module is used BEFORE this line in the same function
        # (simplified check — agents should do full scope analysis)
        [ -n "$MODULE" ] && head -n $((LINENO-1)) "$f" 2>/dev/null | grep -qE "^\s+.*\b${MODULE}\." && \
            echo "WARNING: Local 'import $MODULE' at line $LINENO may shadow module-level import — check for UnboundLocalError on references above this line"
    done
done

# Config file assumption check (baked into Docker image vs volume-mounted)
echo "$CHANGED_FILES" | grep -E "config/.*\.(json|yaml|yml)$" | while IFS= read -r f; do
    echo "=== Config File: $f ==="
    grep -n "$(dirname $f)" docker-compose.yml 2>/dev/null || echo "WARNING: Config dir may not be mounted — changes may require --build"
    grep -n "$(dirname $f)" services/*/Dockerfile 2>/dev/null || true
done

# Sibling workflow drift check — ALWAYS runs for staging→main PRs.
# Also runs when any workflow file changes on non-staging PRs.
#
# The class of bug this catches: ci.yml has PYTHONPATH + worker deps,
# deploy-production.yml doesn't. CI passes, deploy fails.
# PR #11356 was approved with green CI but deploy pipeline broke.
#
# CRITICAL: This check must NOT be gated on workflow files being in the
# diff. Pre-existing drift is the most dangerous kind — it lurks until
# staging→main and then blocks the deploy.
WORKFLOW_FILES=$(echo "$CHANGED_FILES" | grep -E "^\.github/workflows/.*\.yml$" || true)
# Use POSIX-portable conditional (avoid bash-only [[ ]])
IS_STAGING_PR="false"
if [ "$HEAD" = "staging" ] && [ "$BASE" = "main" ]; then IS_STAGING_PR="true"; fi

if [ -n "$WORKFLOW_FILES" ] || [ "$IS_STAGING_PR" = "true" ]; then
    echo "=== Sibling Workflow Drift Check (MANDATORY for staging→main) ==="

    CI_WF=".github/workflows/ci.yml"
    DEPLOY_WF=".github/workflows/deploy-production.yml"

    if [ -f "$CI_WF" ] && [ -f "$DEPLOY_WF" ]; then
        # Deep comparison: extract the full test step (name + run + env) from
        # each shared job and diff them. Keyword grepping missed the PR #11356
        # failure — PYTHONPATH was present in CI but absent in deploy.
        for JOB in test-api test-web; do
            CI_HAS=$(grep -c "name: Test.*${JOB#test-}" "$CI_WF" 2>/dev/null || echo 0)
            DEPLOY_HAS=$(grep -c "name: Test.*${JOB#test-}" "$DEPLOY_WF" 2>/dev/null || echo 0)
            [ "$CI_HAS" -eq 0 ] || [ "$DEPLOY_HAS" -eq 0 ] && continue

            echo "--- Comparing '$JOB' job between ci.yml and deploy-production.yml ---"

            # Extract env vars from ALL steps in the job (not just pytest).
            # Flag-based awk avoids the range-collapse bug: /pat1/,/pat2/ collapses
            # to a single line when the header (e.g. "  test-api:") matches both
            # patterns simultaneously. The flag form sets p=1 on the header line,
            # prints body lines while p=1, and clears p when the next sibling job
            # header (same indentation, lowercase start) is seen. <!-- Added: forge#310 -->
            CI_ENVS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $(0)~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$CI_WF" 2>/dev/null | grep -E "PYTHONPATH|DATABASE_URL|REDIS_URL|TESTING" | sed 's/^ *//' | sort)
            DEPLOY_ENVS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $(0)~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$DEPLOY_WF" 2>/dev/null | grep -E "PYTHONPATH|DATABASE_URL|REDIS_URL|TESTING" | sed 's/^ *//' | sort)

            # Check for PYTHONPATH specifically — the exact var that caused the #11356 failure
            CI_PYPATH=$(echo "$CI_ENVS" | grep "PYTHONPATH" || echo "(not set)")
            DEPLOY_PYPATH=$(echo "$DEPLOY_ENVS" | grep "PYTHONPATH" || echo "(not set)")
            if [ "$CI_PYPATH" != "$DEPLOY_PYPATH" ]; then
                echo "  BLOCKING: PYTHONPATH differs between ci.yml and deploy-production.yml for job '$JOB'"
                echo "    ci.yml:              $CI_PYPATH"
                echo "    deploy-production:   $DEPLOY_PYPATH"
                echo "  This WILL cause deploy failure — CI passes but deploy test step uses different Python path."
            fi

            # Check for dependency installation steps that exist in one but not the other
            CI_INSTALLS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $(0)~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$CI_WF" 2>/dev/null | grep -c "poetry install\|pip install\|npm install" || echo 0)
            DEPLOY_INSTALLS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $(0)~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$DEPLOY_WF" 2>/dev/null | grep -c "poetry install\|pip install\|npm install" || echo 0)
            if [ "$CI_INSTALLS" != "$DEPLOY_INSTALLS" ]; then
                echo "  WARNING: Different number of dependency install steps in '$JOB' — ci.yml has $CI_INSTALLS, deploy has $DEPLOY_INSTALLS"
                echo "  ACTION: Read both files and verify all dependencies needed by tests are installed in both workflows."
            fi

            # Check step names — if CI has a step that deploy doesn't, flag it
            CI_STEPS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $(0)~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$CI_WF" 2>/dev/null | grep "- name:" | sed 's/.*- name: //' | sort)
            DEPLOY_STEPS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $(0)~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$DEPLOY_WF" 2>/dev/null | grep "- name:" | sed 's/.*- name: //' | sort)
            MISSING_IN_DEPLOY=$(comm -23 <(echo "$CI_STEPS") <(echo "$DEPLOY_STEPS") 2>/dev/null || true)
            if [ -n "$MISSING_IN_DEPLOY" ]; then
                echo "  WARNING: Steps in ci.yml '$JOB' missing from deploy-production.yml:"
                echo "$MISSING_IN_DEPLOY" | sed 's/^/    - /'
            fi
        done
    fi
fi
```
