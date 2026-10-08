---
user-invocable: false
description: Review subcommand — push branch, create PR, invoke /review-pr with --auto-merge
context: fork
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
  _cx="${CODEX_HOME:-$HOME/.codex}"; case "$_cx" in /*) _x="$(head -n 1 "$_cx/forge-home" 2>/dev/null || true)" ;; *) _x="" ;; esac
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

## Phase R1: Pre-Push Ancestry Guard

Before pushing, verify the branch contains no merge commits from branches outside the PR base ancestry. This is the final defense against milestone-code-onto-staging contamination.

```bash
cd {WORKTREE_PATH}
# Skip if PR_BASE does not exist on origin yet (new branch — no contamination possible)
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  MERGE_COMMITS=$(git log --merges {BRANCH} ^origin/{PR_BASE} 2>/dev/null)
  if [ -n "$MERGE_COMMITS" ]; then
    echo "PRE-PUSH ANCESTRY GUARD FAILED: merge commits from outside {PR_BASE} detected"
    gh issue comment {NUMBER} {GH_FLAG} --body "## Pre-Push Ancestry Guard Failed

Branch \`{BRANCH}\` contains merge commits from branches outside the PR base (\`{PR_BASE}\`). Pushing this branch risks contaminating \`{PR_BASE}\` with unapproved code (e.g. milestone code leaking onto staging).

**Detected merge commits**:
\`\`\`
${MERGE_COMMITS}
\`\`\`

Do NOT push this branch. Human review required to identify the source of the merge commits and clean the branch history (e.g. via \`git rebase\` to replay only the intended commits onto \`origin/{PR_BASE}\`).

<!-- FORGE:PUSH_BLOCKED -->"
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
    # Return REVIEW_RESULT: status: BLOCKED — do not push
    printf 'REVIEW_RESULT:\n  status: BLOCKED\n  pr_number:\n  pr_url:\n  merged_to:\n  blocker: %s\n' "pre-push ancestry guard failed: merge commits from outside {PR_BASE}"
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

If push fails, retry with `--force-with-lease`:
```bash
git push -u origin {BRANCH} --force-with-lease # allowlist:check-command-side-effects
```

If still fails:
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
  _cx="${CODEX_HOME:-$HOME/.codex}"; case "$_cx" in /*) _x="$(head -n 1 "$_cx/forge-home" 2>/dev/null || true)" ;; *) _x="" ;; esac
  # newest cached version first: numeric major.minor.patch of the version dir name only (non-semver names such as commit SHAs are skipped); a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ -v mk="$_mk" '$(NF-2)==mk && $(NF-1)=="forgedock" && $NF ~ /^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$/{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5- || true)"
  _m="$HOME/.claude/plugins/marketplaces/$_mk"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_x" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
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
ATTRIBUTION_PR_FOOTER=$(grep -A5 "^attribution:" forge.yaml 2>/dev/null | grep "pr_footer:" | awk '{print $2}' | tr -d '"' || echo "false")
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
  prose) gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:in-review" --remove-label "workflow:investigating" --remove-label "workflow:ready-to-build" --remove-label "workflow:building" --remove-label "workflow:awaiting-merge" --remove-label "workflow:merged" --remove-label "workflow:invalid" --remove-label "workflow:decomposed" 2>/dev/null || true # allowlist:check-command-side-effects ;;
esac
```

---

## Phase R3: Invoke /review-pr with --auto-merge

**First re-run the Phase R1.5 phase-trail preflight** (resume entry can skip R1.5). Do not invoke `/review-pr` while it fails. <!-- Added: forge#3061 -->

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

/review-pr handles: full domain-agent review → post findings as separate issues (non-blocking) → merge the PR. It does NOT close the issue or clean up the worktree — `work-on:close` does both.

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

- `REVIEW_RESULT: status: PHASE_TRAIL_FAILED` from /review-pr (forge#3102; internal to this skill — never printed as this skill's status) → the review gate refused to merge because phase markers are missing. Do NOT hand-post markers and do NOT add `needs-human` yet. For each `MISSING: <marker> -> <action>` line, run that phase via its `Skill(...)`, then re-invoke Phase R3 once (this is the single re-dispatch owner; the trail preflight at the top of R3 re-runs). If the second attempt returns `PHASE_TRAIL_FAILED` again, post a `<!-- FORGE:PHASE_TRAIL_FAILED -->` comment listing the still-missing markers, add `needs-human`, and return `REVIEW_RESULT: status: BLOCKED`, blocker: "phase trail incomplete after re-dispatch". The PR stays open and unmerged throughout.

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker mentions the phase trail (any blocker containing "phase trail": "phase trail unreadable" when the Phase 8 verifier exited ≥2 / 127, "phase trail incomplete…", or "auto-merge requires --issue", forge#3147): the merge gate refused or could not run. Do NOT re-run phases (nothing is missing) and do NOT attempt the manual merge below, because that would bypass the gate. Add `needs-human` and return `REVIEW_RESULT: status: BLOCKED` with the same blocker. The PR stays open and unmerged.

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "stale review" (a commit landed on the PR after the verdict, or the head moved during the CI wait, so the code that would merge is not the reviewed code): do NOT merge. The re-review bound is persisted, not remembered: count `<!-- FORGE:STALE_REREVIEW: pr={PR_NUMBER} -->` comments on the issue. If the count is 0, post that marker (with the new head SHA), run the quality gate on the new head (`Skill(skill="{FORGE_SKILL_PREFIX}quality-gate", args="<changed files> --worktree {WORKTREE_PATH}")`, which posts a fresh `FORGE:QUALITY_GATE` for the code that will actually merge), then re-invoke Phase R3 once — a full review of the new head. If the count is already ≥ 1 (the head keeps moving after review), add `needs-human` and return `REVIEW_RESULT: status: BLOCKED`, blocker: "PR head keeps moving after review". <!-- forge#3188 -->

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "ci gate" (Phase 8 refused to merge because checks failed, were cancelled, or stayed pending past the gate retries): do NOT attempt the manual merge below — that would bypass the CI gate. Fixing red CI is pipeline work, not a human decision: invoke remediation **once** — `Skill(skill="{FORGE_SKILL_PREFIX}work-on:remediate", args="{PR_NUMBER} --issue {NUMBER} --base {PR_BASE}")` (forked; it classifies a CI-gate refusal as FIXABLE, clears `needs-human`, reads the failing job logs, fixes them on the PR branch, re-runs the quality gate and a full review, and auto-lands through the same CI gate). Bound: count `<!-- FORGE:CI_REMEDIATION: pr={PR_NUMBER} -->` comments on the issue first; if ≥ 1, do not remediate again. Post that marker before invoking. `REMEDIATE_RESULT` re-gate outcome `AUTO-LANDED` → treat as merged and return `REVIEW_RESULT: status: COMPLETE`; `REMEDIATE_RESULT: status: REREVIEW_REQUIRED` (forge#3240: the fix is pushed but remediation had no sub-agent dispatch tool, so no review ran) → do NOT add `needs-human` and do not re-invoke remediation; return `REVIEW_RESULT: status: BLOCKED` with blocker "re-review required: no dispatch tool" so the caller re-dispatches review from a session that has dispatch; any other outcome → leave `needs-human` (remediation sets it) and return `REVIEW_RESULT: status: BLOCKED` with blocker "ci gate not green after remediation". <!-- forge#3191 -->

- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "in-pr fix required" (review-pr §6B.6: CONFIRMED MEDIUM findings in files this PR changed, requested on the PR in a `FORGE:INPR_FIX` comment at the current head): do NOT merge and do NOT leave the issue at `needs-human` because of this gate. Run **one** fix round, bounded by `<!-- FORGE:INPR_REMEDIATION: pr={PR_NUMBER} -->` on the issue (`{BOUND}` = `INPR_REMEDIATION` below).
  - **Bound unused**: post the marker. Add `needs-human` (remediation only targets `needs-human`-gated PRs, and its Phase M1 clears it as FIXABLE). Then invoke `Skill(skill="{FORGE_SKILL_PREFIX}work-on:remediate", args="{PR_NUMBER} --issue {NUMBER} --base {PR_BASE}")`. Remediation reads the `FORGE:INPR_FIX` work order, fixes exactly those findings, re-reviews the new head and auto-lands. On the re-review, any finding still present is filed as an issue (the round is used).
  - `REMEDIATE_RESULT` re-gate outcome `AUTO-LANDED` → return `REVIEW_RESULT: status: COMPLETE`. `REREVIEW_REQUIRED` → same handling as the ci-gate case above.
  - **Any other outcome, or bound already used**: waive the gate for the current head. Remove `needs-human`, post `<!-- FORGE:INPR_FIX_WAIVED: head=<current head SHA> -->` on the **PR**, then re-invoke Phase R3 once under the `STALE_REREVIEW` bound. That review files the remaining findings as issues and merges as it would have before this gate. Only if `STALE_REREVIEW` is also exhausted, add `needs-human`.
    ```bash
    INPR_WAIVE_HEAD=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq .headRefOid)
    gh issue edit {NUMBER} {GH_FLAG} --remove-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
    gh pr comment {PR_NUMBER} {GH_FLAG} --body "<!-- FORGE:INPR_FIX_WAIVED: head=${INPR_WAIVE_HEAD} -->
In-PR fix round did not land; the remaining CONFIRMED MEDIUM findings are filed as issues on the next review instead of blocking the merge." # allowlist:check-command-side-effects
    ```

  Persisted loop bounds for the cases above — count first, post the marker, then act (`{BOUND}` is `STALE_REREVIEW`, `CI_REMEDIATION` or `INPR_REMEDIATION`):
  ```bash
  [ "${DRY_RUN:-false}" = "true" ] && { echo "[DRY_RUN] bound check only"; }
  if [ "{BOUND}" = "STALE_REREVIEW" ]; then
    BOUND_COUNT=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate \
      --jq '[.[] | select((.body | contains("FORGE:STALE_REREVIEW:")) and (.body | contains("pr={PR_NUMBER}")))] | length' 2>/dev/null | awk '{s+=$1} END {print s+0}')
  elif [ "{BOUND}" = "INPR_REMEDIATION" ]; then
    BOUND_COUNT=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate \
      --jq '[.[] | select((.body | contains("FORGE:INPR_REMEDIATION:")) and (.body | contains("pr={PR_NUMBER}")))] | length' 2>/dev/null | awk '{s+=$1} END {print s+0}')
  else
    BOUND_COUNT=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate \
      --jq '[.[] | select((.body | contains("FORGE:CI_REMEDIATION:")) and (.body | contains("pr={PR_NUMBER}")))] | length' 2>/dev/null | awk '{s+=$1} END {print s+0}')
  fi
  if [ "$BOUND_COUNT" -ge 1 ]; then
    echo "BOUND_EXHAUSTED: {BOUND} already used for PR #{PR_NUMBER}"
  elif [ "${DRY_RUN:-false}" != "true" ]; then
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:STALE_REREVIEW: pr={PR_NUMBER} -->
Stale review on PR #{PR_NUMBER}: quality-gating and re-reviewing the new head once." 2>/dev/null || true   # when {BOUND}=STALE_REREVIEW
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CI_REMEDIATION: pr={PR_NUMBER} -->
CI gate refused PR #{PR_NUMBER}: dispatching remediation once to fix the failing checks." 2>/dev/null || true   # when {BOUND}=CI_REMEDIATION
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:INPR_REMEDIATION: pr={PR_NUMBER} -->
In-PR fix requested on PR #{PR_NUMBER}: dispatching remediation once to fix the CONFIRMED MEDIUM findings before merge." 2>/dev/null || true   # when {BOUND}=INPR_REMEDIATION
  fi
  ```
  Post only the comment matching `{BOUND}`. `BOUND_EXHAUSTED` → take the "already ≥ 1" branch of that case.

- PR NOT MERGED (and not a phase-trail, auto-merge-gate, stale-review, ci-gate or in-pr-fix BLOCKED above) → attempt manual merge, **only if the PR head is still the commit named in the latest `<!-- FORGE:REVIEW -->` APPROVED verdict** (otherwise re-invoke Phase R3 instead, as for "stale review") **and only after the same CI gate**:
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
  DISPOSITION_COUNT=$(printf '%s' "$DISPO_JSON" | jq -s '[.[][] | select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR") | select(.body | test("^<!-- FORGE:NOTE_DISPOSITION"))] | length' 2>/dev/null || echo "")
  if [ -z "$DISPO_JSON" ] || [ -z "$FINDING_COUNT" ] || { [ "$FINDING_COUNT" -gt 0 ] && [ "${DISPOSITION_COUNT:-0}" -eq 0 ]; }; then
    echo "REVIEW_RESULT: status: BLOCKED, blocker: note disposition missing"
  elif [ "$CI_GATE_RC" -eq 0 ]; then
    gh pr merge {PR_NUMBER} {GH_FLAG} --merge --auto --match-head-commit "$GATED_HEAD" # allowlist:check-command-side-effects (CI-gated merge)
  else
    echo "REVIEW_RESULT: status: BLOCKED, blocker: ci gate not green (rc=${CI_GATE_RC})"
  fi
  ```
  If the note-disposition gate refuses (`blocker: note disposition missing`): do NOT add `needs-human` — treat it like a stale review and re-invoke Phase R3 once under the `STALE_REREVIEW` bound so `/review-pr` records its §6B.5 disposition; only if that bound is exhausted, add `needs-human`. If the CI gate refuses: post the gate output as an issue comment, add `needs-human`, return `REVIEW_RESULT: status: BLOCKED` (blocker "ci gate not green"). If merge fails: post comment, add `needs-human`, return `REVIEW_RESULT: status: BLOCKED`

---

## Output

**`REVIEW_RESULT: status: COMPLETE` is an intermediate result, NOT a terminal state: the pipeline is not done. Print the block as your final reply; the caller then invokes `work-on:close` (issue closure, `workflow:merged`, trajectory log, worktree cleanup). Do not close anything here.**

Output this structured block:

```
REVIEW_RESULT:
  status: COMPLETE | ALREADY_MERGED | BLOCKED
  pr_number: {PR_NUMBER}
  pr_url: {PR_URL}
  merged_to: {PR_BASE}
  blocker: {description if status=BLOCKED}
```

---

## Integration

This skill is invoked by the `work-on` router (forked) after validate returns `GATE_PASSED: true` and before `work-on:close`:

```
build/validate → [THIS SKILL] push + PR creation + /review-pr invocation + merge verification → work-on:close
```

/review-pr is invoked within this skill (not by the router). The router sees only the final `REVIEW_RESULT:` block and never re-dispatches phase-trail failures.
