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

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

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
        Fix each HIGH and MEDIUM finding in the code at {WORKTREE_PATH}
        (Do NOT commit yet — fixes are staged for the next gate run)

if iteration == max_iterations AND result != PASS:
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
git diff HEAD~1 -- {CHANGED_FILES} | grep -oP '(?<=os\.environ\[")[^"]+|(?<=os\.getenv\()["\']?[A-Z_]+' | sort -u
# Also check TypeScript:
git diff HEAD~1 -- {CHANGED_FILES} | grep -oP 'process\.env\.\K[A-Z_]+' | sort -u
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
                            # e.g. ["python.format", "typescript.typecheck/build"]
                            # populated from SKIPPED_CHECKS in Phase V2
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
