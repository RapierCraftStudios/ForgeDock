---
user-invocable: false
description: Implementation agent — writes code, makes commits, posts builder comment
argument-hint: "{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE} --branch {BRANCH} --base {PR_BASE} [--fix-acceptance \"<failed checks>\"]"
context: fork
background: false
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/implement — Implementation Subcommand

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

**Invoked by**: `work-on:build`, after the worktree is created and context is gathered. This skill runs in an isolated forked context: it sees only this text and its args, so it re-reads all other state from GitHub/git.
**Output**: Write code, stage changes, post `<!-- FORGE:BUILDER -->` comment, and end with exactly one `IMPLEMENT_RESULT:` block as the final reply.

**Result-on-every-exit rule**: every exit path — success, `ALREADY_DONE`, `INVESTIGATION_COMPLETE`, every guard, every failure — MUST print the `IMPLEMENT_RESULT:` block (see Output) as the final reply. Never exit with a bare `exit 1` or free text. Failures use `status: BLOCKED` with a `blocker` line.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/build/implement.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree (required)
- `--branch {BRANCH}` — feature branch name (e.g. `feat/my-feature`) (required)
- `--base {PR_BASE}` — PR base branch name without the `origin/` prefix (required; computed by the router and passed down; used by the cross-lane import guard and migration collision check)

**Fail closed**: if `{NUMBER}`, `--repo`, `--worktree`, `--branch`, or `--base` is missing or empty, or `{WORKTREE_PATH}` is not an existing directory, print `IMPLEMENT_RESULT:` with `status: BLOCKED` and `blocker: missing or invalid arg: <name>` and STOP. `{GH_FLAG}` defaults to `-R {GH_REPO}` when absent.

**Derived values**: `{CHANGED_FILES}` (used below) is the space-separated list of files you changed in the worktree — derive it with `git -C {WORKTREE_PATH} diff --name-only HEAD` plus any untracked files from `git -C {WORKTREE_PATH} ls-files --others --exclude-standard`. `{GH_REPO}` and `{GH_FLAG}` as parsed above.

---

- `--fix-acceptance "<failed checks>"` — optional. Set only by build B6.5 after a failed acceptance gate. In this mode, skip I1–I2 planning: read the listed failing `ACCEPTANCE_CHECK` ids from the FORGE:INVESTIGATOR comment, change the code in `{WORKTREE_PATH}` until each check's target/matcher holds (do not edit the checks), update the BUILDER comment's `### Changes` list, and return `IMPLEMENT_RESULT: status: COMPLETE`. If a check is impossible as written (contradicts the contract), return `status: BLOCKED` with that reason.

## Phase I1: Load Context from GitHub

Read the full context chain before writing a single line of code:

```bash
# Issue body and labels
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels

# Architect plan (primary implementation guide — read BEFORE writing any code)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:ARCHITECT")) | .body'

# Investigation report
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Builder contract
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body'

# Context briefing (if present)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body'
```

**Resume check**:
- If `<!-- FORGE:BUILDER:COMPLETE -->` is present in a BUILDER comment → implementation is done — EXIT and print `IMPLEMENT_RESULT: status: ALREADY_DONE` as the final reply.
- If `<!-- FORGE:BUILDER -->` exists BUT `<!-- FORGE:BUILDER:COMPLETE -->` is ABSENT → implementation was interrupted after the comment was posted but before the commit (validate.md V5). Delete the partial comment and restart from Phase I2:
  ```bash
  PARTIAL_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
    --jq '[.[] | select(.body | contains("FORGE:BUILDER") and (contains("FORGE:BUILDER:COMPLETE") | not))] | last | .id // ""')
  if [ -n "$PARTIAL_ID" ]; then
    gh api repos/{GH_REPO}/issues/comments/$PARTIAL_ID -X DELETE
    echo "Deleted partial FORGE:BUILDER comment (no FORGE:BUILDER:COMPLETE) — restarting implementation"
  fi
  ```

**Primary guide**: If `<!-- FORGE:ARCHITECT -->` is present, it is the **primary implementation input**. Follow its ordered implementation list exactly — it defines which files change, in what order, and what consistency checks must pass. The investigation report and contract are secondary context.

**Fallback**: If `<!-- FORGE:ARCHITECT -->` is absent (architect step was skipped), proceed with investigation report + contract as the sole implementation guide.

Extract from architect plan (when present):
- Ordered implementation list (sequence of file changes to make)
- All affected paths (every file that must change for consistency)
- Consistency checks (invariants the builder must verify before committing)
- Risk assessment (HIGH/MEDIUM/LOW risks to watch for)

Extract from investigation report:
- Affected files list
- Root cause
- Recommendation

Extract from contract:
- Task type (Bug Fix / Feature / Refactor / Maintenance / UI/UX / Full-Stack)
- Deliverables table (file, change, why)
- Acceptance criteria

**Danger-Zone Rule Cards (BINDING CONSTRAINTS)**: When the FORGE:CONTEXT comment contains a `### Danger-Zone Rule Cards` section, each card is a **binding must-not-violate constraint** with the same authority as devdocs custom instructions. Before writing any code, read all injected cards and internalize them as explicit prohibitions. If the implementation plan requires touching a file listed in a card, the card's rule overrides the plan — choose an implementation path that satisfies the rule, or post a `needs-human` comment explaining the conflict. Do NOT silently proceed past a rule card that the implementation would violate. The quality gate (check 2G.9) will flag violations as `known-pattern-recurrence` (highest embarrassment class). <!-- Added: forge#1744 -->

---

## Phase I2: Route by Task Type

| Task Type | Approach |
|-----------|----------|
| Bug Fix | Implement fix directly in worktree |
| Feature (backend only) | Implement directly |
| Feature (UI/UX) | Invoke `frontend-design` skill + visual verification |
| Full-Stack | Backend first, then invoke `frontend-design` skill for UI |
| Refactor / Maintenance | Implement directly following contract deliverables |
| Investigation | Spawn research agents, create GitHub issues for findings, skip to I5 |

**Investigation task special case**: Research deeply, create GitHub issues for each finding using the Pipeline Issue Template (see `commands/issue.md` § "Pipeline Issue Template"). Each issue MUST include `## Problem`, `## Affected Files`, and `## Acceptance Criteria`. Create each issue via the `/issue` create-hook's programmatic invocation contract (see `commands/issue.md` § "Programmatic Invocation Contract") — `Skill(skill="{FORGE_SKILL_PREFIX}issue", args="--title \"...\" --body-file <path> --label ...")` — instead of calling the raw issue-creation command directly; this gets dedup and body validation for free. Post a deliverables comment listing the created issues, close the original issue, and print `IMPLEMENT_RESULT: status: INVESTIGATION_COMPLETE` as the final reply (the build skill passes this up and the router skips review). <!-- Added: forge#2090 -->

**Durable exit marker** (the engine reads this, not the free-text result): the deliverables comment MUST begin with the exact first line `<!-- FORGE:INVESTIGATION:DELIVERABLES -->` followed by the list of created issues. Post it BEFORE closing the original issue, remove the stale `workflow:building` label (`gh issue edit {NUMBER} {GH_FLAG} --remove-label "workflow:building"`), then close the issue and print the result. Without this marker an investigation exit is indistinguishable from a crashed build. <!-- Added: forge#3534 -->

---

## Phase I3: Implement

Work in `{WORKTREE_PATH}`. Follow the contract deliverables table exactly — implement each file change listed, in the order that resolves dependencies first.

**Implementation rules**:
- Read the current file before modifying it — never assume its state
- Read related files identified in the context briefing before touching the changed code
- For each acceptance criterion in the contract: implement it, then mentally verify it's met
- Do NOT add unrequested scope — contract out-of-scope items stay out of scope
- **Library callback verification**: When writing a lambda or callable that will be passed to a library/framework parameter (e.g., `prepared_statement_name_func=lambda: ""`, `key=lambda x: ...`), you MUST verify the expected calling convention BEFORE writing it. Check the library's default value for that parameter, its documentation, or its source code. A lambda with wrong arity causes `TypeError` at runtime — this is invisible to static analysis and linting. The P0 incident from PR #14391 was caused by `lambda _: ""` (1 arg) passed where SQLAlchemy expects 0 args.
- **Worktree-aware path derivation**: When writing shell code that derives repository paths, ALWAYS use `git rev-parse --show-toplevel` for the repo root in regular checkouts, or `git rev-parse --git-common-dir` (then `dirname`) to get the shared `.git` directory when the context may be a linked worktree. For worktree cleanup code specifically, ALWAYS use `--git-common-dir` — `--show-toplevel` returns the worktree path itself, NOT the main repo root. NEVER use `pwd`, relative paths, or `dirname` chains on `--show-toplevel` output for repo root derivation. Test path logic for both regular checkouts and linked worktrees. (Ref: review-findings #104, #105 — 4 PATH_DERIVATION defects, 15% of all review findings)
- **State machine completeness verification**: When implementing routing logic, state transition tables, or phase dispatch code (e.g., adding a `Skill()` call in a routing loop, adding a new phase to a state machine, creating a new subcommand file), you MUST run three checks BEFORE staging: (1) **Routing target existence** — for each `Skill("subcommand", ...)` call or file reference in routing logic, verify the target file exists at `commands/{subcommand-path}.md`; (2) **State reachability** — for each declared state or phase, verify at least one prior state or entry condition in the router routes to it; (3) **Subcommand invocation wiring** — for each `commands/work-on/*.md` file that declares its invocation condition (e.g., `Invoked by work-on.md routing loop, when X`), verify that condition is actually handled in the router. A missing target file, an unreachable state, or a declared-but-unwired subcommand will not surface until review. (Ref: review-findings #85, #116, #137 — 4 ROUTING defects, 15% of all review findings)
- **Migration safety checklist** *(trigger: diff includes `*.sql` files or files under a `migrations/` path)*: When any migration file is in the diff, verify ALL of the following BEFORE staging. Fix each violation inline — do not defer to review or the quality gate: (a) **Rollback file**: a corresponding down/rollback migration file exists (e.g. `0042_down_*.sql`, `rollback_*.sql`) or the migration is explicitly self-reversing (DROP of a previously-added column); (b) **NOT NULL safety**: any `ADD COLUMN ... NOT NULL` either includes a `DEFAULT` clause or is preceded by a backfill step — a NOT NULL column without DEFAULT locks the table and fails on existing rows; (c) **Constraint name consistency**: constraint names in the migration match ORM model declarations — a mismatch causes `alembic stamp` and FK introspection to silently diverge; (d) **CREATE TRIGGER idempotency**: every `CREATE TRIGGER` uses `CREATE OR REPLACE TRIGGER` or is preceded by `DROP TRIGGER IF EXISTS` — a bare `CREATE TRIGGER` fails on re-run in test and CI environments; (e) **Migration prefix uniqueness**: confirm the new file's numeric prefix does not already exist in the `infra/migrations/` tree (`ls infra/migrations/*.sql | xargs -n1 basename | grep -oE '^[0-9]+' | sort | uniq -d` prints duplicates) — a duplicate prefix hard-fails the deploy gate regardless of file content. <!-- Added: forge#373 -->
- **Cross-lane import guard**: Before adding any `import` or `from X import Y` statement for a service-internal module (`app.*`), verify the module exists on the PR's base branch (`{PR_BASE}`) — NOT just on your local disk or a milestone branch. Run `git show origin/{PR_BASE}:{module_path}.py` (replacing dots with slashes) to confirm. If the module only exists on a milestone branch, do NOT import it — find an alternative implementation or make the import conditional with a `try/except ImportError` fallback. A milestone-only import on a fast-lane PR will crash production on every request with `ModuleNotFoundError`. <!-- Added: forge#277 -->
- **Deliverable-type consistency check**: Before committing, compare the actual output against the CONTRACT's deliverable list. If the CONTRACT explicitly states "no code changes required", "docs only", or "configuration update only" AND the diff introduces new executable files (`.py`, `.js`, `.ts`, `.sh` — not test, config, or documentation files), STOP. Do NOT commit. Re-read the CONTRACT, the investigation recommendation, and the ARCHITECT plan. If all three agree that code is needed, update the CONTRACT comment to reflect the new deliverable type before proceeding. If only the builder decided to add code without contract support, discard the code change and implement the contracted deliverable instead. <!-- Added: forge#279 -->
- **Pipeline check documentation — generalization rule**: When writing or updating pipeline check documentation (in `commands/*.md`), describe the **bug class**, not a specific incident. Do NOT embed: PR numbers, issue numbers, run IDs, timestamps, function names, dollar amounts, or multi-sentence incident timelines in check prose or `**Evidence**:` blocks. One brief HTML comment `<!-- Added: forge#NNN -->` is acceptable per check for traceability. `**Evidence**:` blocks must describe the vulnerability pattern (what the class of bug looks like, why it's dangerous) — not narrate a single historical occurrence. CHANGELOG entries may reference originating issues; command prompt text must not.
- **Pattern sweep — class-wide fix and test**: When the FORGE:ARCHITECT plan or FORGE:INVESTIGATOR report contains a `### Pattern Sweep` table (`Query | Hit | Disposition`), fix EVERY hit with disposition `fix`, not only the instance the reviewer cited. Write the test against a representative set of instances from the table, not the reviewer's single repro, so it fails for any sibling still carrying the defect. Do not tune a rule, matcher, or fixture to the cited example. If a `fix` row cannot be changed, or a `not-affected` row turns out to be affected, say so in the `### Approach` of the FORGE:BUILDER comment instead of dropping it silently. Absent table = no-op. <!-- Added: forge#3449 -->
- **Endpoint response contract consumer tracing**: When changing an endpoint's response body shape or status field values (e.g., changing `"status": "healthy"` to `"status": "ok"`, renaming response keys, removing fields), grep the full repo for ALL consumers of that response body before committing. Consumers are not limited to the service being changed — they include deploy scripts, CI health checks, monitoring configs, docker-compose healthcheck definitions, Traefik probes, and any script that parses or pattern-matches on the response body. Run: `grep -rn "{old_value}\|{endpoint_path}" scripts/ infra/ .github/ docker-compose*.yml traefik/ 2>/dev/null`. All consumers whose behavior depends on the old response format MUST be updated in the same PR — a response contract change that updates only one consumer while leaving others on the old format is a deploy-time breakage. <!-- Added: forge#321 -->
- If you discover the contract is wrong (e.g. a file doesn't exist, a function has a different signature): STOP, post a comment on the issue explaining the discrepancy, add label `needs-human`, and EXIT with `IMPLEMENT_RESULT: status: BLOCKED` and a `blocker` describing the discrepancy

**Worktree working directory**:
```bash
cd {WORKTREE_PATH}
# all file reads, writes, and git operations happen here
```

---

## Phase I3.5: Env/Config Completeness Check

**Run this BEFORE Phase I4.** This phase is read-only — it scans the working changes for INFRA-class gaps that would otherwise surface as review findings. Do NOT run `git add` or `git commit` here.

**Trigger**: Run this phase whenever the diff introduces env vars, touches infra/deploy configs, or adds literal IP addresses.

### Check 1 — New env var documentation sync

Scan changed files for newly introduced env var references:

```bash
cd {WORKTREE_PATH}
# Collect all env var names referenced in changed files
NEW_ENV_VARS=$(grep -rnE "os\.getenv\(|process\.env\." {CHANGED_FILES} 2>/dev/null \
  | grep -oE "(os\.getenv\(['\"]|process\.env\.)[A-Za-z0-9_]+" \
  | sed "s/os\.getenv\(['\"]//; s/process\.env\.//" \
  | sort -u)

if [ -n "$NEW_ENV_VARS" ]; then
    for var in $NEW_ENV_VARS; do
        grep -q "$var" .env.example 2>/dev/null \
            || echo "MISSING: $var not in .env.example — add it before staging"
        [ -f ENV_VARS.md ] \
            && { grep -q "$var" ENV_VARS.md \
                || echo "MISSING: $var not in ENV_VARS.md — add it before staging"; }
        [ -f env_validation.py ] \
            && { grep -q "$var" env_validation.py \
                || echo "MISSING: $var not in env_validation.py — add it before staging"; }
    done
fi
```

**If any MISSING line is printed**: add the var to the missing location before proceeding to Phase I4. If a file listed above doesn't exist in this repo (e.g. `ENV_VARS.md` or `env_validation.py` may not be present in all projects), skip that check silently.

### Check 2 — Deploy/infra restart risk

```bash
cd {WORKTREE_PATH}
INFRA_FILES=$(echo "{CHANGED_FILES}" | tr ' ' '\n' \
  | grep -E "docker-compose.*\.yml|deploy/|infra/")

if [ -n "$INFRA_FILES" ]; then
    echo "INFRA CHANGE DETECTED in: $INFRA_FILES"
    # Check for restart-inducing changes
    RESTART_LINES=$(while IFS= read -r f; do grep -n "" "$f"; done <<< "$INFRA_FILES" \
      | grep -E "^\+.*(image:|resources:|mem_limit|cpus:|restart:|depends_on:)" \
      | grep -v "^---" || true)
    if [ -n "$RESTART_LINES" ]; then
        echo "RESTART RISK: the following lines may force container restarts on next deploy:"
        echo "$RESTART_LINES"
        echo "ACTION: annotate your commit message with [restart: <service_name>]"
    fi
fi
```

**If RESTART RISK is printed**: annotate the commit message (in Phase V5) with `[restart: <service>]` so operators know to plan downtime.

### Check 3 — Hardcoded IPs and credentials

```bash
cd {WORKTREE_PATH}
# Scan for bare IPv4 literals not inside env var lookups
grep -rnE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" {CHANGED_FILES} 2>/dev/null \
  | grep -vE "os\.getenv|process\.env|\.env\.example|example|placeholder|test|mock|localhost|127\.0\.0\.1|0\.0\.0\.0" \
  && echo "HARDCODED IP: replace with a config reference (env var or config file) before staging"

# Scan for credential-like assignments with literal values
grep -rnE "(api_key|secret|password|token|credential)\s*=\s*(f?['\"]|\`)[^{'\"\`]" {CHANGED_FILES} 2>/dev/null \
  | grep -vE "os\.getenv|process\.env|example|placeholder|test|mock" \
  && echo "HARDCODED CREDENTIAL: replace with env var before staging"
```

**If HARDCODED IP or HARDCODED CREDENTIAL is printed**: replace the literal value with a config reference before proceeding to Phase I4. This is a hard blocker — do not stage hardcoded secrets or IPs.

### Check 4 — SDK/API Literal sync advisory

**Trigger**: the diff contains `Literal[` in a schema file.

```bash
# Detect Literal type changes in API schema files
cd {WORKTREE_PATH}
LITERAL_CHANGES=$(git diff HEAD -- | grep -E '^\+.*Literal\[' | grep -v '^\+\+\+')
if [ -n "$LITERAL_CHANGES" ]; then
    echo "SDK SYNC ADVISORY: Literal type changed in schema."
    echo "Changed Literal lines:"
    echo "$LITERAL_CHANGES"
    echo ""
    echo "ACTION REQUIRED — verify SDK method/type lists match new API schema:"
    echo "  - sdk/python/*/client.py: check _valid_methods or equivalent list"
    echo "  - sdk/node/src/index.ts: check JSDoc @param Literal type annotation"
    echo "  - web/public/openapi*.json: check enum arrays for affected field"
    echo "  - web/public/openapi-versions/*.json: check all versioned specs"
    echo ""
    echo "Inconsistency example: API schema narrows Literal['GET','POST','PUT','PATCH','DELETE']"
    echo "to Literal['GET','POST'] but SDK JSDoc still lists all 5 methods — API returns 422"
    echo "for callers following SDK docs. This produces silent user-facing failures."
fi
```

This advisory is informational — it does NOT block the commit. But the implementer MUST check each listed file and add to the implementation scope if any SDK/spec file still documents the removed/changed Literal values. If SDK files need changes, add them to the current PR rather than leaving the inconsistency for review to catch.

---

## Phase I4: Stage Changes

**Precondition**: Do NOT commit yet — the validate subcommand (validate.md) runs AFTER implement and will make the commit in Phase V5 after the gate passes. Commit will happen in validate.md Phase V5 after the gate passes.

Migration collision check (if applicable):
```bash
git fetch origin
git log --oneline origin/{PR_BASE}..HEAD -- {MIGRATION_PATHS}
```
If a collision is detected, post a comment, add `needs-human` label before staging, and EXIT with `IMPLEMENT_RESULT: status: BLOCKED` (`blocker: migration collision`).

Stage the changed files:
```bash
cd {WORKTREE_PATH}
git add {CHANGED_FILES}
```

Do NOT run `git commit` here. The commit (with conventional commit message and issue reference) is made by validate.md Phase V5 after `GATE_PASSED=true`.

**Informational diff size** <!-- Added: forge#3450 -->: after staging, read the changed-line count so the builder comment and result carry it. This is a hint only. Implement never gates or decides: the diff-size gate lives in build B5.5, which re-measures authoritatively. Leave `DIFF_LINES` empty when the script is unavailable or fails.

```bash
# <Script resolution block from work-on/build.md, verbatim>
SCRIPT_REF=$(resolve_script 'diff-size')
DIFF_LINES=""
case "$SCRIPT_REF" in
  prose:*) ;;
  *) DIFF_LINES=$(bash "${SCRIPT_REF#*:}" --repo-path "{WORKTREE_PATH}" --base "{PR_BASE}" 2>/dev/null | sed -n 's/^diff_lines=//p' | head -n 1) || DIFF_LINES="" ;;
esac
case "$DIFF_LINES" in ''|*[!0-9]*) DIFF_LINES="" ;; esac
echo "DIFF_LINES=${DIFF_LINES}"
```

---

## Phase I5: Update Issue Body

Check off each acceptance criterion that has been implemented:
```bash
gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body'
# Edit the body: check off completed items, add PR reference if known
gh issue edit {NUMBER} {GH_FLAG} --body "{UPDATED_BODY}"
```

---

## Phase I6: Post FORGE:BUILDER Comment

Post the implementation summary comment. **Do NOT include `<!-- FORGE:BUILDER:COMPLETE -->` here** — that marker is posted by `validate.md` Phase V5 after the commit succeeds. A crash between I6 and V5 would otherwise leave a completion-marked comment with no commit on the branch.

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: \`{BRANCH}\`
**Commits**: {COMMIT_SHA(S)}
**Files changed**: {COUNT}
**Diff lines**: {DIFF_LINES or —}

### Approach
{One paragraph: what was built, key decisions, why this approach over alternatives}

### Changes
{Bulleted list of each file changed and what was done}

### Acceptance Criteria Status
{Checklist of each criterion from the contract, marked ✅ or ❌}

### Testing Checklist
- [ ] {Test scenario 1} [type:api]
- [ ] {Test scenario 2} [type:unit]
- [ ] {Test scenario 3} [type:e2e]

> **Test-type annotation** (optional): Append `[type:api]`, `[type:unit]`, `[type:e2e]`, or `[type:manual]` to each checklist item. The test gate reads this annotation directly and skips regex inference. Omit it to rely on regex classification fallback."
```

**Note**: `<!-- FORGE:BUILDER:COMPLETE -->` is intentionally absent from this comment. It is appended to this comment by `validate.md` Phase V5 after the git commit completes — see `validate.md § Phase V5`. This ordering ensures the completion marker only exists when a real commit is present on the branch.

---

## Output

The subcommand writes its results to GitHub (FORGE:BUILDER comment). The final reply is exactly one `IMPLEMENT_RESULT:` block — on every exit path (use `status: BLOCKED` + `blocker` for failures; fields not applicable may be empty):

```
IMPLEMENT_RESULT:
  status: COMPLETE | ALREADY_DONE | INVESTIGATION_COMPLETE | BLOCKED
  branch: {BRANCH}
  commits: [{SHA}, ...]
  files_changed: [{file}, ...]
  diff_lines: {N — informational, from scripts/diff-size.sh after I4; empty when unavailable}
  comment_url: {url of FORGE:BUILDER comment}
  blocker: {description if status=BLOCKED}
```

---

## Integration Point

This module is invoked by `work-on:build` after the worktree exists and context/architect are posted, and before validate:

```
build (worktree + contract)
  → context   (work-on:build:context)
  → architect (work-on:build:architect)
  → [THIS MODULE] implement — Phases I1–I6: code written, staged (not committed), FORGE:BUILDER posted
  → validate  (work-on:build:validate) — gate loop; the single commit happens in validate Phase V5 after the gate passes
```

The validate subcommand reads the staged diff produced by this module, runs the gate, and commits only after the gate passes.
