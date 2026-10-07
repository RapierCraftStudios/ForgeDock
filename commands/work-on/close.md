---
user-invocable: false
description: Close subcommand — update project board, final issue body, parent tracker, summary report, trajectory log
argument-hint: "[issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--pr PR_NUMBER] [--base PR_BASE] [--branch BRANCH] [--worktree WORKTREE_PATH] --terminal-state merged|investigation|decomposed|invalid"
context: fork
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/close — Close & Trajectory Subcommand

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

> **Transient GitHub failures** (field test: a 12-minute GitHub HTTP 500 window parked an issue at needs-human): retry any `gh` call that fails with HTTP 5xx, a timeout or "Something went wrong" up to 3 times with 10s/30s/60s backoff. If it still fails, do NOT add `needs-human` — print this phase's RESULT block with `status: BLOCKED` and a blocker that starts with `github-unavailable:`. The router retries the phase; every phase resumes from GitHub state, so a retry is safe.


**Invoked by**: the `work-on` router, as its final step, via `Skill(skill="{FORGE_SKILL_PREFIX}work-on:close", args="...")`. This file declares `context: fork`, so it runs in an isolated sub-agent context that sees ONLY this text and its args — there is no "Phase 0 state" to rely on. Everything not passed as an arg is re-derived from GitHub/git in Phase C0. The router sees ONLY the final `CLOSE_RESULT:` block (see Output), so this file is the single source of truth for the close report, the summary card, the trajectory comment and the decision record.
**Output**: Update project board, close issue, update parent tracker, post trajectory log, post decision record, clean up the worktree. Final reply is the `CLOSE_RESULT:` block.

**Agent model policy**: `effort: low` (mechanical tier — label transitions, annotation posting, board updates; this file is mechanical end-to-end, so a low effort level is safe here). Fallback: `model: "sonnet"` if rate-limited. Feature gate: pass `effort` only on Claude Code >= 2.1.154. **Note**: this file is dispatched via `Skill("{FORGE_SKILL_PREFIX}work-on:close", ...)`, which does not support a `model` override — see `work-on.md` section "Model and Effort Tiering — What Actually Applies" for why a `model: "haiku"` claim here would not take effect. <!-- Corrected: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/close.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}`) (required)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`) (required)
- `--pr {PR_NUMBER}` — merged PR number (required when `--terminal-state merged`; empty/absent for PR-less terminals)
- `--base {PR_BASE}` — branch the PR merged into (e.g. `staging`, `milestone/modular-pipeline-architecture`). Optional — re-derived from the PR when absent
- `--branch {BRANCH}` — feature branch name (for worktree cleanup reference)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree to remove (optional — skip cleanup if not provided)
- `--terminal-state {TERMINAL_STATE}` — `merged | investigation | decomposed | invalid` (required)

Set shell variables from the parsed values (the `{X}` placeholders used throughout this file and the `$X` shell variables are the same values):

```bash
NUMBER="{NUMBER}"; GH_REPO="{GH_REPO}"; GH_FLAG="{GH_FLAG}"; PR_NUMBER="{PR_NUMBER}"
PR_BASE="{PR_BASE}"; BRANCH="{BRANCH}"; WORKTREE_PATH="{WORKTREE_PATH}"; TERMINAL_STATE="{TERMINAL_STATE}"
# Any optional arg that was not supplied is the empty string (never the literal "{...}" text).
```

**Fail closed.** If `{NUMBER}`, `--repo`, `--gh-flag` or `--terminal-state` is missing, if `--terminal-state` is not one of the four values, or if `--terminal-state merged` is passed without `--pr`: do NOT run any phase; print the `CLOSE_RESULT:` block with `status: FAILED` and the reason in `blocker:` (e.g. `blocker: missing required arg: --terminal-state`) as the final reply and STOP.

**Failure handling (status: FAILED)**: MANDATORY phases (C1, C2, C5) retry a failed `gh` write once; if it still fails, STOP at that point and print `CLOSE_RESULT: status: FAILED` with `blocker: "<phase>: <error>"`. Do NOT run C6 after a FAILED stop (the worktree is kept so the run can be retried). Phases marked non-blocking (C1.7, C1.5, C5.1–C5.5) log and continue and never produce FAILED. Every exit path — success, ALREADY_DONE, PHASE_COMPLETE, every guard, every failure — prints the `CLOSE_RESULT:` block.

**Terminal-state routing** — which phases run:

| `--terminal-state` | Runs | Skips (and why) |
|---|---|---|
| `merged` | C0 → C6, all phases | — |
| `investigation` | C0, C0.5, C1, C1.5, C2, C3, C4, C4.5, C5, C5.1–C5.4, C6 | C1.7, C5.5 (no PR); PR lines in the issue body, report and trajectory use the "no PR" form |
| `decomposed` | C0, C0.5, C4, C4.5, C5, C5.1–C5.4, C6 | C1, C1.7, C1.5, C2, C3, C5.5 — the parent issue stays OPEN with `workflow:decomposed` (owned by the decompose phase) |
| `invalid` | C0, C0.5, C4, C4.5, C5, C6 | C1, C1.7, C1.5, C2, C3, C5.1–C5.5 — the issue was already closed with `workflow:invalid` by the investigate phase |

Every `gh pr view {PR_NUMBER}` and every other PR-dependent step in this file is guarded on a non-empty `PR_NUMBER`: with an empty PR, the PR-derived values render as `—` and nothing aborts.

## Script resolution

Resolve the repo path first (needed by the dossier append, the knowledge indexer and the script resolver), then expand the canonical resolver block. Re-run both blocks if shell variables were lost between tool calls.

```bash
# REPO_PATH = main checkout root. From the worktree when one was passed (linked worktrees share a git common dir), else the current repo.
if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
  _gc=$(git -C "$WORKTREE_PATH" rev-parse --git-common-dir 2>/dev/null)
  case "$_gc" in /*) ;; *) _gc="$WORKTREE_PATH/$_gc" ;; esac
  REPO_PATH=$(dirname "$(cd "$_gc" 2>/dev/null && pwd)")
fi
[ -n "${REPO_PATH:-}" ] && [ -d "$REPO_PATH" ] || REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
```

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

Workflow-state transitions use the tiered `transition-label` script (adaptive → universal → prose). A transition to state X removes every other `workflow:*` label (full set: investigating, ready-to-build, building, in-review, awaiting-merge, merged, invalid, decomposed). `set_workflow_state <issue> <state>` is used by C2 and C3:

```bash
set_workflow_state() {
  local _issue="$1" _state="$2" _res _tier _path _s _rm=""
  _res=$(resolve_script 'transition-label'); _tier="${_res%%:*}"; _path="${_res#*:}"
  case "$_tier" in
    adaptive|universal) bash "$_path" "$_issue" $GH_FLAG "$_state" ;;
    prose)
      for _s in investigating ready-to-build building in-review awaiting-merge merged invalid decomposed; do
        [ "$_s" = "$_state" ] || _rm="${_rm:+$_rm,}workflow:$_s"
      done
      gh issue edit "$_issue" $GH_FLAG --add-label "workflow:$_state" --remove-label "$_rm" 2>/dev/null || true # allowlist:check-command-side-effects
      ;;
  esac
}
```

---

## Phase C0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything, and re-derive every value this file used to receive from the router. All derivations are best-effort: a value that cannot be found degrades (`—`, `unknown`, `0`) and never aborts the close.

```bash
# Issue full context
ISSUE_JSON=$(gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone)
TITLE=$(printf '%s' "$ISSUE_JSON" | jq -r '.title // ""')
ISSUE_STATE=$(printf '%s' "$ISSUE_JSON" | jq -r '.state // "UNKNOWN"')

# PR state — only when a PR exists (PR-less terminals: investigation | decomposed | invalid)
PR_STATE=""; PR_BASE_REF=""
if [ -n "$PR_NUMBER" ]; then
  PR_JSON=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,mergedAt,mergeCommit,baseRefName 2>/dev/null || echo "")
  PR_STATE=$(printf '%s' "$PR_JSON" | jq -r '.state // ""' 2>/dev/null)
  PR_BASE_REF=$(printf '%s' "$PR_JSON" | jq -r '.baseRefName // ""' 2>/dev/null)
fi
[ -n "$PR_BASE" ] || PR_BASE="$PR_BASE_REF"

# All agent comments (to reconstruct pipeline results) — one paginated read, reused below
COMMENTS_JSON=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments 2>/dev/null | jq -s 'add // []' 2>/dev/null || echo '[]')
[ -n "$COMMENTS_JSON" ] || COMMENTS_JSON='[]'
last_comment_body() {  # $1 = marker substring; prints the newest matching comment body (or empty)
  printf '%s' "$COMMENTS_JSON" | jq -r --arg m "$1" '[.[] | select(.body | contains($m)) | .body] | last // ""' 2>/dev/null
}
INVESTIGATOR_BODY=$(last_comment_body "FORGE:INVESTIGATOR")
BUILDER_BODY=$(last_comment_body "FORGE:BUILDER")
FAST_PATH_BODY=$(last_comment_body "FORGE:FAST_PATH")
```

**Merged guard**: if `TERMINAL_STATE` is `merged` and `PR_STATE` is not `MERGED` → print `CLOSE_RESULT: status: FAILED` with `blocker: "PR #{PR_NUMBER} is not merged (state: <PR_STATE>)"` and STOP.

**Resume check**:
- If a `FORGE:TRAJECTORY` comment already exists (`last_comment_body "FORGE:TRAJECTORY"` is non-empty) → trajectory already posted. Print `CLOSE_RESULT: status: ALREADY_DONE` (with `trajectory_url` = that comment's `html_url`, `issue_state` from the live issue) and STOP.
- If the issue is already CLOSED and the PR is MERGED → C1, C1.7, C1.5 and C2 already ran: set `REMAINING_AFTER=0` and continue at C3 (then C4 → C4.5 → C5 → … — the trajectory is missing, and C5 posts it).

### Derive the values the router no longer passes

```bash
# --- Lane: --base wins (staging -> fast, milestone/* -> feature); otherwise the PR's baseRefName; otherwise unknown ---
lane_from_base() { case "$1" in staging) echo fast ;; milestone/*) echo feature ;; *) echo "" ;; esac; }
LANE=$(lane_from_base "$PR_BASE")
[ -n "$LANE" ] || LANE=$(lane_from_base "$PR_BASE_REF")
if [ -z "$LANE" ]; then
  if [ -n "$PR_BASE" ]; then LANE=feature; else LANE=unknown; fi   # any other base (e.g. main) is treated as feature
fi
case "$LANE" in fast) LANE_LABEL="FAST" ;; feature) LANE_LABEL="FEATURE" ;; *) LANE_LABEL="UNKNOWN" ;; esac

# --- Investigation verdict / confidence (FORGE:INVESTIGATOR) — ERE/sed only, no PCRE ---
VERDICT=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Verdict\*\*: *\([A-Za-z0-9_]*\).*/\1/p' | head -1)
CONFIDENCE=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Confidence\*\*: *\([A-Za-z0-9_]*\).*/\1/p' | head -1)

# --- Task type + complexity band (FORGE:FAST_PATH; fall back to the investigator's task type) ---
TASK_TYPE=$(printf '%s\n' "$FAST_PATH_BODY" | sed -n 's/.*\*\*Task [Tt]ype\*\*: *\(.*[^ ]\) *$/\1/p' | head -1)
[ -n "$TASK_TYPE" ] || TASK_TYPE=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Task Type\*\*: *\(.*[^ ]\) *$/\1/p' | head -1)
TASK_TYPE=${TASK_TYPE:-unknown}
COMPLEXITY_BAND=$(printf '%s\n' "$FAST_PATH_BODY" | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: *\([A-Za-z_]*\).*/\1/p' | head -1 | tr '[:lower:]' '[:upper:]')
COMPLEXITY_BAND=${COMPLEXITY_BAND:-unknown}

# --- Files changed (FORGE:BUILDER) ---
FILES_CHANGED=$(printf '%s\n' "$BUILDER_BODY" | sed -n 's/.*\*\*Files changed\*\*: *\([0-9][0-9]*\).*/\1/p' | head -1)
FILES_CHANGED=${FILES_CHANGED:-—}
case "$FILES_CHANGED" in ''|*[!0-9]*) FILES_CHANGED_JSON=null ;; *) FILES_CHANGED_JSON="$FILES_CHANGED" ;; esac

# --- Quality gate: one FORGE:QUALITY_GATE comment per gate run => iteration count ---
GATE_ITERATIONS=$(printf '%s' "$COMMENTS_JSON" | jq '[.[] | select(.body | contains("FORGE:QUALITY_GATE"))] | length' 2>/dev/null)
GATE_ITERATIONS=${GATE_ITERATIONS:-0}
GATE_RESULT=$(last_comment_body "FORGE:QUALITY_GATE" | sed -n 's/.*\*\*Result\*\*: *\([A-Za-z]*\).*/\1/p' | head -1 | tr '[:upper:]' '[:lower:]')
if [ "$GATE_ITERATIONS" -eq 0 ]; then GATE_ROW="⏭ No gate record"; GATE_NOTE="docs-only change or gate marker not recorded"
elif [ "$GATE_RESULT" = "pass" ]; then GATE_ROW="✅ Gate passed"; GATE_NOTE="${GATE_ITERATIONS} iteration(s)"
else GATE_ROW="⚠ Gate result: ${GATE_RESULT:-unknown}"; GATE_NOTE="${GATE_ITERATIONS} iteration(s)"; fi
GATE_PASS_FAIL=${GATE_RESULT:-unknown}

# --- Verification status: the "**Verification Status**" line of the FORGE:BUILDER comment ---
VERIFICATION_LINE=$(printf '%s\n' "$BUILDER_BODY" | sed -n 's/.*\*\*Verification Status\*\*: *\(.*\)$/\1/p' | head -1)
VERIFICATION_SKIPPED_CHECKS=""
case "$VERIFICATION_LINE" in
  "") VERIFICATION_ROW="— (no verification status recorded)" ;;
  *"Verification NOT run:"*)
    VERIFICATION_SKIPPED_CHECKS=$(printf '%s' "$VERIFICATION_LINE" | sed 's/.*Verification NOT run: *//; s/ — verification.commands.*//')
    VERIFICATION_ROW="⚠ Skipped — verification.commands not configured for: ${VERIFICATION_SKIPPED_CHECKS}" ;;
  *) VERIFICATION_ROW="✅ Ran" ;;
esac

# --- PR reference line for the issue body (PR-less terminals use the no-PR form) ---
if [ -n "$PR_NUMBER" ]; then PR_LINE="**PR**: #${PR_NUMBER} → merged to \`${PR_BASE}\`"
else PR_LINE="**Result**: ${TERMINAL_STATE} (no PR)"; fi
```

Also available from the comments read above: from FORGE:INVESTIGATOR — verdict, confidence, task type; from FORGE:BUILDER — branch, commits, files changed; from FORGE:TRAJECTORY (if exists) — prior trajectory entries.

---

## Phase C0.5: Close-Scope Invariant Assertions (MANDATORY)

Run before any close actions. Evaluates `close`-scope invariants declared in
`forge-invariants.yaml` via `bin/engine/invariants.mjs`. A failed assertion
logs the violated proposition by name and flags the anomaly in the trajectory
log — it does NOT abort the close phase (advisory enforcement: flag, then continue).

**Skip if**: `forge-invariants.yaml` is absent or `bin/engine/invariants.mjs`
is unavailable (e.g. fresh install before this file ships). Fail-open.

The evaluator module is imported from ForgeDock's OWN install root (`FORGE_ROOT`, else
`FORGEDOCK_HOME`, else `FORGE_HOME` — absolute paths only), never from the consumer cwd, so a
consumer repo cannot supply the JS that runs here. If none of them holds
`bin/engine/invariants.mjs`, the check is skipped (fail-open). Paths are passed as argv and
converted with `pathToFileURL`, never concatenated into a `file://` string.

```bash
# Read local run-log for this issue (absolute path matches engine run-log dir)
RUN_LOG_DIR="${HOME}/.forge/runs"
RUN_LOG_FILE="${RUN_LOG_DIR}/{NUMBER}.jsonl"

INVARIANT_ANOMALIES=""

INV_MODULE=""
for _r in "${FORGE_ROOT:-}" "${FORGEDOCK_HOME:-}" "${FORGE_HOME:-}"; do
  case "$_r" in /*) [ -z "$INV_MODULE" ] && [ -r "$_r/bin/engine/invariants.mjs" ] && INV_MODULE="$_r/bin/engine/invariants.mjs" ;; esac
done

if [ -n "$INV_MODULE" ] && [ -f "${RUN_LOG_FILE}" ] && [ -f "$(dirname "$(which node)")/node" ] 2>/dev/null; then
  # Check close-scope invariants via the evaluator
  INVARIANT_RESULT=$(node -e "
    import(require('node:url').pathToFileURL(process.argv[1]).href)
      .then(m => {
        const decls = m.loadInvariants(process.argv[2]);
        const fs = require('fs');
        let events = [];
        try {
          const lines = fs.readFileSync(process.argv[3], 'utf-8').split('\n').filter(Boolean);
          events = lines.flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
        } catch {}
        const results = m.assertCloseInvariants(decls, events);
        const failed = results.filter(r => !r.ok);
        if (failed.length) {
          failed.forEach(r => process.stderr.write(m.formatViolation(r) + '\n'));
          process.exit(1);
        }
      })
      .catch(() => process.exit(0));  // fail-open on any error
  " "$INV_MODULE" "$(pwd)/forge-invariants.yaml" "${RUN_LOG_FILE}" 2>&1) || INVARIANT_ANOMALIES="${INVARIANT_RESULT}"

  if [ -n "$INVARIANT_ANOMALIES" ]; then
    echo "CLOSE-SCOPE INVARIANT ANOMALY (flagging — close continues):"
    echo "$INVARIANT_ANOMALIES"
    # The anomaly will be recorded in the trajectory log Anomalies field.
    # It does NOT block the close phase.
  fi
fi

# Also check: issue must be in CLOSED state after close attempt.
# This check runs AFTER Phase C2 (ensure issue is closed). Set a sentinel
# here to be evaluated post-C2:
CLOSE_INVARIANT_ISSUE_CHECK=true
```

**Post-C2 check** (evaluate after Phase C2 runs the `gh issue close` command; only on paths where C2 reached its close branch — `REMAINING_AFTER == 0` and `TERMINAL_STATE` is `merged` or `investigation` — otherwise skip it):

```bash
if [ "${CLOSE_INVARIANT_ISSUE_CHECK:-false}" = "true" ]; then
  ISSUE_STATE=$(gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
  if [ "$ISSUE_STATE" != "CLOSED" ]; then
    INVARIANT_ANOMALIES="${INVARIANT_ANOMALIES:+$INVARIANT_ANOMALIES; }issue_closed_at_terminal: issue state is ${ISSUE_STATE} (not CLOSED) after close attempt"
    echo "INVARIANT ANOMALY: issue_closed_at_terminal — issue is ${ISSUE_STATE}, not CLOSED"
    # Flag but continue — trajectory Anomalies field will surface this.
  fi
fi
```

The `INVARIANT_ANOMALIES` variable is read in Phase C5 (Step 1) and rendered in the trajectory's **Anomalies** field (joined with `; `; `None` only when it is empty and the review ran).

---


## Phase C1: Final Issue Body Update

**Skip if**: `TERMINAL_STATE` is `decomposed` or `invalid` (set `REMAINING_AFTER=0`; nothing to check off).

**Fresh read — intentionally NOT covered by the session-state cache.** The body is about to be rewritten below, and the review phase's `/review-pr` invocation is an external process that can post comments/edits between the last read and here. Writing back a stale cached body would silently revert any concurrent change, so this file always fetches the body fresh immediately before a body mutation (the parent body in Phase C3 likewise).

**Multi-phase guard**: Before checking off items, detect whether the issue has multiple phases. Only check off items belonging to the current completed phase — not all remaining items across future phases.

```bash
# Read current body
BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')

# Count remaining unchecked items BEFORE any edit
REMAINING_BEFORE=$(printf '%s\n' "$BODY" | grep -cE '^[-*+] \[ \]' || true)
```

**If `REMAINING_BEFORE == 0`** (no unchecked items): skip body edit — all items already checked, proceed to add PR reference only:
```bash
UPDATED_BODY="${BODY}"$'\n\n'"${PR_LINE}"
gh issue edit {NUMBER} {GH_FLAG} --body "$UPDATED_BODY" # allowlist:check-command-side-effects
REMAINING_AFTER=0
```

**If `REMAINING_BEFORE > 0`**: check whether ANY unchecked GFM task items will still remain after a full check-off — i.e., does the issue have multi-phase structure?

Multi-phase issues have **two or more checkbox-bearing sections** — that is, two or more heading-delimited sections that each contain at least one GFM task item. Test that structure directly; do **not** infer it from the presence of headings. Every templated issue carries `## Problem`, `## Evidence`, `## Affected Files`, `## Acceptance Criteria`, and `## Context`, so a heading count is `> 0` universally and says nothing about phase structure. <!-- Fixed: forge#2840 -->

```bash
# Structural test: count heading-delimited sections that contain checkbox items.
# Multi-phase == 2+ checkbox-bearing sections. A single checkbox group is
# single-phase regardless of how many prose headings surround it.
#
# - Fenced code blocks are stripped first: issue bodies routinely embed fenced
#   blocks whose lines start with '#' or contain a literal '- [ ]'. An
#   unterminated fence keeps the original body so later work is never hidden.
# - ATX headings and setext underlines both delimit sections. The ATX pattern
#   avoids awk interval-quantifier variance across awk implementations.
# - grep -E / awk only — no PCRE. '^#+ ' needs none.
FENCE_COUNT=$(printf '%s\n' "$BODY" | grep -cE '^(```+|~~~+)' || true)
if [ $(( ${FENCE_COUNT:-0} % 2 )) -ne 0 ]; then
  BODY_STRIPPED="$BODY"
else
  BODY_STRIPPED=$(printf '%s\n' "$BODY" | awk '/^(```+|~~~+)/{f=!f; next} !f')
fi

CHECKBOX_SECTIONS=$(printf '%s\n' "$BODY_STRIPPED" | awk '
  /^#+ / { if (in_section && has) n++; in_section=1; has=0; previous=""; next }
  /^(=+|-+)$/ && previous != "" { if (in_section && has) n++; in_section=1; has=0; previous=""; next }
  { if (in_section && /^[-*+] \[[ xX]\]/) has=1; previous=$0 }
  END { if (in_section && has) n++; print n+0 }
')

# Sub-issue-tracker guard: a decompose parent whose only checkbox group is
# '## Sub-Issue Tracker' counts 1 section. Checking those off would mark open
# sub-issues done and close the tracker, so any unchecked GFM task item for an
# issue forces multi-phase.
SUBISSUE_ITEMS=$(printf '%s\n' "$BODY_STRIPPED" | grep -cE '^[-*+] \[ \] #[0-9]+' || true)

# Keep this classifier and consuming guard unchanged unless scripts/checkbox-sections.test.sh
# is updated with them.
# Both counters are default-expanded: a failed extraction yields an empty string,
# not 0, which would make the integer test error out rather than evaluate false.
if [ "${CHECKBOX_SECTIONS:-0}" -ge 2 ] || [ "${SUBISSUE_ITEMS:-0}" -gt 0 ]; then
  # Multi-phase issue: do NOT check off any [ ] items
  # Only add the PR reference so progress is recorded
  UPDATED_BODY="${BODY}"$'\n\n'"${PR_LINE} (phase complete — remaining phases open)"
  gh issue edit {NUMBER} {GH_FLAG} --body "$UPDATED_BODY" # allowlist:check-command-side-effects
  REMAINING_AFTER="$REMAINING_BEFORE"
else
  # Single-phase issue: check off all remaining GFM task items
  UPDATED_BODY=$(printf '%s\n' "$BODY" | sed 's/^\([-*+]\) \[ \]/\1 [x]/g')
  UPDATED_BODY="${UPDATED_BODY}"$'\n\n'"${PR_LINE}"
  gh issue edit {NUMBER} {GH_FLAG} --body "$UPDATED_BODY" # allowlist:check-command-side-effects
  REMAINING_AFTER=0
fi
```

The `REMAINING_AFTER` variable is passed to Phase C2 to decide whether to close.

---

## Phase C1.7: Module Dossier Append (MANDATORY when PR exists) <!-- Added: forge#1733 -->

**Goal**: After each merge that touches a module covered by `devdocs/modules/`, append a dated entry so future agents working on that module receive current institutional knowledge through the binding devdocs channel.

**This phase is non-blocking** — if the dossier write fails, log the reason and continue to Phase C1.5. Never stall close for dossier maintenance.

**Skip if**: `{PR_NUMBER}` is empty (investigation / decomposed / invalid terminals — `TERMINAL_STATE` is not `merged`) OR `$REPO_PATH` is unset OR `devdocs/index.yaml` does not contain a `modules:` section OR no PR files match any module glob.

### Step 1: Resolve affected files from FORGE:BUILDER comment

```bash
# Read FORGE:BUILDER comment to get the list of changed files
BUILDER_COMMENT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:BUILDER"))] | last | .body // ""' 2>/dev/null || echo "")

# Extract file paths from the Changes section (lines starting with `- \`filepath\``)
CHANGED_FILES_RAW=$(echo "$BUILDER_COMMENT" \
  | sed -n '/^### Changes/,/^###/p' \
  | grep -oE '`[^`]+`' \
  | tr -d '`' \
  | grep -E '\.' \
  | head -20)

# Fallback: try the FORGE:INVESTIGATOR affected files list
if [ -z "$CHANGED_FILES_RAW" ]; then
  CHANGED_FILES_RAW=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
    --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null \
    | sed -n '/### Affected Files/,/###/p' \
    | grep -oE '`[^`]+`' \
    | tr -d '`' \
    | grep -E '\.' \
    | head -20)
fi

if [ -z "$CHANGED_FILES_RAW" ]; then
  echo "Phase C1.7: No changed files found from FORGE:BUILDER or FORGE:INVESTIGATOR — skipping dossier append"
  # → continue to Phase C1.5
fi
```

### Step 2: Match against module globs and append entries

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
DEVDOCS_REL=$(yq '.devdocs.path // "devdocs"' "$CONFIG_FILE" 2>/dev/null || echo "devdocs")
DEVDOCS_PATH="${REPO_PATH}/${DEVDOCS_REL}"
INDEX_PATH="${DEVDOCS_PATH}/index.yaml"

if [ ! -f "$INDEX_PATH" ]; then
  echo "Phase C1.7: ${INDEX_PATH} not found — skipping dossier append"
  # → continue to Phase C1.5
fi

# Extract modules entries: "name|glob|path"
MODULE_ENTRIES=$(yq '.modules[]? | .name + "|" + .glob + "|" + .path' "$INDEX_PATH" 2>/dev/null || echo "")

if [ -z "$MODULE_ENTRIES" ]; then
  echo "Phase C1.7: No modules[] section in index.yaml — skipping dossier append"
  # → continue to Phase C1.5
fi

DOSSIER_TIMESTAMP=$(date -u +"%Y-%m-%d")
DOSSIER_UPDATED_MODULES=""

# Iterate module entries; for each: check if any changed file matches the glob
while IFS='|' read -r MOD_NAME MOD_GLOB MOD_PATH; do
  [ -z "$MOD_GLOB" ] || [ -z "$MOD_PATH" ] && continue
  DOSSIER_ABS="${DEVDOCS_PATH}/${MOD_PATH}"

  MATCHED=0
  # Iterate changed files using while read — not bare for-in (IFS word-split guard per c39758d)
  while IFS= read -r af; do
    [ -z "$af" ] && continue
    AF_BASENAME=$(basename "$af")
    case "$AF_BASENAME" in
      $MOD_GLOB) MATCHED=1; break ;;
    esac
    case "$af" in
      $MOD_GLOB) MATCHED=1; break ;;
    esac
  done <<< "$CHANGED_FILES_RAW"

  if [ "$MATCHED" -eq 0 ]; then
    continue
  fi

  echo "Phase C1.7: Module '${MOD_NAME}' matched (glob '${MOD_GLOB}') — appending entry to ${MOD_PATH}"

  # Build entry text
  # One-line summary from the PR title + issue number
  PR_TITLE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json title --jq '.title' 2>/dev/null || echo "untitled")
  DOSSIER_ENTRY="## Entry ${DOSSIER_TIMESTAMP} — ${PR_TITLE} (#{NUMBER})

PR #{PR_NUMBER} touched \`${MOD_NAME}\`. See FORGE:BUILDER comment on issue #{NUMBER} for full change list.
Key gotcha recorded: (update this entry by editing \`${MOD_PATH}\` in a follow-up PR if the change revealed a new failure mode).
Cite: #${NUMBER} / PR #{PR_NUMBER}."

  # Ensure dossier file exists (create skeleton if missing — allows operator to create
  # a new module entry in index.yaml before the dossier file is seeded)
  if [ ! -f "$DOSSIER_ABS" ]; then
    mkdir -p "$(dirname "$DOSSIER_ABS")"
    cat > "$DOSSIER_ABS" <<DOSSIER_INIT_EOF
---
module: ${MOD_NAME}
glob: "${MOD_GLOB}"
authority: required
token_cost: 200
last_compacted: "${DOSSIER_TIMESTAMP}"
---

# Module Dossier: ${MOD_NAME}

Rolling per-module knowledge log. Each entry is 3–5 lines with a citation.
Hard cap: 150 lines. Entries are appended by close.md Phase C1.7 after each
PR that touches this module. When the file exceeds 150 lines, oldest entries
are compacted into the Summary block (LLM compaction, in-run).

## Summary

_No compacted history yet. Dossier was auto-created on ${DOSSIER_TIMESTAMP} by close.md Phase C1.7._
DOSSIER_INIT_EOF
    echo "Phase C1.7: Created new dossier skeleton at ${DOSSIER_ABS}"
  fi

  # Append entry (avoid subshell — use file redirect directly)
  printf '\n%s\n' "$DOSSIER_ENTRY" >> "$DOSSIER_ABS"

  # Compact if over 150 lines
  DOSSIER_LINE_COUNT=$(wc -l < "$DOSSIER_ABS" 2>/dev/null || echo 0)
  if [ "$DOSSIER_LINE_COUNT" -gt 150 ]; then
    echo "Phase C1.7: Dossier ${MOD_PATH} has ${DOSSIER_LINE_COUNT} lines (>150) — compacting oldest entries"
    # LLM compaction: read the dossier, summarize oldest Entry blocks into the ## Summary
    # section, keeping the most recent 3 entries intact.
    # Implementation note: this is prose-instruction compaction (LLM reads the file and
    # rewrites it). The compacted file must preserve the frontmatter and ## Summary block;
    # it may replace old ## Entry blocks with a single "## Archived Summary (compacted)"
    # block. After compaction, update frontmatter last_compacted to today's date.
    # The compacted file MUST be ≤ 150 lines. If compaction fails (e.g. LLM context
    # overflow), log a warning and leave the file as-is — never delete entries silently.
    echo "COMPACT INSTRUCTION: Read ${DOSSIER_ABS}. Keep the frontmatter (lines between ---), keep the ## Summary section, keep the 3 most recent ## Entry blocks, and replace all older ## Entry blocks with a single '## Archived Summary (compacted — ${DOSSIER_TIMESTAMP})' block containing a 5–8 line distillation of the key failure modes, gotchas, and citations from the archived entries. Write the result back to ${DOSSIER_ABS}. The output MUST be ≤ 150 lines. Update frontmatter last_compacted to ${DOSSIER_TIMESTAMP}."
  fi

  DOSSIER_UPDATED_MODULES="${DOSSIER_UPDATED_MODULES} ${MOD_NAME}"

done <<< "$MODULE_ENTRIES"
```

### Step 3: Commit dossier changes and post annotation

```bash
if [ -n "$DOSSIER_UPDATED_MODULES" ]; then
  # Commit the updated dossier files
  cd "${REPO_PATH}"
  CHANGED_DOSSIER_FILES=$(echo "$DOSSIER_UPDATED_MODULES" | tr ' ' '\n' | while IFS= read -r mod; do
    yq ".modules[]? | select(.name == \"${mod}\") | \"${DEVDOCS_REL}/\" + .path" "$INDEX_PATH" 2>/dev/null
  done | grep -v '^$')

  if [ -n "$CHANGED_DOSSIER_FILES" ]; then
    # CHANGED_DOSSIER_FILES is newline-separated — iterate so paths containing
    # spaces are staged individually rather than word-split by the shell.
    while IFS= read -r dossier_file; do
      [ -n "$dossier_file" ] || continue
      git -C "${REPO_PATH}" add "$dossier_file" 2>/dev/null || true
    done <<< "$CHANGED_DOSSIER_FILES"
    # Only commit if there are staged changes (new or modified dossier files)
    if ! git -C "${REPO_PATH}" diff --cached --quiet 2>/dev/null; then
      git -C "${REPO_PATH}" commit -s -m "docs(dossier): append entry for PR #{PR_NUMBER} (#${NUMBER})" 2>/dev/null || true
      echo "Phase C1.7: Dossier commit created for modules:${DOSSIER_UPDATED_MODULES}"
    else
      echo "Phase C1.7: No staged dossier changes — skipping commit"
    fi
  fi

  # Post annotation on the issue
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DOSSIER_UPDATED -->
Module dossier(s) updated:${DOSSIER_UPDATED_MODULES}

Entries appended to \`devdocs/modules/\` after PR #{PR_NUMBER} merged. Future agents working
on these modules will receive the updated knowledge through the devdocs channel (context.md Phase C-1).

<!-- FORGE:DOSSIER_UPDATED:COMPLETE -->" 2>/dev/null || true
else
  echo "Phase C1.7: No module dossiers matched changed files — skipping"
fi
```

---

## Phase C1.5: Project Board Update (Status=Done, Workflow=Merged)

**Skip if**: `TERMINAL_STATE` is `decomposed` or `invalid`. Non-blocking: a missing board, item or option never stalls the close.

Update the project board to reflect the merged state. This replaces the old Phase 5E project board update that existed before the modular refactor.

**Read project board config from `forge.yaml → project_board`** (`owner`, `project_number`, `project_id`, `field_ids`, `option_ids`). **Fallback**: if the `project_board` section is absent, fall back to `forge.yaml → project.owner` and project number `1`, and resolve the project id, field ids and option ids from the board itself (`gh project view` / `gh project field-list`). If even that yields no owner, project id or Status field, skip the board update:

```bash
# Read project board config from forge.yaml
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_ID=$(yq '.project_board.project_id // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_NUMBER=$(yq '.project_board.project_number // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
STATUS_FIELD_ID=$(yq '.project_board.field_ids.status // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
WORKFLOW_FIELD_ID=$(yq '.project_board.field_ids.workflow // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
STATUS_DONE_OPTION_ID=$(yq '.project_board.option_ids.status.done // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
WORKFLOW_MERGED_OPTION_ID=$(yq '.project_board.option_ids.workflow.merged // ""' "$CONFIG_FILE" 2>/dev/null || echo "")

# project_board section absent -> fall back to project.owner + project number 1 and discover the ids
if [ -z "$PROJECT_BOARD_OWNER" ] && [ -z "$PROJECT_ID" ]; then
  PROJECT_BOARD_OWNER=$(yq '.project.owner // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
  PROJECT_NUMBER="${PROJECT_NUMBER:-1}"
  if [ -n "$PROJECT_BOARD_OWNER" ]; then
    PROJECT_ID=$(gh project view "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --format json --jq '.id' 2>/dev/null || echo "")
    FIELDS_JSON=$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --format json 2>/dev/null || echo "")
    STATUS_FIELD_ID=$(printf '%s' "$FIELDS_JSON" | jq -r '.fields[]? | select(.name == "Status") | .id' 2>/dev/null | head -1)
    STATUS_DONE_OPTION_ID=$(printf '%s' "$FIELDS_JSON" | jq -r '.fields[]? | select(.name == "Status") | .options[]? | select(.name == "Done") | .id' 2>/dev/null | head -1)
    WORKFLOW_FIELD_ID=$(printf '%s' "$FIELDS_JSON" | jq -r '.fields[]? | select(.name == "Workflow") | .id' 2>/dev/null | head -1)
    WORKFLOW_MERGED_OPTION_ID=$(printf '%s' "$FIELDS_JSON" | jq -r '.fields[]? | select(.name == "Workflow") | .options[]? | select(.name == "Merged") | .id' 2>/dev/null | head -1)
  fi
fi
PROJECT_NUMBER="${PROJECT_NUMBER:-1}"

if [ -z "$PROJECT_BOARD_OWNER" ] || [ -z "$PROJECT_ID" ] || [ -z "$STATUS_FIELD_ID" ]; then
  echo "INFO: project board not configured or not discoverable — skipping board update"
  # → STOP: do not proceed to ITEM_ID fetch or board update — continue to Phase C2
else
  # Project board is configured — find the item and update it

  # Find the project item ID for this issue
  ISSUE_URL="https://github.com/{GH_REPO}/issues/{NUMBER}"
  ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --format json --limit 200 \
    --jq ".items[] | select(.content.url == \"$ISSUE_URL\") | .id" 2>/dev/null | head -1)

  if [ -n "$ITEM_ID" ]; then
    # Set Status=Done
    if [ -n "$STATUS_FIELD_ID" ] && [ -n "$STATUS_DONE_OPTION_ID" ]; then
      gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
        --field-id "$STATUS_FIELD_ID" --single-select-option-id "$STATUS_DONE_OPTION_ID" 2>/dev/null || true
    fi

    # Set Workflow=Merged
    if [ -n "$WORKFLOW_FIELD_ID" ] && [ -n "$WORKFLOW_MERGED_OPTION_ID" ]; then
      gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
        --field-id "$WORKFLOW_FIELD_ID" --single-select-option-id "$WORKFLOW_MERGED_OPTION_ID" 2>/dev/null || true
    fi
  else
    echo "INFO: Issue #{NUMBER} not found on project board — skipping board update"
  fi
fi
```

**Project board field IDs are read from `forge.yaml → project_board`**. To configure:
```yaml
project_board:
  owner: "{your-github-org}"
  project_number: 1
  project_id: "PVT_kwHO..."
  field_ids:
    status: "PVTSSF_..."
    workflow: "PVTSSF_..."
  option_ids:
    status:
      done: "..."
    workflow:
      merged: "..."
```
To find your project IDs: `gh project list --owner {owner}` and `gh project field-list {number} --owner {owner}`.

---

## Phase C2: Ensure Issue is Closed

**Skip if**: `TERMINAL_STATE` is `decomposed` or `invalid` (the issue is not closed by this phase — see Terminal-state routing).

**Multi-phase guard**: If `REMAINING_AFTER > 0` (set in Phase C1), uncompleted phases remain — do NOT close the issue. Instead, post a phase-complete comment and return early so the router can pick up the next phase.

```bash
ISSUE_STATE=$(gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state')
```

**If `REMAINING_AFTER > 0`** (multi-phase: uncompleted phases remain):
```bash
# Post phase-complete marker — the router's continuation rule re-reads labels and continues to the next phase
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:PHASE:COMPLETE -->
Phase complete. PR #{PR_NUMBER} merged to \`{PR_BASE}\`. ${REMAINING_AFTER} phase item(s) remain — leaving issue open for next pipeline iteration." # allowlist:check-command-side-effects

# Reset the workflow label to investigating so the router has a signal for which phase comes next
# (fixes: issue #1381). The transition removes every other workflow:* label (tiered transition-label dispatch).
set_workflow_state {NUMBER} investigating
```

Then STOP — do not close, do not post a trajectory, do not run C3–C6 (the worktree is kept for the next phase). Print the final reply:

```
CLOSE_RESULT:
  status: PHASE_COMPLETE
  issue_state: open
  trajectory_url:
  decision_record_url:
  parent_updated: false
  parent_closed: false
  blocker:
```

**If `REMAINING_AFTER == 0`** (all phases complete — single-phase or final phase of multi-phase):

If state is `OPEN`:
```bash
if [ "$ISSUE_STATE" = "OPEN" ]; then
  if [ -n "$PR_NUMBER" ]; then CLOSE_COMMENT="Closed: PR #{PR_NUMBER} merged to \`{PR_BASE}\`. Closes #{NUMBER}."
  else CLOSE_COMMENT="Closed: investigation complete (no PR). Closes #{NUMBER}."; fi
  gh issue close {NUMBER} {GH_FLAG} --comment "$CLOSE_COMMENT" # allowlist:check-command-side-effects
fi
```

Transition the workflow label to `merged` (tiered `transition-label` dispatch; the prose tier removes the FULL set: investigating, ready-to-build, building, in-review, awaiting-merge, invalid, decomposed):
```bash
set_workflow_state {NUMBER} merged
```

---

## Phase C3: Parent Tracker Update (Sub-Issues Only)

**Skip if**: `TERMINAL_STATE` is `decomposed` or `invalid`, OR the issue body does NOT contain a parent issue reference (e.g. `Part of #NNN`) or the issue has no parent in its milestone tracker.

Detect parent reference. Markdown emphasis markers (`**bold**`, `__bold__`, `*italic*`) are stripped before matching, since sub-issue bodies commonly render the label as `**Parent**: #NNN` and the bare label alternation below would otherwise fail to match past the emphasis characters. POSIX ERE only (no PCRE — `grep -P` is unavailable on macOS/BSD grep):
```bash
PARENT_REF=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' \
  | sed -E 's/[*_]+//g' \
  | grep -ioE '(part of|spawned from|sub-issue of|parent issue:?|parent:)[[:space:]]*#[0-9]+' \
  | head -1 | sed 's/.*#//')
PARENT_UPDATED=false; PARENT_CLOSED=false
```

If no parent reference found → log a warning and skip this phase (`PARENT_STATUS="⏭ Skipped"`, `PARENT_NOTES="No parent tracker"`):
```bash
echo "WARNING: No parent reference found in issue body — skipping parent tracker update"
```

If parent found:
```bash
# Read parent body (fresh read immediately before the body mutation)
PARENT_BODY=$(gh issue view "$PARENT_REF" {GH_FLAG} --json body --jq '.body')

# Check off this sub-issue in parent body (replace "- [ ] #{NUMBER}" with "- [x] #{NUMBER}"; the trailing guard stops #12 matching #123)
UPDATED_PARENT=$(printf '%s\n' "$PARENT_BODY" | sed -E "s/- \[ \] #${NUMBER}([^0-9]|\$)/- [x] #${NUMBER}\1/g")
gh issue edit "$PARENT_REF" {GH_FLAG} --body "$UPDATED_PARENT" # allowlist:check-command-side-effects
PARENT_UPDATED=true

# Check if all sub-issues are now checked off
OPEN_SUBS=$(printf '%s\n' "$UPDATED_PARENT" | grep -cE '^[[:space:]]*[-*+] \[ \]' || true)
OPEN_SUBS=${OPEN_SUBS:-0}
```

If `OPEN_SUBS == 0` (all sub-issues checked off) — close the parent and transition it to `merged` with the same tiered dispatch and FULL remove list as C2:
```bash
if [ "$OPEN_SUBS" -eq 0 ]; then
  gh issue close "$PARENT_REF" {GH_FLAG} --comment "All sub-issues complete. Closing parent tracker. Last completed: #{NUMBER}${PR_NUMBER:+ (PR #${PR_NUMBER})}." # allowlist:check-command-side-effects
  set_workflow_state "$PARENT_REF" merged
  PARENT_CLOSED=true
fi
```

Set `PARENT_STATUS="✅ Complete"` and `PARENT_NOTES="Checked off in #${PARENT_REF}"` when the parent was updated.

---

## Phase C4: Summary Report

All values (`TITLE`, `VERDICT`, `CONFIDENCE`, `LANE_LABEL`, `FILES_CHANGED`, …) were derived from GitHub state in Phase C0 — do not re-guess them.

Output to stdout (returned to calling agent):

```
## Done: #{NUMBER} — {TITLE}
- Investigation: {VERDICT} ({CONFIDENCE})
- Lane: {LANE_LABEL}
- Fix: {BRANCH} → PR #{PR_NUMBER} → merged to `{PR_BASE}`
- Files changed: {FILES_CHANGED}
```

For PR-less terminals replace the `Fix:` line with `- Outcome: {TERMINAL_STATE} (no PR)`. Render a missing `VERDICT`/`CONFIDENCE` as `—`.

---

## Phase C4.5: Pipeline Summary Card (MANDATORY)

The shareable artifact. After the close completes, render a box-drawing summary card to
stdout (terminal screenshot moment) AND compute a machine-readable twin that Phase C5
embeds in the `FORGE:TRAJECTORY` comment for platform consumption.

**All stats are real — pulled from `gh`/`git`. Every lookup degrades gracefully: a missing
value renders as `—` and NEVER aborts the card. Do NOT fabricate stats.**

### C4.5a: Gather real stats

```bash
# Commit / diff stats from the merged PR (single API call). Fallbacks to "—" if absent or PR-less.
PR_STATS=""
[ -n "$PR_NUMBER" ] && PR_STATS=$(gh pr view {PR_NUMBER} {GH_FLAG} --json commits,additions,deletions,baseRefName,isDraft 2>/dev/null)
COMMITS=$(echo "$PR_STATS"   | jq -r '(.commits | length) // empty' 2>/dev/null); COMMITS=${COMMITS:-—}
ADDITIONS=$(echo "$PR_STATS" | jq -r '.additions // empty' 2>/dev/null); ADDITIONS=${ADDITIONS:-—}
DELETIONS=$(echo "$PR_STATS" | jq -r '.deletions // empty' 2>/dev/null); DELETIONS=${DELETIONS:-—}
PR_TARGET=$(echo "$PR_STATS" | jq -r '.baseRefName // empty' 2>/dev/null); PR_TARGET=${PR_TARGET:-${PR_BASE:-—}}
IS_DRAFT=$(echo "$PR_STATS"  | jq -r '.isDraft // false' 2>/dev/null)

# Review summary — count domain-agent verdicts posted by /review-pr on the PR (PR-less: nothing to count).
REVIEW_BODIES=""
[ -n "$PR_NUMBER" ] && REVIEW_BODIES=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '[.reviews[].body // ""] + [.comments[].body // ""] | .[]' 2>/dev/null)
# NOTE: `grep -c` already prints `0` on no match (and exits non-zero) — do NOT add
# `|| echo 0`, which would append a second line ("0\n0") and break the arithmetic
# and `--argjson` below. Swallow the non-zero exit with `|| true`, then default.
APPROVED=$(echo "$REVIEW_BODIES" | grep -cE 'APPROVED:' 2>/dev/null || true); APPROVED=${APPROVED:-0}
CHANGES=$(echo  "$REVIEW_BODIES" | grep -cE 'CHANGES REQUESTED:' 2>/dev/null || true); CHANGES=${CHANGES:-0}
TOTAL_AGENTS=$((APPROVED + CHANGES))
# Blockers = review-finding issues created by this PR that are still open (best-effort).
BLOCKERS=$(echo "$REVIEW_BODIES" | grep -ciE 'blocker|merge.?block' 2>/dev/null || true); BLOCKERS=${BLOCKERS:-0}
if [ "$TOTAL_AGENTS" -gt 0 ]; then
  REVIEW_SUMMARY="${APPROVED}/${TOTAL_AGENTS} agents passed, ${BLOCKERS} blockers"
else
  REVIEW_SUMMARY="—"   # review data unavailable (e.g. review skipped)
fi

# Elapsed wall-clock: first FORGE agent comment → now.
FIRST_TS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:")) | .created_at] | sort | .[0] // empty' 2>/dev/null)
if [ -n "$FIRST_TS" ]; then
  START_EPOCH=$(date -u -d "$FIRST_TS" +%s 2>/dev/null \
    || python3 -c "import sys,datetime; ts=sys.argv[1].rstrip('Z'); print(int(datetime.datetime.fromisoformat(ts+'+00:00').timestamp()))" "$FIRST_TS" 2>/dev/null \
    || echo "")
  NOW_EPOCH=$(date -u +%s)
  if [ -n "$START_EPOCH" ]; then
    ELAPSED_SECS=$((NOW_EPOCH - START_EPOCH))
    ELAPSED=$(printf '%dm %02ds' $((ELAPSED_SECS / 60)) $((ELAPSED_SECS % 60)))
  else ELAPSED="—"; ELAPSED_SECS=0; fi
else ELAPSED="—"; ELAPSED_SECS=0; fi

# Pipeline line + status — reflect the ACTUAL terminal state (from --terminal-state).
#   merged        → investigate → architect → build → review → merge ✓
#   investigation → investigate ✓ (investigation only, no PR)
#   decomposed    → investigate → decompose ⏹ (sub-issues spawned)
#   invalid       → investigate → invalid ✗
#   blocked       → investigate → … → blocked ⚠ (needs-human; not a --terminal-state value, kept for card rendering)
#   draft PR      → append "(draft)" to the merge segment
case "$TERMINAL_STATE" in
  investigation) PIPELINE_LINE="investigate ✓ (investigation only)"; CARD_STATUS="investigation" ;;
  decomposed) PIPELINE_LINE="investigate → decompose ⏹"; CARD_STATUS="decomposed" ;;
  invalid)    PIPELINE_LINE="investigate → invalid ✗";   CARD_STATUS="invalid" ;;
  blocked)    PIPELINE_LINE="investigate → build → blocked ⚠"; CARD_STATUS="blocked" ;;
  *)          PIPELINE_LINE="investigate → architect → build → review → merge ✓"; CARD_STATUS="merged" ;;
esac
[ "$IS_DRAFT" = "true" ] && PIPELINE_LINE="${PIPELINE_LINE} (draft)"
```

### C4.5b: Render the card to stdout

Print the card to stdout (the calling agent surfaces it in the terminal; the router relays only the `CLOSE_RESULT:` block, so print the card BEFORE it). Card inner
width is **51** columns. Truncate the title with an ellipsis (`…`) if `#{NUMBER} — {TITLE}`
exceeds the field; pad shorter lines with spaces so the right border `║` stays aligned.

```
╔═══════════════════════════════════════════════════╗
║  ForgeDock Pipeline Complete                      ║
╠═══════════════════════════════════════════════════╣
║                                                   ║
║  Issue:    #{NUMBER} — {TITLE}                    ║
║  Pipeline: {PIPELINE_LINE}                        ║
║  Commits:  {COMMITS} ({ADDITIONS} additions, {DELETIONS} deletions) ║
║  PR:       #{PR_NUMBER} (merged to {PR_TARGET})   ║
║  Review:   {REVIEW_SUMMARY}                       ║
║  Time:     {ELAPSED}                              ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
```

**Edge-case rendering**:
- Investigation-only: header `ForgeDock Pipeline — Investigation Complete`; `Pipeline:` shows `investigate ✓ (investigation only)`; `PR:`, `Review:`, `Commits:` render `—`.
- Decomposed: title line stays; `Pipeline:` shows `investigate → decompose ⏹`; `PR:`, `Review:`, `Commits:` render `—`; the header reads `ForgeDock Pipeline — Decomposed`.
- Invalid: header `ForgeDock Pipeline — Closed (invalid)`; `Pipeline:` shows `investigate → invalid ✗`; downstream stats `—`.
- Blocked / needs-human: header `ForgeDock Pipeline — Blocked`; `Review:`/`PR:` reflect last known state; remaining stats `—`.
- Draft PR: `PR:` line appends `(draft)` and the merge segment is not marked `✓`.

### C4.5c: Build the machine-readable twin

Assemble the JSON object below. Its field set is exactly what Phase C5 passes to the codec `emit CARD --b64` call (including `title` and `blockers`); the JSON itself is for local use/debugging and is not embedded. Numeric stats that were `—`
become `null` in JSON; never emit `"—"` as a number.

```bash
CARD_JSON=$(jq -nc \
  --argjson issue {NUMBER} \
  --arg title "$TITLE" \
  --arg status "$CARD_STATUS" \
  --arg pipeline "$PIPELINE_LINE" \
  --arg pr "$PR_NUMBER" \
  --arg target "$PR_TARGET" \
  --arg commits "$COMMITS" --arg adds "$ADDITIONS" --arg dels "$DELETIONS" \
  --arg review "$REVIEW_SUMMARY" --argjson blockers "${BLOCKERS:-0}" \
  --argjson elapsed "${ELAPSED_SECS:-0}" \
  '{issue:$issue, title:$title, status:$status, pipeline:$pipeline,
    pr:($pr|tonumber? // null), pr_target:$target,
    commits:($commits|tonumber? // null),
    additions:($adds|tonumber? // null),
    deletions:($dels|tonumber? // null),
    review:$review, blockers:$blockers, elapsed_seconds:$elapsed}')
```

---

## Phase C5: Trajectory Log (MANDATORY)

**CODEC PATH (forge#1727)**: Post the `<!-- FORGE:TRAJECTORY -->` comment via the protocol codec — do NOT hand-roll the opening tag. Use `node "$CODEC_CLI" emit TRAJECTORY` (or `forge-annotation.sh write TRAJECTORY --field ...`) to produce the opening tag; the codec handles any field escaping. `CODEC_CLI` resolves from the ForgeDock install root (`FORGE_ROOT`, from the script-resolution block), never from the consumer's cwd.

**This file is the single source** for the trajectory comment, the summary card and the decision record — there is no second inline copy to keep in sync.

### Step 1: Resolve the codec, review row, anomalies, decisions

```bash
CODEC_CLI=""
[ -n "${FORGE_ROOT:-}" ] && [ -f "$FORGE_ROOT/packages/protocol/src/cli.js" ] && CODEC_CLI="$FORGE_ROOT/packages/protocol/src/cli.js"
[ -z "$CODEC_CLI" ] && [ -f "$REPO_PATH/packages/protocol/src/cli.js" ] && CODEC_CLI="$REPO_PATH/packages/protocol/src/cli.js"
TRAJECTORY_HEADER=""
[ -n "$CODEC_CLI" ] && TRAJECTORY_HEADER=$(node "$CODEC_CLI" emit TRAJECTORY 2>/dev/null)
# Codec CLI genuinely absent (not installed): the literal opening tag is the exact string the codec emits.
[ -n "$TRAJECTORY_HEADER" ] || TRAJECTORY_HEADER="<!-- FORGE:TRAJECTORY -->"
```

**Review-presence check** (run before filling in the Review + PR row): <!-- Added: forge#381 -->
```bash
# Check whether /review-pr was actually invoked — look for review agent comments on the PR
REVIEW_PRESENT="false"
if [ -n "$PR_NUMBER" ]; then
  REVIEW_PRESENT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
    --jq '([.reviews[].body // ""] + [.comments[].body // ""]) |
          map(select(test("APPROVED:|CHANGES REQUESTED:|FORGE:REVIEWER|review-pr";"i"))) |
          length > 0' 2>/dev/null || echo "false")
  # Set the Review + PR row: ✅ Merged if review present, ⚠ Skipped (no review) if not
  REVIEW_ROW=$([ "$REVIEW_PRESENT" = "true" ] && echo "✅ Merged" || echo "⚠ Skipped (no review)")
else
  REVIEW_ROW="⏭ N/A (no PR)"
fi

# Anomalies: close-scope invariant violations (Phase C0.5 + post-C2 check) and a skipped review.
ANOMALIES=""
if [ -n "${INVARIANT_ANOMALIES:-}" ]; then
  ANOMALIES=$(printf '%s' "$INVARIANT_ANOMALIES" | tr '\n' ' ' | sed 's/  */ /g; s/ *$//')
fi
if [ -n "$PR_NUMBER" ] && [ "$REVIEW_PRESENT" != "true" ]; then
  ANOMALIES="${ANOMALIES:+$ANOMALIES; }review skipped: no review-pr output found on PR #${PR_NUMBER}"
fi
ANOMALIES_TEXT="${ANOMALIES:-None}"
```

This check is **audit-only** — it annotates the trajectory for visibility and cannot retroactively block a merged PR. A `⚠ Skipped (no review)` is always logged in the Anomalies field so the skip is surfaced during pipeline health review.

**Rows and decisions are parameterised by `TERMINAL_STATE` and `LANE`** — nothing is hard-coded to "Feature lane" / "✅ Merged" / "Anomalies: None":

```bash
if [ -n "$PR_BASE" ]; then LANE_NOTE="${LANE_LABEL} lane → \`${PR_BASE}\`"; else LANE_NOTE="${LANE_LABEL} lane"; fi
case "$TERMINAL_STATE" in
  merged)
    PHASE2_ROW="⏭ Skipped | Single-concern change, no decomposition needed"
    BUILD_ROW="✅ Complete | Branch: \`${BRANCH}\`"
    GATE_CELL="${GATE_ROW} | ${GATE_NOTE}"
    VERIF_CELL="${VERIFICATION_ROW} |"
    REVIEW_CELL="${REVIEW_ROW} | PR #${PR_NUMBER} → \`${PR_BASE}\`"
    CLOSE_CELL="✅ Complete | Issue closed"
    DECISIONS_BLOCK="- Decomposition skipped: single-concern change, no decomposition needed
- PR merged to: \`${PR_BASE}\` (${LANE} lane)" ;;
  investigation)
    PHASE2_ROW="⏭ Skipped | Investigation-only task"
    BUILD_ROW="✅ Complete | Investigation deliverables created (no PR)"
    GATE_CELL="⏭ N/A | no code change"; VERIF_CELL="⏭ N/A |"; REVIEW_CELL="⏭ N/A (no PR) |"
    CLOSE_CELL="✅ Complete | Issue closed"
    DECISIONS_BLOCK="- Investigation-only task: no PR produced" ;;
  decomposed)
    PHASE2_ROW="✅ Decomposed | Sub-issues spawned (see FORGE:DECOMPOSED)"
    BUILD_ROW="⏭ Skipped | Handled by sub-issues"
    GATE_CELL="⏭ N/A |"; VERIF_CELL="⏭ N/A |"; REVIEW_CELL="⏭ N/A (no PR) |"
    CLOSE_CELL="✅ Complete | Issue left open (sub-issue tracker)"
    DECISIONS_BLOCK="- Decomposed into sub-issues; this issue stays open as the tracker" ;;
  invalid)
    PHASE2_ROW="⏭ Skipped | Issue invalid"
    BUILD_ROW="⏭ Skipped | Issue invalid"
    GATE_CELL="⏭ N/A |"; VERIF_CELL="⏭ N/A |"; REVIEW_CELL="⏭ N/A (no PR) |"
    CLOSE_CELL="✅ Complete | Issue closed (invalid)"
    DECISIONS_BLOCK="- Closed as invalid after investigation" ;;
esac
# C6 runs after this post and cannot fail the close, so the planned outcome is recorded here.
if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then CLEANUP_STATUS="✅ Removed"; else CLEANUP_STATUS="⏭ Skipped"; fi
PARENT_STATUS="${PARENT_STATUS:-⏭ Skipped}"; PARENT_NOTES="${PARENT_NOTES:-No parent tracker}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

### Step 2: Prior delta computation

Read cost-prior for this issue's task_type × module before posting (forge#1743):

```bash
# Compute actual vs prior cost delta for self-correction of cost priors
COST_PRIORS_PATH="${HOME}/.forge/index/cost-priors.json"
ACTUAL_TOTAL_USD=""
PRIOR_EST_USD=""
COST_DELTA_NOTE=""

# Read actual spend from FORGE:BUILDER best-effort telemetry (the same cost_usd extraction
# is used for the per-stage cost block in Phase C5.5). ERE/sed only — no PCRE.
ACTUAL_TOTAL_USD=$(printf '%s\n' "$BUILDER_BODY" \
  | sed -n 's/.*cost_usd: *\([0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p' | head -1)

if [ -n "$ACTUAL_TOTAL_USD" ] && [ -f "$COST_PRIORS_PATH" ]; then
  # Derive task_type:module key (same logic as the orchestrate cost-prior step) — TASK_TYPE comes from Phase C0
  TASK_TYPE_KEY=$(printf '%s' "$TASK_TYPE" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-')
  PRIMARY_FILE=$(printf '%s\n' "$INVESTIGATOR_BODY" \
    | grep -oE '`[^`]+\.(py|mjs|ts|md|sh|yaml|yml)`' | tr -d '`' | head -1 || echo '')
  MODULE=$(basename "${PRIMARY_FILE:-_unknown}" | sed 's/\.[^.]*$//' | tr '[:upper:]' '[:lower:]')
  [ -z "$MODULE" ] && MODULE="_unknown"
  PRIOR_KEY="${TASK_TYPE_KEY}:${MODULE}"

  PRIOR_EST_USD=$(jq -r --arg k "$PRIOR_KEY" '.priors[$k].mean // empty' "$COST_PRIORS_PATH" 2>/dev/null || echo '')

  if [ -n "$PRIOR_EST_USD" ]; then
    DELTA=$(echo "scale=4; $ACTUAL_TOTAL_USD - $PRIOR_EST_USD" | bc 2>/dev/null || echo "?")
    COST_DELTA_NOTE="actual=\$${ACTUAL_TOTAL_USD} prior=\$${PRIOR_EST_USD} delta=${DELTA} key=${PRIOR_KEY}"
  else
    COST_DELTA_NOTE="actual=\$${ACTUAL_TOTAL_USD} prior=absent (no prior for key ${PRIOR_KEY})"
  fi
elif [ -n "$ACTUAL_TOTAL_USD" ]; then
  COST_DELTA_NOTE="actual=\$${ACTUAL_TOTAL_USD} prior=index-absent"
else
  COST_DELTA_NOTE="no-telemetry"
fi
```

### Step 3: Build the card line and post

The CARD line carries the same fields as the Phase C4.5c twin, **including `title` and `blockers`**, encoded by the codec (`--b64`):

```bash
CARD_LINE=""
if [ -n "$CODEC_CLI" ]; then
  CARD_LINE=$(node "$CODEC_CLI" emit CARD --b64 \
    --field issue="${NUMBER}" \
    --field title="${TITLE}" \
    --field status="${CARD_STATUS}" \
    --field pipeline="${PIPELINE_LINE}" \
    --field pr="${PR_NUMBER}" \
    --field pr_target="${PR_TARGET}" \
    --field commits="${COMMITS}" \
    --field additions="${ADDITIONS}" \
    --field deletions="${DELETIONS}" \
    --field review="${REVIEW_SUMMARY}" \
    --field blockers="${BLOCKERS:-0}" \
    --field elapsed="${ELAPSED_SECS:-0}" 2>/dev/null) || CARD_LINE=""
fi

TRAJ_FILE=$(mktemp)
cat > "$TRAJ_FILE" <<TRAJ_EOF
${TRAJECTORY_HEADER}
## Pipeline Trajectory — #${NUMBER}

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 0: Context Load | ✅ Complete | ${LANE_NOTE} |
| Phase 1: Investigation | ✅ ${VERDICT:-—} (${CONFIDENCE:-—}) | Task type: ${TASK_TYPE} (${COMPLEXITY_BAND}) |
| Phase 2: Decomposition | ${PHASE2_ROW} |
| Phase 3: Build | ${BUILD_ROW} |
| Phase 3G: Quality Gate | ${GATE_CELL} |
| Phase 3H: Verification | ${VERIF_CELL} |
| Phase 4–5: Review + PR | ${REVIEW_CELL} |
| Phase 6: Parent Tracker | ${PARENT_STATUS} | ${PARENT_NOTES} |
| Phase C6: Cleanup | ${CLEANUP_STATUS} | Worktree: ${WORKTREE_PATH:-none}, Branch: ${BRANCH:-none} |
| Phase 7: Close | ${CLOSE_CELL} |

**Decisions**:
${DECISIONS_BLOCK}

**Anomalies**: ${ANOMALIES_TEXT}

**Cost (economic scheduling)**: ${COST_DELTA_NOTE}

**Pipeline completed**: ${TIMESTAMP}

${CARD_LINE}
TRAJ_EOF

DRY_RUN="${DRY_RUN:-false}"
TRAJECTORY_URL=""
if [ "$DRY_RUN" = "true" ]; then
  echo "DRY_RUN: would post FORGE:TRAJECTORY comment on #${NUMBER}"
else
  TRAJECTORY_URL=$(gh issue comment {NUMBER} {GH_FLAG} --body-file "$TRAJ_FILE" 2>/dev/null) \
    || TRAJECTORY_URL=$(gh issue comment {NUMBER} {GH_FLAG} --body-file "$TRAJ_FILE" 2>/dev/null) \
    || CLOSE_FAILED="C5: failed to post FORGE:TRAJECTORY comment"
fi
rm -f "$TRAJ_FILE"
```

If `CLOSE_FAILED` is set, STOP: print `CLOSE_RESULT: status: FAILED` with `blocker: "$CLOSE_FAILED"` (do not run C5.1–C6).

The `**Decisions**:` block MUST stay a bullet list and `**Decisions**:` must precede `**Anomalies**:` — the Phase C5.4 ADR extractor reads the lines between those two markers.

The `<!-- FORGE:CARD: v1 sha:... b64:... -->` line carries the machine-readable summary (the Phase C4.5c fields plus `title` and `blockers`), encoded as Base64url (design decision 2026-07-08: encoding beats escaping — the Base64url alphabet cannot contain HTML comment delimiters by construction). It is wrapped in the inline-value annotation form `<!-- FORGE:CARD: ... -->` so `parse()` extracts the encoded payload. Platform consumers (e.g. `/orchestrate`) decode via `node "$CODEC_CLI" parse --type CARD [--field <key>]`. This block is **additive**: all existing `FORGE:TRAJECTORY` consumers select via `contains("FORGE:TRAJECTORY")` and parse the markdown table, so the embedded CARD line does not affect them.

**CODEC PATH (forge#1727)**: the `emit CARD --b64` call replaces the previous `<!-- FORGE:CARD ${CARD_JSON} -->` inline-JSON form. The Base64url form is safe against all HTML comment injection vectors and includes a sha8 integrity prefix for truncation detection. Consumers that parsed the old inline-JSON form must migrate to the codec parse path: `echo '...' | node "$CODEC_CLI" parse --type CARD --field <key>`.

Where:
- `PARENT_STATUS` = `⏭ Skipped` (if no parent) or `✅ Complete` (if parent updated)
- `PARENT_NOTES` = `No parent tracker` or `Checked off in #${PARENT_REF}`
- `CLEANUP_STATUS` = `✅ Removed` (worktree removed + branch deleted) or `⏭ Skipped` (no path provided or path not found)
- `TIMESTAMP` = current date/time in ISO format

---

## Phase C5.1: Knowledge Index + Cost Prior Update (forge#1743) <!-- Added: forge#1743 -->

**Goal**: Re-index this issue's knowledge cards and regenerate cost-priors.json so that economic scheduling (orchestrate Step 3E.5) has up-to-date data for future runs. The actual-vs-prior delta recorded in the TRAJECTORY above is the write side of the self-correction loop — this step performs the read/recompute.

**This phase is non-blocking** — if the indexer fails, log the reason and continue to Phase C5.2. Never stall close for the cost-prior update.

**Skip if**: Terminal state is `INVALID` (no useful cost data from invalid issues).

```bash
# Re-index this issue and regenerate cost priors — non-blocking
# Resolve from the ForgeDock install root (FORGE_ROOT, from the script-resolution block) — never from $0, which is meaningless inside a skill
INDEXER_PATH=""
[ -n "${FORGE_ROOT:-}" ] && INDEXER_PATH="$FORGE_ROOT/scripts/build-knowledge-index.mjs"
[ -f "$INDEXER_PATH" ] || INDEXER_PATH="$REPO_PATH/scripts/build-knowledge-index.mjs"
if node --version >/dev/null 2>&1 && [ -f "$INDEXER_PATH" ]; then
  echo "[cost-prior] Re-indexing issue #${NUMBER} and regenerating cost priors..."
  node "$INDEXER_PATH" --issue {NUMBER} --no-mirror 2>&1 | tail -5 \
    && echo "[cost-prior] Cost priors updated" \
    || echo "WARNING: Cost prior update failed — continuing (non-blocking)"
else
  echo "[cost-prior] Indexer not available — skipping cost prior update (non-blocking)"
fi
```

---

## Phase C5.2: Memory Index Update <!-- Added: forge#1316 -->

**Goal**: Append this run's learnings to the per-repo memory index so future `investigate` runs can retrieve relevant priors. This is the write side of the compounding intelligence loop.

**This phase is non-blocking** — if Gist creation or update fails, log the reason and continue to Phase C5.5. Never stall close for memory.

**Skip if**: Terminal state is `INVALID` (nothing useful to learn from an invalid issue) OR `<!-- FORGE:TRAJECTORY -->` was already posted AND `<!-- FORGE:MEMORY_INDEXED -->` comment exists on the issue (idempotency guard).

### Step 1: Compose memory entry

Extract key fields from the pipeline:

```bash
ROOT_CAUSE=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | sed -n '/### Root Cause/{n;p;q}' | head -1 | cut -c1-120)

AFFECTED_FILES_BRIEF=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | sed -n '/### Affected Files/{n;p;q}' | head -1 | cut -c1-120)

DOMAIN_TAGS=$(gh issue view {NUMBER} {GH_FLAG} --json labels \
  --jq '[.labels[].name | select(test("^(auth|billing|database|security|payments|gdpr|perf|ui|api|config)"))] | join(",")' 2>/dev/null || echo "")

MEMORY_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

MEMORY_ENTRY="MEMORY_ENTRY: issue={NUMBER} title=\"{TITLE}\" domain=\"${DOMAIN_TAGS}\" root_cause=\"${ROOT_CAUSE}\" outcome=\"${CARD_STATUS}\" files=\"${AFFECTED_FILES_BRIEF}\" lesson=\"${ROOT_CAUSE}\" timestamp=${MEMORY_TIMESTAMP}"
```

### Step 2: Find or create the memory index Gist

```bash
MEMORY_INDEX_ID=$(gh gist list --limit 100 \
  --jq '.[] | select(.description | contains("FORGE:MEMORY_INDEX: {GH_REPO}")) | .id' 2>/dev/null | head -1)

if [ -z "$MEMORY_INDEX_ID" ]; then
  # First run — create the index Gist
  TMPFILE=$(mktemp)
  cat > "$TMPFILE" <<GIST_EOF
# ForgeDock Memory Index — {GH_REPO}
<!-- FORGE:MEMORY_INDEX: {GH_REPO} -->
Generated by ForgeDock close phase. Each line is a prior pipeline run.

${MEMORY_ENTRY}
GIST_EOF
  # Memory gists MUST be secret — never pass --public here (forge#1587).
  # The entry content below embeds real issue titles, root causes, and file
  # paths; for a private consumer repo, --public would publish that content
  # to a world-readable Gist. `gh gist create` is secret by default, so
  # simply omitting --public is sufficient — the read side (investigate.md
  # Phase 0.5, via `gh gist view`/`gh gist list`) works unchanged against
  # secret gists for the authenticated owner.
  MEMORY_INDEX_URL=$(gh gist create "$TMPFILE" \
    --desc "FORGE:MEMORY_INDEX: {GH_REPO} — per-codebase learning index" \
    2>/dev/null | head -1)
  MEMORY_INDEX_ID=$(echo "$MEMORY_INDEX_URL" | sed 's|.*/||')
  rm -f "$TMPFILE"
  echo "[MEMORY] Created memory index Gist: ${MEMORY_INDEX_URL}"
else
  # Append to existing index
  EXISTING_CONTENT=$(gh gist view "$MEMORY_INDEX_ID" 2>/dev/null)
  UPDATED_CONTENT="${EXISTING_CONTENT}
${MEMORY_ENTRY}"
  INDEX_FILENAME=$(gh api gists/${MEMORY_INDEX_ID} --jq '.files | keys[0]' 2>/dev/null)
  INDEX_FILENAME="${INDEX_FILENAME:-memory_index.md}"
  TMPFILE=$(mktemp)
  echo "$UPDATED_CONTENT" > "$TMPFILE"
  gh gist edit "$MEMORY_INDEX_ID" -f "$INDEX_FILENAME" "$TMPFILE" 2>/dev/null
  EDIT_EXIT=$?
  rm -f "$TMPFILE"
  MEMORY_INDEX_URL="https://gist.github.com/${MEMORY_INDEX_ID}"
  if [ $EDIT_EXIT -eq 0 ]; then
    echo "[MEMORY] Appended to memory index: ${MEMORY_INDEX_URL}"
  else
    echo "WARNING: Failed to update memory index — run will not be persisted"
    MEMORY_INDEX_URL=""
  fi
fi
```

### Migration: replacing an existing public memory-index Gist

GitHub does not support flipping a Gist's visibility from public to secret in place. If you find an existing `FORGE:MEMORY_INDEX: {GH_REPO}` Gist that is **public** (check with `gh api gists/${MEMORY_INDEX_ID} --jq '.public'`), replace it:

```bash
# The gist ID here is the same one found by the FORGE:MEMORY_INDEX search above.
OLD_PUBLIC_GIST_ID="$MEMORY_INDEX_ID"

# 1. Save the existing content so no learnings are lost — and verify the save
#    succeeded BEFORE deleting anything.
gh gist view "$OLD_PUBLIC_GIST_ID" > /tmp/memory_index_migrate.md
if [ ! -s /tmp/memory_index_migrate.md ]; then
  echo "ABORT: failed to save gist content — not deleting the public gist." >&2
  exit 1
fi

# 2. Delete the public gist (removes the world-readable copy)
gh gist delete "$OLD_PUBLIC_GIST_ID" --yes

# 3. Recreate it secret (no --public) with the same description tag so the
#    next close/investigate run finds it via the FORGE:MEMORY_INDEX search
gh gist create /tmp/memory_index_migrate.md \
  --desc "FORGE:MEMORY_INDEX: {GH_REPO} — per-codebase learning index"
```

This is a one-time manual step per affected repo — Phase C5.2 itself only ever creates the index once (Step 2's `if [ -z "$MEMORY_INDEX_ID" ]` branch) and appends afterward, so a stale public gist is never auto-recreated secret on its own.

### Step 3: Post audit annotation on the issue

```bash
if [ -n "$MEMORY_INDEX_URL" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:MEMORY_INDEXED -->
This run has been indexed in the per-repo memory: ${MEMORY_INDEX_URL}

Future \`investigate\` runs on \`{GH_REPO}\` will retrieve this entry as a prior when working on related issues.

<!-- FORGE:MEMORY_INDEXED:COMPLETE -->"
  echo "[MEMORY] Indexed issue #{NUMBER} into memory at: ${MEMORY_INDEX_URL}"
fi
```

---

## Phase C5.3: Knowledge Ledger Index <!-- Added: forge#1732 -->

**Goal**: Index the just-closed issue into the Forge Ledger so future context phases can retrieve
its knowledge cards by file path or symbol without making live GitHub API calls.

**This phase is non-blocking** — if the indexer fails, log the reason and continue to Phase C5.5.
Never stall close for ledger indexing.

**Skip if**: Terminal state is `INVALID` (no confirmed findings to index) OR a `<!-- FORGE:LEDGER_INDEXED -->` comment already exists on the issue (idempotency guard).

**Requires**: `scripts/build-knowledge-index.mjs` present in the repository root. If absent, skip
with a warning — the feature may not be installed on this version.

### Step 1: Idempotency check

```bash
LEDGER_INDEXED=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:LEDGER_INDEXED"))] | length > 0' 2>/dev/null || echo "false")
```

**Skip to Phase C5.5 if `$LEDGER_INDEXED == "true"`**.

### Step 2: Run incremental indexer

Resolve the indexer script path from the ForgeDock install root (`FORGE_ROOT`), falling back to the repository root:

```bash
INDEXER_PATH=""
[ -n "${FORGE_ROOT:-}" ] && INDEXER_PATH="$FORGE_ROOT/scripts/build-knowledge-index.mjs"
[ -f "$INDEXER_PATH" ] || INDEXER_PATH="$REPO_PATH/scripts/build-knowledge-index.mjs"

if [ ! -f "$INDEXER_PATH" ]; then
  echo "[LEDGER] scripts/build-knowledge-index.mjs not found — skipping Phase C5.3"
  echo "[LEDGER] Install: update ForgeDock to a version that ships this file"
else
  # Run incremental indexer for this issue only — ~2 API calls
  LEDGER_EXIT=0
  LEDGER_OUTPUT=$(node "$INDEXER_PATH" \
    --issue {NUMBER} \
    --repo {GH_REPO} \
    --no-mirror \
    2>&1) || LEDGER_EXIT=$?

  if [ $LEDGER_EXIT -eq 0 ]; then
    echo "[LEDGER] Issue #{NUMBER} indexed into Forge Ledger"

    # Mirror update: run separately after single-issue index so mirror has up-to-date postings
    node "$INDEXER_PATH" --issue {NUMBER} --repo {GH_REPO} \
      2>/dev/null || true  # Non-blocking: mirror failure does not affect local index

    # Post audit annotation (idempotency guard for future close runs)
    gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:LEDGER_INDEXED -->
Issue #{NUMBER} has been indexed into the Forge Ledger.

Knowledge cards extracted from FORGE:INVESTIGATOR and FORGE:TRAJECTORY annotations are now
queryable via \`forge recall\` (exact file/symbol lookup or free-text BM25 search).

\`\`\`
forge recall --file {PRIMARY_AFFECTED_FILE} --json
\`\`\`

<!-- FORGE:LEDGER_INDEXED:COMPLETE -->" 2>/dev/null || true

  else
    echo "[LEDGER] WARNING: Indexer exited with code ${LEDGER_EXIT} — continuing"
    echo "[LEDGER] Output: ${LEDGER_OUTPUT}"
  fi
fi
```

### Watermark semantics

The indexer's watermark is `max(issue.updated_at)` across all indexed issues. Indexing a
single issue via `--issue` advances the watermark only if this issue's `updated_at` is newer
than the stored watermark — ensuring the next full incremental run starts from the right
position and does not re-scan already-indexed history.

---

## Phase C5.4: Auto-ADR Extraction from TRAJECTORY Decisions <!-- Added: forge#1737 -->

**Goal**: Promote tradeoff-shaped Decisions bullets from the FORGE:TRAJECTORY comment into
human-readable, git-tracked ADR markdown files at `devdocs/decisions/NNN-{slug}.md`. Architect
plans on future runs will load matching ADRs as constraints before writing any code.

**This phase is non-blocking** — if ADR extraction, file write, or commit fails at any step,
log the reason and continue to Phase C5.5. Never stall close for ADR generation.

**Skip if**: Terminal state is `INVALID` (no useful decisions to record) OR a
`<!-- FORGE:ADR_EXTRACTED -->` comment already exists on the issue (idempotency guard) OR
`devdocs/decisions/` directory does not exist in the repository root (feature not installed).

### What is a "tradeoff-shaped" decision?

A Decisions bullet is extractable if it contains BOTH:
1. A **choice indicator**: words like `chose`, `use`, `prefer`, `process substitution`, `over`,
   `instead`, `rather than`, `not X`
2. A **rationale connector**: `because`, `since`, `so`, `to avoid`, `prevents`, `due to`

Generic bullets like `- Decomposition skipped: single-concern change` do NOT match and are ignored.

### Step 1: Idempotency check

```bash
ADR_EXTRACTED=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:ADR_EXTRACTED"))] | length > 0' 2>/dev/null || echo "false")
```

**Skip to Phase C5.5 if `$ADR_EXTRACTED == "true"`**.

### Step 2: Extract TRAJECTORY Decisions

```bash
# Read the TRAJECTORY comment posted in Phase C5
TRAJECTORY_BODY=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:TRAJECTORY"))] | last | .body // ""' 2>/dev/null || echo '')

# Extract the Decisions section (lines between **Decisions**: and **Anomalies**:)
DECISIONS_RAW=$(echo "$TRAJECTORY_BODY" \
  | awk '/^\*\*Decisions\*\*:/{found=1; next} /^\*\*Anomalies\*\*:/{found=0} found{print}' \
  | grep -v '^[[:space:]]*$' \
  | head -20)  # Cap at 20 bullets to prevent runaway parsing

if [ -z "$DECISIONS_RAW" ] || echo "$DECISIONS_RAW" | grep -qiE '^(- )?None$'; then
  echo "[ADR] No Decisions section found in TRAJECTORY — skipping ADR extraction"
  ADR_FILES_WRITTEN=0
fi
```

### Step 3: Parse and filter for tradeoff shape

```bash
ADR_FILES_WRITTEN=0
DECISIONS_DIR="${REPO_PATH:-$(git rev-parse --show-toplevel 2>/dev/null)}/devdocs/decisions"

if [ -z "$DECISIONS_RAW" ] || ! [ -d "$DECISIONS_DIR" ]; then
  echo "[ADR] Skipping: no decisions or devdocs/decisions/ absent"
else
  # Get commit SHA for anchor citation
  COMMIT_SHA=$(git -C "${REPO_PATH:-$(git rev-parse --show-toplevel 2>/dev/null)}" \
    rev-parse HEAD 2>/dev/null | head -c 12 || echo "unknown")

  while IFS= read -r bullet; do
    # Strip leading "- " or "* "
    text=$(echo "$bullet" | sed 's/^[-*][[:space:]]*//')
    [ -z "$text" ] && continue

    # Tradeoff shape filter: must have a choice indicator + rationale connector
    CHOICE_MATCH=$(echo "$text" | grep -iE 'chose|use |prefer|instead|rather than|over |not [a-z]|process substitution|branched from|avoided' || true)
    RATIONALE_MATCH=$(echo "$text" | grep -iE 'because|since[[:space:]]|so[[:space:]]|to avoid|prevents|due to' || true)

    if [ -z "$CHOICE_MATCH" ] || [ -z "$RATIONALE_MATCH" ]; then
      echo "[ADR] Skipped (not a tradeoff): $text"
      continue
    fi

    # Extract anchor: first backtick-quoted path-like string in the decision text
    ANCHOR_PATH=$(echo "$text" | grep -oE '`[a-zA-Z][^`]*/[^`]+`' | head -1 | tr -d '`' || true)

    # Build slug from first 6 words of decision (lowercase, hyphenated)
    SLUG=$(echo "$text" | tr '[:upper:]' '[:lower:]' | \
      sed 's/[^a-z0-9 ]/ /g' | tr -s ' ' '-' | \
      cut -c1-40 | sed 's/-$//')
    ADR_FILENAME="${NUMBER}-${SLUG}.md"
    ADR_PATH="$DECISIONS_DIR/$ADR_FILENAME"

    # Idempotency: skip if file already exists
    if [ -f "$ADR_PATH" ]; then
      echo "[ADR] Already exists — skipping: $ADR_FILENAME"
      ADR_FILES_WRITTEN=$((ADR_FILES_WRITTEN + 1))
      continue
    fi

    # Write ADR file
    PR_REF="${PR_NUMBER:-unknown}"
    cat > "$ADR_PATH" <<ADR_EOF
---
issue: {NUMBER}
pr: ${PR_REF}
commit: ${COMMIT_SHA}
status: fresh
anchor: ${ANCHOR_PATH:-unknown}
created: $(date -u +%Y-%m-%d)
---

# ADR — ${text}

## Decision

${text}

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #{NUMBER}.

**Citations**:
- Issue: https://github.com/{GH_REPO}/issues/{NUMBER}
- PR: https://github.com/{GH_REPO}/pull/${PR_REF}
- Commit: ${COMMIT_SHA}
- Anchor: \`${ANCHOR_PATH:-no file anchor found}\`

## Status

\`fresh\` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files.

Set \`status: needs-review\` manually (or the staleness pass in \`build-knowledge-index.mjs\` will
flip it automatically) when the anchored code region no longer exists.
ADR_EOF

    echo "[ADR] Written: $ADR_FILENAME"
    ADR_FILES_WRITTEN=$((ADR_FILES_WRITTEN + 1))
  done <<< "$DECISIONS_RAW"
fi
```

### Step 4: Commit and push ADR files (non-blocking)

```bash
if [ "$ADR_FILES_WRITTEN" -gt 0 ] && [ -n "{WORKTREE_PATH}" ] && [ -d "{WORKTREE_PATH}" ]; then
  # Commit ADR files in the worktree so they ride the existing PR
  (
    cd "{WORKTREE_PATH}"
    # Stage only the new/updated ADR files (not the whole tree)
    git add devdocs/decisions/*.md 2>/dev/null || true
    # Check if there's anything to commit
    if ! git diff --cached --quiet 2>/dev/null; then
      git commit -s -m "docs(decisions): auto-ADRs from TRAJECTORY decisions (#{NUMBER})" \
        --no-verify 2>/dev/null && echo "[ADR] Committed ${ADR_FILES_WRITTEN} ADR file(s)" || \
        echo "[ADR] WARNING: commit failed — ADR files on disk but not in git"
    else
      echo "[ADR] No staged changes — ADR files may already be committed"
    fi
  ) || echo "[ADR] WARNING: worktree operations failed — ADR files written but not committed"
else
  if [ "$ADR_FILES_WRITTEN" -gt 0 ]; then
    echo "[ADR] No worktree available — ADR files written to repo root devdocs/decisions/ only"
    echo "[ADR] Manually commit devdocs/decisions/*.md if needed"
  fi
fi
```

### Step 5: Post audit annotation

```bash
if [ "${ADR_FILES_WRITTEN:-0}" -gt 0 ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ADR_EXTRACTED -->
${ADR_FILES_WRITTEN} ADR file(s) auto-extracted from TRAJECTORY decisions and written to \`devdocs/decisions/\`.

Future architect runs will load matching ADRs as constraints when anchor paths overlap contract files.

ADRs are human-editable — update or remove them as the codebase evolves. The staleness pass in
\`build-knowledge-index.mjs\` automatically flips \`status: needs-review\` when an anchor is dead.

<!-- FORGE:ADR_EXTRACTED:COMPLETE -->" 2>/dev/null || true
else
  echo "[ADR] No tradeoff-shaped decisions found — no ADR files written"
fi
```

---

## Phase C5.5: Graph Decision Record (MANDATORY when PR exists)

**Skip if**: `{PR_NUMBER}` is empty (investigation-only / decomposed / invalid terminals) OR `<!-- FORGE:DECISION_RECORD -->` already posted on the PR. **Non-blocking** — a failed post is logged and the close continues to C6.

**Purpose**: Post a single consolidated provenance artifact to the PR that proves the merge was backed by citable evidence. Enables downstream benchmarking queries (repeated-mistake rate, stale-edge hit rate, review escape rate) by making every pipeline run queryable via `gh api`. This file is the single source for the decision record. <!-- Added: forge#776 -->

**Idempotency check**:
```bash
GDR_EXISTS="false"
[ -n "$PR_NUMBER" ] && GDR_EXISTS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:DECISION_RECORD"))] | length > 0' 2>/dev/null || echo "false")
```

**Extract context edge counts** from FORGE:CONTEXT comment:
```bash
CONTEXT_COMMENT=$(last_comment_body "FORGE:CONTEXT")
# Count historical review-finding issue references (#NNN patterns in the Context comment)
REVIEW_FINDING_COUNT=$(printf '%s\n' "$CONTEXT_COMMENT" | grep -oE '#[0-9]+' | wc -l | tr -d ' ')
REVIEW_FINDING_COUNT=${REVIEW_FINDING_COUNT:-0}
```

**Extract review verdict and findings count** from the PR review summary:
```bash
GDR_REVIEW_BODY=""
[ -n "$PR_NUMBER" ] && GDR_REVIEW_BODY=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REVIEWER") or (.body | test("APPROVED:|CHANGES REQUESTED:"; "i")))] | last | .body // ""' 2>/dev/null || echo '')

REVIEW_VERDICT=$(printf '%s\n' "$GDR_REVIEW_BODY" | sed -n 's/.*Verdict: \(APPROVED\|CHANGES REQUESTED\).*/\1/p' | head -1)
REVIEW_VERDICT="${REVIEW_VERDICT:-APPROVED}"
FINDINGS_COUNT=$(printf '%s\n' "$GDR_REVIEW_BODY" | grep -oE '[0-9]+ findings' | grep -oE '[0-9]+' | head -1)
FINDINGS_COUNT="${FINDINGS_COUNT:-0}"
AGENTS_RUN=$(printf '%s\n' "$GDR_REVIEW_BODY" | grep -oE '[0-9]+ agents' | grep -oE '[0-9]+' | head -1)
AGENTS_RUN="${AGENTS_RUN:-0}"
```

**Capture best-effort cost signal** from session telemetry before posting the GDR. This is best-effort — if the signal is unavailable, the cost block is omitted rather than blocking the pipeline or fabricating a number. Field names align with `bin/runner.mjs` usage accounting from #1295 so downstream tooling shares one schema:
```bash
# Best-effort: read per-stage `cost_usd:` values from the FORGE:INVESTIGATOR / FORGE:BUILDER / FORGE:REVIEWER annotations.
# Source: session telemetry when available (e.g. OTEL_LOG_TOOL_DETAILS, Claude Code usage reporting).
# If unavailable, COST_BLOCK is empty — the field is omitted from the GDR rather than fabricated.
cost_from() { sed -n 's/.*cost_usd: *\([0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p' | head -1; }
COST_INVESTIGATION=$(printf '%s\n' "$INVESTIGATOR_BODY" | cost_from)
COST_BUILD=$(printf '%s\n' "$BUILDER_BODY" | cost_from)
COST_REVIEW=""
[ -n "$PR_NUMBER" ] && COST_REVIEW=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REVIEWER")) | .body] | last // ""' 2>/dev/null | cost_from)

# Build the cost block JSON only if at least one stage value is present; otherwise empty
if [ -n "$COST_INVESTIGATION" ] || [ -n "$COST_BUILD" ] || [ -n "$COST_REVIEW" ]; then
  COST_INV_JSON="${COST_INVESTIGATION:-null}"
  COST_BUILD_JSON="${COST_BUILD:-null}"
  COST_REVIEW_JSON="${COST_REVIEW:-null}"
  COST_BLOCK="\"cost\": {
    \"stages\": {
      \"investigation\": $COST_INV_JSON,
      \"build\": $COST_BUILD_JSON,
      \"review\": $COST_REVIEW_JSON
    },
    \"total_usd\": null,
    \"source\": \"session-telemetry\"
  },"
else
  COST_BLOCK=""
fi
```

**Post GDR to PR** (not to issue — the PR comment survives as the permanent artifact on the merged diff). `lane`, verdict, confidence, task type, files changed and gate iterations are all derived in Phase C0 — nothing is hard-coded:
```bash
DRY_RUN="${DRY_RUN:-false}"
if [ "$GDR_EXISTS" != "true" ] && [ -n "$PR_NUMBER" ] && [ "$DRY_RUN" != "true" ]; then
  GDR_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  HEAD_SHA=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
  MERGE_COMMIT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json mergeCommit --jq '.mergeCommit.oid // ""' 2>/dev/null || echo "")

  GDR_FILE=$(mktemp)
  cat > "$GDR_FILE" <<GDR_EOF
<!-- FORGE:DECISION_RECORD -->
## Graph Decision Record — Issue #${NUMBER} / PR #${PR_NUMBER}

\`\`\`json
{
  "schema_version": "1",
  "issue": ${NUMBER},
  "pr": ${PR_NUMBER},
  "repo": "${GH_REPO}",
  "lane": "${LANE}",
  "pr_base": "${PR_BASE}",
  "branch": "${BRANCH}",
  "head_sha": "${HEAD_SHA}",
  "merge_commit": "${MERGE_COMMIT}",
  "investigation": {
    "verdict": "${VERDICT}",
    "confidence": "${CONFIDENCE}",
    "task_type": "${TASK_TYPE}"
  },
  ${COST_BLOCK}
  "context": {
    "historical_edges_referenced": ${REVIEW_FINDING_COUNT},
    "forge_annotations_read": ["FORGE:INVESTIGATOR", "FORGE:CONTRACT", "FORGE:CONTEXT", "FORGE:ARCHITECT", "FORGE:BUILDER"]
  },
  "build": {
    "files_changed": ${FILES_CHANGED_JSON},
    "quality_gate": "${GATE_PASS_FAIL}",
    "quality_gate_iterations": ${GATE_ITERATIONS}
  },
  "review": {
    "verdict": "${REVIEW_VERDICT}",
    "findings_created": ${FINDINGS_COUNT},
    "agents_run": ${AGENTS_RUN}
  },
  "merge": {
    "merged_at": "${GDR_TIMESTAMP}",
    "justification": "Investigation confirmed (${VERDICT}/${CONFIDENCE}), quality gate ${GATE_PASS_FAIL}, review ${REVIEW_VERDICT}"
  }
}
\`\`\`

**Queryable**: \`gh api repos/${GH_REPO}/issues/${PR_NUMBER}/comments --jq '[.[] | select(.body | contains("FORGE:DECISION_RECORD"))] | .[0].body'\`
GDR_EOF
  DECISION_RECORD_URL=$(gh pr comment {PR_NUMBER} {GH_FLAG} --body-file "$GDR_FILE" 2>/dev/null || echo "")
  rm -f "$GDR_FILE"
fi
DECISION_RECORD_URL="${DECISION_RECORD_URL:-}"
```

**Benchmarking** (reference — used by `/pipeline-health`): query all GDRs for a repo to compute pipeline metrics (repeated-mistake rate, stale-edge hit rate, review escape rate):
```bash
# Fetch all merged PRs and extract their GDR JSON blocks for metric computation
gh pr list -R {GH_REPO} --state merged --limit 100 --json number \
  --jq '.[].number' | while read pr; do
    gh api repos/{GH_REPO}/issues/$pr/comments \
      --jq '.[] | select(.body | contains("FORGE:DECISION_RECORD")) | .body' 2>/dev/null
  done
```

---

## Phase C6: Worktree & Branch Cleanup

Remove the git worktree and delete the local feature branch after the PR has merged. This prevents worktree accumulation across pipeline runs.

**Skip if**: `{WORKTREE_PATH}` is not provided OR the path does not exist OR the close stopped with `status: FAILED` (the worktree is kept so the run can be retried).

```bash
# Remove worktree (--force handles detached or uncommitted state)
if [ -n "{WORKTREE_PATH}" ] && [ -d "{WORKTREE_PATH}" ]; then
  # Use --git-common-dir to correctly resolve REPO_ROOT for linked worktrees.
  # --show-toplevel returns the worktree path itself (not the main repo root),
  # so xargs dirname would give the worktree's parent dir — not the repo root.
  # --git-common-dir returns the shared .git dir (e.g. /repo/.git), and
  # dirname of that is always the main repo root regardless of worktree depth.
  GIT_COMMON=$(git -C {WORKTREE_PATH} rev-parse --git-common-dir 2>/dev/null)
  REPO_ROOT=$(dirname "$(realpath "$GIT_COMMON" 2>/dev/null || echo "$GIT_COMMON")")
  git -C "$REPO_ROOT" worktree remove {WORKTREE_PATH} --force 2>/dev/null || true
  echo "Worktree removed: {WORKTREE_PATH}"

  # Delete local feature branch (remote branch already deleted by GitHub on merge)
  if [ -n "{BRANCH}" ]; then
    git -C "$REPO_ROOT" branch -D {BRANCH} 2>/dev/null || true
    echo "Local branch deleted: {BRANCH}"
  fi
else
  echo "Worktree cleanup skipped: path not provided or does not exist"
fi
```

Set `{CLEANUP_STATUS}` based on outcome:
- Worktree path provided and existed → `✅ Removed` (worktree removed, branch deleted)
- Worktree path not provided or path didn't exist → `⏭ Skipped`

The trajectory (C5) already recorded the planned `CLEANUP_STATUS` (computed from the same path check; the removal commands above are non-fatal, so plan and outcome match). Do not re-edit the comment. C6 is the LAST phase: it must stay last because C1.7 and C5.4 use the repo/worktree. After C6, print the Phase C4 report and C4.5b card if not already shown, then the Output block.

---

## Output

Every exit path ends with exactly one `CLOSE_RESULT:` block as the final reply — it is ALL the router sees. Fill it from the shell state:

```
CLOSE_RESULT:
  status: COMPLETE | ALREADY_DONE | PHASE_COMPLETE | FAILED
  issue_state: closed | open
  trajectory_url: {url of FORGE:TRAJECTORY comment}
  decision_record_url: {url of FORGE:DECISION_RECORD comment on PR, or "" if skipped}
  parent_updated: {true|false}
  parent_closed: {true|false}
  blocker: {"" unless status is FAILED — "<phase>: <reason>"}
```

- `COMPLETE` — all applicable phases ran; the pipeline is finished for this issue.
- `ALREADY_DONE` — a `FORGE:TRAJECTORY` comment already existed (Phase C0); nothing was re-posted.
- `PHASE_COMPLETE` — the current phase was closed but uncompleted phases remain (Phase C2); the issue is left OPEN with `<!-- FORGE:PHASE:COMPLETE -->` and `workflow:investigating`. The caller re-reads labels and continues with the next phase. Returned directly from C2 — C3–C6 do not run.
- `FAILED` — a guard, missing arg, or mandatory phase failed (see Failure handling in Inputs); `blocker` says which. The worktree is kept.

For `status: COMPLETE`, the Phase C4 report and the Phase C4.5b card are printed to stdout BEFORE the result block so the caller can surface them; the result block is the last thing printed. `issue_state` is the live issue state (`gh issue view --json state`); `parent_updated` / `parent_closed` come from Phase C3 (`false` when C3 was skipped).
