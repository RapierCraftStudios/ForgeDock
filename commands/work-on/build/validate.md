---
description: Validation agent — quality gate loop, format/verify, proxy check, deploy check
argument-hint: "[issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--worktree PATH] [--files FILE1 FILE2...]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/validate — Validation Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Step 3F.5, after `implement.md` has written and staged code (not committed).
**Output**: Return `GATE_PASSED: true/false` to caller. On failure after max iterations, post comment and set `needs-human`.

Agent policy: see `commands/shared/agent-policies.md` (default-tier model resolution + plan-mode ban) if not already in context.

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

## Phase V1: Builder Self-Check — Wire-Through Proof (MANDATORY, run BEFORE quality gate loop)

Before invoking the quality gate, the builder MUST perform a self-check on newly added conditional paths. This mirrors the quality gate's 2G.8 check and allows the builder to resolve gaps before the gate invocation rather than after.

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

**Why this matters**: Guards, flags, and validators that are never exercised are functionally dead code. This class has cost multiple sprint cycles in this pipeline (#1230, #1244, #1522, #1580). The self-check catches gaps before the quality gate fires, reducing iteration count.

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

## Phase V3.6: Browser Signal Check

**Skip if**: No TypeScript/TSX files were changed, OR `forge.yaml → services.app_url` is absent or empty.

After static proxy checks, run a lightweight live browser check using Playwright MCP tools to surface console errors, failed network requests, and basic performance metrics for any changed UI routes. This check is advisory — findings are surfaced as warnings in the V5 summary but do NOT block the gate unless the browser session is available AND returns ERROR-level console output.

```bash
cd {WORKTREE_PATH}
APP_URL=$(yq '.services.app_url // ""' forge.yaml 2>/dev/null || echo '')
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

**Attribution**: The commit message is exactly the conventional-commit line above — nothing more. Do NOT append a `Co-Authored-By: Claude` trailer, a `🤖 Generated with Claude Code` line, or any assistant-tool attribution. Pipeline output is ForgeDock-branded; the assistant signature must never enter the repo's commit history. (A PreToolUse guard hard-blocks it as a backstop — see `bin/hooks/pre-tool-use.mjs` Rule 5.)

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

After the ancestry audit passes (or is skipped), append `<!-- FORGE:BUILDER:COMPLETE -->` to the existing FORGE:BUILDER comment. This is the **only** place this marker is written — it signals that a real commit exists on the branch and the build is safe to resume-skip.

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

## Phase V5.1: Auto-ADR Extraction (transactional with PR)

**Goal**: Promote tradeoff-shaped decisions from the just-posted `FORGE:BUILDER` comment's `### Approach`
section into human-readable, git-tracked ADR markdown files at `devdocs/decisions/NNN-{slug}.md` —
committed into the **same worktree, before push** so the files ride the issue's own PR diff and are
reviewed and merged exactly like any other change. Architect plans on future runs load matching ADRs
as constraints before writing any code.

**Historical note**: this step previously ran in `close.md` Phase C5.4, *after* the PR
had already merged (`close.md` is invoked with `--pr {PR_NUMBER}` = the merged PR number). Writing
ADR files that late meant the "commit" (if it even succeeded) landed on a worktree that Phase C6
deletes moments later — an unreachable local commit, never pushed, never part of any diff. That is
the exact "written but uncommitted" failure this phase closes. Extraction now happens here, before
`{BRANCH}` is ever pushed to `origin`, so there is no post-merge path left that can orphan a file.

**This phase is non-blocking** — if ADR extraction, file write, or commit fails at any step, log the
reason and continue to Phase V5's ancestry audit / Phase 4 push. Never block the build on ADR
generation.

**Skip if**: `devdocs/decisions/` directory does not exist in the repository root (feature not
installed) OR a `<!-- FORGE:ADR_EXTRACTED -->` comment already exists on the issue (idempotency
guard — covers resumed/re-run builds).

### Step 1: Idempotency check

```bash
ADR_EXTRACTED=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:ADR_EXTRACTED"))] | length > 0' 2>/dev/null || echo "false")
DECISIONS_DIR="{WORKTREE_PATH}/devdocs/decisions"

if [ "$ADR_EXTRACTED" = "true" ] || [ ! -d "$DECISIONS_DIR" ]; then
  echo "[ADR] Skipping — already extracted for this issue, or devdocs/decisions/ not installed"
else
  : # continue to Step 2
fi
```

### Step 2: Extract tradeoff-shaped text from FORGE:BUILDER's Approach section

Source is the `FORGE:BUILDER` comment posted by `implement.md` Phase I6 (already on the issue by
this point) — not `FORGE:TRAJECTORY`, which does not exist yet this early in the pipeline.

```bash
APPROACH_TEXT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:BUILDER") and (contains("FORGE:BUILDER:COMPLETE") | not))] | last | .body // ""' \
  2>/dev/null | sed -n '/^### Approach$/,/^### /p' | sed '1d;$d')

if [ -z "$APPROACH_TEXT" ]; then
  echo "[ADR] No Approach text found on FORGE:BUILDER comment — skipping ADR extraction"
  ADR_FILES_WRITTEN=0
fi
```

### Step 3: Filter for tradeoff shape and write ADR file(s)

Same tradeoff heuristic as before (a choice keyword AND a rationale keyword must both be present) —
only ported to a single Approach paragraph instead of a bulleted Decisions list, so it is evaluated
once per build rather than once per bullet.

```bash
ADR_FILES_WRITTEN=0

if [ -n "$APPROACH_TEXT" ] && [ -d "$DECISIONS_DIR" ]; then
  CHOICE_MATCH=$(echo "$APPROACH_TEXT" | grep -iE 'chose|chosen|opted|decided|instead of|rather than|over ' || true)
  RATIONALE_MATCH=$(echo "$APPROACH_TEXT" | grep -iE 'because|since[[:space:]]|so[[:space:]]|to avoid|prevents|due to' || true)

  if [ -z "$CHOICE_MATCH" ] || [ -z "$RATIONALE_MATCH" ]; then
    echo "[ADR] Skipped (not a tradeoff): $APPROACH_TEXT"
  else
    COMMIT_SHA=$(git -C {WORKTREE_PATH} rev-parse HEAD 2>/dev/null || echo "unknown")
    # Anchor: first backtick-quoted path-like string in the Approach text — same extraction
    # as the original close.md logic. architect.md Phase A1.5 reads this field directly
    # (`grep "^anchor:"`) and `continue`s past any ADR where it's empty, so a missing anchor
    # here means the file is silently never matched/injected by future architect runs.
    ANCHOR_PATH=$(echo "$APPROACH_TEXT" | grep -oE '`[a-zA-Z][^`]*/[^`]+`' | head -1 | tr -d '`' || true)
    SLUG=$(echo "$APPROACH_TEXT" | tr '[:upper:]' '[:lower:]' | \
      sed 's/[^a-z0-9 ]/ /g' | tr -s ' ' '-' | cut -c1-40 | sed 's/-$//')
    ADR_FILENAME="{NUMBER}-${SLUG}.md"
    ADR_PATH="$DECISIONS_DIR/$ADR_FILENAME"

    if [ -f "$ADR_PATH" ]; then
      echo "[ADR] Already exists — skipping: $ADR_FILENAME"
      ADR_FILES_WRITTEN=$((ADR_FILES_WRITTEN + 1))
    else
      cat > "$ADR_PATH" <<ADR_EOF
---
issue: {NUMBER}
pr: pending
commit: ${COMMIT_SHA}
status: fresh
anchor: ${ANCHOR_PATH:-unknown}
created: $(date -u +%Y-%m-%d)
---

# ADR — ${APPROACH_TEXT}

## Decision

${APPROACH_TEXT}

## Context

Auto-extracted from the FORGE:BUILDER comment's Approach section on issue #{NUMBER}.

**Citations**:
- Issue: https://github.com/{GH_REPO}/issues/{NUMBER}
- Commit: ${COMMIT_SHA}
- Anchor: \`${ANCHOR_PATH:-no file anchor found}\`

## Status

\`fresh\` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files (see `architect.md` Phase A1.5 — it reads the
`anchor:` frontmatter field directly, and skips any ADR where it is empty).

Set \`status: needs-review\` manually (or the staleness pass in \`build-knowledge-index.mjs\` will
flip it automatically) when the anchored code region no longer exists.
ADR_EOF
      echo "[ADR] Written: $ADR_FILENAME"
      ADR_FILES_WRITTEN=$((ADR_FILES_WRITTEN + 1))
    fi
  fi
fi
```

The `pr: pending` frontmatter field is intentional — the PR does not exist yet at this point in the
pipeline (PR creation is Phase 4, still ahead). `close.md` Phase C3/C6.5 back-fills the real PR
number into any ADR frontmatter matching this issue once the PR is known (see below).

### Step 4: Commit ADR files into the same worktree, before push (MANDATORY — this is the transactional step)

```bash
if [ "$ADR_FILES_WRITTEN" -gt 0 ]; then
  cd {WORKTREE_PATH}
  git add devdocs/decisions/*.md 2>/dev/null || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -s -m "docs(decisions): auto-ADR from build decisions (#{NUMBER})" \
      && echo "[ADR] Committed ${ADR_FILES_WRITTEN} ADR file(s) — will ride PR #{NUMBER}'s diff on push" \
      || echo "[ADR] WARNING: commit failed — ADR file(s) written but not committed (non-blocking; will surface as an uncommitted diff for V5's ancestry audit to catch)"
  else
    echo "[ADR] No staged changes — ADR file(s) already committed"
  fi
fi
```

Because this runs **before** Phase 4B's `git push`, a successful commit here is pushed with every
other commit on `{BRANCH}` and appears in the PR diff exactly like the implementation change itself
— it is reviewed, and it merges (or doesn't) atomically with the rest of the PR. There is no
worktree-deletion window between "committed" and "pushed": Phase 6E's worktree cleanup does not run
until long after this branch is on `origin` and merged.

### Step 5: Post audit annotation

```bash
if [ "${ADR_FILES_WRITTEN:-0}" -gt 0 ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ADR_EXTRACTED -->
${ADR_FILES_WRITTEN} ADR file(s) auto-extracted from the build's Approach decision and committed to
\`devdocs/decisions/\` on branch \`{BRANCH}\` — they ride this issue's own PR diff (transactional:
forge#2687) rather than being written after merge.

Future architect runs will load matching ADRs as constraints when anchor paths overlap contract files.

ADRs are human-editable — update or remove them as the codebase evolves. The staleness pass in
\`build-knowledge-index.mjs\` automatically flips \`status: needs-review\` when an anchor is dead.

<!-- FORGE:ADR_EXTRACTED:COMPLETE -->" 2>/dev/null || true
else
  echo "[ADR] No tradeoff-shaped decision found in Approach text — no ADR files written"
fi
```

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
  commits_added: [{SHA}, ...]  # from V5 (and V5.1's ADR commit, if any)
  adr_files_written: {COUNT}  # from V5.1, 0 if none
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
3F.5 → [THIS MODULE] Validate — gate loop, format, proxy, browser signals, deploy checks
3G  → (covered by Phase V2 above)
3H  → (covered by Phase V3 above)
3H.5 → (covered by Phase V3.6 above — browser signal check for UI changes)
3I  → (covered by Phase V4 above)
3J  → V5 commit happens here after GATE_PASSED=true (single commit for implementation + any fixes)
```

If `VALIDATE_RESULT: gate_passed: false`, the router adds `needs-human` label and stops — no PR is created.
