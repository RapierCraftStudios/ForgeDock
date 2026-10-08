---
user-invocable: false
description: Build subcommand — create worktree, post contract, sequence context/architect/implement/validate
context: fork
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

**CRITICAL: You MUST execute ALL phases B0–B6.5 in order. Every child (B3 context, B4 architect, B5 implement, B6 validate) is invoked via `Skill(...)` — each is a forked sub-skill with its own isolated context. B3 and B4 are invoked for every complexity band except where the band is TRIVIAL or INVESTIGATION (B2/B2.1/B2.5 are also skipped for INVESTIGATION); the children post their own skip markers, so a skipped child is still visible on the issue. Skipping a child without the band justification degrades build quality and fails the phase-trail check.**

**Synchronous child consumption**: each child `Skill(...)` call (B3-B6) runs to completion in this phase's own turn, and you consume its result in that same turn. Never end or yield your turn to wait for a child, and never wait for a completion notification: notifications for forked children go to the root session, not to this phase, so a turn that yields is never resumed. A child return with no `*_RESULT:` block (running, backgrounded, empty) is not a result — re-read the GitHub markers for that child (`FORGE:CONTEXT`, `FORGE:ARCHITECT`, `FORGE:BUILDER`, `FORGE:VALIDATE`/`FORGE:QUALITY_GATE`) and re-invoke the same child with the same args.

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
# ForgeDock's own install root (holds scripts/ and commands/), resolved ONCE by the canonical bootstrap
# below — never the consumer repo: plugin installs set neither FORGE_HOME nor FORGEDOCK_HOME, and a
# repo-relative fallback would execute (or miss) a same-named script controlled by the consumer repo.
# Resolution: $FORGEDOCK_HOME (authoritative when set) > $FORGE_HOME > $CLAUDE_PLUGIN_ROOT > the
# ~/.claude/commands symlink target > the Claude Code plugin cache/marketplace dirs. <!-- forge#3098 -->
# FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
FORGE_ROOT=""
# Windows drive-letter FORGEDOCK_HOME (C:/x or C:\x) is normalized to /c/x (cygpath when present); relative values stay rejected.
_h="${FORGEDOCK_HOME:-}"; case "$_h" in [A-Za-z]:[/\\]*) _w="$_h"; _h="$(cygpath -u "$_w" 2>/dev/null || true)"; [ -n "$_h" ] || _h="/$(printf %s "$_w" | cut -c1 | tr 'A-Z' 'a-z')$(printf %s "${_w#??}" | tr '\\' '/')" ;; esac
# Only the official marketplace is trusted (name pinned; override only via the trusted FORGEDOCK_MARKETPLACE env, never repo files).
_mk="${FORGEDOCK_MARKETPLACE:-forgedock}"; case "$_mk" in ""|.|..|*[!A-Za-z0-9._-]*) _mk="forgedock" ;; esac
if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$_h" in /*) FORGE_ROOT="$_h" ;; esac; else
  # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match). Every assignment ends in || true so the block survives set -e / pipefail.
  _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null || true)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
  # Codex: install-codex.sh records the clone path in $CODEX_HOME/forge-home (one absolute path); skills are generated files, not symlinks.
  _x="$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null || true)"
  # newest cached version first: numeric major.minor.patch of the version dir name only (non-semver names such as commit SHAs are skipped); a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ -v mk="$_mk" '$(NF-2)==mk && $(NF-1)=="forgedock" && $NF ~ /^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$/{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5- || true)"
  _m="$HOME/.claude/plugins/marketplaces/$_mk"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_x" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
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
  local operation="$1"
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

# Check investigation report
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Check if build already completed (require FORGE:BUILDER:COMPLETE — not just FORGE:BUILDER)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body'

# Existing classification from a prior run (resume path)
EXISTING_FAST_PATH=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | select(.body | contains("FORGE:FAST_PATH")) | .body' 2>/dev/null | head -1)
```

**Resume check**:
- If `<!-- FORGE:BUILDER:COMPLETE -->` is present in a BUILDER comment → build already complete. Derive BRANCH/WORKTREE_PATH as in B1A/B1C (without creating anything), then print `BUILD_RESULT: status: ALREADY_DONE`.
- If `<!-- FORGE:BUILDER -->` exists BUT `<!-- FORGE:BUILDER:COMPLETE -->` is ABSENT → build was interrupted after the comment was posted but before the commit (validate V5). Delete the partial comment and restart from Phase B2 (contract): <!-- Added: forge#1305 -->
  ```bash
  PARTIAL_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
    --jq '[.[] | select(.body | contains("FORGE:BUILDER") and (contains("FORGE:BUILDER:COMPLETE") | not))] | last | .id // ""')
  if [ -n "$PARTIAL_ID" ]; then
    gh api repos/{GH_REPO}/issues/comments/$PARTIAL_ID -X DELETE
    echo "Deleted partial FORGE:BUILDER comment (no FORGE:BUILDER:COMPLETE) — restarting build from Phase B2"
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

If `--branch` was passed, or a local/remote branch already exists whose name ends in `-{NUMBER}` (`git branch -a --list "*-{NUMBER}"`), reuse it (resume). Otherwise derive from the issue title: lowercase, hyphenated, max 40 chars (truncate if needed).
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
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

---

## Phase B2: Post Builder Contract (skip for INVESTIGATION)

**Skip if COMPLEXITY_BAND: INVESTIGATION** — go to B5. For every other band (TRIVIAL included) the contract is mandatory. If a `FORGE:CONTRACT` comment already exists on the issue (resume), do not post a second one — continue to B2.1.

Post `<!-- FORGE:CONTRACT -->` comment documenting what will be built and why:

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
- Returned running/backgrounded/empty (no `CONTEXT_RESULT:`) → do not end the turn; re-read for a `FORGE:CONTEXT` marker, re-invoke the same child if absent (advisory rules above still apply once it returns)
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
- Returned running/backgrounded/empty → do not end the turn to wait; re-read markers and re-invoke the same child (the marker fallback above applies only after a real return)
# MUST CONTINUE to Phase B5 — architect result is intermediate, NOT terminal.

---

## Phase B5: Implementation (Subcommand)

Invoke the implement subcommand to write code, stage, and post the builder comment:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:implement", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE}")
```

**After subcommand returns** (read its `IMPLEMENT_RESULT:` block):
- `status: COMPLETE` → continue to B6
- `status: ALREADY_DONE` → continue to B6 (validate what's already there)
- `status: INVESTIGATION_COMPLETE` → issues were created as deliverables and the original closed; print `BUILD_RESULT: status: INVESTIGATION_COMPLETE` (skip B6/B6.5)
- `status: BLOCKED` → Blocked exit with the child's `blocker`
- Skill not found → Blocked exit, blocker "skill not found: work-on:build:implement"
- Returned running/backgrounded/empty (no `IMPLEMENT_RESULT:`) → do not end the turn to wait; re-read the `FORGE:BUILDER` comment and the worktree state, then re-invoke the same child
# MUST CONTINUE to Phase B6 — implement result is intermediate, NOT terminal (validation still required).

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
- `gate_passed: true` → verify the `FORGE:QUALITY_GATE` marker exists on the issue (posted by validate V5; docs-only changes exempt). If absent, re-invoke validate once; a missing marker is not a pass. Then continue to Phase B6.5 (acceptance gate)
- `gate_passed: false` → the subcommand has already posted its comment and added `needs-human`; print `BUILD_RESULT: status: BLOCKED` with the child's `blocker` (run the Blocked exit if no comment was posted)
- Skill not found → Blocked exit, blocker "skill not found: work-on:build:validate"
- Returned running/backgrounded/empty (no `VALIDATE_RESULT:`) → do not end the turn to wait; re-read the `FORGE:QUALITY_GATE` marker and re-invoke the same child

---

## Phase B6.5: Acceptance Gate (MANDATORY — cannot be silently skipped) <!-- Added: forge#1315 -->

**Goal**: Execute the machine-checkable acceptance spec emitted by investigate Phase 1C and block merge if any check fails. This is a hard gate — not advisory. Run the checks from the worktree (`cd "{WORKTREE_PATH}"`) so relative targets resolve against the built code.

**Read acceptance spec from FORGE:INVESTIGATOR comment**:

```bash
ACCEPTANCE_CHECKS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | grep "^ACCEPTANCE_CHECK:" )
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
GATE_PASS=true
CORRECTED=""
FAILED_CHECKS=""

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

  [ "$TYPE" = "skipped" ] && continue

  RESULT="PASS"
  DETAIL=""

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
        eval "$TARGET" >/dev/null 2>&1 || { RESULT="FAIL"; DETAIL="command exited non-zero: $TARGET"; }
      else
        OUTPUT=$(eval "$TARGET" 2>&1)
        if ! printf '%s\n' "$OUTPUT" | grep -qE "$MATCHER"; then
          if printf '%s\n' "$OUTPUT" | grep -qF -- "$MATCHER"; then CORRECTED="${CORRECTED}\n- **$ID**: output matched as a literal string"
          else RESULT="FAIL"; DETAIL="output did not match '$MATCHER'. Got: $(printf '%s\n' "$OUTPUT" | head -3)"; fi
        fi
      fi
      ;;
    *)
      RESULT="FAIL"; DETAIL="unknown check type: $TYPE"
      ;;
  esac

  if [ "$RESULT" = "FAIL" ]; then
    GATE_PASS=false
    FAILED_CHECKS="${FAILED_CHECKS}\n- **$ID** ($DESC): $DETAIL"
  fi
done <<< "$ACCEPTANCE_CHECKS"
```

**Post gate result comment**:

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
if [ "$GATE_PASS" = "true" ]; then
  run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — PASSED

All machine-checkable acceptance criteria verified against real behavior.
$( [ -n "$CORRECTED" ] && printf '\n**Checks corrected (malformed matcher, literal text present)**:%b\n' "$CORRECTED" )

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"
else
  run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — FAILED

The following acceptance checks did not pass:

$(echo -e "$FAILED_CHECKS")

Merge is blocked. Fix the failing criteria and re-run the validate phase.

<!-- FORGE:ACCEPTANCE_GATE:FAILED -->"
  run gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
fi
```

If `GATE_PASS = false`, the build repairs itself **once** before anything escalates (a failing acceptance check is pipeline work, not a human decision):

1. Count `<!-- FORGE:ACCEPTANCE_REPAIR: issue={NUMBER} -->` comments on the issue. If one already exists, skip to step 4.
2. Post that marker (with the failed check ids), remove `needs-human` if this gate added it, then invoke
   `Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:implement", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE} --fix-acceptance \"<failed check ids and details>\"")`
   followed by `work-on:build:validate` with the same args as B6 (the new code gets a fresh quality gate and commit).
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

- `COMPLETE` — B0–B6.5 all passed; `FORGE:BUILDER:COMPLETE` is on the issue.
- `ALREADY_DONE` — B0 found `FORGE:BUILDER:COMPLETE`.
- `INVESTIGATION_COMPLETE` — the implement child created the deliverable issues (B5); no review follows.
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
