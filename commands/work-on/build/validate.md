---
user-invocable: false
description: Validation agent — quality gate loop, format/verify, proxy check, deploy check
argument-hint: "{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE} --branch {BRANCH} --base {PR_BASE} --files \"<changed files>\""
context: fork
background: false
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/validate — Validation Subcommand

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

**Invoked by**: `work-on:build`, after `implement.md` has written and staged code (not committed). This skill runs in an isolated forked context: it sees only this text and its args, so it re-reads all other state from GitHub/git/forge.yaml.
**Output**: End with exactly one `VALIDATE_RESULT:` block as the final reply. On failure after max iterations, post comment and set `needs-human`.

**Result-on-every-exit rule**: every exit path — success, skip path, quality-gate failure, timeout, ancestry failure, missing arg, skill not found — MUST print the `VALIDATE_RESULT:` block (see Output) as the final reply. Failures use `gate_passed: false` with a `blocker` line. Never exit with a bare `exit 1` or free text.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/build/validate.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree (required)
- `--branch {BRANCH}` — feature branch name (required)
- `--base {PR_BASE}` — PR base branch name without the `origin/` prefix (required; used by the V5 ancestry audit)
- `--files {CHANGED_FILES}` — space-separated list of changed files (required; from the implement result)

**Fail closed**: if `{NUMBER}`, `--repo`, `--worktree`, `--branch`, `--base`, or `--files` is missing or empty, or `{WORKTREE_PATH}` is not an existing directory, print `VALIDATE_RESULT:` with `gate_passed: false` and `blocker: missing or invalid arg: <name>` and STOP. `{GH_FLAG}` defaults to `-R {GH_REPO}` when absent.

---

## Skip Conditions

Skip Phases V0–V4 (set `GATE_PASSED=true`, iterations 0) and go straight to Phase V5 (which posts the skip-path quality-gate marker, commits, and marks the build complete) if:
- Only 1 file was changed AND the shared predicate classifies it as documentation: `printf '%s\n' "<that file>" | bash "$FORGE_ROOT/scripts/is-docs-only.sh"` exits 0 (resolve `FORGE_ROOT` with the canonical block; unresolvable → the gate runs). A single file under `commands/`, `.claude/`, `.agents/`, `hooks/`, … or any agent-instruction Markdown is **code** for this purpose (it contains executable shell and agent instructions) and is never skipped. <!-- field test: phase-4-execution.md was skipped as "docs" -->

In all other cases, the gate MUST run.

---

## Phase V0: Builder Self-Check — Wire-Through Proof (MANDATORY, run BEFORE the Phase V1 quality gate loop)

<!-- Added: forge#1731 -->

Before invoking the quality gate (Phase V1), the builder MUST perform a self-check on newly added conditional paths. This mirrors the quality gate's 2G.8 check and allows the builder to resolve gaps before the gate invocation rather than after.

**Self-check protocol**:

1. Scan the staged diff for newly added conditional lines:
   ```bash
   git diff HEAD -- {CHANGED_FILES} | grep -E '^\+' | grep -v '^+++' \
       | grep -E '\bif\b|\belif\b|\belse\b|guard|feature.?flag|FEATURE_FLAG|ENABLE_|DISABLE_'
   ```

2. For each new conditional found, confirm at least ONE of:
   - **Test in diff**: A test function or assertion in the diff exercises this conditional branch (e.g., calls the function with parameters that trigger the `if`, asserts the guarded output, or triggers the error path deliberately)
   - **WIRE:PROVEN annotation**: Add `# WIRE:PROVEN — <method>` immediately before or after the new conditional, describing how you verified it fires (e.g., `# WIRE:PROVEN — gate logic: condition is checked before every call; unreachable path would raise ValueError visible in tests`)
   - **Trivial re-guard** (auto-exempt): The conditional is a null/length/type check whose body is `return`/`continue`/`break`/`pass` or a single-line assignment — defensive re-guards with no new behavior

3. If none of the above is true for a new conditional, either:
   - Add a test or trace that exercises the path before staging
   - Add a `# WIRE:PROVEN — <method>` annotation explaining how you verified reachability
   - Confirm it qualifies as a trivial re-guard

**Why this matters**: Guards, flags, and validators that are never exercised are functionally dead code. This class has cost multiple sprint cycles in this pipeline (#1230, #1244, #1522, #1580). The self-check catches gaps before the quality gate fires, reducing iteration count. <!-- Added: forge#1731 -->

---

## Phase V1: Quality Gate Loop

The loop runs **in this context** and calls `quality-gate` through the `Skill` tool; `quality-gate` is itself a forked skill (isolated context) that returns only its PASS/FINDINGS result lines, so no `Agent` fork is needed here. <!-- Added: forge#1825 -->

**Loop protocol** — the gate MUST pass or exhaust iterations before returning:

```
iteration = 0
max_iterations = 3

while iteration < max_iterations:
    iteration += 1
    Run quality-gate agent on CHANGED_FILES
    if result == "QUALITY GATE: PASS":
        GATE_PASSED = true
        break
    else:
        # Separate quarantined test findings from real blocker findings.
        # quality-gate Step 2R classifies each failing test as PRE_BROKEN, FLAKY, or REAL.
        # TEST-QUARANTINE findings (LOW) are advisory — do not fix, do not count as gate failures.
        # TEST-REAL findings (HIGH) and all other HIGH/MEDIUM findings must be fixed.
        quarantine_findings = findings where severity == LOW and code starts with "TEST-QUARANTINE"
        blocker_findings    = findings where code != "TEST-QUARANTINE"

        if blocker_findings is empty:
            # All remaining findings are quarantined tests — gate passes from the builder's perspective.
            GATE_PASSED = true
            break
        else:
            Fix each HIGH and MEDIUM finding in blocker_findings at {WORKTREE_PATH}
            (Do NOT commit yet — fixes are staged for the next gate run)

if iteration == max_iterations AND result != PASS AND blocker_findings not empty:
    GATE_PASSED = false
    → post comment (see V1-FAIL below)
    → add label needs-human
    → print VALIDATE_RESULT with gate_passed: false (blocker = remaining findings), STOP
```

**Quality gate invocation**:
```
Skill("{FORGE_SKILL_PREFIX}quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
```

**Timeout handling**: The quality-gate's executable checks carry their own explicit timeouts; a `QUALITY-GATE-TIMEOUT` result is a failed gate iteration. Record it as HIGH, do not apply speculative fixes, and proceed to V1-FAIL immediately (post the failure comment, add `needs-human`, print `VALIDATE_RESULT` with `gate_passed: false`). Do not retry a timed-out check. A wall-time timeout for the in-context `Skill(...)` invocation itself requires native runtime support and is not claimed by this workflow.

**Rules**:
- Re-run after EVERY fix pass — never trust that fixes resolved findings without verification
- Each iteration re-scans ALL changed files — fixes can introduce new issues
- Only HIGH and MEDIUM findings must be fixed; LOW findings are advisory only
- `COVERAGE-1 | HIGH` findings (quality-gate 2U coverage reduction) are fixed by restoring the deleted/skipped test or workflow step — never by `--no-verify` or suppression <!-- Added: forge#3257 -->
- `TEST-QUARANTINE | LOW` findings (pre-broken or flaky tests classified by Step 2R) do **not** require fixing and do **not** count toward gate failure — include them in the V5 commit comment for reviewer visibility
- If the `quality-gate` skill is not found under either name, STOP and print `VALIDATE_RESULT` with `gate_passed: false`, `blocker: skill not found: quality-gate` — never run the gate inline

**V1-FAIL comment** (post when gate never passes):
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Quality Gate Failed After 3 Iterations

Quality gate findings persist after 3 fix passes. Flagging for human review.

**Files**: {CHANGED_FILES}
**Final findings**: {SUMMARY_OF_REMAINING_FINDINGS}

Needs human review before proceeding to commit.

<!-- FORGE:GATE_FAILED -->"
gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
```

---

## Phase V2: Format and Verify

Run after quality gate passes. All tool commands are read from `forge.yaml → verification.commands`. `forge.yaml` is usually gitignored, so it is absent from the worktree: every block below resolves `FORGE_CFG` to the worktree copy if present, else the main checkout's `forge.yaml` (via `git rev-parse --git-common-dir`). Before this, every verification command, learned test command and the SOPS chain check were silently skipped in worktree builds; each step logs `SKIPPED — not configured` when the corresponding key is absent rather than silently passing.

**Track skipped checks** — initialize before any check runs:
```bash
SKIPPED_CHECKS=""

# Verification commands are project configuration; bound each one so a stalled
# formatter, typechecker, or build cannot block validation indefinitely.
# Set FORGEDOCK_VERIFICATION_TIMEOUT_SECONDS to override the 120-second default.
run_verification_command() {
    local label="${1}" command="${2}"
    local timeout_seconds="${FORGEDOCK_VERIFICATION_TIMEOUT_SECONDS:-120}"
    if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
        echo "VERIFY-CONFIG | HIGH | timeout | FORGEDOCK_VERIFICATION_TIMEOUT_SECONDS must be a positive integer (got '$timeout_seconds')"
        return 2
    fi
    timeout "$timeout_seconds" bash -c "$command" 2>&1
    local command_exit=$?
    if [ "$command_exit" -eq 124 ]; then
        echo "VERIFY-TIMEOUT | HIGH | $label | timed out after ${timeout_seconds}s"
    fi
    return "$command_exit"
}
```

**Python**:
```bash
cd {WORKTREE_PATH}
FORGE_CFG=forge.yaml; [ -f "$FORGE_CFG" ] || { _gcd=$(git rev-parse --git-common-dir 2>/dev/null) && _gcd=$(cd "$_gcd" 2>/dev/null && pwd) && [ -f "${_gcd%/.git}/forge.yaml" ] && FORGE_CFG="${_gcd%/.git}/forge.yaml"; }  # gitignored forge.yaml exists only in the main checkout, not in worktrees

PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' "$FORGE_CFG" 2>/dev/null || echo '')
if [ -n "$PYTHON_FORMAT" ]; then
    run_verification_command "python.format" "$PYTHON_FORMAT"
else
    echo "SKIPPED — python.format not configured in verification.commands"
    SKIPPED_CHECKS="${SKIPPED_CHECKS:+$SKIPPED_CHECKS, }python.format"
fi

# Compile check always runs for Python files (no config needed — catches syntax errors)
python -m py_compile {PYTHON_FILES}
```
Failures in `py_compile` are BLOCKING — fix before continuing.

**TypeScript**:
```bash
cd {WORKTREE_PATH}
FORGE_CFG=forge.yaml; [ -f "$FORGE_CFG" ] || { _gcd=$(git rev-parse --git-common-dir 2>/dev/null) && _gcd=$(cd "$_gcd" 2>/dev/null && pwd) && [ -f "${_gcd%/.git}/forge.yaml" ] && FORGE_CFG="${_gcd%/.git}/forge.yaml"; }  # gitignored forge.yaml exists only in the main checkout, not in worktrees

TS_FORMAT=$(yq '.verification.commands.typescript.format // ""' "$FORGE_CFG" 2>/dev/null || echo '')
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' "$FORGE_CFG" 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' "$FORGE_CFG" 2>/dev/null || echo '')

if [ -n "$TS_FORMAT" ]; then
    run_verification_command "typescript.format" "$TS_FORMAT"
else
    echo "SKIPPED — typescript.format not configured in verification.commands"
    SKIPPED_CHECKS="${SKIPPED_CHECKS:+$SKIPPED_CHECKS, }typescript.format"
fi

if [ -n "$TS_TYPECHECK" ]; then
    run_verification_command "typescript.typecheck" "$TS_TYPECHECK"
    TS_EXIT=$?
elif [ -n "$TS_BUILD" ]; then
    TS_OUTPUT=$(run_verification_command "typescript.build" "$TS_BUILD")
    TS_EXIT=$?
    echo "$TS_OUTPUT" | tail -30
else
    echo "SKIPPED — typescript.typecheck and typescript.build not configured in verification.commands"
    SKIPPED_CHECKS="${SKIPPED_CHECKS:+$SKIPPED_CHECKS, }typescript.typecheck/build"
    TS_EXIT=0
fi
```
Typecheck or build failures are BLOCKING — fix type errors before continuing.

**Shell scripts**: Verify service interactions — read target middleware files, document what was verified in the V5 summary.

**Markdown / config files**: No format step required.

If no files match a language category, skip that language's step.

### Known-slow test gate <!-- Added: forge#1861 -->

Before running any test command below, check it against `verification.known_slow_tests` (a repo-declared list of test patterns known to hang or make live network/LLM calls). When absent or empty, this is a no-op and behavior is unchanged.

```bash
cd {WORKTREE_PATH}
FORGE_CFG=forge.yaml; [ -f "$FORGE_CFG" ] || { _gcd=$(git rev-parse --git-common-dir 2>/dev/null) && _gcd=$(cd "$_gcd" 2>/dev/null && pwd) && [ -f "${_gcd%/.git}/forge.yaml" ] && FORGE_CFG="${_gcd%/.git}/forge.yaml"; }  # gitignored forge.yaml exists only in the main checkout, not in worktrees
# Read directly from forge.yaml (static, operator-declared config).
KNOWN_SLOW_TESTS=$(yq -o=json -I=0 '.verification.known_slow_tests // []' "$FORGE_CFG" 2>/dev/null || echo '[]')

# apply_known_slow_filter <cmd> — echoes the command to actually run, or "" to
# skip it entirely. Matching is substring match of `pattern` against the full
# command text. Exactly one of skip/subset is expected per matched entry.
apply_known_slow_filter() {
  local cmd="${1}"
  local out="$cmd"
  if [ -n "$KNOWN_SLOW_TESTS" ] && [ "$KNOWN_SLOW_TESTS" != "[]" ] && [ "$KNOWN_SLOW_TESTS" != "null" ]; then
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      pattern=$(echo "$entry" | yq '.pattern // ""')
      skip=$(echo "$entry" | yq '.skip // false')
      subset=$(echo "$entry" | yq '.subset // ""')
      reason=$(echo "$entry" | yq '.reason // "no reason given"')
      [ -z "$pattern" ] && continue
      case "$cmd" in
        *"$pattern"*)
          if [ "$skip" = "true" ]; then
            echo "SKIPPED — known-slow test matched pattern '$pattern' ($reason)" >&2
            out=""
          elif [ -n "$subset" ]; then
            echo "SUBSTITUTED — known-slow test matched pattern '$pattern' ($reason); running safe subset instead" >&2
            out="$subset"
          fi
          ;;
      esac
    done < <(echo "$KNOWN_SLOW_TESTS" | yq -o=json -I=0 '.[]' 2>/dev/null)
  fi
  echo "$out"
}
```

### Learned test commands <!-- Added: forge#667, forge#1861 -->

After all `verification.commands` steps complete, run any commands from `forge.yaml → learned.test_commands` (captured from owner corrections or set manually), filtered through the known-slow gate above. This phase reads `learned:` itself — no value is passed in from the caller.

```bash
cd {WORKTREE_PATH}
FORGE_CFG=forge.yaml; [ -f "$FORGE_CFG" ] || { _gcd=$(git rev-parse --git-common-dir 2>/dev/null) && _gcd=$(cd "$_gcd" 2>/dev/null && pwd) && [ -f "${_gcd%/.git}/forge.yaml" ] && FORGE_CFG="${_gcd%/.git}/forge.yaml"; }  # gitignored forge.yaml exists only in the main checkout, not in worktrees
LEARNED_TEST_COMMANDS=$(yq -o=json -I=0 '.learned.test_commands // []' "$FORGE_CFG" 2>/dev/null || echo '[]')
LEARNED_FAILED=0
if [ -n "$LEARNED_TEST_COMMANDS" ] && [ "$LEARNED_TEST_COMMANDS" != "[]" ] && [ "$LEARNED_TEST_COMMANDS" != "null" ]; then
  echo "Running learned test commands..."
  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    FILTERED_CMD=$(apply_known_slow_filter "$cmd")
    [ -z "$FILTERED_CMD" ] && continue
    echo "Running learned command: $FILTERED_CMD"
    CMD_OUTPUT=$(run_verification_command "learned.test_commands" "$FILTERED_CMD")
    CMD_EXIT=$?
    echo "$CMD_OUTPUT" | tail -30
    if [ "$CMD_EXIT" -ne 0 ]; then
      echo "FAILED (exit $CMD_EXIT): $FILTERED_CMD"
      LEARNED_FAILED=1
    fi
  done < <(echo "$LEARNED_TEST_COMMANDS" | yq -r '.[]' 2>/dev/null)
else
  echo "No learned test commands configured — skipping"
fi
```

Learned test command failures (`LEARNED_FAILED=1`) are BLOCKING (same as `verification.commands` failures) — fix and re-run. A command matched and skipped by the known-slow gate is never executed and never counted as a failure.

---

## Phase V3: Frontend Proxy Wiring Check

**Skip if**: No TypeScript/TSX files were changed.

Scan all changed client-side files for direct backend calls that bypass the Next.js proxy:

```bash
grep -n "api/v1" {CHANGED_TS_FILES}
grep -n "localhost:" {CHANGED_TS_FILES}
grep -n "127.0.0.1" {CHANGED_TS_FILES}
```

**Rule**: All client-side `fetch`, `useSWR`, `apiFetch`, and `axios` calls MUST use `/api/...` proxy routes. Direct calls to `/api/v1/...` or hardcoded host:port are BLOCKING.

If violations found:
1. Fix them in `{WORKTREE_PATH}`
2. Document fixes in the V5 summary

---

## Phase V3.5: Database Configuration Change Advisory

**Skip if**: No changed Python files contain database engine/session/pool configuration patterns.

When changed files touch database engine configuration, flag for manual connectivity verification. Configuration bugs in `create_async_engine`, `connect_args`, or session factories are invisible to static analysis but cause immediate runtime failures.

```bash
cd {WORKTREE_PATH}
DB_CONFIG_FILES=""
# Process substitution (< <(...)), NOT a piped `| while read`, so DB_CONFIG_FILES
# set inside the loop body survives past the loop (a piped while-read would run
# in a subshell and silently discard the accumulator).
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -qE "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker" "$f" 2>/dev/null && \
        DB_CONFIG_FILES="${DB_CONFIG_FILES}${f}"$'\n'
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')

if [ -n "$DB_CONFIG_FILES" ]; then
    echo "DB CONFIG CHANGE DETECTED in:"
    echo "$DB_CONFIG_FILES"
    echo "ACTION: Verify database connectivity after deploy — changes to engine config, connect_args, or session factories can cause silent runtime failures."
    echo "RECOMMENDED: Run a minimal connectivity test (e.g., SELECT 1) through the modified session/engine path."

    # Check for lambda/callable in connect_args — the exact bug class from PR #14391
    # $DB_CONFIG_FILES is one path per line (built above) — herestring, not a
    # piped `| while read`, so behavior stays consistent with the other fixes
    # in this sweep even though no accumulator is set inside this particular loop.
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        grep -nE "lambda.*:.*['\"]|=lambda" "$f" 2>/dev/null | grep -iE "connect_args|prepared_statement|pool|engine" && \
            echo "WARNING: Lambda/callable in database configuration in $f — verify callback signature matches library's expected calling convention"
    done <<< "$DB_CONFIG_FILES"
fi
```

**This is advisory only** — it does not block the build. The output is included in the V5 summary to alert reviewers and deployers. This check exists because PR #14391 passed `lambda _: ""` to `prepared_statement_name_func` (which expects 0 args), breaking all worker billing. Static analysis cannot catch arity mismatches in library callbacks — the flag ensures a human verifies connectivity.

---

## Phase V3.6: Browser Signal Check

**Skip if**: No TypeScript/TSX files were changed, OR `forge.yaml → services.app_url` is absent or empty.

After static proxy checks, run a lightweight live browser check using Playwright MCP tools to surface console errors, failed network requests, and basic performance metrics for any changed UI routes. This check is advisory — findings are surfaced as warnings in the V5 summary but do NOT block the gate unless the browser session is available AND returns ERROR-level console output.

```bash
cd {WORKTREE_PATH}
FORGE_CFG=forge.yaml; [ -f "$FORGE_CFG" ] || { _gcd=$(git rev-parse --git-common-dir 2>/dev/null) && _gcd=$(cd "$_gcd" 2>/dev/null && pwd) && [ -f "${_gcd%/.git}/forge.yaml" ] && FORGE_CFG="${_gcd%/.git}/forge.yaml"; }  # gitignored forge.yaml exists only in the main checkout, not in worktrees
APP_URL=$(yq '.services.app_url // ""' "$FORGE_CFG" 2>/dev/null || echo '')
if [ -z "$APP_URL" ]; then
    echo "SKIPPED — services.app_url not configured in forge.yaml (browser signal check requires a running app URL)"
else
    echo "BROWSER SIGNAL CHECK: navigating $APP_URL"
fi
```

**When APP_URL is configured**, perform the following using Playwright MCP tools:

**Step 1 — Navigate**
Use `browser_navigate` to load `{APP_URL}`. If the changed files include a specific page route (e.g., `web/src/app/dashboard/page.tsx`), derive the route path and navigate there instead (e.g., `{APP_URL}/dashboard`).

**Step 2 — Capture console messages**
```
browser_console_messages
```
Classify findings:
- Any message at `error` level → **MEDIUM** finding: `BROWSER-CONSOLE-ERROR | MEDIUM | console | {message}`
- Any message at `warn` level → **LOW** advisory: `BROWSER-CONSOLE-WARN | LOW | console | {message}`
- Ignore `info` and `log` levels

**Step 3 — Capture network failures**
```
browser_network_requests filter="static:false"
```
Check for HTTP 4xx and 5xx responses on non-static requests. Exclude known third-party analytics/tracking domains.
- HTTP 4xx or 5xx response → **HIGH** finding: `BROWSER-NETWORK-FAIL | HIGH | network | {url} returned {status}`

**Step 4 — Capture performance metrics (LCP-ish)**
```
browser_evaluate function="() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint');
  const fcp = paint.find(e => e.name === 'first-contentful-paint');
  return {
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadTime: nav ? Math.round(nav.loadEventEnd) : null,
    fcp: fcp ? Math.round(fcp.startTime) : null
  };
}"
```
Classify:
- `loadTime > 4000` ms → **HIGH** finding: `BROWSER-PERF | HIGH | performance | page load time {loadTime}ms exceeds 4s threshold`
- `loadTime > 2500` ms → **MEDIUM** finding: `BROWSER-PERF | MEDIUM | performance | page load time {loadTime}ms exceeds 2.5s threshold`
- `fcp > 1800` ms → **LOW** advisory: `BROWSER-PERF | LOW | performance | FCP {fcp}ms — consider lazy-loading or code splitting`

**Advisory scope**: Browser signal findings are included in the V5 summary under "Browser Signals". They do NOT block the gate (GATE_PASSED stays true) unless a BROWSER-NETWORK-FAIL HIGH finding is present on the primary app URL (indicating the app is completely broken for that route). Console ERROR findings are MEDIUM — surfaced for human review, not blocking.

---

## Phase V4: Deployment Completeness Check

**Skip if**: No new environment variables were introduced in the changed files.

Detect new env vars (staged + unstaged changes versus `HEAD`; the commit has not happened yet, so the diff base is `HEAD`, not `HEAD~1`):
```bash
cd {WORKTREE_PATH}
ADDED_LINES=$(git diff HEAD -- {CHANGED_FILES} | grep -E '^\+' | grep -v '^+++')
{
  # Python: os.environ["VAR"], os.getenv("VAR")
  echo "$ADDED_LINES" | grep -oE 'os\.environ\["[^"]+' | sed 's/^os\.environ\["//'
  echo "$ADDED_LINES" | grep -oE "os\.getenv\([\"']?[A-Z_]+" | sed -E "s/^os\.getenv\([\"']?//"
  # TypeScript: process.env.VAR
  echo "$ADDED_LINES" | grep -oE 'process\.env\.[A-Z_]+' | sed 's/^process\.env\.//'
} | sort -u
```

**Config variables used by this phase** (set in `forge.yaml`):
- `deploy.secrets_backend` — secrets delivery method (`sops`, `aws-sm`, `vault`, `ci-env`, `none`). When absent or not `sops`, SOPS-specific checks below are skipped with an explicit log message.
- `verification.services[name].container` — container name for post-deploy verification. Resolved by matching the service name; falls back to `{service}` (bare name) when not configured.

```bash
cd {WORKTREE_PATH}
FORGE_CFG=forge.yaml; [ -f "$FORGE_CFG" ] || { _gcd=$(git rev-parse --git-common-dir 2>/dev/null) && _gcd=$(cd "$_gcd" 2>/dev/null && pwd) && [ -f "${_gcd%/.git}/forge.yaml" ] && FORGE_CFG="${_gcd%/.git}/forge.yaml"; }  # gitignored forge.yaml exists only in the main checkout, not in worktrees
SECRETS_BACKEND=$(yq '.deploy.secrets_backend // ""' "$FORGE_CFG" 2>/dev/null || echo '')
if [ "$SECRETS_BACKEND" != "sops" ]; then
    echo 'SKIP: SOPS chain check — deploy.secrets_backend is not "sops". Configure deploy.secrets_backend in forge.yaml to enable.'
fi
```

For each new env var found, verify it is present in ALL required locations:

| Location | Required for |
|----------|-------------|
| `.env.example` | All new vars |
| Secrets backend (see `deploy.secrets_backend`) | Secret vars — skip if backend is `none` or unset |
| `app/env_validation.py` | API service vars (if project has one) |
| `docker-compose.prod.yml` | Vars needing explicit injection (if project uses Docker Compose) |

**Secrets backend check** *(trigger: `deploy.secrets_backend == "sops"`)*: verify the new var is present in all SOPS chain locations:
- `infra/secrets/prod.enc.yaml` — SOPS-encrypted secret store
- `infra/decrypt-secrets.sh` ENV_MAPPING — maps SOPS key to env var name
- Deploy chain: SOPS → `decrypt-secrets.sh` (ENV_MAPPING) → `.env.secrets` → `merge-env-secrets.sh` → `.env.production` → docker-compose `env_file`

If any required location is missing the var:
1. Add it to the missing location in `{WORKTREE_PATH}`
2. Document the addition in the V5 summary
3. These additions are NOT new commits — they are absorbed into the single V5 commit

**Operator-set var classification** *(trigger: new env var is NOT in the configured secrets backend)*: <!-- Added: forge#380 -->

Some env vars are operator-set (non-secret, not sourced from the secrets backend) — they must be manually added to the runtime environment on the production server. When a new env var has no entry in the secrets backend, classify it as operator-set and add a **HARD BLOCKER** item to the Testing Checklist (in the FORGE:BUILDER comment).

Resolve the container name for the verification command:
1. Look up the service in `forge.yaml → verification.services[]` by name — use the `container` field if present.
2. If no matching entry, fall back to the bare service name: `{service}` (no suffix).

```
- [ ] HARD BLOCKER: Add {VAR_NAME} to the runtime environment on the production server.
      This var is operator-set — it does NOT flow through the automated secrets chain.
      It must be added manually before or after deploy.
      Verify with: docker exec {CONTAINER_NAME} env | grep {VAR_NAME}
      (CONTAINER_NAME resolved from verification.services[{service}].container in forge.yaml,
       or bare service name if not configured)
```

**`env_file` re-read warning** *(trigger: any new env var added to `.env.production` path)*:

> **Docker `env_file` re-read behavior**: New entries in `.env.production` are only read when a container is **recreated** (e.g., `docker compose up --force-recreate`). A plain `docker restart` restarts the existing container with its frozen env — new `env_file` entries are silently absent. The standard deploy workflow uses `--force-recreate` and handles this correctly. If any out-of-band restart is used, new env vars will not take effect.

Add this warning to the Testing Checklist whenever a new env var is introduced (whether secret or operator-set).

**Post-deploy in-container verification** *(trigger: any new env var)*: add the following to the Testing Checklist so the deployer can confirm delivery after deploy. Resolve `{CONTAINER_NAME}` from `forge.yaml → verification.services[{service}].container`; use `{service}` (bare) if the field is absent.

```bash
# Verify env var reached the running container (run post-deploy)
docker exec {CONTAINER_NAME} env | grep {VAR_NAME}
# Expected: {VAR_NAME}={value}
# If blank: container was not recreated — run: docker compose up --no-deps --force-recreate {service}
```

---

## Phase V5: Marker, Commit, Audit, Complete (always — after GATE_PASSED=true)

Phase V5 runs in this exact order: **(1)** post the `FORGE:QUALITY_GATE` marker, **(2)** commit, **(3)** ancestry audit, **(4)** append `FORGE:BUILDER:COMPLETE` and the verification status. Do not reorder.

### V5 Step 1: Post FORGE:QUALITY_GATE Marker (MANDATORY, before the commit) <!-- Added: forge#3061 -->

The quality gate must leave a checkable artifact. `scripts/verify-phase-trail.sh` (run before PR creation and before auto-merge) requires a `FORGE:QUALITY_GATE` comment with `**Result**: PASS` for every non-docs-only change. Post it after the V1 loop ends, recording the real commands run and their real results. The marker records the staged tree (`**Tree**`) so a PASS from an earlier build commit cannot satisfy the gate for a later one: any edit after the gate requires re-running validate. Do NOT hand-post this marker without having actually run the gate: a marker with no run behind it is a pipeline bypass.

**Skip-path marker**: when the Skip Conditions above set `GATE_PASSED=true` early (single config/docs file), still post the marker with `**Result**: PASS (skipped — single config/docs file)` and `**Iterations**: 0`, so the verifier never has to guess. The verifier's `--docs-only` waiver additionally covers diffs accepted by `scripts/is-docs-only.sh` (allowlisted Markdown only: `docs/**` or root README/CHANGELOG/CONTRIBUTING/SECURITY/GOVERNANCE; nested `AGENTS.md`/`CLAUDE.md`/`SKILL.md`/`GEMINI.md` and the instruction directories `commands/`, `devdocs/`, `templates/`, `skills/`, `agents/`, `hooks/`, `.claude/`, `.claude-plugin/`, `.agents/`, `.codex/`, `.cursor/`, `.github/`, `.opencode/`, `.gemini/`, `.kiro/` excluded; callers feed both sides of renames).

```bash
GATE_RESULT=$([ "$GATE_PASSED" = "true" ] && echo PASS || echo FAIL)
# Bind the PASS to what was actually gated: the staged tree is exactly the tree the V5 commit will have.
# scripts/verify-phase-trail.sh --head-tree (work-on/review.md R1.5) rejects a PASS recorded for a different tree. <!-- Added: forge#3149 -->
git -C {WORKTREE_PATH} add -u   # same staging as the commit below; valid only because V2-V4 are done
GATE_TREE=$(git -C {WORKTREE_PATH} write-tree)
QG_BODY="<!-- FORGE:QUALITY_GATE -->
## Quality Gate Result

**Result**: ${GATE_RESULT}
**Tree**: ${GATE_TREE}
**Iterations**: {N}
**Commands run**: {quality-gate invocation, format/verify commands, test commands actually executed}
**Findings remaining**: {none | summary}"
gh issue comment {NUMBER} {GH_FLAG} --body "$QG_BODY" # allowlist:check-command-side-effects
```

### V5 Step 2: Commit

After the marker is posted, commit all staged changes in a single commit. This includes:
- The implementation changes staged by `implement.md` Phase I4
- Any format, proxy, or deploy fixes applied by phases V2–V4

```bash
cd {WORKTREE_PATH}
git add -u
git commit -s -m "fix({SCOPE}): {description} (#{NUMBER})"
```

Where `{SCOPE}` is the command or module scope from the contract (e.g. `work-on`, `quality-gate`), and `{description}` summarises the implementation. Use the commit convention from the contract:
- Bug Fix → `fix(`
- Feature → `feat(`
- Refactor → `refactor(`
- Docs-only → `docs(`

Reference `#{NUMBER}` in the message. This is the **only** commit for this build cycle. Do NOT create a separate commit for validation fixes — they are absorbed into this single commit.

**Attribution**: The commit message is exactly the conventional-commit line above — nothing more. Do NOT append a `Co-Authored-By: Claude` trailer, a `🤖 Generated with Claude Code` line, or any assistant-tool attribution. Pipeline output is ForgeDock-branded; the assistant signature must never enter the repo's commit history. (A PreToolUse guard hard-blocks it as a backstop — see `bin/hooks/pre-tool-use.mjs` Rule 5.)

### V5 Step 3: Post-Commit Ancestry Audit (MANDATORY)

After committing, run the ancestry audit to detect merge commits that bring in history from outside the PR base before the branch is pushed. Merging `origin/{PR_BASE}` itself into the branch (a base sync) is allowed: every non-first parent of each merge must be an ancestor of `origin/{PR_BASE}`. If `origin/{PR_BASE}` does not exist yet (new branch), skip this check — no contamination is possible from a non-existent base.

```bash
cd {WORKTREE_PATH}
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  git fetch origin {PR_BASE} >/dev/null 2>&1 || true
  # Resolve the shared check from ForgeDock's install root ($FORGE_ROOT, set by the canonical bootstrap when present) or the worktree's own scripts/ (ForgeDock repo itself).
  ANCESTRY_SCRIPT=""
  for _d in "${FORGE_ROOT:-}/scripts" "{WORKTREE_PATH}/scripts"; do [ -f "$_d/check-branch-ancestry.sh" ] && { ANCESTRY_SCRIPT="$_d/check-branch-ancestry.sh"; break; }; done
  if [ -n "$ANCESTRY_SCRIPT" ]; then
    MERGE_COMMITS=$(bash "$ANCESTRY_SCRIPT" HEAD origin/{PR_BASE} 2>&1); ANCESTRY_RC=$?
  else
    # Prose fallback: same checks inline (exit 0 clean, 1 foreign, 2 error). Fails closed: unresolvable refs or git errors give rc=2.
    ANCESTRY_RC=0; MERGE_COMMITS=""
    if ! git rev-parse --verify --quiet "origin/{PR_BASE}^{commit}" >/dev/null 2>&1 || ! git rev-parse --verify --quiet "HEAD^{commit}" >/dev/null 2>&1; then
      ANCESTRY_RC=2
    elif ! MERGES=$(git rev-list --merges origin/{PR_BASE}..HEAD 2>/dev/null) || ! FP=$(git rev-list --first-parent origin/{PR_BASE}..HEAD 2>/dev/null); then
      ANCESTRY_RC=2
    else
      for M in $MERGES; do
        PARENTS=$(git rev-list --parents -n 1 "$M" 2>/dev/null) || { ANCESTRY_RC=2; continue; }
        for P in $(printf '%s\n' "$PARENTS" | cut -d' ' -f3-); do
          git merge-base --is-ancestor "$P" origin/{PR_BASE} 2>/dev/null; rc=$?
          if [ "$rc" -eq 1 ]; then MERGE_COMMITS="${MERGE_COMMITS}${M} ${P}
"; [ "$ANCESTRY_RC" -eq 2 ] || ANCESTRY_RC=1
          elif [ "$rc" -ne 0 ]; then ANCESTRY_RC=2; fi
        done
      done
      # First-parent line must not carry milestone history (branch cut from a milestone, then base sync).
      for F in $(git for-each-ref --format='%(refname)' refs/remotes/origin/milestone/ refs/heads/milestone/ 2>/dev/null); do
        for C in $FP; do
          git merge-base --is-ancestor "$C" "$F" 2>/dev/null; rc=$?
          if [ "$rc" -eq 0 ]; then MERGE_COMMITS="${MERGE_COMMITS}${C} first-parent history reachable from ${F}
"; [ "$ANCESTRY_RC" -eq 2 ] || ANCESTRY_RC=1
          elif [ "$rc" -ne 1 ]; then ANCESTRY_RC=2; fi
        done
      done
    fi
  fi
  if [ "$ANCESTRY_RC" -ne 0 ]; then
    echo "ANCESTRY AUDIT FAILED (rc=$ANCESTRY_RC): merge commits from outside {PR_BASE} detected, or ancestry could not be verified:"
    echo "$MERGE_COMMITS"
    ANCESTRY_BODY="## Ancestry Audit Failed

Branch \`{BRANCH}\` contains merge commits that bring in history from outside the PR base (\`{PR_BASE}\`), or ancestry could not be verified (failing closed). This is a staging contamination risk — these commits may carry code from milestone branches that has not been approved for \`{PR_BASE}\`. Merges of \`{PR_BASE}\` itself are allowed and do not trigger this audit.

**Detected merge commits** (merge, foreign parent, subject — or the verification error):
\`\`\`
${MERGE_COMMITS}
\`\`\`

Human review required before this branch can be pushed.

<!-- FORGE:ANCESTRY_FAILED -->"
    gh issue comment {NUMBER} {GH_FLAG} --body "$ANCESTRY_BODY" # allowlist:check-command-side-effects
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
    echo "ANCESTRY_FAILED=1"
  fi
else
  echo "PR_BASE not on origin — skipping ancestry audit"
fi
```

If the output contains `ANCESTRY_FAILED=1`: do NOT append `:COMPLETE` and do NOT push. Print `VALIDATE_RESULT` with `gate_passed: false` and `blocker: ancestry audit failed — merge commits from outside the PR base` as the final reply, and STOP.

### V5 Step 4: Mark Build Complete and Record Verification Status (MANDATORY)

After the ancestry audit passes (or is skipped), patch the existing FORGE:BUILDER comment: add the `**Verification Status**` line, the best-effort `cost_usd:` line, and the `<!-- FORGE:BUILDER:COMPLETE -->` marker. This is the **only** place the marker is written — it signals that a real commit exists on the branch and the build is safe to resume-skip. <!-- Added: forge#1305 -->

`SKIPPED_CHECKS` comes from Phase V2. Shell state may not persist between Bash calls, so set it here from your V2 notes before running the block (comma-separated check names, empty when every configured check ran).

**Cost line reconciliation**: the machine-readable `cost_usd:` line (best-effort; only when `PHASE_COST_USD` is available, never blocking) is the single cost signal. Do not add a separate `**Cost (build phase)**` line.

```bash
# SKIPPED_CHECKS: set from the V2 notes, e.g. SKIPPED_CHECKS="python.format, typescript.typecheck/build"
SKIPPED_CHECKS="${SKIPPED_CHECKS:-}"
if [ -z "$SKIPPED_CHECKS" ]; then
  VERIFICATION_STATUS="✅ All configured verification commands passed"
else
  VERIFICATION_STATUS="⚠ Verification NOT run: ${SKIPPED_CHECKS} — verification.commands not configured for these checks"
fi

# Find the FORGE:BUILDER comment posted by implement.md Phase I6
BUILDER_COMMENT_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:BUILDER") and (contains("FORGE:BUILDER:COMPLETE") | not))] | last | .id // ""')

if [ -n "$BUILDER_COMMENT_ID" ]; then
  CURRENT_BODY=$(gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID --jq '.body')
  # Insert the Verification Status line after the "**Files changed**" line (idempotent).
  if printf '%s' "$CURRENT_BODY" | grep -q '^\*\*Verification Status\*\*'; then
    PATCHED_BODY="$CURRENT_BODY"
  else
    PATCHED_BODY=$(printf '%s\n' "$CURRENT_BODY" | awk -v vs="**Verification Status**: ${VERIFICATION_STATUS}" \
      '{print} /^\*\*Files changed\*\*/ && !done {print vs; done=1}')
  fi
  # Best-effort cost append: only include if session telemetry provides a value; never block
  PHASE_COST_LINE=""
  [ -n "${PHASE_COST_USD:-}" ] && PHASE_COST_LINE="
cost_usd: ${PHASE_COST_USD}"
  UPDATED_BODY="${PATCHED_BODY}${PHASE_COST_LINE}

<!-- FORGE:BUILDER:COMPLETE -->"
  gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID \
    -X PATCH \
    --field body="$UPDATED_BODY"
  echo "FORGE:BUILDER:COMPLETE appended to comment $BUILDER_COMMENT_ID"
else
  echo "WARNING: FORGE:BUILDER comment not found or already marked complete — skipping BUILDER:COMPLETE append"
fi
```

**Why here and not in implement.md**: The commit (`git commit`) runs in Step 2. Appending `:COMPLETE` after the commit and ancestry audit ensures that a session crash between implement.md I6 (comment posted) and this step leaves a partial BUILDER comment without `:COMPLETE`. The next resume will detect the partial comment, delete it, and restart the build. See `implement.md § Phase I1 resume check`.

---

## Output

The final reply is exactly one `VALIDATE_RESULT:` block — on every exit path (success, skip path, and every failure):

```
VALIDATE_RESULT:
  gate_passed: true | false
  quality_gate_iterations: {COUNT}
  format_issues_fixed: {COUNT}
  proxy_violations_fixed: {COUNT}
  deploy_completeness_fixes: [{VAR_NAME: location_added}, ...]
  commits_added: [{SHA}, ...]  # from V5 if any
  blocker: {description if gate_passed=false}
  verification_skipped: []  # empty when all configured checks ran; list of skipped check names otherwise
                            # e.g. ["python.format", "typescript.typecheck/build"]
                            # populated from SKIPPED_CHECKS in Phase V2
```

---

## Integration Point

This module is invoked by `work-on:build` after implement and before review:

```
implement (work-on:build:implement) — code written, staged (not committed), FORGE:BUILDER posted
  → [THIS MODULE] validate
      V0 self-check → V1 quality-gate loop (Skill quality-gate, forked) → V2 format/verify + known-slow/learned tests
      → V3 proxy wiring → V3.5 DB advisory → V3.6 browser signals → V4 deploy completeness
      → V5 marker → commit → ancestry audit → BUILDER:COMPLETE
review (work-on:review) — push, PR, merge
```

If `VALIDATE_RESULT: gate_passed: false`, the build skill reports BLOCKED (`needs-human` is set) and no PR is created.
