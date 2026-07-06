---
description: Validation agent — quality gate loop, format/verify, proxy check, deploy check
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--worktree PATH] [--files FILE1 FILE2...]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/validate — Validation Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Step 3F.5, after `implement.md` has written and staged code (not committed).
**Output**: Return `GATE_PASSED: true/false` to caller. On failure after max iterations, post comment and set `needs-human`.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/build/validate.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree
- `--files {CHANGED_FILES}` — space-separated list of changed files (from implement result)

---

## Skip Conditions

Skip all phases (return `GATE_PASSED: true` immediately) if:
- Only 1 file was changed AND it is a config or docs file with no code logic (e.g. `.md`, `.yml` with no scripts, `.env.example`)

In all other cases, the gate MUST run.

---

## Phase V1: Quality Gate Loop

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
    → return GATE_PASSED: false to caller, STOP
```

**Quality gate invocation**:
```
Skill("quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
```

**Rules**:
- Re-run after EVERY fix pass — never trust that fixes resolved findings without verification
- Each iteration re-scans ALL changed files — fixes can introduce new issues
- Only HIGH and MEDIUM findings must be fixed; LOW findings are advisory only
- `TEST-QUARANTINE | LOW` findings (pre-broken or flaky tests classified by Step 2R) do **not** require fixing and do **not** count toward gate failure — include them in the V5 commit comment for reviewer visibility

**V1-FAIL comment** (post when gate never passes):
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Quality Gate Failed After 3 Iterations

Quality gate findings persist after 3 fix passes. Flagging for human review.

**Files**: {CHANGED_FILES}
**Final findings**: {SUMMARY_OF_REMAINING_FINDINGS}

Needs human review before proceeding to commit.

<!-- FORGE:GATE_FAILED -->"
```

---

## Phase V2: Format and Verify

Run after quality gate passes. All tool commands are read from `forge.yaml → verification.commands`; each step logs `SKIPPED — not configured` when the corresponding key is absent rather than silently passing.

**Track skipped checks** — initialize before any check runs:
```bash
SKIPPED_CHECKS=""
```

**Python**:
```bash
cd {WORKTREE_PATH}

PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
if [ -n "$PYTHON_FORMAT" ]; then
    eval "$PYTHON_FORMAT" 2>&1
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

TS_FORMAT=$(yq '.verification.commands.typescript.format // ""' forge.yaml 2>/dev/null || echo '')
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$TS_FORMAT" ]; then
    eval "$TS_FORMAT" 2>&1
else
    echo "SKIPPED — typescript.format not configured in verification.commands"
    SKIPPED_CHECKS="${SKIPPED_CHECKS:+$SKIPPED_CHECKS, }typescript.format"
fi

if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1
    TS_EXIT=$?
elif [ -n "$TS_BUILD" ]; then
    eval "$TS_BUILD" 2>&1 | tail -30
    TS_EXIT=$?
else
    echo "SKIPPED — typescript.typecheck and typescript.build not configured in verification.commands"
    SKIPPED_CHECKS="${SKIPPED_CHECKS:+$SKIPPED_CHECKS, }typescript.typecheck/build"
    TS_EXIT=0
fi
```
Typecheck or build failures are BLOCKING — fix type errors before continuing.

**Test suite** (stack-agnostic — runs every configured `verification.commands.<lang>.test`):

<!-- Added: forge#1605 -->

This is a direct, blocking backstop — unlike `quality-gate.md` Step 2T/2S, it does not classify a failure as pre-existing/flaky vs. real; it simply blocks, exactly like the `py_compile`/typecheck checks above. Runs whenever this phase runs (the module-level Skip Conditions above already exclude 1-file config/docs-only changes).

```bash
cd {WORKTREE_PATH}

TEST_LANGS=$(yq '.verification.commands // {} | keys | .[]' forge.yaml 2>/dev/null || echo '')

if [ -z "$TEST_LANGS" ]; then
    echo "SKIPPED — verification.commands not configured in forge.yaml (no test key to run)"
else
    while IFS= read -r LANG; do
        [ -z "$LANG" ] && continue
        TEST_CMD=$(yq ".verification.commands.${LANG}.test // \"\"" forge.yaml 2>/dev/null || echo '')

        if [ -z "$TEST_CMD" ]; then
            echo "SKIPPED — ${LANG}.test not configured in verification.commands"
            SKIPPED_CHECKS="${SKIPPED_CHECKS:+$SKIPPED_CHECKS, }${LANG}.test"
            continue
        fi

        echo "Running ${LANG}.test: $TEST_CMD"
        (cd {WORKTREE_PATH} && eval "$TEST_CMD") 2>&1
        TEST_EXIT=$?

        if [ "$TEST_EXIT" -ne 0 ]; then
            echo "TEST SUITE FAILED (${LANG}): exit $TEST_EXIT"
            TEST_FAILURES="${TEST_FAILURES:+$TEST_FAILURES, }${LANG}"
        fi
    done <<< "$TEST_LANGS"
fi
```

**Test failures are BLOCKING**:
- If the failure is caused by the change just made in this build (a broken test in a changed module): fix it in `{WORKTREE_PATH}` and re-run this step before continuing.
- If the failure cannot be resolved in-place (e.g. it appears unrelated to this change): do NOT silently pass. Escalate exactly like V1-FAIL — post a `## Test Suite Failed` comment naming `$TEST_FAILURES` and the failing command(s), add `needs-human`, set `GATE_PASSED: false`, and STOP.

**JS/Node syntax + entrypoint boot smoke** (JS analogue of `py_compile` above — universal, direct blocking backstop mirroring the test-suite pairing with `quality-gate.md` Step 2T/2S above):

<!-- Added: forge#1606 -->

```bash
cd {WORKTREE_PATH}

JS_FILES=$(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.(mjs|js)$')

if [ -z "$JS_FILES" ]; then
    echo "SKIPPED — no .mjs/.js files changed (no runtime surface for this check)"
else
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        node --check "$f" 2>&1
        if [ $? -ne 0 ]; then
            echo "NODE --CHECK FAILED: $f"
            JS_SYNTAX_FAILURES="${JS_SYNTAX_FAILURES:+$JS_SYNTAX_FAILURES, }$f"
        fi
    done <<< "$JS_FILES"
fi
```
`node --check` failures are BLOCKING — fix the syntax error before continuing (same treatment as a `py_compile` failure above).

Entrypoint **load smoke** runs additionally when a changed `.mjs`/`.js` file is a declared CLI entrypoint (`package.json → bin` target, auto-detected; or `forge.yaml → verification.entrypoints[].files`), OR this build's own `FORGE:CONTRACT` comment declares `**Task type**: Refactor` (a refactor of any changed file, not just entrypoints, is exactly the class of change that produced the #1500/#1578 import-time crash this check targets):

```bash
cd {WORKTREE_PATH}

# Resolve declared entrypoints: package.json bin targets + forge.yaml verification.entrypoints
BIN_TARGETS=""
if [ -f package.json ]; then
    BIN_TARGETS=$(node -e '
        try {
            const pkg = require(process.argv[1]);
            const bin = pkg.bin;
            if (!bin) process.exit(0);
            const vals = typeof bin === "string" ? [bin] : Object.values(bin);
            console.log(vals.join("\n"));
        } catch (e) {}
    ' "$(pwd)/package.json" 2>/dev/null || true)
fi
FORGE_ENTRYPOINTS=$(yq '.verification.entrypoints[].files[]' forge.yaml 2>/dev/null | grep -v '^null$' || true)
ALL_ENTRYPOINTS=$(printf '%s\n%s\n' "$BIN_TARGETS" "$FORGE_ENTRYPOINTS" | grep -v '^[[:space:]]*$' | sort -u)

# Refactor signal — this build's own FORGE:CONTRACT comment (already posted by build.md
# Phase B2 before this validate phase ever runs) declares the task type.
IS_REFACTOR=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' 2>/dev/null | grep -iE '\*\*Task type\*\*:[[:space:]]*Refactor' || true)

SMOKE_TARGETS=""
IFS=' ' read -ra CHANGED_FILES_ARR <<< "{CHANGED_FILES}"
for f in "${CHANGED_FILES_ARR[@]}"; do
    case "$f" in
        *.mjs|*.js)
            if echo "$ALL_ENTRYPOINTS" | grep -qxF "$f" || [ -n "$IS_REFACTOR" ]; then
                SMOKE_TARGETS="${SMOKE_TARGETS}${f}"$'\n'
            fi
            ;;
    esac
done

if [ -z "$SMOKE_TARGETS" ]; then
    echo "SKIPPED — no declared entrypoint or refactor-flagged .mjs/.js files in this change (no boot smoke required)"
else
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        SMOKE_CMD=$(yq ".verification.entrypoints[] | select(.files[] == \"$f\") | .command" forge.yaml 2>/dev/null | grep -v '^null$' | head -1)
        [ -z "$SMOKE_CMD" ] && SMOKE_CMD="node $f --help"
        echo "Running load smoke for $f: $SMOKE_CMD"
        SMOKE_OUTPUT=$(eval "$SMOKE_CMD" 2>&1)
        SMOKE_EXIT=$?
        if [ "$SMOKE_EXIT" -ne 0 ]; then
            echo "ENTRYPOINT SMOKE FAILED ($SMOKE_EXIT): $f"
            echo "$SMOKE_OUTPUT"
            ENTRYPOINT_FAILURES="${ENTRYPOINT_FAILURES:+$ENTRYPOINT_FAILURES, }$f"
        fi
    done <<< "$SMOKE_TARGETS"
fi
```

**Entrypoint smoke failures are BLOCKING**:
- If the failure is caused by the change just made in this build: fix it in `{WORKTREE_PATH}` and re-run this step before continuing.
- If it cannot be resolved in-place: escalate exactly like the test-suite failure above — post a `## Entrypoint Smoke Failed` comment naming `$ENTRYPOINT_FAILURES` and the failing command(s), add `needs-human`, set `GATE_PASSED: false`, and STOP.

Docs/config-only changes (a diff containing no `.mjs`/`.js` files) never reach either block above — `JS_FILES`/`SMOKE_TARGETS` are empty and both log `SKIPPED`, matching the module's own Skip Conditions for pure docs/config edits.

**Shell scripts**: Verify service interactions — read target middleware files, document what was verified in V4 summary.

**Markdown / config files**: No format step required.

If no files match a language category, skip that language's step.

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
2. Document fixes in V4 summary

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

## Phase V4: Deployment Completeness Check

**Skip if**: No new environment variables were introduced in the changed files.

Detect new env vars:
```bash
cd {WORKTREE_PATH}
# Portable (POSIX ERE) — no grep -P / PCRE lookbehind required
git diff HEAD~1 -- {CHANGED_FILES} \
  | grep -oE 'os\.environ\["[A-Z_]+"[^"]*|os\.getenv\(["\'"'"']?[A-Z_]+' \
  | sed "s/os\.environ\[\"//;s/os\.getenv(['\"]*//" \
  | grep -oE '^[A-Z_]+' | sort -u
# Also check TypeScript (portable):
git diff HEAD~1 -- {CHANGED_FILES} \
  | grep -oE 'process\.env\.[A-Z_]+' \
  | sed 's/process\.env\.//' | sort -u
```

For each new env var found, verify it is present in ALL required locations:

| Location | Required for |
|----------|-------------|
| `.env.example` | All new vars |
| `infra/secrets/prod.enc.yaml` (SOPS) | Production secrets |
| `infra/decrypt-secrets.sh` ENV_MAPPING | All vars in deploy chain |
| `app/env_validation.py` | API service vars |
| `docker-compose.prod.yml` | Vars needing explicit injection |

**Deploy chain**: SOPS → `decrypt-secrets.sh` (ENV_MAPPING) → `.env.secrets` → `merge-env-secrets.sh` → `.env.production` → docker-compose `env_file`.

If any required location is missing the var:
1. Add it to the missing location in `{WORKTREE_PATH}`
2. Document the addition in V4 summary
3. These additions are NOT new commits — they should be staged and committed together with any other pending fixes, or as a separate commit if clean

---

## Phase V5: Commit (always — after GATE_PASSED=true)

After the gate passes, commit all staged changes in a single commit. This includes:
- The implementation changes staged by `implement.md` Phase I4
- Any format, proxy, or deploy fixes applied by phases V2–V4

```bash
cd {WORKTREE_PATH}
git add -u
git commit -s -m "fix({SCOPE}): {description} (#NUMBER)"
```

Where `{SCOPE}` is the command or module scope from the contract (e.g. `work-on`, `quality-gate`), and `{description}` summarises the implementation. Use the commit convention from the contract:
- Bug Fix → `fix(`
- Feature → `feat(`
- Refactor → `refactor(`

This is the **only** commit for this build cycle. It replaces the old `git commit` that was previously in `implement.md` Phase I4. Do NOT create a separate commit for validation fixes — they are absorbed into this single commit.

### V5 Post-Commit Ancestry Audit (MANDATORY)

After committing, run the ancestry audit to detect merge commits from unrelated branches before the branch is pushed:

```bash
cd {WORKTREE_PATH}
MERGE_COMMITS=$(git log --merges HEAD ^origin/{PR_BASE} 2>/dev/null)
if [ -n "$MERGE_COMMITS" ]; then
  echo "ANCESTRY AUDIT FAILED: merge commits from unrelated branches detected on this branch:"
  echo "$MERGE_COMMITS"
  # Block push — do NOT proceed to review.md R1
  gh issue comment {NUMBER} {GH_FLAG} --body "## Ancestry Audit Failed

Branch \`{BRANCH}\` contains merge commits from branches outside the PR base (\`{PR_BASE}\`). This is a staging contamination risk — these commits may carry code from milestone branches that has not been approved for \`{PR_BASE}\`.

**Detected merge commits**:
\`\`\`
${MERGE_COMMITS}
\`\`\`

Human review required before this branch can be pushed.

<!-- FORGE:ANCESTRY_FAILED -->"
  gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
  # Return GATE_PASSED: false — do not push
  exit 1
fi
```

If `origin/{PR_BASE}` does not exist yet (new branch), skip this check — no contamination is possible from a non-existent base. Detect with:
```bash
git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1 || echo "PR_BASE not on origin — skipping ancestry audit"
```

### V5 Post-Commit: Mark Build Complete (MANDATORY)

After the ancestry audit passes (or is skipped), append `<!-- FORGE:BUILDER:COMPLETE -->` to the existing FORGE:BUILDER comment. This is the **only** place this marker is written — it signals that a real commit exists on the branch and the build is safe to resume-skip. <!-- Added: forge#1305 -->

```bash
# Find the FORGE:BUILDER comment posted by implement.md Phase I6
BUILDER_COMMENT_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:BUILDER") and (contains("FORGE:BUILDER:COMPLETE") | not))] | last | .id // ""')

if [ -n "$BUILDER_COMMENT_ID" ]; then
  # Fetch current body and append the completion marker plus best-effort cost signal
  CURRENT_BODY=$(gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID --jq '.body')
  # Best-effort cost append: only include if session telemetry provides a value; never block
  PHASE_COST_LINE=""
  [ -n "${PHASE_COST_USD:-}" ] && PHASE_COST_LINE="
cost_usd: ${PHASE_COST_USD}"
  UPDATED_BODY="${CURRENT_BODY}${PHASE_COST_LINE}

<!-- FORGE:BUILDER:COMPLETE -->"
  gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID \
    -X PATCH \
    --field body="$UPDATED_BODY"
  echo "FORGE:BUILDER:COMPLETE appended to comment $BUILDER_COMMENT_ID"
else
  echo "WARNING: FORGE:BUILDER comment not found or already marked complete — skipping BUILDER:COMPLETE append"
fi
```

**Why here and not in implement.md**: The commit (`git commit`) runs in this phase (V5). Appending `:COMPLETE` after the commit ensures that a session crash between implement.md I6 (comment posted) and this step (commit) leaves a partial BUILDER comment without `:COMPLETE`. The next resume will detect the partial comment, delete it, and restart the build. See `implement.md § Phase I1 resume check`.

---

## Output

Return structured output to the caller:

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
                            # e.g. ["python.format", "typescript.typecheck/build", "rust.test"]
                            # populated from SKIPPED_CHECKS in Phase V2
  test_failures: []         # empty when all configured verification.commands.*.test runs passed;
                            # list of language keys whose test command exited non-zero otherwise
                            # (e.g. ["python", "go"]) — populated from TEST_FAILURES in Phase V2.
                            # Any non-empty value here means gate_passed: false and blocker is set.
  js_syntax_failures: []    # empty when node --check passed for every changed .mjs/.js file;
                            # list of file paths that failed otherwise — populated from
                            # JS_SYNTAX_FAILURES in Phase V2. Non-empty means gate_passed: false.
  entrypoint_smoke_failures: []  # empty when every declared-entrypoint/refactor-flagged
                            # .mjs/.js file's load smoke exited 0; list of file paths that
                            # failed otherwise — populated from ENTRYPOINT_FAILURES in Phase
                            # V2. Non-empty means gate_passed: false. <!-- Added: forge#1606 -->
```

---

## Integration Point in work-on.md

This module runs at **Step 3F.5** — after implement, before commit (3J) and PR creation (Phase 4):

```
3F  → Implement (by implement.md) — code written, staged (not committed)
3F.5 → [THIS MODULE] Validate — gate loop, format, proxy, deploy checks
3G  → (covered by Phase V2 above)
3H  → (covered by Phase V3 above)
3I  → (covered by Phase V4 above)
3J  → V5 commit happens here after GATE_PASSED=true (single commit for implementation + any fixes)
```

If `VALIDATE_RESULT: gate_passed: false`, the router adds `needs-human` label and stops — no PR is created.
