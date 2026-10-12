---
user-invocable: false
description: Build subcommand — create worktree, post contract, sequence context/architect/implement/validate
context: fork
background: false
argument-hint: "{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --base {PR_BASE}"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build — Build Phase Orchestrator

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

> **Transient GitHub failures** (field test: a 12-minute GitHub HTTP 500 window parked an issue at needs-human): retry any `gh` call that fails with HTTP 5xx, a timeout or "Something went wrong" up to 3 times with 10s/30s/60s backoff. If it still fails, do NOT add `needs-human` — print this phase's RESULT block with `status: BLOCKED` and a blocker that starts with `github-unavailable:`. The router retries the phase; every phase resumes from GitHub state, so a retry is safe.


**Invoked by**: the work-on router, when the issue carries label `workflow:ready-to-build` or `workflow:building`. This skill runs in an isolated forked context: it sees only its args and re-reads everything else from GitHub and git.
**Output**: Create worktree, classify complexity, post contract, run the child phases (context, architect, implement, validate) through `Skill()`, run the acceptance gate, and print exactly one `BUILD_RESULT:` block as the final reply.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. This file's mechanical bits (classification, label transitions) stay at this tier because they are interleaved with the reasoning-heavy child phases in the same run. <!-- Added: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

**CRITICAL: You MUST execute ALL phases B0–B6.5 (including B5.5) in order (the one exception is the B0 gate-resume branch, which enters at B6.5 with its state verified). Every child (B3 context, B4 architect, B5 implement, B6 validate) is invoked via `Skill(...)` — each is a forked sub-skill with its own isolated context. B3 and B4 are invoked for every complexity band except where the band is TRIVIAL or INVESTIGATION (B2/B2.1/B2.5 are also skipped for INVESTIGATION); the children post their own skip markers, so a skipped child is still visible on the issue. Skipping a child without the band justification degrades build quality and fails the phase-trail check.**

**Synchronous child consumption**: each child `Skill(...)` call (B3-B6) runs to completion in this phase's own turn, and you consume its result in that same turn. Never end or yield your turn to wait for a child, and never wait for a completion notification: notifications for forked children go to the root session, not to this phase, so a turn that yields is never resumed. A child return with no `*_RESULT:` block (running, backgrounded, empty) is not a result — re-read the GitHub markers for that child (`FORGE:CONTEXT`, `FORGE:ARCHITECT`, `FORGE:BUILDER`, `FORGE:VALIDATE`/`FORGE:QUALITY_GATE`) and apply the **bounded re-invoke rule**: re-invoke the same child with the same args at most 2 times per child on running/backgrounded/empty returns (the counter is per child and is not reset by a re-invoke). Before re-invoking, check state: if the child's marker is present, consume it instead of re-invoking; for implement and validate, also check the worktree (`git status --short` and `git log origin/{PR_BASE}..HEAD` in `{WORKTREE_PATH}`) — uncommitted in-flight edits or a fresh commit mean the original child may still be live, so wait for it by re-reading state rather than launching a second writer on the same worktree, and count that as a re-invoke attempt. After the cap is exhausted, take the Blocked exit (see Result emission and Blocked exit) with `blocker: child-stalled: <child>` (child = context|architect|implement|validate); it is terminal and is not re-invoked by the router.

<!-- FORGE:SPEC_LOADED — work-on/build.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}`) (required)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`) (required)
- `--base {PR_BASE}` — PR target branch, computed by the router (e.g. `milestone/modular-pipeline-architecture` or `staging`) (required)
- `--worktree {WORKTREE_PATH}` / `--branch {BRANCH}` — optional hints from a router re-invocation; when present and consistent with the issue they are reused, otherwise they are re-derived in B1

**Fail closed**: if `{NUMBER}`, `--repo` or `--gh-flag` is missing, or `--base` is missing or empty, take the Blocked exit below with blocker "missing required arg: <name>" — never guess a base branch (no fallback to `staging`/`main`).

---

## Script resolution

**Shell state does not persist between Bash tool calls** (each call is a fresh shell): paste the block below at the top of every bash command in this skill that calls `resolve_script` or uses `FORGE_ROOT`/`UNIVERSAL_DIR`.

```bash
# Canonical script resolution (keep byte-identical across specs; guarded by scripts/forge-root.test.sh).
# Shell state does NOT persist between Bash tool calls: include this whole block at the top of
# every command that uses resolve_script or FORGE_ROOT.
REPO_PATH="${REPO_PATH:-$(yq '.paths.root // ""' forge.yaml 2>/dev/null)}"
[ -n "$REPO_PATH" ] && [ "$REPO_PATH" != "null" ] || REPO_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ADAPTIVE_DIR_RAW="${REPO_PATH}/$(yq '.adaptive_scripts.directory // ".forgedock/scripts"' forge.yaml 2>/dev/null || echo '.forgedock/scripts')"
ADAPTIVE_DIR=$(realpath -m "$ADAPTIVE_DIR_RAW" 2>/dev/null || echo "$ADAPTIVE_DIR_RAW")
ADAPTIVE_ENABLED=$(yq '.adaptive_scripts.enabled // "true"' forge.yaml 2>/dev/null || echo 'true')
# Bounds check: reject adaptive_scripts.directory values that escape the repo root.
# Normalize REPO_PATH the same way ADAPTIVE_DIR is normalized (realpath -m) so a trailing
# slash in paths.root does not inject a '//' into the glob and trigger a false positive.
REPO_PATH_NORM=$(realpath -m "$REPO_PATH" 2>/dev/null || echo "$REPO_PATH")
if [[ "$ADAPTIVE_DIR" != "${REPO_PATH_NORM}/"* ]]; then
  echo "WARNING: adaptive_scripts.directory resolves outside repo root ('$ADAPTIVE_DIR') — adaptive tier disabled" >&2
  ADAPTIVE_ENABLED=false
fi
# ForgeDock's own install root (holds scripts/ and commands/), resolved ONCE by the shared forge_resolve stub
# below — never the consumer repo: plugin installs set neither FORGE_HOME nor FORGEDOCK_HOME, and a
# repo-relative fallback would execute (or miss) a same-named script controlled by the consumer repo.
# Resolution: $FORGEDOCK_HOME (authoritative when set) > the running plugin root (FORGE_SOURCED_ROOT) > $FORGE_HOME > the
# ~/.claude/commands symlink target > the Claude Code plugin cache/marketplace dirs. <!-- forge#3098 -->
# FORGE_ROOT: shared resolver scripts/lib/forge-resolve.sh (empty when unresolved => callers fail closed)
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
FORGE_ROOT="$(forge_root 2>/dev/null || true)"
UNIVERSAL_DIR="${FORGE_ROOT:+$FORGE_ROOT/scripts}"   # empty => tier 3 skipped, prose tier
# NOTE: never resolve this via `which` or `find` — universal scripts are
# install-relative, not installed on $PATH, so a PATH lookup always misses.
# FORGE_ROOT (above) is the deterministic resolution; there is NO repo-path fallback.
# Pipeline agents MUST NOT use `find` (unbounded or filesystem-wide) to
# locate pipeline scripts under any circumstances: if UNIVERSAL_DIR/${operation}.sh
# does not exist, resolve_script() falls through to Tier 4 (prose) below,
# which is always safe and available. A missing script is never a reason
# to search the filesystem. <!-- Added: forge#1984 -->

resolve_script() {
  local operation="${1}"
  # Tier 2: per-repo adaptive (skip if disabled)
  if [ "$ADAPTIVE_ENABLED" != "false" ] && [ -f "${ADAPTIVE_DIR}/${operation}.sh" ]; then
    echo "adaptive:${ADAPTIVE_DIR}/${operation}.sh"
    return
  fi
  # Tier 3: universal script
  if [ -n "$UNIVERSAL_DIR" ] && [ -f "${UNIVERSAL_DIR}/${operation}.sh" ]; then
    echo "universal:${UNIVERSAL_DIR}/${operation}.sh"
    return
  fi
  # Tier 4: prose fallback
  echo "prose:"
}
```

---

## Result emission and Blocked exit

Every exit path of this skill — COMPLETE, ALREADY_DONE, INVESTIGATION_COMPLETE, every guard, every failure — ends by printing exactly one block as the final reply:

```
BUILD_RESULT:
  status: COMPLETE | ALREADY_DONE | INVESTIGATION_COMPLETE | BLOCKED
  branch: {BRANCH}
  worktree: {WORKTREE_PATH}
  blocker: {description if status=BLOCKED, else empty}
```

`branch` / `worktree` are empty when the build stopped before B1 created them.

Every `BLOCKED` exit first runs this procedure (set `BLOCKER` to the reason text), then prints the block with `status: BLOCKED`:

```bash
BLOCKER="{reason}"
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" 2>/dev/null || true
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:BUILD_BLOCKED -->
## Build Blocked

${BLOCKER}

Human attention required (needs-human)." 2>/dev/null || true
```

(When the arguments themselves are missing and no `gh` call is possible, skip the procedure and print the block only.)

---

## Phase B0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Check investigation report — intentionally NOT cycle-scoped: investigate may commit CONFIRMED in a later cycle without re-posting INVESTIGATOR, so scoping it would block every new-cycle build
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh) # script resolution block verbatim; unresolved/failed read = fail closed
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:INVESTIGATOR -->'

# Current-cycle slice (forge#3666): every resume read below runs on the comments AFTER the newest TRUSTED
# `<!-- FORGE:CYCLE: n -->` marker (same predicate as `cycleNumber`/`sliceToCurrentCycle` in bin/engine/phases.mjs:
# trusted author incl. the FORGE_TRAIL_TRUSTED_ASSOCIATIONS / FORGE_TRAIL_TRUSTED_LOGINS overrides, same `${VAR-default}`
# handling as scripts/trusted-comments.sh; body starts with the header, marker on its own line); all comments when no marker exists.
# A cycle-1 BUILDER:COMPLETE must never yield ALREADY_DONE in cycle 2. Re-declare this function verbatim in every
# fence that uses it (shell functions do not survive across fences).
cycle_slice() {
  jq -s --arg assoc "${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}" --arg logins "${FORGE_TRAIL_TRUSTED_LOGINS-}" '[.[][]] as $c
    | ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
    | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
    | ([$c | to_entries[]
        | select(((.value.author_association // "") as $x | $A | index($x) != null) or ((.value.user.type // "") == "Bot") or ((.value.user.login // "") as $x | $L | index($x) != null))
        | select((.value.body // "") | test("\\A\\s*<!--\\s*FORGE:CYCLE:") and test("(?m)^[ \\t]*<!--[ \\t]*FORGE:CYCLE:[ \\t]*[0-9]+[ \\t]*-->[ \\t]*$"))
        | .key] | last) as $i
    | if $i == null then $c else $c[($i + 1):] end'
}
COMMENTS_JSON=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate) \
  && CYCLE_SLICE=$(printf '%s' "$COMMENTS_JSON" | cycle_slice) && [ -n "$CYCLE_SLICE" ] \
  || echo "CYCLE_LOOKUP=FAILED"  # a failed read is NEVER "no marker"

# Check if build already completed (require FORGE:BUILDER:COMPLETE — not just FORGE:BUILDER); current-cycle slice only
printf '%s' "$CYCLE_SLICE" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:BUILDER'

# Existing classification from a prior run of THIS cycle (resume path); none in a fresh cycle, so B0.5 re-classifies and re-posts
EXISTING_FAST_PATH=$(printf '%s' "$CYCLE_SLICE" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:FAST_PATH' 2>/dev/null \
  | head -n 1 | jq -r 'select(type == "string")')
```

`CYCLE_LOOKUP=FAILED` (or `trusted-comments.sh` unresolved) → Blocked exit with blocker `cycle-lookup-unavailable: could not read FORGE:CYCLE` (a transient GitHub failure uses the `github-unavailable:` prefix); never read a failed lookup as "no marker". Below, "present" and "exists" for BUILDER, BUILDER:COMPLETE, FAST_PATH, DIFF_SIZE, ACCEPTANCE_GATE and BUILD_BLOCKED comments always mean present in the **current-cycle slice** (comments after the newest trusted `FORGE:CYCLE` marker); a cycle-1 `BUILDER:COMPLETE` is invisible in cycle 2, so a new cycle with no slice COMPLETE falls through to B1 and builds fresh.

**Resume check**:
- If `<!-- FORGE:BUILDER:COMPLETE -->` is present in a BUILDER comment of the current-cycle slice → the builder finished, but COMPLETE is posted at validate V5, BEFORE the B6.5 acceptance gate, so it is not proof the build passed. **Gate resume** (checked first; first match wins) <!-- Added: forge#3725 -->: read the newest trusted, comment of the current-cycle slice that starts with `FORGE:ACCEPTANCE_GATE` or `FORGE:BUILD_BLOCKED`, through the same anchored, trust-filtered lookup as the FAST_PATH read above (script resolution block verbatim; pipe `cycle_slice` into `bodies '^<!-- FORGE:(ACCEPTANCE_GATE|BUILD_BLOCKED)'`, and compare by comment order, never by presence):
  - Lookup failed (`trusted-comments.sh` unresolved or `gh` error) → Blocked exit with blocker `gate-lookup-unavailable: could not read FORGE:ACCEPTANCE_GATE` (a transient GitHub failure uses the `github-unavailable:` prefix). Never read a failed lookup as "no gate marker".
  - Newest is `FORGE:ACCEPTANCE_GATE:FAILED`, `FORGE:ACCEPTANCE_GATE:BLOCKED`, or a `FORGE:BUILD_BLOCKED` comment → the gate is blocked and the engine fails closed on it, so returning ALREADY_DONE would deadlock every re-run. Derive BRANCH/WORKTREE_PATH/PR_BASE as in B1A/B1C (without creating anything), verify the branch and worktree exist and that `git -C "$WORKTREE_PATH" branch --show-current` equals BRANCH (missing or mismatched → Blocked exit `worktree-missing: cannot re-enter B6.5`; never recreate silently), recover `COMPLEXITY_BAND` from `EXISTING_FAST_PATH` with the B0.5 resume extraction, then skip B0.5-B6 and re-enter at **Phase B6.5**, which posts a fresh PASSED/FAILED/BLOCKED verdict (the one-repair `FORGE:ACCEPTANCE_REPAIR` bound still applies).
  - Newest is `FORGE:ACCEPTANCE_GATE:PASSED` or `FORGE:ACCEPTANCE_GATE:DEGRADED` (pass-class: the build completed, review gates the merge on the degraded paths), or no gate marker exists → build already complete. Derive BRANCH/WORKTREE_PATH as in B1A/B1C (without creating anything), then print `BUILD_RESULT: status: ALREADY_DONE`.
- If `<!-- FORGE:BUILDER -->` exists in the current-cycle slice BUT `<!-- FORGE:BUILDER:COMPLETE -->` is ABSENT → build was interrupted after the comment was posted but before the commit (validate V5). Delete the partial comment and restart from Phase B2 (contract): <!-- Added: forge#1305 -->
  Select with ONE anchored, trusted selector (body must start with the marker; author must be a Bot or OWNER/MEMBER/COLLABORATOR). Delete ONLY when exactly one non-complete candidate exists and it carries no other FORGE phase marker; unparsable, zero, or multiple matches delete nothing (fail closed). <!-- Added: forge#3668 -->
  ```bash
  # <cycle_slice function from B0, verbatim> — only a current-cycle partial is ever deleted; prior-cycle comments are never touched
  BLD=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments | cycle_slice | jq -s '[.[][] | select((.body // "") | startswith("<!-- FORGE:BUILDER -->")) | select((.user.type // "") == "Bot" or ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR"))) | {id: .id, complete: (.body | contains("<!-- FORGE:BUILDER:COMPLETE -->")), other: (.body | test("<!-- FORGE:(INVESTIGATOR|CONTEXT|CONTRACT|ARCHITECT)"))}]') || BLD=""
  PARTIAL_ID=$(printf '%s' "$BLD" | jq -r '[.[] | select(.complete | not)] | if length == 1 and (.[0].other | not) then .[0].id else empty end' 2>/dev/null)
  if [ -n "$PARTIAL_ID" ]; then
    gh api repos/{GH_REPO}/issues/comments/$PARTIAL_ID -X DELETE
    echo "Deleted partial FORGE:BUILDER comment (no FORGE:BUILDER:COMPLETE) — restarting build from Phase B2"
  else
    echo "builder resume: no single safe partial BUILDER comment — deleting nothing"
  fi
  ```
- If there is no `<!-- FORGE:INVESTIGATOR -->` comment with `<!-- INVESTIGATION:COMPLETE -->` → Blocked exit with blocker "Investigation not complete — run investigate first".

Extract from the investigation report:
- Affected files list → `{AFFECTED_FILES}` (space-separated repo-relative paths; this is what B3/B4 receive via `--files`)
- Root cause
- Recommendation
- Task type (Bug Fix / Feature / Refactor / Maintenance / UI/UX / Full-Stack)

---

## Phase B0.5: Classify Task Type and Complexity (MANDATORY — build owns this) <!-- Added: forge#1380 -->

Build classifies the task and posts the `FORGE:FAST_PATH` comment. `scripts/verify-phase-trail.sh` fails the review preflight if it is missing.

**Resume path**: If `EXISTING_FAST_PATH` is non-empty, extract COMPLEXITY_BAND from it and skip re-classification (do not post a second comment):

```bash
COMPLEXITY_BAND=$(printf '%s\n' "$EXISTING_FAST_PATH" \
  | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: *\([A-Za-z_]*\).*/\1/p' | head -1 | tr '[:lower:]' '[:upper:]')
echo "COMPLEXITY_BAND (existing): ${COMPLEXITY_BAND:-<none>}"
```

If `COMPLEXITY_BAND` is empty after this (no prior classification, or an unparseable one), classify now as below.

**Step 1 — Task type classification:**

| Signal | Type | Approach |
|--------|------|----------|
| Title starts with "Investigate:"/"Audit:"/"Research:" | Investigation | Produce issues as deliverables |
| UI/UX, feature + web/ files | UI/UX | `frontend-design` skill |
| Feature + services/ | Backend Feature | Implement directly |
| Feature + both | Full-Stack | Backend first, then frontend-design |
| Bug + web/ | Frontend Fix | Direct |
| Bug + services/ | Backend Fix | Direct |
| Refactor/docs | Maintenance | Direct |

**Investigation tasks — early exit (skip B2, B2.1, B2.5, B3, B4):** If task type = Investigation (title prefix, or task type = Investigation in the investigator report), the Builder Contract, Context Gathering and Architecture Plan are NOT run. Post the `<!-- FORGE:FAST_PATH -->` comment below, still run B1 (worktree and `building` label), then go straight to B5 (implement → issue-creation path). Do NOT run B2/B2.1/B2.5/B3/B4 for investigation tasks.

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:FAST_PATH -->
## Fast-Path Classification

**COMPLEXITY_BAND**: INVESTIGATION
**Task type**: Investigation
**Rationale**: Title prefix 'Investigate:' (or task type = Investigation from investigator report) — skipping Builder Contract, Context Gathering and Architecture Plan. Jumping directly to implement (issue creation).
**Phases skipped**: contract, context, architect"
```

**Step 2 — Complexity classification (for non-Investigation tasks):**

Classify COMPLEXITY_BAND based on affected file count and task nature:

| Condition | COMPLEXITY_BAND |
|-----------|-----------------|
| Single file, doc/config/markdown only, no logic changes expected | TRIVIAL |
| 1–5 files, existing patterns, no cross-service impact | STANDARD |
| 6+ files, new abstractions, cross-service, migration, schema changes | COMPLEX |

Post `<!-- FORGE:FAST_PATH -->` immediately after classification:

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:FAST_PATH -->
## Fast-Path Classification

**COMPLEXITY_BAND**: {TRIVIAL|STANDARD|COMPLEX}
**Task type**: {TASK_TYPE}
**Affected file count**: {N}
**Rationale**: {one-sentence explanation of classification decision}
**Phases skipped**: {list phases skipped, or 'none — full pipeline' for STANDARD/COMPLEX}"
```

**TRIVIAL tasks**: B3 (context) and B4 (architect) are skipped only. B2 (Builder Contract) is **retained** — it still runs. When filling in **Phases skipped**, write: `context, architect`. (Each skipped child still posts its own skip marker when invoked — see B3/B4.)

**STANDARD and COMPLEX tasks**: Run the full pipeline. No phases skipped.

Whatever path was taken, set `COMPLEXITY_BAND` (uppercase) for the rest of this run and echo it. A missing or unparseable band at this point is a bug in this phase — re-classify, never default silently.

---

## Phase B1: Create Worktree & Branch

### B1A: Derive branch name

If `--branch` was passed, or a local/remote branch already exists whose name ends in `-{NUMBER}` (`git branch -a --list "*-{NUMBER}"`), reuse it (resume). **New-cycle guard** <!-- Added: forge#3666 -->: when a trusted `FORGE:CYCLE` marker exists and the current-cycle slice has no `FORGE:BUILDER`, never re-adopt a prior-cycle branch whose PR is already merged or closed (`gh pr list {GH_FLAG} --head "<branch>" --state all --json state --jq '.[].state'` shows `MERGED`/`CLOSED`, or the branch is already merged into `origin/{PR_BASE}`); derive a fresh name instead (append `-c<cycle>` before `-{NUMBER}`, e.g. `fix/foo-c2-{NUMBER}`). Otherwise derive from the issue title: lowercase, hyphenated, max 40 chars (truncate if needed).
- Bug / fix issues → prefix `fix/`
- Feature issues → prefix `feat/`
- Refactor / maintenance → prefix `fix/` or `refactor/`

Append `-{NUMBER}` to ensure uniqueness: e.g. `fix/work-on-build-landing-file-85`. Then `BRANCH_SLUG` is `{BRANCH}` with every `/` replaced by `-`.

### B1B: Determine source branch

- Review-finding issue → parse `**Code branch**: \`{branch}\`` from issue body; branch from `origin/{branch}`
  - **Milestone review-finding hybrid lane** (ONLY when Code branch matches `milestone/*`): This is a high-risk lane. The worktree will carry the full milestone history. The PR target is `{PR_BASE}`. **DANGER: Agents MUST NOT use `git merge` to resolve any conflicts in this lane.** Merge-based conflict resolution will pull the entire milestone commit tree onto the PR target, contaminating it with unapproved code. Use `git rebase` or `git cherry-pick` only. If conflicts cannot be resolved without a merge, post a comment on the issue, add `needs-human`, and STOP (Blocked exit).
  - **Missing ref fallback**: After parsing, verify the Code branch still exists on remote. If not, fall back to `{PR_BASE}` and note the fallback:
    ```bash
    SOURCE_BRANCH="{CODE_BRANCH_FROM_ISSUE_BODY}"
    if ! git ls-remote --exit-code origin "$SOURCE_BRANCH" >/dev/null 2>&1; then
      echo "WARNING: Code branch '$SOURCE_BRANCH' not found on remote — falling back to PR base '{PR_BASE}'"
      SOURCE_BRANCH="{PR_BASE}"
    fi
    ```
- Every other issue (feature lane or fast lane) → `SOURCE_BRANCH` = `{PR_BASE}` (the `--base` arg). There is no hardcoded lane default here: the router already chose `{PR_BASE}` for the lane. <!-- Fixed: forge#639 -->

### B1C: Create worktree

```bash
REPO_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
WORKTREE_ROOT="${REPO_ROOT}/.claude/worktrees"
if [ "${FORGE_RUNTIME:-}" = "opencode" ] ||
   [ -n "${OPENCODE_SESSION_ID:-}" ] ||
   [ -n "${OPENCODE_PID:-}" ] ||
   [ -n "${OPENCODE:-}" ]; then
  WORKTREE_ROOT="${REPO_ROOT}/.opencode/worktrees"
elif [ "${FORGE_RUNTIME:-}" = "codex" ]; then
  WORKTREE_ROOT="${REPO_ROOT}/.codex/worktrees"
fi
# An explicit, absolute forge.yaml paths.worktree_base wins over the runtime default, so worktrees
# land where the project's cleanup and recovery tooling expects them (e.g. a project that keeps worktrees under .forge/worktrees).
CONFIGURED_BASE=$(yq '.paths.worktree_base // ""' forge.yaml 2>/dev/null || echo "")
case "$CONFIGURED_BASE" in /*) WORKTREE_ROOT="${CONFIGURED_BASE%/}" ;; esac
mkdir -p "$WORKTREE_ROOT"
WORKTREE_PATH="${WORKTREE_ROOT}/{BRANCH_SLUG}"
git fetch origin "{SOURCE_BRANCH}" 2>/dev/null || true
if [ -d "$WORKTREE_PATH" ]; then
  # Reuse existing worktree only when it is on the correct branch
  CURRENT=$(git -C "$WORKTREE_PATH" branch --show-current 2>/dev/null)
  if [ "$CURRENT" != "{BRANCH}" ]; then
    git worktree remove "$WORKTREE_PATH" --force
  fi
fi
if [ ! -d "$WORKTREE_PATH" ]; then
  if git show-ref --verify --quiet "refs/heads/{BRANCH}"; then
    git worktree add "$WORKTREE_PATH" "{BRANCH}"            # resume: branch already exists
  else
    git worktree add "$WORKTREE_PATH" -b "{BRANCH}" "origin/{SOURCE_BRANCH}"
  fi
fi
echo "WORKTREE_PATH=$WORKTREE_PATH BRANCH={BRANCH} BASE={PR_BASE}"
```

If worktree creation fails, take the Blocked exit with the git error as the blocker. Use the resulting `$WORKTREE_PATH` as `{WORKTREE_PATH}` for every later phase and in `BUILD_RESULT`.

### B1D: Set building label

```bash
RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} building ;;
  prose)
    [ -n "${DRY_RUN:-}" ] && echo "DRY_RUN: set workflow:building" || \
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:building" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:in-review,workflow:remediating,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

---

## Phase B2: Post Builder Contract (skip for INVESTIGATION)

**Skip if COMPLEXITY_BAND: INVESTIGATION** — go to B5. For every other band (TRIVIAL included) the contract is mandatory. If a `FORGE:CONTRACT` comment already exists on the issue (resume), do not post a second one — continue to B2.1.

Post `<!-- FORGE:CONTRACT -->` comment documenting what will be built and why. Run B2.0 first: it folds small siblings and files one batched follow-up for the `deferred` out-of-scope items and validates the section, so `{OUT_OF_SCOPE_ITEMS}` below already holds real issue numbers.

### B2.0: Out-of-scope dispositions — file deferred follow-ups, validate the section <!-- Added: forge#3447 -->

Every item in the contract's `### Out of Scope` section must carry exactly one disposition, or the section is the single line `None.`. Each bullet names at least one backticked path or symbol so review can match findings against it:

```
- `path/or/symbol` — deferred → #N: <why it is deferred>
- `path/or/symbol` — not-affected: <evidence, e.g. the grep or call-graph check that shows no impact>
- `path/or/symbol` — accepted-risk: <reason the risk is acceptable>
```

- **`deferred → #N`**: a follow-up issue `#N` already exists (filed in this step, before the contract is posted). Use it for a sibling path the work leaves alone but that still needs the change.
- **`not-affected: <evidence>`**: the path was checked and the change does not reach it. The evidence must be concrete. Review never demotes a finding against a `not-affected` item: a finding that contradicts the evidence means the contract was wrong.
- **`accepted-risk: <reason>`**: a known gap that is knowingly kept. Review demotes a non-security finding on this path to a note.
- **Known-flaw rule**: a contract that keeps a known-flawed design (a design the investigation or architect plan identified as flawed, a fail-open caller, an unsound threshold) must state the flaw and list it as a `deferred → #N` item with a linked follow-up. It may not hide behind `accepted-risk` or free text.
- Free-text exclusions without a disposition are invalid. `->` is accepted for `→`.

**Fold, then batch** <!-- Added: forge#3843 -->: before filing anything, fold small siblings into scope. A candidate deferred item that is the same mechanical change at a sibling path and fits the remaining scope budget (a small fraction of the plan's own estimate: at most 20% of the current `ESTIMATED_DIFF_LINES`, or 200 lines when no estimate exists) goes into the contract's Deliverables, not Out of Scope; count it as `folded`. Defer only genuinely separate work (different module, design or owner). All remaining deferred items of this build go into ONE follow-up issue with a checklist; `scripts/file-deferred-followups.sh` appends to an open trusted follow-up for the same parent (exact path match) or creates one.

**File the `deferred` follow-ups** (skip the filing on resume when the contract already exists):

```bash
# <Script resolution block from work-on/build.md, verbatim>
# DEFERRED_TSV: one line per remaining deferred item: path<TAB>one-line why<TAB>known-flaw (or empty)
SCRIPT_REF=$(resolve_script 'file-deferred-followups')
case "$SCRIPT_REF" in
  prose:*) echo "DEFERRED_SCRIPT=PROSE" ;;   # file ONE issue by hand: marker + checklist of every path (see below)
  *) printf '%s\n' "$DEFERRED_TSV" | bash "${SCRIPT_REF#*:}" --parent {NUMBER} --repo {GH_REPO} --folded "${FOLDED_COUNT:-0}"; echo "DEFERRED_RC=$?" ;;
esac
```

- Output is one `path<TAB>issue` row per item (rows share the batched issue number: use it as the `#N` in each `deferred → #N` bullet) plus a `DEFERRED_TELEMETRY deferred_items=N folded=N batched_into=#M filed=N` line (forwarded to the #3834 emitter when present).
- A known-flawed design is recorded as a `known-flaw` checklist item in that batched issue (pass the flag in the TSV); it is never dropped or hidden behind `accepted-risk`.
- Only follow-ups by a trusted author (OWNER/MEMBER/COLLABORATOR or Bot; `FORGE_TRAIL_TRUSTED_*` honoured) are reused; an untrusted match is ignored.
- `DEFERRED_LOOKUP=FAILED` or `DEFERRED_FILE=FAILED` (non-zero `DEFERRED_RC`) → Blocked exit with blocker `github-unavailable: could not file or look up deferred follow-ups` (a transient failure follows the retry rule above; no `needs-human` for `github-unavailable:`).
- Prose tier (script absent): create one issue by hand whose body has the exact `<!-- FORGE:DEFERRED_FROM: #{NUMBER} -->` marker and a `- [ ] \`path\` — why` checklist line per path, after a trusted-author marker lookup; a failed lookup is a Blocked exit.
- On resume the lookup reuses the open issue carrying the marker and appends only missing paths, so a retried build never files a duplicate.

**Validate the composed section** with `scripts/check-contract-scope.sh validate` (the exact text that will replace `{OUT_OF_SCOPE_ITEMS}`):

```bash
# <Script resolution block from work-on/build.md, verbatim>
SCOPE_FILE=$(mktemp "${TMPDIR:-/tmp}/contract-scope.XXXXXX")
printf '### Out of Scope\n\n%s\n' "{OUT_OF_SCOPE_ITEMS}" > "$SCOPE_FILE"
SCRIPT_REF=$(resolve_script 'check-contract-scope')
case "$SCRIPT_REF" in
  prose:*) echo "SCOPE_CHECK=PROSE" ;;   # apply the three-disposition rules above by hand
  *) bash "${SCRIPT_REF#*:}" validate "$SCOPE_FILE"; echo "SCOPE_CHECK_RC=$?" ;;
esac
rm -f "$SCOPE_FILE"
```

- `SCOPE_CHECK_RC=0` (or `SCOPE_CHECK=PROSE` after a manual check) → post the contract.
- `SCOPE_CHECK_RC=1` → the stderr lists each bad item. Fix the items (add the missing disposition, file the missing follow-up, name a backticked path), recompose, and re-run once. Still invalid → Blocked exit with blocker `contract-scope-invalid: <first bad item>`.
- `SCOPE_CHECK_RC=2` → a usage error in this step: fix the invocation and retry once, then Blocked exit.

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: {TASK_TYPE}

### Proposed Approach

{BRIEF_APPROACH_DESCRIPTION}

### Deliverables

| File | Change | Why |
|------|--------|-----|
{DELIVERABLES_ROWS}

### Acceptance Criteria

{ACCEPTANCE_CRITERIA_CHECKLIST}

### Quality Considerations

{AUTH_MODEL_NEW_ENV_VARS_SQL_SAFETY_SECURITY_SURFACE}

### Out of Scope

{OUT_OF_SCOPE_ITEMS}
${ATTRIBUTION_LINE}"
```

`{OUT_OF_SCOPE_ITEMS}` is the validated B2.0 section body: `None.`, or typed bullets using the literal dispositions `deferred → #N`, `not-affected:` and `accepted-risk:`. Never post free text there.

Contract must be grounded in the investigation report. Every deliverable file must appear in the affected files list from the investigator. Adversarially validate the proposed fix against adjacent system layers before posting.

### B2.1: Post FORGE:CLAIM on coordination issue (conditional — when running under orchestration batch) <!-- Added: forge#1736 -->

**Skip if**: `FORGE_COORD_ISSUE` is not set (agent is not running under an orchestration batch). This step is a no-op outside of `/orchestrate` dispatch — no error, no output.

**When `FORGE_COORD_ISSUE` is set**: Post a `FORGE:CLAIM` annotation on the coordination issue to advertise this agent's active resource reservation to the orchestrator and peer agents. This enables the claims-board Layer-2/4 relaxation sweep (orchestrate Step 4B) to identify issue-pairs with disjoint file sets and downgrade unnecessary serialization edges.

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
  COORD_NUM=$(echo "$FORGE_COORD_ISSUE" | grep -oE '[0-9]+$')
  if [ -n "$COORD_NUM" ]; then
    # Extract file paths from the just-posted FORGE:CONTRACT deliverables table
    CLAIMED_FILES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
      --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | last | .body' 2>/dev/null \
      | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
      | grep -oE '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|md|mjs|sh)`' \
      | tr -d '`' | sort -u | head -20)
    CLAIMED_FILES="${CLAIMED_FILES:-"(files listed in FORGE:CONTRACT deliverables table)"}"

    # Extract preserved interfaces from the FORGE:ARCHITECT affected paths table (if present)
    CLAIMED_INTERFACES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
      --jq '[.[] | select(.body | contains("FORGE:ARCHITECT"))] | last | .body' 2>/dev/null \
      | awk '/^### Affected Paths/{p=1; next} /^### /{p=0} p' \
      | grep -oE 'Function/Class.*\|.*\|' | head -10 || true)
    CLAIMED_INTERFACES="${CLAIMED_INTERFACES:-"(see FORGE:ARCHITECT comment for interface details)"}"

    CLAIM_HOLDER="#{NUMBER} / $(date -u +%Y%m%dT%H%M%S)"
    CLAIM_TTL="terminal state of Holder issue #{NUMBER}"

    run gh issue comment "$COORD_NUM" -R {GH_REPO} --body "<!-- FORGE:CLAIM -->
## Resource Claim

**Holder**: ${CLAIM_HOLDER}
**Files**: ${CLAIMED_FILES}
**Interfaces**: ${CLAIMED_INTERFACES}
**TTL**: ${CLAIM_TTL}

<!-- CLAIM:COMPLETE -->" 2>/dev/null || true
    echo "FORGE:CLAIM posted on coordination issue #${COORD_NUM} for #{NUMBER}"
  fi
fi
```

**After posting**: Continue to Phase B2.5. The claim is now visible to the orchestrator and peer agents. The orchestrator's claims-board relaxation sweep (orchestrate Step 4B) will read this claim when determining whether serialized peers can be unblocked.

---

## Phase B2.5: Extract FUNCTION_NAMES from Contract (skip for INVESTIGATION)

After posting the Builder Contract, extract the primary function/class names from the contract's deliverables table. These are passed to the context child for its C3 caller/importer discovery.

```bash
FUNCTION_NAMES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' \
  | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
  | grep -oE '`[A-Za-z_][A-Za-z0-9_]*`' \
  | tr -d '`' \
  | sort -u \
  | tr '\n' ' ' \
  | xargs)
# Scope is limited to the ### Deliverables section to avoid false matches from FORGE markers,
# phase labels (B2, C3), and identifiers mentioned in Acceptance Criteria or Quality sections.
# Fallback: if extraction yields nothing, FUNCTION_NAMES remains the empty string and
# context C3 skips gracefully (its for-loop produces zero iterations).
```

If `FUNCTION_NAMES` is non-empty, pass it via `--functions` to the context child. If empty, omit the `--functions` flag.

---

## Phase B3: Context Gathering (invoke for every band except TRIVIAL / INVESTIGATION)

**Skip only if COMPLEXITY_BAND is TRIVIAL or INVESTIGATION** — proceed directly to Phase B4. (The context child would also detect these bands and return `SKIPPED` itself; for STANDARD and COMPLEX it is NOT optional — it must be invoked.)

Always invoke it as a forked sub-skill — never inline:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:context", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --repo-path {WORKTREE_PATH} --files \"{AFFECTED_FILES}\" --functions \"{FUNCTION_NAMES}\"")
```

If `FUNCTION_NAMES` is empty, omit `--functions`. The child posts its own `FORGE:CONTEXT` comment (a minimal marker when it skips a non-TRIVIAL issue).

**After the child returns** (read its `CONTEXT_RESULT:` block):
- `status: COMPLETE | PARTIAL | SKIPPED` → continue to B4
- No `CONTEXT_RESULT:` block, timeout or error → log a warning and continue to B4 (context is advisory and non-blocking)
- Skill not found → Blocked exit, blocker "skill not found: work-on:build:context"
- Returned running/backgrounded/empty (no `CONTEXT_RESULT:`) → do not end the turn; re-read for a `FORGE:CONTEXT` marker, re-invoke the same child if absent, per the bounded re-invoke rule (at most 2; check the marker before re-invoking) (advisory rules above still apply once it returns)
# MUST CONTINUE to Phase B4 — context result is intermediate, NOT terminal.

---

## Phase B4: Architecture Planning (invoke for every band except TRIVIAL / INVESTIGATION)

**Skip only if COMPLEXITY_BAND is TRIVIAL or INVESTIGATION** — proceed directly to Phase B5. For STANDARD and COMPLEX it is NOT optional; even a 1-file STANDARD fix benefits from cross-path consistency checks.

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:architect", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --repo-path {WORKTREE_PATH} --files \"{AFFECTED_FILES}\"")
```

The child posts its own `FORGE:ARCHITECT` comment (a "Skipped" marker + `:COMPLETE` on every skip, forge#2689).

**After the child returns** (read its `ARCHITECT_RESULT:` block):
- `status: COMPLETE | PARTIAL | SKIPPED` → continue to B5
- `status: BLOCKED` (conflicting constraints that cannot be resolved) → Blocked exit with the child's `blocker`
- No `ARCHITECT_RESULT:` block → re-read the issue: if a `FORGE:ARCHITECT:COMPLETE` marker exists continue to B5, otherwise Blocked exit "architect produced no result"
- Skill not found → Blocked exit, blocker "skill not found: work-on:build:architect"
- Returned running/backgrounded/empty → do not end the turn to wait; re-read markers and re-invoke the same child per the bounded re-invoke rule (at most 2; the marker fallback above applies only after a real return)
# MUST CONTINUE to Phase B5 — architect result is intermediate, NOT terminal.

---

## Phase B5: Implementation (Subcommand)

Invoke the implement subcommand to write code, stage, and post the builder comment:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:implement", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE}")
```

**After subcommand returns** (read its `IMPLEMENT_RESULT:` block):
- `status: COMPLETE` → continue to B5.5
- `status: ALREADY_DONE` → continue to B5.5 (scope-check what's already there)
- `status: INVESTIGATION_COMPLETE` → issues were created as deliverables and the original closed; verify a `<!-- FORGE:INVESTIGATION:DELIVERABLES -->` comment exists on the issue (the implement child posts it and removes `workflow:building`; if it is missing, post it listing the created issues and remove the label), then print `BUILD_RESULT: status: INVESTIGATION_COMPLETE` (skip B5.5/B6/B6.5). The engine keys off that marker, not the result text. <!-- Added: forge#3534 -->
- `status: BLOCKED` → Blocked exit with the child's `blocker`
- Skill not found → Blocked exit, blocker "skill not found: work-on:build:implement"
- Returned running/backgrounded/empty (no `IMPLEMENT_RESULT:`) → do not end the turn to wait; re-read the `FORGE:BUILDER` comment and the worktree state; if `FORGE:BUILDER:COMPLETE` is present consume it, and if the worktree shows in-flight edits or a fresh commit treat the child as possibly live; before re-invoking, apply the bounded re-invoke rule (at most 2, then `child-stalled: implement`)
# MUST CONTINUE to Phase B5.5 — implement result is intermediate, NOT terminal (the scope check and validation still follow).

---

## Phase B5.5: Scope Check

A finished build is never discarded and never routed to decompose: decomposition is a planning decision (investigate / architect), not a post-build one. This phase compares the staged diff with the plan, measures a deterministic `review_weight`, and records a scope outcome. Size never blocks; it scales review depth. It measures the staged diff (implement staged everything in I4; nothing is committed until validate V5) and edits code only for the opt-in out-of-plan trim in Step 4. <!-- Added: forge#3862 -->

**Skip** (continue to B6) only when the task type is Investigation (B5 already exited). Never skip because a lookup failed: unknown is not in plan.

**Step 1 — baseline.** The plan is the scope baseline: the latest trusted `FORGE:ARCHITECT` comment of the current-cycle slice carries `PLANNED_FILES:` (a `- path` list; a trailing `/` is a directory prefix) and `ESTIMATED_DIFF_LINES: N` under `### Scope Baseline`. An architect skip marker has an empty list, which means "no plan baseline": proceed with no out-of-plan check. The estimate falls back to the issue body's own-line `ESTIMATED_DIFF_LINES: N` (written by `work-on:decompose` D3), then to the latest trusted `FORGE:INVESTIGATOR` comment's. Paste the Script resolution block and the `cycle_slice` function from B0 first (shell state does not persist); quote every interpolation:

```bash
# <Script resolution block from above goes here, verbatim>
# <cycle_slice function from B0, verbatim>
set -o pipefail
TRUSTED_SCRIPT="${UNIVERSAL_DIR:+$UNIVERSAL_DIR/trusted-comments.sh}"
[ -n "$TRUSTED_SCRIPT" ] && [ -f "$TRUSTED_SCRIPT" ] || { echo "BASELINE_LOOKUP=FAILED (trusted-comments.sh unresolved)"; exit 0; }
SLICE=$(gh api --paginate "repos/{GH_REPO}/issues/{NUMBER}/comments" | cycle_slice) && [ -n "$SLICE" ] || { echo "BASELINE_LOOKUP=FAILED"; exit 0; }
ARCH_BODY=$(printf '%s' "$SLICE" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:ARCHITECT' | jq -rs 'map(select(type == "string")) | last // ""') || { echo "BASELINE_LOOKUP=FAILED"; exit 0; }
INV_BODY=$(printf '%s' "$SLICE" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:INVESTIGATOR' | jq -rs 'map(select(type == "string")) | last // ""') || { echo "BASELINE_LOOKUP=FAILED"; exit 0; }
ISSUE_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq .body) || { echo "BASELINE_LOOKUP=FAILED"; exit 0; }
SCOPE_DIR="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"; mkdir -p "$SCOPE_DIR"
PLAN_FILE="$SCOPE_DIR/scope-plan-{NUMBER}"   # fixed path: Step 2 runs in a fresh shell and re-derives it
printf '%s\n' "$ARCH_BODY" | awk '/^PLANNED_FILES:[ \t]*$/{f=1;next} f&&/^[ \t]*[-*][ \t]+/{print;next} f{exit}' > "$PLAN_FILE"
EST_RE='s/^ESTIMATED_DIFF_LINES: *\([0-9][0-9]*\) *$/\1/p'
ESTIMATE=$(printf '%s\n' "$ARCH_BODY" | sed -n "$EST_RE" | tail -n 1)
[ -n "$ESTIMATE" ] || ESTIMATE=$(printf '%s\n' "$ISSUE_BODY" | sed -n "$EST_RE" | tail -n 1)
[ -n "$ESTIMATE" ] || ESTIMATE=$(printf '%s\n' "$INV_BODY" | sed -n "$EST_RE" | tail -n 1)
printf '%s' "${ESTIMATE:-}" > "$SCOPE_DIR/scope-estimate-{NUMBER}"
echo "BASELINE_LOOKUP=ok PLAN_FILE=${PLAN_FILE} ESTIMATE=${ESTIMATE:-none}"
```

`BASELINE_LOOKUP=FAILED` → Blocked exit with blocker `github-unavailable: could not read the scope baseline (FORGE:ARCHITECT)` (transient; the router retry rule applies; no `needs-human`). Never read a failed lookup as "no plan" or "in plan". A read that succeeds with no `PLANNED_FILES:` entries is a legitimate "no plan baseline".

**Step 2 — measure.** Config (all values are config, none is a magic number; defaults are generous and are calibrated from telemetry, forge#3834): `build.scope.test_weight` (percent weight of test lines in `review_weight`, default 50), `build.scope.module_depth` (path segments that define a module, default 2), `build.scope.overrun_pct` (actual whitespace-insensitive lines over the plan estimate, in percent, that count as scope creep, default 200), `build.scope.exclude_globs`, `review.depth.extended_weight` (`review_weight` at or above which review is extended, default 1500) and `review.depth.extended_modules` (modules touched at or above which review is extended, default 6). The deprecated `build.diff_size.exclude_globs` is read as an alias of `build.scope.exclude_globs` and a positive `build.diff_size.threshold` as an alias of `review.depth.extended_weight` for one release; when an alias supplied the value, add `deprecated_config: build.diff_size.*` to the comment (Step 5). The threshold no longer blocks anything.

```bash
# <Script resolution block from above goes here, verbatim>
# Step 1's variables do not survive into this fence: reload the baseline it persisted.
SCOPE_DIR="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"
PLAN_FILE="$SCOPE_DIR/scope-plan-{NUMBER}"; [ -f "$PLAN_FILE" ] || : > "$PLAN_FILE"
ESTIMATE=$(cat "$SCOPE_DIR/scope-estimate-{NUMBER}" 2>/dev/null || true)
# Fresh origin/base for the merge-base measurement: retry with 10s/30s/60s backoff, record whether it ever succeeded
FETCH_OK=0
for _delay in 0 10 30 60; do
  [ "$_delay" -gt 0 ] && sleep "$_delay"
  if git -C "{WORKTREE_PATH}" fetch origin "{PR_BASE}" 2>/dev/null; then FETCH_OK=1; break; fi
done
TEST_WEIGHT=$(yq '.build.scope.test_weight // 50' forge.yaml 2>/dev/null || echo 50)
MODULE_DEPTH=$(yq '.build.scope.module_depth // 2' forge.yaml 2>/dev/null || echo 2)
OVERRUN_PCT=$(yq '.build.scope.overrun_pct // 200' forge.yaml 2>/dev/null || echo 200)
EXT_WEIGHT=$(yq '.review.depth.extended_weight // ""' forge.yaml 2>/dev/null || true)
EXT_MODULES=$(yq '.review.depth.extended_modules // 6' forge.yaml 2>/dev/null || echo 6)
DEPRECATED=""
if [ -z "$EXT_WEIGHT" ] || [ "$EXT_WEIGHT" = "null" ]; then
  OLD_THRESHOLD=$(yq '.build.diff_size.threshold // 0' forge.yaml 2>/dev/null || echo 0)
  case "$OLD_THRESHOLD" in ''|*[!0-9]*|0) EXT_WEIGHT=1500 ;; *) EXT_WEIGHT="$OLD_THRESHOLD"; DEPRECATED="build.diff_size.threshold" ;; esac
fi
EXCLUDES=()
while IFS= read -r _g; do [ -n "$_g" ] && [ "$_g" != "null" ] && EXCLUDES+=(--exclude-glob "$_g"); done \
  < <(yq '(.build.scope.exclude_globs // []) + (.build.diff_size.exclude_globs // []) | .[]' forge.yaml 2>/dev/null || true)
SCRIPT_REF=$(resolve_script 'diff-size')
case "$SCRIPT_REF" in
  prose:*) echo "SCOPE_CHECK: scripts/diff-size.sh unresolved (prose tier) — check skipped with a note in the FORGE:BUILDER comment" ;;
  *)
    SIZE_OUT=$(bash "${SCRIPT_REF#*:}" --repo-path "{WORKTREE_PATH}" --base "{PR_BASE}" --test-weight "$TEST_WEIGHT" --module-depth "$MODULE_DEPTH" --overrun-pct "$OVERRUN_PCT" \
      --plan-files "$PLAN_FILE" ${ESTIMATE:+--estimate "$ESTIMATE"} ${EXCLUDES[@]+"${EXCLUDES[@]}"}) && SIZE_RC=0 || SIZE_RC=$?
    echo "SIZE_RC=${SIZE_RC}"; echo "FETCH_OK=${FETCH_OK}"; printf '%s\n' "$SIZE_OUT" ;;
esac
```

- Prose tier (script unresolvable) → skip the check, continue to B6 (the script is part of the install; a missing install must not strand every build).
- Exit 2, empty output, or output without `diff_lines=`, `review_weight=`, `modules=` and `scope=`, AND `FETCH_OK=0` (the base fetch failed after the 10s/30s/60s retries) → Blocked exit with blocker `github-unavailable: could not fetch origin/{PR_BASE} for scope measurement` (transient; the router retry rule applies).
- The same unmeasurable result with `FETCH_OK=1` → Blocked exit with blocker `scope-check-unavailable: diff-size.sh failed (rc=<N>)`. Either way, do NOT treat an unmeasurable diff as in plan.
- Otherwise parse `diff_lines`, `excluded_lines`, `ws_lines`, `review_weight`, `modules`, `scope` (`ok` | `out_of_plan` | `no_baseline`), `plan_files`, `out_of_plan_count`, `estimate`, `overrun` and the `out_of_plan=` and `top=` lines.

**Step 3 — classify.** `review_depth` is `EXTENDED` when `review_weight` >= `EXT_WEIGHT` or `modules` >= `EXT_MODULES`, else `STANDARD`. The scope is flagged when `scope=out_of_plan` or `overrun=true` (an unparseable `scope=`/`overrun=` reads as flagged, never as clean). A flagged scope also sets `review_depth: EXTENDED`.

**Step 4 — look up an override and decide** (override lookup only when the scope is flagged). The lookup is anchored, trust-filtered through `scripts/trusted-comments.sh` (trusted association, Bot, or `FORGE_TRAIL_TRUSTED_LOGINS`), and fails closed:

```bash
# <Script resolution block from above goes here, verbatim>
set -o pipefail
TRUSTED_SCRIPT="${UNIVERSAL_DIR:+$UNIVERSAL_DIR/trusted-comments.sh}"
[ -n "$TRUSTED_SCRIPT" ] && [ -f "$TRUSTED_SCRIPT" ] || { echo "OVERRIDE_LOOKUP=FAILED (trusted-comments.sh unresolved)"; exit 0; }
OVR=$(gh api --paginate "repos/{GH_REPO}/issues/{NUMBER}/comments" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:SIZE_OVERRIDE') \
  || { echo "OVERRIDE_LOOKUP=FAILED"; exit 0; }
# A valid override has a non-empty justification: the first non-blank, non-marker line after the marker line.
JUSTIFICATION=$(printf '%s\n' "$OVR" | jq -r 'select(type == "string") | split("\n") | .[1:] | map(select(test("\\S") and (test("^\\s*<!--") | not))) | first // empty' | tail -n 1)
if [ -n "$JUSTIFICATION" ]; then echo "OVERRIDE=VALID"; else echo "OVERRIDE=NONE"; fi
```

- `OVERRIDE_LOOKUP=FAILED` → Blocked exit with blocker `scope-check-unavailable: could not read FORGE:SIZE_OVERRIDE` (a transient GitHub failure uses the `github-unavailable:` prefix per the retry rule above). Never read a failed lookup as "no override".
- A marker with an empty justification is not valid.

| Condition | Result | Action |
|-----------|--------|--------|
| scope not flagged, `review_depth=STANDARD` | `OK` | Post/refresh `FORGE:DIFF_SIZE`, continue to B6 |
| scope not flagged, `review_depth=EXTENDED` | `EXTENDED_REVIEW` | Post/refresh `FORGE:DIFF_SIZE` (review extends: more reviewers or per-file slices, read by review-pr), continue to B6. Never a block, never a split |
| scope flagged, valid `FORGE:SIZE_OVERRIDE` | `OVERRIDDEN` | Post/refresh `FORGE:DIFF_SIZE` quoting the justification, `review_depth` as classified (a valid override suppresses only the scope flag, not extended review), continue to B6 |
| scope flagged, no valid override | `SCOPE_FLAGGED` | Flag: list every `out_of_plan=` path and the overrun in the comment so review checks them (a scope-creep note, not a block), `review_depth: EXTENDED`, continue to B6. When `build.scope.trim_out_of_plan` is `true`, also trim (below) |

**Trim out-of-plan scope** (opt-in: `build.scope.trim_out_of_plan: true`, default `false`; only when `out_of_plan_count` is at most `build.scope.trim_max_files`, default 3; never for `overrun=true` alone). Each out-of-plan path's hunks move out of this PR into the batched follow-up checklist (forge#3843) instead of being discarded, so no work is lost:

```bash
# <Script resolution block from above goes here, verbatim>
MB=$(git -C "{WORKTREE_PATH}" merge-base HEAD "origin/{PR_BASE}") || { echo "TRIM=FAILED"; exit 0; }
PATCH_PATH="$(git -C "{WORKTREE_PATH}" rev-parse --git-common-dir)/forge-trimmed-{NUMBER}.patch"
DEFERRED_TSV=""
# OOP_PATHS: the out_of_plan= values, one per line (data, never evaluated)
while IFS= read -r _p; do
  [ -n "$_p" ] || continue
  git -C "{WORKTREE_PATH}" diff --cached --binary "$MB" -- "$_p" >> "$PATCH_PATH" || { echo "TRIM=FAILED"; exit 0; }
  if git -C "{WORKTREE_PATH}" cat-file -e "${MB}:${_p}" 2>/dev/null; then
    git -C "{WORKTREE_PATH}" restore --source="$MB" --staged --worktree -- "$_p" || { echo "TRIM=FAILED"; exit 0; }
  else
    git -C "{WORKTREE_PATH}" rm -q -f --cached -- "$_p" && rm -f -- "{WORKTREE_PATH}/$_p" || { echo "TRIM=FAILED"; exit 0; }
  fi
  DEFERRED_TSV="${DEFERRED_TSV}${_p}"$'\t'"out-of-plan hunks trimmed from #{NUMBER}; saved in ${PATCH_PATH}"$'\t'$'\n'
done <<< "$OOP_PATHS"
printf '%s' "$DEFERRED_TSV" | bash "$(resolve_script 'file-deferred-followups' | sed 's/^[^:]*://')" --parent {NUMBER} --repo {GH_REPO}; echo "DEFERRED_RC=$?"
```

`TRIM=FAILED` or a non-zero `DEFERRED_RC` → do not trim further; keep whatever state is staged, fall back to the flag outcome (`SCOPE_FLAGGED`, nothing lost), and say so in the comment. After a successful trim re-run Step 2 once so `FORGE:DIFF_SIZE` records the trimmed numbers, set `trimmed: <N> file(s) -> #<follow-up>` and result `SCOPE_FLAGGED`.

**Step 5 — record.** Set `DIFF_LINES`, `EXCLUDED_LINES`, `WS_LINES`, `REVIEW_WEIGHT`, `MODULES`, `ESTIMATE`, `SCOPE`, `REVIEW_DEPTH` and `RESULT` from the steps above, then post one `<!-- FORGE:DIFF_SIZE -->` comment, idempotently: find the latest trusted comment starting with the marker and edit it, otherwise create it (on resume never stack duplicates; readers use the latest trusted one). `diff_lines` stays the first field close.md and the protocol read:

```bash
# <Script resolution block from above goes here, verbatim>
BODY="<!-- FORGE:DIFF_SIZE -->
## Diff Size and Scope

diff_lines: ${DIFF_LINES}
excluded_lines: ${EXCLUDED_LINES}
ws_lines: ${WS_LINES}
review_weight: ${REVIEW_WEIGHT}
modules: ${MODULES}
estimated_diff_lines: ${ESTIMATE:-none}
scope: ${SCOPE}
review_depth: ${REVIEW_DEPTH}
result: ${RESULT}
${DEPRECATION_NOTE:-}${SCOPE_NOTE:-}"
_t=$(forge_resolve lib/telemetry.sh); FORGE_REPO="{GH_REPO}" FORGE_ISSUE="{NUMBER}" FORGE_PHASE=build bash "${_t:-/dev/null}" diff_size lines="$DIFF_LINES" excluded="$EXCLUDED_LINES" estimate="${ESTIMATE:-0}" actual="$WS_LINES" review_weight="$REVIEW_WEIGHT" modules="$MODULES" scope="$SCOPE" review_depth="$REVIEW_DEPTH" result="$RESULT" >/dev/null 2>&1 || true # forge#3834 telemetry (final result: estimate vs actual, review_weight, scope outcome, depth)
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
CID=$(gh api --paginate "repos/{GH_REPO}/issues/{NUMBER}/comments" --jq '[.[] | select(.body | startswith("<!-- FORGE:DIFF_SIZE")) | select((.author_association | IN("OWNER","MEMBER","COLLABORATOR")) or (.user.type == "Bot"))] | last | .id // ""' 2>/dev/null || true)
if [ -n "$CID" ]; then run gh api "repos/{GH_REPO}/issues/comments/${CID}" -X PATCH -f body="$BODY" >/dev/null 2>&1 || run gh issue comment {NUMBER} {GH_FLAG} --body "$BODY"
else run gh issue comment {NUMBER} {GH_FLAG} --body "$BODY"; fi
```

`SCOPE_NOTE` carries, one per line, `out_of_plan: <path>` for each out-of-plan file (up to 50), `overrun: <ws_lines> vs estimate <N> (>{OVERRUN_PCT}%)` when `overrun=true`, the `trimmed:` line after a trim, the override justification for `OVERRIDDEN`, and `review-note: <what reviewers should check>` (for example, check the out-of-plan files first). `DEPRECATION_NOTE` is `deprecated_config: build.diff_size.*` plus a newline when an alias supplied a value. A `FORGE:DIFF_SIZE` comment never contains a `### Split Proposal` heading and never routes anywhere: no engine path reads it as a decompose signal.

**Resume**: B5.5 is idempotent. A re-invoked build re-runs B5.5 only through the normal path (B0 resumes at B5/B6 by BUILDER/COMPLETE state); a repeated measure edits the same `FORGE:DIFF_SIZE` comment, and a repeated trim finds the out-of-plan files already gone from the diff.
# MUST CONTINUE to Phase B6 — the scope check result is intermediate, NOT terminal (validation still required), except the Blocked exits above.

---

## Phase B6: Validation (Subcommand)

Invoke the validate subcommand to run the quality gate loop, formatting, and deploy checks:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:validate", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE} --files \"{CHANGED_FILES}\"")
```

Where `{CHANGED_FILES}` is the space-separated list of files changed by the implement subcommand (`files_changed` in `IMPLEMENT_RESULT`, or derive it):

```bash
CHANGED_FILES=$(git -C "{WORKTREE_PATH}" diff --name-only "origin/{PR_BASE}...HEAD" 2>/dev/null | tr '\n' ' ' | xargs)
```

**After subcommand returns** (read its `VALIDATE_RESULT:` block):
- `gate_passed: true` → record `gate_status` (`PASS` or `DEGRADED`) and `degraded_checks` from the `VALIDATE_RESULT:` block for B6.5 (the FORGE:QUALITY_GATE `**Degraded**:` line is the source of truth); a DEGRADED gate never blocks the build. Verify the `FORGE:QUALITY_GATE` marker exists on the issue (posted by validate V5; docs-only changes exempt). If absent, re-derive `{CHANGED_FILES}` with the B6 command above and re-invoke validate once with the full B6 `Skill(...)` call, including `--files "{CHANGED_FILES}"` (never omit `--files`; an empty list falls back to the git diff); a missing marker is not a pass. Then continue to Phase B6.5 (acceptance gate)
- `gate_passed: false` → the subcommand has already posted its comment and added `needs-human`; print `BUILD_RESULT: status: BLOCKED` with the child's `blocker` (run the Blocked exit if no comment was posted)
- Skill not found → Blocked exit, blocker "skill not found: work-on:build:validate"
- Returned running/backgrounded/empty (no `VALIDATE_RESULT:`) → do not end the turn to wait; re-read the `FORGE:QUALITY_GATE` marker (consume it if present) and the worktree state before re-invoking, then re-invoke the same child under the bounded re-invoke rule (at most 2, then `child-stalled: validate`); this cap is separate from the single marker-absent re-invoke above

---

## Phase B6.5: Acceptance Gate (MANDATORY — cannot be silently skipped) <!-- Added: forge#1315 -->

**Goal**: Execute the machine-checkable acceptance spec emitted by investigate Phase 1C and block merge if any check fails. This is a hard gate — not advisory. Run the checks from the worktree (`cd "{WORKTREE_PATH}"`) so relative targets resolve against the built code. This phase may also be entered directly from the B0 gate resume (BRANCH/WORKTREE_PATH/PR_BASE re-derived there) when a prior run left a blocked gate.

**Read acceptance spec from FORGE:INVESTIGATOR comment**:

The spec lines are executed as check targets, so read them only from trusted authors (`scripts/trusted-comments.sh`, resolved by `forge_resolve` from the script resolution block, never the working directory). Unresolvable helper or unreadable comments: fail closed (Blocked exit, run nothing). A spec present only in untrusted comments is no spec (the empty case below). <!-- Added: forge#3813 -->

```bash
# <Script resolution block, verbatim>
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
COMMENTS_JSON=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate 2>/dev/null)
if [ -z "$TRUSTED_SCRIPT" ] || [ -z "$COMMENTS_JSON" ] \
   || ! TRUSTED_BODIES=$(printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:INVESTIGATOR -->'); then
  echo "acceptance spec unreadable: trust helper or comments unavailable (fail closed)"
  # post nothing executable: label needs-human, print BUILD_RESULT: status: BLOCKED, blocker "acceptance spec trust check unavailable"
else
  ACCEPTANCE_CHECKS=$(printf '%s\n' "$TRUSTED_BODIES" | jq -r '.' | grep "^ACCEPTANCE_CHECK:")
fi
```

**If `ACCEPTANCE_CHECKS` is empty** (investigation predates this feature or comment was deleted): post a warning comment and **block** — do not silently pass:

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — No Spec Found

No \`ACCEPTANCE_CHECK:\` lines found in the FORGE:INVESTIGATOR comment. This may mean:
- The investigation was run before acceptance spec emission was added (re-run investigate to generate the spec), or
- The investigator comment was deleted.

**Gate result: BLOCKED** — re-run \`/work-on:investigate {NUMBER}\` to regenerate the acceptance spec, then retry the build.

<!-- FORGE:ACCEPTANCE_GATE:BLOCKED -->"
run gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
```
Print `BUILD_RESULT: status: BLOCKED`, blocker: "No acceptance spec — re-run investigate to emit ACCEPTANCE_CHECK lines".

**If all checks are `type=skipped`**: post a pass comment noting human review is required, then continue to the checkpoint (non-blocking — skip was deliberate):

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — Skipped (No Machine-Checkable Criteria)

The acceptance spec contains only a skip sentinel (\`type=skipped\`). No automated checks were run. Human review is required before merge.

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"
```

**Otherwise — execute each check**: <!-- Added: forge#1829 -->

```bash
# <Script resolution block, verbatim>
GREP_CLS=$(forge_resolve classify-grep-exit.sh) # empty/unresolved = every grep exit>=2 is a real FAIL (fail closed)
GATE_PASS=true
CORRECTED=""
FAILED_CHECKS=""
VERIFIED_COUNT=0       # checks actually executed and judged (PASS or FAIL); malformed ones do not count
MALFORMED_CHECKS=""   # malformed-check: generated check that can never pass; reported, never repaired, never needs-human
DEFERRED_COUNT=0       # phase=review checks (and legacy "no pull requests found" results): evaluated by review R2.5, never counted here
DEFERRED_CHECKS=""    # <!-- Added: forge#3793 -->
MANUAL_CHECKS=""      # per-check type=skipped (manual / post-deploy): never executed, listed as unchecked follow-ups <!-- Added: forge#3825 -->
SPEC_DEFECT=false     # nothing verifiable: a spec defect that code repair cannot fix <!-- Added: forge#3825 -->

while IFS= read -r check_line; do
  # Fields are extracted by anchoring each sed pattern to `^ACCEPTANCE_CHECK:` and walking
  # through the fixed field order from investigate.md (id= type= target="..." matcher="..."
  # description=<free text to EOL>) instead of truncating the line before extraction. This
  # is deliberate: description= is unconstrained free text and can legitimately contain
  # key="value"-shaped substrings (e.g. `description=works when target="prod"`), while
  # target=/matcher= are themselves free-form shell commands/regexes and can legitimately
  # contain the literal substring "description=" (e.g. `target="grep -c description= file"`).
  # A prior fix truncated the line at the first description= to keep free text from being
  # mistaken for a real field — but that truncation then broke whenever a *real* target=/
  # matcher= value contained "description=" text, cutting mid-quote. Anchoring from the start
  # of the line through each preceding field in order avoids truncation entirely: every
  # anchored pattern matches only the one fixed position where that field can occur, so
  # neither direction of collision (fake fields inside description=, or description=-like
  # text inside target=/matcher=) can hijack extraction. Falls back to the full line
  # unchanged if a field is absent (no-op, safe for malformed lines).
  ID=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=\([^ ]*\) type=.*/\1/p')
  TYPE=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=\([^ ]*\) target=.*/\1/p')
  # target=/matcher= are quoted (target="..." matcher="...") per the investigate.md wire format —
  # quoting is required so multi-word/piped shell-command values (e.g. `target="grep -qE '...' file"`)
  # survive extraction instead of being truncated at the first space. The quote-bounded pattern
  # (`"\([^"]*\)"`) captures everything up to the next literal quote verbatim, including a literal
  # "description=" substring inside the value. Fall back to the legacy unquoted [^ ]* extraction
  # only for older ACCEPTANCE_CHECK comments emitted before this fix (still correct for
  # single-token exists/contains targets; multi-word legacy targets remain truncated until the
  # issue's investigation is re-run to emit the quoted format).
  # Quoted fields may contain escaped quotes (matcher="return \"$HELD\""): match (\\.|[^"\\])* and unescape.
  # A plain [^"]* stops at the first \" and silently checks a truncated matcher (field test #3167).
  TARGET=$(printf '%s\n' "$check_line" | sed -nE 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target="(([^"\\]|\\.)*)".*/\1/p' | sed 's/\\"/"/g')
  [ -z "$TARGET" ] && TARGET=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=\([^ ]*\).*/\1/p')
  MATCHER=$(printf '%s\n' "$check_line" | sed -nE 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=("([^"\\]|\\.)*"|[^ ]*) matcher="(([^"\\]|\\.)*)".*/\3/p' | sed 's/\\"/"/g')
  [ -z "$MATCHER" ] && MATCHER=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=[^ ]* matcher=\([^ ]*\).*/\1/p')
  DESC=$(echo "$check_line"  | sed -n 's/.*description=\(.*\)/\1/p')
  # phase= (optional, after matcher=, before description=): `review` defers the check to review R2.5 (the PR does not exist yet at build time).
  # Anchored after the matcher field so `phase=` text inside description/target/matcher cannot hijack it; any other value or an absent token is `build` (fail closed).
  PHASE=$(printf '%s\n' "$check_line" | sed -nE 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=("(([^"\\]|\\.)*)"|[^ ]*) matcher=("(([^"\\]|\\.)*)"|[^ ]*) phase=(build|review)( .*)?$/\7/p')
  [ "$PHASE" = "review" ] || PHASE=build

  [ "$TYPE" = "skipped" ] && { MANUAL_CHECKS="${MANUAL_CHECKS}\n- [ ] **$ID** ($DESC)"; continue; }

  # Deferred (review) <!-- Added: forge#3793 -->: never executed, never VERIFIED, never GATE_PASS=false, never in FAILED_CHECKS / --fix-acceptance.
  if [ "$PHASE" = "review" ]; then DEFERRED_COUNT=$((DEFERRED_COUNT+1)); DEFERRED_CHECKS="${DEFERRED_CHECKS}\n- **$ID** ($DESC): DEFERRED (review)"; continue; fi

  # malformed-check <!-- Added: forge#3694 -->: a generated command/behavior target that can never pass is a
  # check defect, not an implementation failure. Static detection only parses (bash -n), never executes.
  MALFORMED=""
  { [ "$TYPE" = "command" ] || [ "$TYPE" = "behavior" ]; } && { case "$TARGET" in *'\\\\'*) MALFORMED="run of 4+ backslashes (over-escaped target)";; esac; [ -n "$MALFORMED" ] || bash -n -c "$TARGET" 2>/dev/null || MALFORMED="shell syntax error (unbalanced quotes)"; }
  { [ "$TYPE" = "command" ] || [ "$TYPE" = "behavior" ]; } && [ -z "$MALFORMED" ] && case "$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" in none) MALFORMED='target "none" is not a command (a manual criterion must be type=skipped)';; esac
  if [ -n "$MALFORMED" ]; then MALFORMED_CHECKS="${MALFORMED_CHECKS}\n- **$ID** ($DESC): $MALFORMED"; continue; fi

  RESULT="PASS"
  DETAIL=""
  ERR=""

  case "$TYPE" in
    exists)
      [ -e "$TARGET" ] || { RESULT="FAIL"; DETAIL="path not found: $TARGET"; }
      ;;
    contains)
      # A matcher is usually literal code; an unescaped $ ( [ . turns it into a different regex. Accept a
      # literal match and record the correction instead of failing the build on a malformed check.
      if ! grep -qE "$MATCHER" "$TARGET" 2>/dev/null; then
        if grep -qF -- "$MATCHER" "$TARGET" 2>/dev/null; then CORRECTED="${CORRECTED}\n- **$ID**: matched as a literal string (the regex form could not match)"
        else RESULT="FAIL"; DETAIL="'$MATCHER' not found in $TARGET"; fi
      fi
      ;;
    command|behavior)
      if [ "$MATCHER" = "exit_0" ]; then
        ERR=$(eval "$TARGET" 2>&1 >/dev/null); RC=$?
        # grep exit >= 2 is a usage/syntax error (e.g. a pattern starting with `-`), never a verdict on the code; exit 1 stays FAIL.
        # Malformed only when stderr positively names a usage error (classify-grep-exit.sh); empty stderr (`2>/dev/null`, `-s`) or any operand error is a REAL failure.
        [ "$RC" -ge 2 ] && MALFORMED=$(bash "$GREP_CLS" "$RC" "$ERR" "$TARGET" 2>/dev/null)
        [ "$RC" -eq 127 ] && [ -z "$MALFORMED" ] && printf '%s' "$ERR" | grep -qF 'command not found' && MALFORMED="command not found (rc 127): the target is not an executable command"
        [ "$RC" -eq 0 ] || [ -n "$MALFORMED" ] || { RESULT="FAIL"; DETAIL="command exited non-zero: $TARGET"; }
      else
        ERRF=$(mktemp); OUTPUT=$(eval "$TARGET" 2>"$ERRF"); RC=$?; ERR=$(cat "$ERRF"); rm -f "$ERRF"; [ -z "$ERR" ] || OUTPUT="${OUTPUT}${OUTPUT:+$'\n'}${ERR}" # classify on stderr only, match on both
        [ "$RC" -ge 2 ] && MALFORMED=$(bash "$GREP_CLS" "$RC" "$ERR" "$TARGET" 2>/dev/null)
        [ "$RC" -eq 127 ] && [ -z "$MALFORMED" ] && printf '%s' "$ERR" | grep -qF 'command not found' && MALFORMED="command not found (rc 127): the target is not an executable command"
        if [ -n "$MALFORMED" ]; then :
        elif ! printf '%s\n' "$OUTPUT" | grep -qE "$MATCHER"; then
          if printf '%s\n' "$OUTPUT" | grep -qF -- "$MATCHER"; then CORRECTED="${CORRECTED}\n- **$ID**: output matched as a literal string"
          else RESULT="FAIL"; DETAIL="output did not match '$MATCHER'. Got: $(printf '%s\n' "$OUTPUT" | head -3)"; fi
        fi
      fi
      ;;
    *)
      RESULT="FAIL"; DETAIL="unknown check type: $TYPE"
      ;;
  esac

  if [ -n "$MALFORMED" ]; then MALFORMED_CHECKS="${MALFORMED_CHECKS}\n- **$ID** ($DESC): $MALFORMED"; continue; fi

  # Legacy fallback (any phase tag): a gh pr check that finds no PR is waiting on the review phase, not failing.
  if [ "$RESULT" = "FAIL" ] && printf '%s' "$ERR" | grep -qF 'no pull requests found'; then
    case "$TARGET" in *'gh pr'*) DEFERRED_COUNT=$((DEFERRED_COUNT+1)); DEFERRED_CHECKS="${DEFERRED_CHECKS}\n- **$ID** ($DESC): DEFERRED (review) (no pull request exists yet)"; continue;; esac
  fi

  VERIFIED_COUNT=$((VERIFIED_COUNT+1))
  if [ "$RESULT" = "FAIL" ]; then
    GATE_PASS=false
    FAILED_CHECKS="${FAILED_CHECKS}\n- **$ID** ($DESC): $DETAIL"
  fi
done <<< "$ACCEPTANCE_CHECKS"

# A gate that verified nothing must not pass: with every check skipped as malformed, PASSED would be a green light on zero evidence.
# A spec whose checks are all deferred to review (DEFERRED_COUNT > 0) is not vacuous: review R2.5 evaluates them before merge.
if [ "$VERIFIED_COUNT" -eq 0 ] && [ "$DEFERRED_COUNT" -eq 0 ]; then
  # spec-defect <!-- Added: forge#3825 -->: only the spec is wrong, so this is a BLOCKED verdict that never enters the --fix-acceptance repair (#3774).
  GATE_PASS=false
  SPEC_DEFECT=true
fi
```

**Gate status (DEGRADED)** <!-- Added: forge#3628 -->: `GATE_STATUS` and `DEGRADED_LIST` come from the B6 `VALIDATE_RESULT` (`gate_status`, `degraded_checks`). When B6.5 is entered without one (B0 gate resume), read them from the `**Degraded**:` line of the newest trusted `FORGE:QUALITY_GATE` comment; an unreadable lookup is DEGRADED, never a pass. A DEGRADED gate means a test run exercised nothing, a known-slow test was skipped, or the blast-radius check did not complete. It does not fail the build: when every check passes, the gate closes with `<!-- FORGE:ACCEPTANCE_GATE:DEGRADED -->` instead of `:PASSED` and lists the degraded checks. Review must cover each one before merge (`scripts/review-finalize.sh`, `degraded-gate-unreviewed`).

```bash
# <Script resolution block, verbatim>
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
if [ -z "${GATE_STATUS:-}" ]; then
  GATE_STATUS=PASS; DEGRADED_LIST=""
  if [ -z "$TRUSTED_SCRIPT" ] || ! QG_COMMENTS=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments 2>/dev/null) \
     || ! QG_BODIES=$(printf '%s' "$QG_COMMENTS" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:QUALITY_GATE -->'); then
    GATE_STATUS=DEGRADED; DEGRADED_LIST="quality-gate — degraded state unreadable"
  else
    DEGRADED_LIST=$(printf '%s\n' "$QG_BODIES" | tail -n 1 | jq -r 'select(type == "string")' | sed -n 's/^\*\*Degraded\*\*: //p' | head -n 1)
    case "$DEGRADED_LIST" in ''|none) DEGRADED_LIST="" ;; *) GATE_STATUS=DEGRADED ;; esac
  fi
fi
[ "$GATE_STATUS" = "DEGRADED" ] && [ -z "${DEGRADED_LIST:-}" ] && DEGRADED_LIST="unspecified (see FORGE:QUALITY_GATE)"
```

**Post gate result comment**:

```bash
# <Script resolution block, verbatim>
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
_nf=$(printf '%b' "$FAILED_CHECKS" | grep -c '^- ' || true); _nm=$(printf '%b' "$MALFORMED_CHECKS" | grep -c '^- ' || true); _t=$(forge_resolve lib/telemetry.sh)
[ -n "${DRY_RUN:-}" ] || FORGE_REPO="{GH_REPO}" FORGE_ISSUE="{NUMBER}" FORGE_PHASE=build bash "${_t:-/dev/null}" acceptance_gate phase=build verified="$VERIFIED_COUNT" failed="${_nf:-0}" malformed="${_nm:-0}" deferred="$DEFERRED_COUNT" >/dev/null 2>&1 || true # forge#3834 telemetry
if [ "$SPEC_DEFECT" = "true" ]; then
  run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — BLOCKED (spec-defect)

No acceptance check could be verified: every check was malformed, manual, or empty. The implementation is not at fault and a code repair cannot fix this, so the repair step is skipped.
$( [ -n "$MALFORMED_CHECKS" ] && printf '\n**malformed-check**:%b\n' "$MALFORMED_CHECKS" )
$( [ -n "$MANUAL_CHECKS" ] && printf '\n**Manual follow-up (type=skipped; not verified at build time)**:%b\n' "$MANUAL_CHECKS" )

**Gate result: BLOCKED** — regenerate the acceptance spec by re-running \`/work-on:investigate {NUMBER}\`, then retry the build.

<!-- FORGE:ACCEPTANCE_GATE:BLOCKED -->"
  run gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
elif [ "$GATE_PASS" = "true" ]; then
  GATE_MARKER=PASSED; [ "${GATE_STATUS:-PASS}" = "DEGRADED" ] && GATE_MARKER=DEGRADED
  run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — ${GATE_MARKER}

All machine-checkable build-phase acceptance criteria verified against real behavior.
$( [ "$GATE_MARKER" = "DEGRADED" ] && printf '\n**Degraded checks (verified nothing; the review must name each one under `### Degraded Paths Reviewed` before merge)**: %s\n' "$DEGRADED_LIST" )
$( [ -n "$DEFERRED_CHECKS" ] && printf '\n**Deferred to review (phase=review; evaluated against the PR before merge)**:%b\n' "$DEFERRED_CHECKS" )
$( [ -n "$MANUAL_CHECKS" ] && printf '\n**Manual follow-up (type=skipped; not verified at build time, confirm after merge/deploy)**:%b\n' "$MANUAL_CHECKS" )
$( [ -n "$CORRECTED" ] && printf '\n**Checks corrected (malformed matcher, literal text present)**:%b\n' "$CORRECTED" )
$( [ -n "$MALFORMED_CHECKS" ] && printf '\n**malformed-check (not counted as failures; regenerate the acceptance spec by re-running investigate)**:%b\n' "$MALFORMED_CHECKS" )

<!-- FORGE:ACCEPTANCE_GATE:${GATE_MARKER} -->"
else
  run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — FAILED

The following acceptance checks did not pass:

$(echo -e "$FAILED_CHECKS")
$( [ -n "$MALFORMED_CHECKS" ] && printf '\n**malformed-check (not counted as failures; regenerate the acceptance spec by re-running investigate)**:%b\n' "$MALFORMED_CHECKS" )

Merge is blocked. Fix the failing criteria and re-run the validate phase.

<!-- FORGE:ACCEPTANCE_GATE:FAILED -->"
  run gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
fi
```

A `malformed-check` (a command/behavior target with a run of 4+ backslashes or a `bash -n` syntax error, or a grep target exiting >= 2 for a reason other than a missing/unreadable operand file, which stays a real FAIL) is reported in the comment and never sets `GATE_PASS=false` by itself, never enters `FAILED_CHECKS`, is never passed to `--fix-acceptance`, and never adds `needs-human` by itself; the gate still posts exactly one of PASSED/FAILED. The gate never posts PASSED with zero verified checks: if every check was malformed (`VERIFIED_COUNT=0` and `DEFERRED_COUNT=0`) it is a spec-defect: it posts `FORGE:ACCEPTANCE_GATE:BLOCKED`, adds `needs-human`, prints `BUILD_RESULT: status: BLOCKED` (blocker: "regenerate acceptance spec via investigate") and skips the `--fix-acceptance` repair entirely, because implement cannot fix a spec defect. <!-- Added: forge#3694, forge#3825 -->

Also `malformed-check` <!-- Added: forge#3825 -->: a `command`/`behavior` target that is literally `none` (any case), or that exits 127 with `command not found` on stderr. Classification keys on that stderr text, never on the code alone: a missing script (a `bash` run of a nonexistent script path, with `No such file or directory`) also exits 127 and stays a real FAIL, so the missing-operand class is not reopened. A per-check `type=skipped` is never executed, never counted, and is listed under "Manual follow-up" as unchecked items in the PASSED comment.

A `phase=review` check (or, for legacy specs, tagged or not, a `command`/`behavior` check on a `gh pr` target whose output contains `no pull requests found`) is recorded as `DEFERRED (review)` in the PASSED comment: it is never executed here, never counted in `VERIFIED_COUNT`, never sets `GATE_PASS=false`, never enters `FAILED_CHECKS` or `--fix-acceptance`, and never spends the repair. A spec whose checks are all deferred posts PASSED (it is not "No Spec Found"). Review R2.5 evaluates the deferred checks against the real PR and blocks merge on failure. <!-- Added: forge#3793 -->

If `SPEC_DEFECT = true`: leave `needs-human`, print `BUILD_RESULT: status: BLOCKED`, blocker: "regenerate acceptance spec via investigate (spec-defect: no check could be verified)", and do NOT run the repair below.

If `GATE_PASS = false` and `SPEC_DEFECT` is not `true`, the build repairs itself **once** before anything escalates (a failing acceptance check is pipeline work, not a human decision):

1. Count `<!-- FORGE:ACCEPTANCE_REPAIR: issue={NUMBER} -->` comments on the issue. If one already exists, skip to step 4.
1.5. **Decomposition guard** <!-- Added: forge#3543 -->: read the `### Decomposition Assessment` of the latest FORGE:INVESTIGATOR comment. If it is `**YES**`, a failing check that belongs to a sub-item the assessment assigns to a separate issue (named in the check's `description`/`# item-N` tag, or matching a listed sub-issue title) is NOT repaired: exclude it from the `--fix-acceptance` list. When ambiguous, treat the check as decomposed-out (fail safe). If every remaining failure is decomposed-out, do not invoke implement: leave `needs-human` and print `BUILD_RESULT: status: BLOCKED`, blocker: "acceptance check {ID} belongs to decomposed item {N} — repair refuses to implement work the investigator assigned to a separate issue".
2. Post that marker (with the failed check ids), remove `needs-human` if this gate added it, then invoke
   `Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:implement", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE} --fix-acceptance \"<failed check ids and details>\"")`
   then re-derive `{CHANGED_FILES}` from the repaired worktree (never reuse the pre-repair value, and never omit `--files`; an empty list falls back to this diff):
   ```bash
   CHANGED_FILES=$(git -C "{WORKTREE_PATH}" diff --name-only "origin/{PR_BASE}...HEAD" 2>/dev/null | tr '\n' ' ' | xargs)
   ```
   and invoke validate explicitly (the new code gets a fresh quality gate and commit):
   `Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:validate", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE} --files \"{CHANGED_FILES}\"")`
3. Re-run this whole B6.5 gate. PASS → continue to the checkpoint.
4. Still failing (or already repaired once) → leave `needs-human` and print `BUILD_RESULT: status: BLOCKED`, blocker: "Acceptance gate failed after one repair — see FORGE:ACCEPTANCE_GATE comment".

If `GATE_PASS = true`: continue to write the phase checkpoint below.

**When the gate passed — write machine-readable phase checkpoint before returning (MANDATORY)**:
```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"BUILD\", \"status\": \"COMPLETE\", \"next_phase\": \"REVIEW\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```

---

## Output

Print this structured block as your final reply (and nothing after it) — the router reads only this block, re-evaluates state, and continues to the next phase. Heartbeats are posted by the router, not here.

```
BUILD_RESULT:
  status: COMPLETE | ALREADY_DONE | INVESTIGATION_COMPLETE | BLOCKED
  branch: {BRANCH}
  worktree: {WORKTREE_PATH}
  blocker: {description if status=BLOCKED}
```

- `COMPLETE` — B0–B6.5 all passed (a DEGRADED acceptance gate, `FORGE:ACCEPTANCE_GATE:DEGRADED`, counts as passed here); `FORGE:BUILDER:COMPLETE` is on the issue.
- `ALREADY_DONE` — B0 found `FORGE:BUILDER:COMPLETE`.
- `INVESTIGATION_COMPLETE` — the implement child created the deliverable issues (B5); no review follows.
- B5.5 never produces a `BUILD_RESULT` status of its own: its scope-check outcome (`OK`, `EXTENDED_REVIEW`, `SCOPE_FLAGGED`, `OVERRIDDEN`) is recorded in `FORGE:DIFF_SIZE`, then the build continues to B6 and ends `COMPLETE`. A finished build is never routed to decompose or discarded. <!-- Added: forge#3862 -->
- `BLOCKED` — any guard or failure; `needs-human` is set and the blocker is posted.

---

## Integration Point

Position in the work-on pipeline (label `workflow:ready-to-build` or `workflow:building`):

```
investigate → [THIS MODULE] worktree + classify + contract + context + architect + implement + validate + acceptance-gate
              → posts FORGE:FAST_PATH, FORGE:CONTRACT, FORGE:BUILDER(:COMPLETE), FORGE:ACCEPTANCE_GATE; writes FORGE:CHECKPOINT next_phase=REVIEW
            → work-on:review (push branch, create PR, review, merge)
            → work-on:close
```
