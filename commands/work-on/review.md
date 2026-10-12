---
user-invocable: false
description: Review subcommand — push branch, create PR, invoke /review-pr with --auto-merge
context: fork
background: false
argument-hint: "{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE} --branch {BRANCH} --base {PR_BASE}"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/review — Review & PR Creation Subcommand

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

> **Transient GitHub failures** (field test: a 12-minute GitHub HTTP 500 window parked an issue at needs-human): retry any `gh` call that fails with HTTP 5xx, a timeout or "Something went wrong" up to 3 times with 10s/30s/60s backoff. If it still fails, do NOT add `needs-human` — print this phase's RESULT block with `status: BLOCKED` and a blocker that starts with `github-unavailable:`. The router retries the phase; every phase resumes from GitHub state, so a retry is safe.


**Invoked by**: the `work-on` router, after `build/validate.md` returns `GATE_PASSED: true`.
**Output**: Push branch, create PR, invoke /review-pr --auto-merge, verify the merge, and print exactly one `REVIEW_RESULT:` block as the final reply (all paths, including every guard/failure).

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. This file's mechanical bits (label transitions, `FORGE:CHECKPOINT` writes) stay at this tier because they're interleaved with the review/merge-decision steps in the same `Skill()` invocation — see `work-on.md` section "Model and Effort Tiering — What Actually Applies". <!-- Added: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/review.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree
- `--branch {BRANCH}` — feature branch name (e.g. `feat/my-feature`)
- `--base {PR_BASE}` — PR target branch (e.g. `milestone/modular-pipeline-architecture` or `staging`). **Required.** The caller has already computed it and validated it against the classified lane; this skill never recomputes or re-validates the lane.

**Fail closed**: if `{NUMBER}`, `--repo`, `--worktree`, `--branch` or `--base` is missing, print the block below and STOP (no push, no PR):

```
REVIEW_RESULT:
  status: BLOCKED
  pr_number:
  pr_url:
  merged_to:
  blocker: missing required arg: --base (or --worktree/--branch/--repo/NUMBER)
```

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

**BLOCKED output pattern**: every guard below that stops the phase prints the result block before exiting, e.g.:

```bash
printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: %s\n' "<blocker text>"
```

---

## Phase R0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Get builder comment (for branch + commit info)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body'

# Check if PR already exists for this branch
gh pr list {GH_FLAG} --head {BRANCH} --json number,state,url 2>/dev/null
```

**Resume check**:
- If PR already exists AND is OPEN → run the **HEAD-unchanged re-review guard** below before proceeding to Phase R3
- If PR already exists AND is MERGED → write the REVIEW checkpoint (same JSON as Phase R4) if one does not already exist, then return `REVIEW_RESULT: status: ALREADY_MERGED`:
  ```bash
  [ "${DRY_RUN:-false}" = "true" ] && { echo "[DRY_RUN] would post the comment below"; exit 0; }
  MERGED_PR=$(gh pr list {GH_FLAG} --head {BRANCH} --state merged --json number --jq '.[0].number' 2>/dev/null)
  HAS_REVIEW_CKPT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
    --jq '[.[] | select((.body | contains("FORGE:CHECKPOINT")) and (.body | contains("\"phase\": \"REVIEW\"")))] | length' 2>/dev/null | tail -1)
  if [ "${HAS_REVIEW_CKPT:-0}" -eq 0 ]; then
    CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
  \`\`\`json
  {\"phase\": \"REVIEW\", \"status\": \"COMPLETE\", \"next_phase\": \"CLOSE\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
  \`\`\`" # allowlist:check-command-side-effects
  fi
  ```
  (`pr_number` in the result is `$MERGED_PR`.)
- If no `<!-- FORGE:BUILDER -->` comment exists → print `REVIEW_RESULT: status: BLOCKED`, blocker: "FORGE:BUILDER comment not found — implement phase may not have completed"

**HEAD-unchanged re-review guard** (MANDATORY when a PR already exists and is OPEN) <!-- Added: forge#2243 --> — a PR whose most recent review verdict was CHANGES REQUESTED must not be resubmitted for a full domain-agent review fan-out if nothing has changed since that verdict. `/review-pr` records the exact commit it reviewed in its verdict comment (`CHANGES REQUESTED: commit {sha} — ...`, see `commands/review-pr.md` Phase 8/9); compare that recorded sha against the PR's current `headRefOid`:

```bash
# NOTE: the CHANGES REQUESTED verdict is posted via `gh pr review --comment` (see
# commands/review-pr.md Phase 7B) — that creates a PullRequestReview, which surfaces under
# the `reviews` field, NOT `comments` (issue/PR comments are a separate GraphQL object).
# Query both --json reviews and --json comments (same combined-read pattern already used in
# work-on.md's REVIEW_BODIES/REVIEW_PRESENT checks) so this guard works regardless of which
# GitHub object type carries the verdict text.
LAST_VERDICT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '([.reviews[] | {body, created_at: (.submittedAt // "")}] + [.comments[] | {body, created_at: (.createdAt // "")}]) | map(select(.body | test("CHANGES REQUESTED: commit "))) | sort_by(.created_at) | last | .body // ""' 2>/dev/null)
LAST_VERDICT_SHA=$(echo "$LAST_VERDICT" | grep -oE 'CHANGES REQUESTED: commit [0-9a-f]+' | grep -oE '[0-9a-f]+$' | head -1)
CURRENT_SHA_SHORT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null | cut -c1-7)

if [ -n "$LAST_VERDICT_SHA" ] && [ "$LAST_VERDICT_SHA" = "$CURRENT_SHA_SHORT" ]; then
  echo "HEAD unchanged since last CHANGES REQUESTED verdict ($LAST_VERDICT_SHA) — skipping re-review."
  # No DRY_RUN/governor guard here — consistent with every other gh issue comment/edit call
  # already in this file (e.g. the Push Failed / Push Blocked sections below), none of which
  # are gated either. This is a report-and-stop action (blocks re-review, does not merge or
  # delete anything), same risk class as those pre-existing calls.
  REREVIEW_SKIP_BODY=$(cat <<SKIP_EOF
## Re-Review Skipped — HEAD Unchanged

PR #{PR_NUMBER}'s HEAD (${CURRENT_SHA_SHORT}) has not changed since the last CHANGES REQUESTED verdict. Re-running /review-pr would re-review byte-identical code and reproduce the same verdict — this is a pure waste of a full domain-agent fan-out.

The PR is already needs-human (or will be shortly, if this is the first time this guard has fired for it). Progress here now depends on remediation (fix the findings, push a new commit, re-review) rather than another raw review submission. If running under /orchestrate, item 6.4 in phase-4-execution.md auto-dispatches remediation for any needs-human-gated issue, including this one (see forge#2243) — no manual action should be needed. If running standalone, invoke /work-on {PR_NUMBER} --remediate --issue {NUMBER} directly.

<!-- FORGE:REREVIEW_SKIPPED -->
SKIP_EOF
)
  gh issue comment {NUMBER} {GH_FLAG} --body "$REREVIEW_SKIP_BODY" # <!-- allowlist:check-command-side-effects -->
  gh issue edit {NUMBER} {GH_FLAG} --add-label needs-human 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
  # Return REVIEW_RESULT: status: BLOCKED — do not invoke /review-pr again on unchanged HEAD
  printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number: {PR_NUMBER}\n  pr_url:\n  merged_to:\n  blocker: %s\n' "HEAD unchanged since last CHANGES REQUESTED verdict (${LAST_VERDICT_SHA}) — re-review skipped; remediation required"
  exit 1
fi
```

If `LAST_VERDICT_SHA` is empty (no prior CHANGES REQUESTED verdict found) or differs from the current HEAD (a new commit was pushed since the last verdict — e.g. by remediation), proceed normally to Phase R3.

---

## Pre-Handoff Base Sync (before the R1 ancestry guard and the first push) <!-- Added: forge#3969 -->

Never hand off a PR born stale. If `origin/{PR_BASE}` exists and is not an ancestor of `{BRANCH}`, merge it now, while the build context is warm. Merge only: no rebase, no force.

```bash
cd {WORKTREE_PATH}
if git fetch origin {PR_BASE} >/dev/null 2>&1 && ! git merge-base --is-ancestor origin/{PR_BASE} HEAD 2>/dev/null; then
  git merge --no-edit origin/{PR_BASE} >/dev/null 2>&1 || { echo "BASE SYNC CONFLICT: resolve in this context, then git commit; on doubt git merge --abort and return BLOCKED + needs-human"; git diff --name-only --diff-filter=U; }
fi
```

On conflict, resolve every file, keep both sides' intent, `git add`, `git commit --no-edit`. If not resolvable with confidence: `git merge --abort`, label `needs-human`, return `REVIEW_RESULT: status: BLOCKED` with blocker "pre-handoff base sync conflict". One bounded round; resolve SHAs only after it.

## Phase R1: Pre-Push Ancestry Guard

Before pushing, verify the branch contains no merge commits that bring in history from outside the PR base. Merging `origin/{PR_BASE}` itself into the branch (a base sync) is allowed: every non-first parent of each merge in `origin/{PR_BASE}..{BRANCH}` must be an ancestor of `origin/{PR_BASE}`. This is the final defense against milestone-code-onto-staging contamination.

```bash
# <Script resolution block from the top of this file, verbatim>
cd {WORKTREE_PATH}
# Skip if PR_BASE does not exist on origin yet (new branch — no contamination possible)
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  git fetch origin {PR_BASE} >/dev/null 2>&1 || true
  RESOLUTION=$(resolve_script 'check-branch-ancestry'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
  if [ "$TIER" = "prose" ]; then
    # Prose fallback: same checks inline (exit 0 clean, 1 foreign, 2 error). Fails closed: unresolvable refs or git errors give rc=2.
    ANCESTRY_RC=0; MERGE_COMMITS=""
    if ! git rev-parse --verify --quiet "origin/{PR_BASE}^{commit}" >/dev/null 2>&1 || ! git rev-parse --verify --quiet "{BRANCH}^{commit}" >/dev/null 2>&1; then
      ANCESTRY_RC=2
    elif ! MERGES=$(git rev-list --merges origin/{PR_BASE}..{BRANCH} 2>/dev/null) || ! FP=$(git rev-list --first-parent origin/{PR_BASE}..{BRANCH} 2>/dev/null); then
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
  else
    MERGE_COMMITS=$(bash "$SCRIPT_PATH" {BRANCH} origin/{PR_BASE} 2>&1); ANCESTRY_RC=$?
  fi
  if [ "$ANCESTRY_RC" -ne 0 ]; then
    if [ "$ANCESTRY_RC" -eq 1 ]; then
      echo "PRE-PUSH ANCESTRY GUARD FAILED: merge commits from outside {PR_BASE} detected"
    else
      echo "PRE-PUSH ANCESTRY GUARD FAILED: could not verify ancestry (failing closed)"
    fi
    gh issue comment {NUMBER} {GH_FLAG} --body "## Pre-Push Ancestry Guard Failed

Branch \`{BRANCH}\` contains merge commits that bring in history from outside the PR base (\`{PR_BASE}\`), or ancestry could not be verified. Pushing this branch risks contaminating \`{PR_BASE}\` with unapproved code (e.g. milestone code leaking onto staging). Merges of \`{PR_BASE}\` itself are allowed and do not trigger this guard.

**Detected merge commits** (merge, foreign parent, subject — or the verification error):
\`\`\`
${MERGE_COMMITS}
\`\`\`

Do NOT push this branch. Human review required to identify the source of the merge commits and clean the branch history (a human re-creates the branch from \`origin/{PR_BASE}\` with only the intended commits).

<!-- FORGE:PUSH_BLOCKED -->" # allowlist:check-command-side-effects
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
    # Return REVIEW_RESULT: status: BLOCKED — do not push
    printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: %s\n' "pre-push ancestry guard failed: merge commits from outside {PR_BASE} or ancestry unverifiable"
    exit 1
  fi
fi
```

## Phase R1: Non-Empty Commit Guard (MANDATORY — run before push) <!-- Added: forge#1305 -->

Before pushing, verify the branch has at least one commit ahead of the PR base. This is the last-line defense against the phantom-commit hazard: a session that resumed from a partial FORGE:BUILDER comment (without `:COMPLETE`) would have skipped the commit step and could otherwise push an empty branch.

```bash
cd {WORKTREE_PATH}
# Count commits on this branch that are not reachable from origin/{PR_BASE}
COMMIT_COUNT=$(git rev-list --count HEAD ^origin/{PR_BASE} 2>/dev/null || echo "0")
if [ "$COMMIT_COUNT" -eq 0 ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "## Push Blocked — No Commits Ahead of Base

Branch \`{BRANCH}\` has 0 commits ahead of \`origin/{PR_BASE}\`. Pushing this branch would create an empty PR.

**Likely cause**: Build was interrupted after the FORGE:BUILDER comment was posted (implement.md Phase I6) but before the commit was created (validate.md Phase V5). The branch was pushed with no implementation on it.

**Resolution**: Delete this branch, re-run \`/work-on {NUMBER}\` to restart the build phase. The partial FORGE:BUILDER comment (lacking \`FORGE:BUILDER:COMPLETE\`) will be detected and deleted, and the build will restart cleanly.

<!-- FORGE:PUSH_BLOCKED_EMPTY_BRANCH -->"
  gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
  printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: %s\n' "branch has 0 commits ahead of origin/{PR_BASE} — empty branch not pushed"
  exit 1
fi
echo "Commit count ahead of origin/{PR_BASE}: $COMMIT_COUNT — OK to push"
```

## Phase R1: Push Branch

```bash
cd {WORKTREE_PATH}
git push -u origin {BRANCH} # allowlist:check-command-side-effects
```

If the push fails, do NOT retry with a force flag (never force-push): a raced or diverged remote is a human decision, and a conflict with the base is handled by the base-sync path (`base-conflict` in Phase R4), not by overwriting the remote. Fall straight through to:
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Push Failed

Branch \`{BRANCH}\` could not be pushed to origin.

**Error**: {ERROR_OUTPUT}

This may indicate a merge conflict or remote rejection. Human review required.

<!-- FORGE:PUSH_FAILED -->"

gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: %s\n' "git push failed" # allowlist:check-command-side-effects
```
Print the block above (`status: BLOCKED`, blocker: "git push failed") and STOP.

---

## Phase R1.5: Phase-Trail Preflight (MANDATORY — before PR creation) <!-- Added: forge#3061 -->

A PR must not be opened for work whose earlier phases were skipped. Run the deterministic verifier; it requires INVESTIGATOR, FAST_PATH and CONTRACT always, CONTEXT and ARCHITECT unless the band is TRIVIAL/INVESTIGATION, and a passing FORGE:QUALITY_GATE unless the diff is docs-only.

```bash
# --no-renames: list BOTH sides of a rename so a file moved into docs/ cannot hide its source path (forge#3145).
CHANGED=$(git -C {WORKTREE_PATH} diff --name-only --no-renames origin/{PR_BASE}...HEAD)
# The verifier ships with ForgeDock (not the consumer repo): same resolution as every universal script.
# FORGE_ROOT: shared resolver scripts/lib/forge-resolve.sh (empty when unresolved => callers fail closed)
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
FORGE_ROOT="$(forge_root 2>/dev/null || true)"
TRAIL_SCRIPT="$FORGE_ROOT/scripts/verify-phase-trail.sh"
# Docs-only predicate: ONE shared copy (scripts/is-docs-only.sh, forge#3134). Fail closed: unresolved script or empty diff -> no flag.
DOCS_ONLY_FLAG=""
if [ -n "$CHANGED" ] && [ -n "$FORGE_ROOT" ] && [ -f "$FORGE_ROOT/scripts/is-docs-only.sh" ] && echo "$CHANGED" | bash "$FORGE_ROOT/scripts/is-docs-only.sh"; then DOCS_ONLY_FLAG="--docs-only"; fi
# Band cross-check (forge#3149): a non-docs diff means an agent-chosen INVESTIGATION band must not waive requirements.
# Fail closed: anything not positively docs-only (including an empty/unreadable diff) is treated as a code diff.
CODE_DIFF_FLAG="--code-diff"
if [ -n "$DOCS_ONLY_FLAG" ]; then CODE_DIFF_FLAG=""; fi
# Bind the QUALITY_GATE PASS to the built tree (forge#3149). An unresolved tree is passed as empty -> the verifier exits 2 (fail closed).
HEAD_TREE=$(git -C {WORKTREE_PATH} rev-parse 'HEAD^{tree}' 2>/dev/null)
# Bind the human break-glass override (forge#3152) to the exact commit being gated. Empty -> the verifier exits 2 (fail closed).
HEAD_SHA=$(git -C {WORKTREE_PATH} rev-parse HEAD 2>/dev/null)
if [ -z "$FORGE_ROOT" ] || [ ! -f "$TRAIL_SCRIPT" ]; then
  # Fail closed: never skip the gate when the verifier cannot be resolved (plugin installs set no FORGE_HOME).
  echo "PHASE TRAIL: verify-phase-trail.sh not resolvable (set FORGEDOCK_HOME to the ForgeDock install)" >&2
  TRAIL_RC=127
else
  TRAIL=$(bash "$TRAIL_SCRIPT" {NUMBER} -R {GH_REPO} $DOCS_ONLY_FLAG $CODE_DIFF_FLAG --head-tree "$HEAD_TREE" --head-sha "$HEAD_SHA"); TRAIL_RC=$?
  echo "$TRAIL"
fi
# Break-glass (forge#3152): exit 0 with an `OVERRIDE:` line means a human override was accepted by the verifier's own checks
# (human identity, write/admin permission, unedited, bound to this head + MISSING set). Record it from the verifier's output, never from agent prose.
if [ "$TRAIL_RC" -eq 0 ]; then
  OVR=$(printf '%s\n' "$TRAIL" | sed -n 's/^OVERRIDE: //p' | sed -n '1p')
  if [ -n "$OVR" ]; then
    gh issue comment {NUMBER} {GH_FLAG} --body "$(printf '<!-- FORGE:PHASE_TRAIL_OVERRIDE_APPLIED -->\nThe phase-trail gate was waived by a human break-glass override. No PR exists yet; /review-pr records it on the PR at merge time.\n\n%s\n%s\n%s\n' '```' "$OVR" '```')" # <!-- allowlist:check-command-side-effects -->
  fi
fi
# Hard guard (same as review-pr.md Phase 8): an unreadable/unresolvable trail never falls through to PR creation.
if [ "$TRAIL_RC" -ge 2 ]; then printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: phase trail unreadable (rc=%s)\n' "$TRAIL_RC"; exit 1; fi
```

- `TRAIL_RC=0` → continue to Phase R2. If the output carried an `OVERRIDE:` line, the block above has already recorded `<!-- FORGE:PHASE_TRAIL_OVERRIDE_APPLIED -->` on the issue; do not post or edit it by hand. An override is a human comment (`<!-- FORGE:PHASE_TRAIL_OVERRIDE -->` with `**Head**`, `**Missing**`, `**Reason**`) that the pipeline can never post for itself; see `scripts/verify-phase-trail.sh -h`. A new commit invalidates it.
- `TRAIL_RC=1` → **do not create the PR.** For each `MISSING: <marker> -> <action>` line, run that phase now via its `Skill(...)` (the action text names it), then re-run this preflight (this skill is the SINGLE owner of the phase-trail re-dispatch; the router never re-dispatches). Do NOT hand-post the missing marker and do NOT escalate to a human: the refusal routes back to the missing phase. If the preflight still fails after one re-dispatch round, post a `<!-- FORGE:PHASE_TRAIL_FAILED -->` comment listing the still-missing markers, add `needs-human`, print `REVIEW_RESULT: status: BLOCKED`, blocker: "phase trail incomplete after re-dispatch". Do NOT close the issue.
- `TRAIL_RC>=2` (2 = trail unreadable; 127 = script not executable) → the trail could not be read; fail closed (the block above is printed) with `REVIEW_RESULT: status: BLOCKED`, blocker: "phase trail unreadable".

Run the same preflight again at the top of Phase R3, before `/review-pr --auto-merge` is invoked, since a resumed run can enter at R3 with an existing PR.

---

## Phase R2: Create PR

### R2A: Determine PR title

Derive from issue title:
- `fix(...):`  → `Fix: {description}`
- `feat(...):`  → `Feat: {description}`
- `refactor(...):`  → `Refactor: {description}`
- `docs(...):`  → `Docs: {description}`
- fallback: use issue title as-is

### R2B: Resolve attribution footer (optional)

Before creating the PR, check `forge.yaml → attribution.pr_footer`:

```bash
ATTRIBUTION_PR_FOOTER=$(grep -A5 "^attribution:" forge.yaml 2>/dev/null | grep "pr_footer:" | awk '{print $(2)}' | tr -d '"' || echo "false")
```

If `ATTRIBUTION_PR_FOOTER` is `true`, append the following footer to the PR body (once — never duplicate on retries):

```
> ⚒️ Orchestrated with [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) — state, scheduling, review, and memory on GitHub.
```

### R2C: Create PR

For a batch issue, construct a non-closing reference line from `BATCH_MEMBERS` before creating the PR:

```bash
BATCH_MEMBER_REFS=""
if [ "${IS_BATCH:-0}" = "1" ]; then
  BATCH_MEMBER_REFS=$(printf 'Refs #%s\n' "${BATCH_MEMBERS[@]}")
fi
```

```bash
gh pr create {GH_FLAG} \
  --base {PR_BASE} \
  --head {BRANCH} \
  --title "{PR_TITLE}" \
  --body "## Summary

{BRIEF_DESCRIPTION_FROM_ISSUE_BODY}

## Changes

{BULLETED_LIST_OF_KEY_CHANGES_FROM_BUILDER_COMMENT}

## Testing

{TESTING_CHECKLIST_FROM_BUILDER_COMMENT}

---

Closes #{NUMBER}
${BATCH_MEMBER_REFS}
**Batch member disposition**: The batch issue is the code unit being closed. Referenced members that require human or operator action remain open as a split outcome.

**Implementation branch**: \`{BRANCH}\`
**Base**: \`{PR_BASE}\`
{IF_ATTRIBUTION_PR_FOOTER_TRUE:
> ⚒️ Orchestrated with [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) — state, scheduling, review, and memory on GitHub.}"
```

**Note**: `Closes #{NUMBER}` documents intent but does NOT auto-close for non-default-branch PRs. The close subcommand handles explicit closure after merge.

**Attribution guard**: The footer line is appended once at PR creation. If the PR already exists (resume path), do NOT append the footer again — check the existing PR body first.

**No assistant attribution**: The PR body is exactly the sections above (plus the optional ForgeDock footer). Do NOT add a `🤖 Generated with Claude Code` line, a `Co-Authored-By: Claude` trailer, or any assistant-tool attribution — the pipeline is ForgeDock-branded. A PreToolUse guard hard-blocks it as a backstop (`bin/hooks/pre-tool-use.mjs` Rule 5).

If PR creation fails because a PR already exists for this branch:
```bash
gh pr list {GH_FLAG} --head {BRANCH} --json number,url --jq '.[0]'
```
Use the existing PR number and continue.

### R2D: Update labels

```bash
RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} in-review ;;
  prose) gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:in-review" --remove-label "workflow:investigating" --remove-label "workflow:ready-to-build" --remove-label "workflow:building" --remove-label "workflow:awaiting-merge" --remove-label "workflow:remediating" --remove-label "workflow:merged" --remove-label "workflow:invalid" --remove-label "workflow:decomposed" 2>/dev/null || true # allowlist:check-command-side-effects ;;
esac
```

---

## Phase R2.5: Review Acceptance Gate <!-- Added: forge#3793 -->

Evaluates the `phase=review` acceptance checks B6.5 deferred (no PR existed at build time) before `/review-pr --auto-merge`: after R2D, and at the top of R3 on resume. Idempotent per head; a no-op without deferred checks; own marker `FORGE:ACCEPTANCE_GATE_REVIEW`, never the build gate's sentinels.

```bash
# <Script resolution block, verbatim>
RESOLUTION=$(resolve_script 'review-acceptance-gate'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
[ "$TIER" != "prose" ] || { echo "review-acceptance-gate not resolvable (fail closed)"; exit 1; }
bash "$SCRIPT_PATH" {NUMBER} {GH_REPO} "{GH_FLAG}" "{WORKTREE_PATH}" || exit 1
```

On non-zero exit do NOT invoke `/review-pr`; the script posted FAILED, added `needs-human` and printed the `REVIEW_RESULT: status: BLOCKED` block as the final reply.

---

## Phase R3: Invoke /review-pr with --auto-merge

**First re-run the Phase R1.5 phase-trail preflight** (resume entry can skip R1.5). Do not invoke `/review-pr` while it fails. <!-- Added: forge#3061 -->

Then re-run **Phase R2.5** (the review acceptance gate); do not invoke `/review-pr` while it fails. <!-- Added: forge#3793 -->

Re-read the PR number (from creation or from resume check):

```bash
PR_NUMBER=$(gh pr list {GH_FLAG} --head {BRANCH} --json number --jq '.[0].number')
```

Post a progress comment before delegating:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Submitting for Review

PR #${PR_NUMBER} created targeting \`{PR_BASE}\`. Invoking /review-pr with --auto-merge.

Review will: analyze changes → spawn domain agents → post findings → merge. The issue is closed and the worktree cleaned up afterwards by `work-on:close`, not by /review-pr.

<!-- FORGE:REVIEW_STARTED -->"
```

Invoke the review command:

```
if DRY_RUN=true:
  record "Would invoke review-pr --auto-merge for PR #{PR_NUMBER}; skipped (dry-run)."
else:
  Skill(skill="{FORGE_SKILL_PREFIX}review-pr", args="{PR_NUMBER} --auto-merge --issue {NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

**Reviewer ownership (spawn-site rule, `docs/WORK-ON-RUNTIME.md` R6)**: `/review-pr` runs inline in this fork. Under async `Agent` dispatch its domain reviewers are attributed to the root session, so their completion notifications never reach this phase: do not end the turn to wait for them. `/review-pr` Phase 4 waits on the reviewers' current-SHA `FORGE:REVIEW-AGENT` PR comments (bounded), and that GitHub comment, not a notification, is the completion signal. If the call returns with no parseable `REVIEW_RESULT` (empty, running or backgrounded), first re-read the PR and issue: a complete current-SHA reviewer panel plus a `FORGE:REVIEW` verdict means consume that state; otherwise re-invoke `/review-pr` once more with the same args (idempotent: it reuses the current-SHA reviewer comments already posted and dispatches only missing domains). Never review inline.

**OpenCode joined-child contract**: When `FORGE_RUNTIME=opencode` (or an OpenCode runtime marker is present), invoke this load-bearing review through one native foreground `task` instead of treating the `Skill(...)` line as an asynchronous handoff:

```
if DRY_RUN=true:
  record "Would invoke the foreground review task for PR #{PR_NUMBER}."
else:
  task(
    description="Review PR #{PR_NUMBER}",
    subagent_type="general",
    background=false,
    prompt="Load commands/review-pr.md and execute it for PR {PR_NUMBER} with --auto-merge --issue {NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}. Return only the structured REVIEW_RESULT block after the review reaches its outcome."
  )
```

Wait for that task's completed result before Phase R4. Propagate its `REVIEW_RESULT` as this module's child state; do not return `REVIEW_RESULT`, report progress, release an orchestrator slot, or begin close work while the child is running. If the child errors or returns no parseable `REVIEW_RESULT`, return `REVIEW_RESULT: status: BLOCKED` with the child failure as the blocker. The normal `Skill(...)` invocation above remains the non-OpenCode path.

/review-pr handles, in this order: **prepare** (`scripts/review-prepare.sh`: PR data, mergeability, scans, roster, FULL, DELTA or BASE_SYNC_ONLY decision, templates and slices into one context file; exit 3 is `BLOCKED`, never skipped) → **LLM** (domain-agent dispatch, arbitration, verdict rationale; a head that only merged the base is carried forward without reviewers) → **finalize** (`scripts/review-finalize.sh`: extract, classify, file findings as separate non-blocking issues, verdict, merge gates, integrity). The same sequence runs on the Agent-spawn and engine paths because it lives in the spec, so no engine hook is needed. It does NOT close the issue or clean up the worktree — `work-on:close` does both.

If `review-pr` is not found under `{FORGE_SKILL_PREFIX}review-pr` or `review-pr`, print `REVIEW_RESULT: status: BLOCKED`, blocker: "skill not found: review-pr" and STOP. Never review inline.

---

## Phase R4: Verify Review Outcome

After /review-pr returns, verify the outcome:

```bash
# Check PR state
gh pr view {PR_NUMBER} {GH_FLAG} --json state,mergedAt --jq '{state: .state, mergedAt: .mergedAt}'

# Check issue state
gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state'
```

**Cases**:
- PR MERGED (issue OPEN or CLOSED) → write checkpoint, then return `REVIEW_RESULT: status: COMPLETE` — do NOT close the issue or add labels here; the caller will route to `work-on:close` which handles issue closure, label updates, project board, trajectory log, and worktree cleanup.

  Write machine-readable phase checkpoint before returning (MANDATORY when PR is MERGED):
  ```bash
  [ "${DRY_RUN:-false}" = "true" ] && { echo "[DRY_RUN] would post the comment below"; exit 0; }
  CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
  \`\`\`json
  {\"phase\": \"REVIEW\", \"status\": \"COMPLETE\", \"next_phase\": \"CLOSE\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
  \`\`\`"
  ```

- `REVIEW_RESULT: status: PHASE_TRAIL_FAILED` from /review-pr (forge#3102; internal to this skill — never printed as this skill's status) → the review gate refused to merge because phase markers are missing. Do NOT hand-post markers and do NOT add `needs-human` yet. For each `MISSING: <marker> -> <action>` line, run that phase via its `Skill(...)`, then re-invoke Phase R3 once (this is the single re-dispatch owner: `/review-pr` and `work-on:remediate` only report the status and never re-run missing phases; the trail preflight at the top of R3 re-runs). If the second attempt returns `PHASE_TRAIL_FAILED` again, post a `<!-- FORGE:PHASE_TRAIL_FAILED -->` comment listing the still-missing markers, add `needs-human`, and return `REVIEW_RESULT: status: BLOCKED`, blocker: "phase trail incomplete after re-dispatch". The PR stays open and unmerged throughout.

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker mentions the phase trail (any blocker containing "phase trail": "phase trail unreadable" when the Phase 8 verifier exited ≥2 / 127, "phase trail incomplete…", or "auto-merge requires --issue", forge#3147): the merge gate refused or could not run. Do NOT re-run phases (nothing is missing) and do NOT attempt the manual merge below, because that would bypass the gate. Add `needs-human` and return `REVIEW_RESULT: status: BLOCKED` with the same blocker. The PR stays open and unmerged.

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "stale review" (a commit landed on the PR after the verdict, or the head moved during the CI wait, so the code that would merge is not the reviewed code): do NOT merge. The re-review bound is persisted, not remembered: count `<!-- FORGE:STALE_REREVIEW: pr={PR_NUMBER} -->` comments on the issue. If the count is 0, post that marker (with the new head SHA), run the quality gate on the new head (`Skill(skill="{FORGE_SKILL_PREFIX}quality-gate", args="<changed files> --worktree {WORKTREE_PATH}")`, which posts a fresh `FORGE:QUALITY_GATE` for the code that will actually merge), then re-invoke Phase R3 once — a review of the new head (scoped by /review-pr: full, delta or carried forward). If the count is already ≥ 1 (the head keeps moving after review), add `needs-human` and return `REVIEW_RESULT: status: BLOCKED`, blocker: "PR head keeps moving after review". <!-- forge#3188 -->

- **Remediation-pending handoff (shared by the ci-gate, in-pr-fix and base-conflict cases below)** <!-- Added: forge#3541 -->: these three cases are autonomous pipeline work, not a human decision, so the issue must NOT carry `needs-human` while remediation is pending. `needs-human` is a human-gate signal (operators alert on it, and orchestrate holds DAG dependents as GATED on it). Mark the handoff with the non-human state `workflow:remediating` instead, and clear any `needs-human` that review-pr Phase 8 already set for the ci-gate refusal. `work-on:remediate` accepts either label (a bare `needs-human` from an older run still works), clears `workflow:remediating` on every exit, and re-asserts `needs-human` only when it cannot fix the PR. Run this block, then return `REVIEW_RESULT: status: NEXT`:
  ```bash
  RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
  case "$TIER" in
    adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} remediating ;;
    prose) gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:remediating" --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true ;; # allowlist:check-command-side-effects
  esac
  gh issue edit {NUMBER} {GH_FLAG} --remove-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
  gh pr edit {PR_NUMBER} {GH_FLAG} --remove-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
  ```

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "degraded-gate-unreviewed" (the build gate was DEGRADED, a check ran nothing, and no trusted `### Degraded Paths Reviewed` PR section names every degraded check; forge#3628): do NOT merge by any other route, and do NOT leave `needs-human` because of this gate on the first pass. Remove the `needs-human` that Phase 8 set, then re-review once on its own bound (forge#3996; never the `STALE_REREVIEW` bound, which other causes consume): count `<!-- FORGE:DEGRADED_REREVIEW: pr={PR_NUMBER} -->` (the `DEGRADED_REREVIEW` bound below), post the marker, and re-invoke Phase R3 once so `/review-pr` reads the degraded list from the issue's FORGE:QUALITY_GATE and adds the section. If the bound is already used, add `needs-human` and return `REVIEW_RESULT: status: BLOCKED`, blocker "degraded-gate-unreviewed after re-review".

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "checks still pending" (Phase 8 merge-gate timed out while CI was still running; nothing failed, #3919): do NOT remediate and do NOT add `needs-human`. Return that BLOCKED result unchanged so the caller retries the review phase, whose merge gate re-runs once CI finishes. The engine (`forgedock run-issue`) is that caller: it recognises the blocker, polls CI with `scripts/wait-ci-green.sh` and backoff (no model calls, bounded by `engine.ci_pending_max_minutes`, default 90), then re-dispatches this review phase once; budget exhaustion ends `needs-human` with `review.ci_pending_timeout`. The router and interactive caller path is unchanged.

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "ci gate" (Phase 8 refused to merge because checks failed or were cancelled): do NOT attempt the manual merge below — that would bypass the CI gate. Fixing red CI is pipeline work, not a human decision: hand remediation to the router **once**. Bound: count `<!-- FORGE:CI_REMEDIATION: pr={PR_NUMBER} -->` comments on the issue first; if ≥ 1, do not remediate again — remove `workflow:remediating`, label the issue `needs-human` (the bound is exhausted, so a human is now genuinely needed) and return `REVIEW_RESULT: status: BLOCKED` with blocker "ci gate not green after remediation". Otherwise run the remediation-pending handoff block above (sets `workflow:remediating`, removes the `needs-human` that Phase 8 set) and return `REVIEW_RESULT: status: NEXT` with `next: remediate` and `remediation: ci-gate` (see Output). Do not post the marker here: the router posts it immediately before it invokes remediation (Phase 4R), so a handoff interrupted before remediation starts is retried instead of being counted as used. **Never invoke `work-on:remediate` from this phase** (forge#3398): remediation re-reviews through `/review-pr`, which spawns domain-reviewer sub-agents, so it must run one level below the router, not nested inside this fork. Nested here, it lands at the sub-agent depth limit under `/orchestrate` with no `Agent` tool and strands the PR at `REREVIEW-REQUIRED` (forge#3391). The router runs `work-on:remediate`, which classifies a CI-gate refusal as FIXABLE, swaps `workflow:remediating` (or a legacy `needs-human`) for `workflow:in-review`, fixes the failing jobs on the PR branch, re-runs the quality gate and re-reviews the new head (scoped by /review-pr: full, delta or carried forward), and auto-lands through the same CI gate. <!-- forge#3191 -->

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "in-pr fix required" (review-pr §6B.6: CONFIRMED MEDIUM/HIGH/CRITICAL findings in files this PR changed, requested on the PR in a `FORGE:INPR_FIX` comment at the current head): do NOT merge and do NOT leave the issue at `needs-human` because of this gate. Run **one** fix round, bounded by `<!-- FORGE:INPR_REMEDIATION: pr={PR_NUMBER} -->` on the issue (`{BOUND}` = `INPR_REMEDIATION` below).
  - **Bound unused**: run the remediation-pending handoff block above (set `workflow:remediating`, no `needs-human`; remediation accepts that state and its Phase M1 clears it as FIXABLE). Then return `REVIEW_RESULT: status: NEXT` with `next: remediate` and `remediation: inpr-fix` (the router posts the bound marker, as in the ci-gate case) — never invoke `work-on:remediate` from this phase (same reason as the ci-gate case). The router runs remediation, which reads the `FORGE:INPR_FIX` work order, fixes exactly those findings, re-reviews the new head and auto-lands. On the re-review, any finding still present is filed as an issue (the round is used). If remediation does not land, the router re-invokes this phase, which then finds the bound used and takes the branch below.
  - **Bound already used** (including the re-invocation after a remediation that did not land): first read `max_severity=` from the latest trusted `FORGE:INPR_FIX` marker on the PR (`gh pr view {PR_NUMBER} {GH_FLAG} --json comments`, author-trusted as elsewhere in this phase; absent means MEDIUM). **HIGH/CRITICAL are never waived**: remove `workflow:remediating`, label the issue `needs-human`, leave the PR unmerged and return `REVIEW_RESULT: status: BLOCKED` with blocker "in-pr fix not landed (HIGH/CRITICAL, no waiver)". The `FORGE:INPR_FIX` work order stays on the PR for the human. For MEDIUM, waive the gate for the current head. Remove `needs-human` and `workflow:remediating` (restoring `workflow:in-review`), post `<!-- FORGE:INPR_FIX_WAIVED: head=<current head SHA> -->` on the **PR**, then re-invoke Phase R3 once under the `STALE_REREVIEW` bound. That review files the remaining findings as issues and merges as it would have before this gate. Only if `STALE_REREVIEW` is also exhausted, label the issue `needs-human`.
    ```bash
    INPR_WAIVE_HEAD=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq .headRefOid)
    gh issue edit {NUMBER} {GH_FLAG} --remove-label "needs-human,workflow:remediating" --add-label "workflow:in-review" 2>/dev/null || true # allowlist:check-command-side-effects
    gh pr comment {PR_NUMBER} {GH_FLAG} --body "<!-- FORGE:INPR_FIX_WAIVED: head=${INPR_WAIVE_HEAD} -->
In-PR fix round did not land; the remaining CONFIRMED MEDIUM findings are filed as issues on the next review instead of blocking the merge." # allowlist:check-command-side-effects
    ```

  Persisted loop bounds for the cases above — count first, then act (`{BOUND}` is `STALE_REREVIEW`, `DEGRADED_REREVIEW`, `CI_REMEDIATION`, `INPR_REMEDIATION` or `BASESYNC_REMEDIATION`). This phase posts only the `STALE_REREVIEW` and `DEGRADED_REREVIEW` markers; `CI_REMEDIATION`, `INPR_REMEDIATION` and `BASESYNC_REMEDIATION` are posted by the router in Phase 4R, immediately before it invokes remediation (forge#3398):
  ```bash
  [ "${DRY_RUN:-false}" = "true" ] && { echo "[DRY_RUN] bound check only"; }
  BOUND_COUNT=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate \
    --jq '[.[] | select((.body | contains("FORGE:{BOUND}:")) and (.body | contains("pr={PR_NUMBER}")))] | length' 2>/dev/null | awk '{s+=$(1)} END {print s+0}')
  if [ "$BOUND_COUNT" -ge 1 ]; then
    echo "BOUND_EXHAUSTED: {BOUND} already used for PR #{PR_NUMBER}"
  elif [ "{BOUND}" = "STALE_REREVIEW" ] && [ "${DRY_RUN:-false}" != "true" ]; then
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:STALE_REREVIEW: pr={PR_NUMBER} -->
Stale review on PR #{PR_NUMBER}: quality-gating and re-reviewing the new head once." 2>/dev/null || true
  elif [ "{BOUND}" = "DEGRADED_REREVIEW" ] && [ "${DRY_RUN:-false}" != "true" ]; then
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DEGRADED_REREVIEW: pr={PR_NUMBER} -->
Degraded-gate review on PR #{PR_NUMBER}: re-reviewing once so the review names each degraded check." 2>/dev/null || true
  fi
  ```
  `BOUND_EXHAUSTED` → take the "already ≥ 1" branch of that case.

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "base-conflict" (review-pr Phase 7B / Phase 8: `mergeable=CONFLICTING` or `mergeStateStatus=DIRTY`, or `BEHIND` under required-up-to-date protection, and no other blocking finding; forge#3496): do NOT attempt the manual merge below and do NOT merge by any other route. Syncing the base is pipeline work: merge `origin/{PR_BASE}` into the issue's own branch (merge only, never rebase, never force-push, never touch a shared branch). Run **one** sync round, bounded by `<!-- FORGE:BASESYNC_REMEDIATION: pr={PR_NUMBER} -->` on the issue (`{BOUND}` = `BASESYNC_REMEDIATION` below).
  - **Bound unused**: run the remediation-pending handoff block above (set `workflow:remediating`, no `needs-human`; a pure base sync needs no human). Then return `REVIEW_RESULT: status: NEXT` with `next: remediate` and `remediation: base-sync`. The router posts the bound marker (Phase 4R) and runs `work-on:remediate`, which merges the base in, re-runs the quality gate and re-reviews the new head. Never invoke `work-on:remediate` from this phase (same reason as the ci-gate case).
  - **Bound already used** (the sync ran and the PR still conflicts, or the sync could not resolve a hunk): do not sync again. Remove `workflow:remediating`, label the issue `needs-human` (a genuine human decision now) and return `REVIEW_RESULT: status: BLOCKED` with blocker "base conflict persists after base-sync remediation". List the conflicting files in the issue comment you post, taken from the remediation's `FORGE:BASESYNC_FAILED` comment (the `git diff --name-only --diff-filter=U` list) when present.

- PR NOT MERGED (and not a phase-trail, auto-merge-gate, stale-review, degraded-gate-unreviewed, ci-gate, in-pr-fix or base-conflict BLOCKED above) → attempt manual merge, **only if the PR head is still the commit named in the latest `<!-- FORGE:REVIEW -->` APPROVED verdict** (otherwise re-invoke Phase R3 instead, as for "stale review") **and only after the same CI gate**:
  ```bash
  # CI gate (MANDATORY before any autonomous merge): merge only when every check on the PR is
  # green. Field test: PRs merged to staging with checks pending or red (#3165), because branch
  # protection required none and an auto-merge waits only for *required* checks.
  CI_GATE_SCRIPT=""
  _l="$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null || true)"; _l="${_l%/commands/work-on.md}"
  for _c in '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGEDOCK_HOME:-}" "${FORGE_HOME:-}" "$_l"; do
    case "$_c" in /*) [ -z "$CI_GATE_SCRIPT" ] && [ -f "$_c/scripts/wait-ci-green.sh" ] && CI_GATE_SCRIPT="$_c/scripts/wait-ci-green.sh" ;; esac
  done
  if [ -n "$CI_GATE_SCRIPT" ]; then CI_GATE_OUT=$(bash "$CI_GATE_SCRIPT" {PR_NUMBER} {GH_FLAG}); CI_GATE_RC=$?
  else CI_GATE_OUT="CI_GATE: ERROR — scripts/wait-ci-green.sh not resolvable (fail closed)"; CI_GATE_RC=2; fi
  echo "$CI_GATE_OUT"
  GATED_HEAD=$(printf '%s\n' "$CI_GATE_OUT" | sed -n 's/^CI_GATE_HEAD: //p' | head -1)
  # rc 3 = CI still running: re-run this block (up to 3 more times) before treating it as a failure.
  # Note-disposition gate (same rule as review-pr.md Phase 8): findings without a recorded
  # §6B.5 disposition must not merge, because that step is what bounds the review-finding cascade.
  DISPO_JSON=$(gh api --paginate "repos/{GH_REPO}/issues/{PR_NUMBER}/comments" 2>/dev/null) || DISPO_JSON=""
  FINDING_COUNT=$(printf '%s' "$DISPO_JSON" | jq -s '[.[][] | select(.body | test("<!-- FINDING:"))] | length' 2>/dev/null || echo "")
  # Trust predicate: ONE shared copy (scripts/trusted-comments.sh, same as verify-phase-trail.sh): trusted association, Bot account, or
  # FORGE_TRAIL_TRUSTED_LOGINS. A GitHub App bot always has author_association NONE, so an association-only filter drops the pipeline's own disposition.
  # TRUSTED_SCRIPT resolver (canonical; byte-identical across specs, guarded by scripts/forge-root.test.sh): plugin root, FORGE_ROOT, FORGEDOCK_HOME, FORGE_HOME, install symlink, marketplaces, newest pinned plugin cache under CLAUDE_CONFIG_DIR then ~/.claude. Never the working directory (author-controlled, #3400). The cache scan matters because the plugin-root placeholder is not always substituted in forked runs.
  _l="$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null || true)"; _l="${_l%/commands/work-on.md}"
  _tc="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGEDOCK_HOME:-}" "${FORGE_HOME:-}" "$_l" "$HOME/.claude/plugins/marketplaces/forgedock")"
  for _cfg in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do
    [ -n "$_cfg" ] && _tc="$_tc"$'\n'"$(find -L "$_cfg/plugins/cache/forgedock/forgedock" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | awk -F/ '$NF ~ /^[0-9]+\.[0-9]+\.[0-9]+$/{split($NF,a,".");printf "%d %d %d %s\n",a[1],a[2],a[3],$(0)}' | sort -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f4- || true)"
  done
  TRUSTED_SCRIPT=""
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$TRUSTED_SCRIPT" ] && [ -f "$_c/scripts/trusted-comments.sh" ] && TRUSTED_SCRIPT="$_c/scripts/trusted-comments.sh" ;; esac
  done <<< "$_tc"
  if [ -n "$TRUSTED_SCRIPT" ]; then DISPOSITION_COUNT=$(printf '%s' "$DISPO_JSON" | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:NOTE_DISPOSITION' 2>/dev/null || echo ""); else DISPOSITION_COUNT=""; fi
  if [ -z "$DISPO_JSON" ] || [ -z "$FINDING_COUNT" ] || [ -z "$DISPOSITION_COUNT" ]; then
    echo "REVIEW_RESULT: status: BLOCKED, blocker: note disposition unreadable (comments or scripts/trusted-comments.sh unresolvable; fail closed)"
  elif [ "$FINDING_COUNT" -gt 0 ] && [ "$DISPOSITION_COUNT" -eq 0 ]; then
    echo "REVIEW_RESULT: status: BLOCKED, blocker: note disposition missing"
  elif [ "$CI_GATE_RC" -eq 0 ]; then
    gh pr merge {PR_NUMBER} {GH_FLAG} --merge --auto --match-head-commit "$GATED_HEAD" # allowlist:check-command-side-effects (CI-gated merge)
  else
    echo "REVIEW_RESULT: status: BLOCKED, blocker: ci gate not green (rc=${CI_GATE_RC})"
  fi
  ```
  If the note-disposition gate refuses with `blocker: note disposition unreadable`: the comment list or the trust helper could not be read; add `needs-human` and return BLOCKED (a re-review cannot fix it). If it refuses with `blocker: note disposition missing` (no trusted disposition exists; bot, trusted-login and trusted-association authors all count): do NOT add `needs-human` — treat it like a stale review and re-invoke Phase R3 once under the `STALE_REREVIEW` bound so `/review-pr` records its §6B.5 disposition; only if that bound is exhausted, add `needs-human`. If the CI gate refuses: post the gate output as an issue comment, add `needs-human`, return `REVIEW_RESULT: status: BLOCKED` (blocker "ci gate not green"). If merge fails: post comment, add `needs-human`, return `REVIEW_RESULT: status: BLOCKED`

---

## Output

**`REVIEW_RESULT: status: COMPLETE` is an intermediate result, NOT a terminal state: the pipeline is not done. Print the block as your final reply; the caller then invokes `work-on:close` (issue closure, `workflow:merged`, trajectory log, worktree cleanup). Do not close anything here.**

Output this structured block:

```
REVIEW_RESULT:
  status: COMPLETE | ALREADY_MERGED | NEXT | BLOCKED
  pr_number: {PR_NUMBER}
  pr_url: {PR_URL}
  merged_to: {PR_BASE}
  next: {remediate, only when status=NEXT}
  remediation: {ci-gate | inpr-fix | base-sync, only when status=NEXT}
  blocker: {description if status=BLOCKED}
```

`NEXT` is a handoff, not a terminal state: the PR is open and unmerged, the bound marker is posted, and the router must run `work-on:remediate` for `{PR_NUMBER}` next (see `commands/work-on.md` Phase 4).

---

## Integration

This skill is invoked by the `work-on` router (forked) after validate returns `GATE_PASSED: true` and before `work-on:close`:

```
build/validate → [THIS SKILL] push + PR creation + /review-pr invocation + merge verification → work-on:close
```

/review-pr is invoked within this skill (not by the router). The router sees only the final `REVIEW_RESULT:` block and never re-dispatches phase-trail failures. Remediation is the one exception that leaves this skill: it is returned as `status: NEXT` and run by the router, because it spawns reviewers of its own (see `docs/WORK-ON-RUNTIME.md`).
