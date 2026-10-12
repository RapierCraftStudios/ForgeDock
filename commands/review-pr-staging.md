---
user-invocable: false
description: Staging review mode — comprehensive review of staging branch before deploy to main
argument-hint: "[PR number or \"staging\"]"
allowed-tools: Task, Agent, Bash, Read, Grep, Glob, WebFetch
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Staging Review

> **Skill names**: `{FORGE_SKILL_PREFIX}` is `forgedock:` (plugin install) or empty (`install.sh`), resolved once per run by `commands/work-on.md` § Skill Name Resolution. If the skill is not found under either name, STOP and report "skill not found" — never run the phase inline.

**Trigger**: Invoked by the orchestrator via `Skill("{FORGE_SKILL_PREFIX}review-pr-staging", $ARGUMENTS)`, or directly with `$ARGUMENTS` = "staging", a PR number targeting main, or "staging:feature".

Performs comprehensive review of `staging` before merging to `main`. Handles large diffs (1,000-10,000+ lines), diverse changes, deep analysis, and business impact assessment.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**
**Sub-agent dispatch tool: `Task` preferred, `Agent` is the documented fallback.** This spec dispatches domain review agents via a sub-agent-spawning tool. Resolve which one is available ONCE per invocation, before Phase 3, per the **Sub-Agent Dispatch Tool Resolution** rule below — do not halt to ask the operator which tool to use. Never fall back to reviewing inline in the orchestrator's own context; that is a strictly weaker substitute for an isolated fresh-context reviewer and is not a permitted fallback.

<!-- FORGE:SPEC_LOADED — review-pr-staging.md loaded and active. Agent is bound by this spec. -->

## Sub-Agent Dispatch Tool Resolution (MANDATORY — run once, before Phase 3)

This spec dispatches Bug Hunter and domain review agents via a sub-agent-spawning tool. Different runtimes expose different tools for this — resolve deterministically, once per invocation, and use the same tool for every dispatch call in this run:

### OpenCode Runtime Override

When the workflow is running under OpenCode, resolve the native tool before applying the Claude-specific availability order above:

```bash
IS_OPENCODE_RUNTIME=false
if [ "${FORGE_RUNTIME:-}" = "opencode" ] ||
   [ -n "${OPENCODE_SESSION_ID:-}" ] ||
   [ -n "${OPENCODE_PID:-}" ] ||
   [ -n "${OPENCODE:-}" ]; then
  IS_OPENCODE_RUNTIME=true
  DISPATCH_TOOL=task
  DISPATCH_SUBAGENT_TYPE=general
fi
```

When `IS_OPENCODE_RUNTIME=true`, lowercase native `task` is the preferred isolated dispatch tool. Do not enter the `Neither tool is available` branch merely because Claude's literal `Task` and `Agent` names are absent. Every native task call must use a top-level `subagent_type`: `general` for implementation/review work and `explore` for read-only discovery (Claude `general-purpose` and `codebase-explorer` map to those values). Review tasks are foreground: wait for their completed result before synthesis. If the native `task` capability itself is absent from the current tool registry, use the existing hard-stop path and post `FORGE:REVIEW_BLOCKED`; never substitute inline review.

1. **If `Task` is available in the current environment**: set `{DISPATCH_TOOL} = Task`. This is the preferred tool — tightest `allowed-tools` scoping. (Identical resolution logic to `/review-pr` Phase 3C — do not diverge.)
2. **Else if `Agent` is available**: set `{DISPATCH_TOOL} = Agent`. This is the documented fallback, not a degraded path — use it exactly as you would `Task`: one call per selected agent (Bug Hunters in Phase 3, Code Quality in Phase 4, domain agents in Phase 5), same prompt template, `subagent_type: "general-purpose"` (or the closest equivalent the environment offers), same requirement that each agent posts its own findings directly to the PR via `gh pr comment`. Isolation and fresh-context review are preserved either way.
3. **Neither tool is available**: this is a genuine setup defect, not a routing decision — HARD STOP, post a PR/issue comment explaining that no sub-agent dispatch tool is available, add `needs-human`, and exit without posting a verdict. Do NOT fall back to reviewing inline in the orchestrator's own context.
4. **Dispatch pool exhausted or dispatch call fails**: this is not tool absence. If any Bug Hunter, quality, domain, material-change, or regression reviewer cannot be launched because the sub-agent pool/session limit is exhausted (or any dispatch call fails), HARD STOP. Do not substitute inline review or silently continue with a partial panel. Mark the PR `review-degraded`, post `<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->` with the selected and completed counts, and exit without a deploy verdict. A fresh session must re-run the full panel.

**Do not halt to ask the operator which tool to use.** Steps 1–2 are deterministic and fully resolve the common case; only step 3 (both absent) requires a stop, and even then the action is HARD STOP + `needs-human`, not a question back to the operator.

Everywhere this file says `Task(...)`, read it as `{DISPATCH_TOOL}(...)` using the value resolved here.

## Forbidden Tools Self-Check

**Before executing any phase**, verify you are NOT using any of these:

| Tool/Pattern | Status | Reason |
|------|--------|--------|
| `Agent`, when `Task` is available | **FORBIDDEN** | `Task` is preferred whenever present — `Agent` is only the fallback for when `Task` is absent, not a free substitute |
| Inline self-review (no sub-agent spawn at all) | **FORBIDDEN** | Bypasses isolated fresh-context review entirely — always spawn via the resolved `{DISPATCH_TOOL}`, never review directly in the orchestrator's own context |
| `EnterPlanMode` | **FORBIDDEN** | Breaks execution context; phases must be executed, not planned |

If you find yourself about to call `Agent(...)` while `Task` is available, stop and use `Task(...)` instead. If neither `Task` nor `Agent` is available, do not fall through to inline review — follow step 3 of Sub-Agent Dispatch Tool Resolution above.

---

## Config Resolution

Read `forge.yaml` to resolve branch names before running any commands:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")

# Test-gate config (Phase 6.5) — read here so vars are available before first use
GATE_POSTURE=$(yq '.verification.test_gate.posture // "blocking"' "$CONFIG_FILE" 2>/dev/null || echo "blocking")
OVERRIDE_PHRASE=$(yq '.verification.test_gate.override_phrase // "OVERRIDE: shipping with test failures —"' "$CONFIG_FILE" 2>/dev/null || echo "OVERRIDE: shipping with test failures —")
```

All `$DEFAULT_BRANCH`, `$STAGING_BRANCH`, `$GATE_POSTURE`, and `$OVERRIDE_PHRASE` references below are populated from `forge.yaml`.

---

## Review Protocol Reference

<!-- FORGE:PROTOCOL_SOURCE — canonical definition lives in docs/spec/review-protocol.md -->

The **Evidence-Based Review Protocol** and **Structured Findings Protocol** are defined in `docs/spec/review-protocol.md`. All agents spawned by this spec MUST follow both protocols as specified there. The full protocol text is embedded in `commands/review-pr-agents.md` for agent use.

**Key protocol rules (summary — see `docs/spec/review-protocol.md` for the normative definition)**:
- Start from the diff. Follow imports. Trace data flows across service boundaries.
- Confidence levels: CONFIRMED (full code-path proof, P1) → LIKELY (pattern + caveat, P2) → POSSIBLE (advisory, P3) → UNFOUNDED (do not report)
- REPRODUCTION GATE: CONFIRMED requires a full code-path trace or concrete input demonstration
- Severity: runtime error → HIGH/CRITICAL; wrong data silently → HIGH; degraded perf → MEDIUM; cosmetic → LOW
- INTERACTION ANALYSIS: never dismiss as "pre-existing" without checking NEW code interactions
- FALSE POSITIVE PREVENTION: trace scope, types, callers before reporting
- Structured findings block MANDATORY at end of every agent comment

---

## Phase -1: Route Assertion

**This phase is MANDATORY and must execute before Phase 0A. No phase may be skipped.**

**Idempotent re-review (merge-train aware)**: <!-- Added: forge#1328, extended: forge#1332 --> This spec is safe to invoke multiple times on the same PR. Each invocation posts a new `FORGE:REVIEW_ROUTE` marker with the current SHA — re-review passes are distinguished by SHA, not by PR number. When a staging→main deploy PR receives blocking findings and the fixes are pushed to the head branch, re-invoke this spec on the same PR number. Do NOT close the PR and create a new one.

Resolve the staging→main PR number and post a routing marker immediately. This creates an audit trail — if a staging→main PR has no `FORGE:REVIEW_ROUTE` comment after this command was invoked, the review was bypassed or never started.

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"   # this fence resolves PR_NUMBER itself, so it binds config directly instead of reloading the persisted pointer
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE" 2>/dev/null); GH_FLAG="-R $GH_REPO"
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE" 2>/dev/null); STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE" 2>/dev/null)
# Resolve PR_NUMBER from the argument string (never name the loader placeholder in this block: every
# occurrence is substituted textually, comments included) <!-- Added: forge#3466 -->
# The argument string may be: a PR number, "staging", "feature", or "staging:feature"
# Only the first token is the PR ref; later tokens are flags (--auto-merge, --issue, ...) <!-- allowlist:check-command-side-effects -->
# The loader substitutes the text before bash parses it, so read it from a quoted heredoc (never a quoted
# assignment) and reject any string with a quote, backtick, dollar sign, backslash, newline or tab. <!-- Added: forge#3466 -->
# NONCE RULE: before running, replace NONCE in BOTH delimiter lines with a fresh random hex string (e.g. `openssl rand -hex 16`) not present in the argument text. <!-- Added: forge#3466 -->
IFS= read -r -d '' STAGING_ARGS_RAW <<'FORGE_ARGS_EOF_NONCE'
$ARGUMENTS
FORGE_ARGS_EOF_NONCE
STAGING_ARGS_RAW="${STAGING_ARGS_RAW%$'\n'}"
STAGING_ARGS_REJECTED=false
case "$STAGING_ARGS_RAW" in
  *'"'*|*'`'*|*'$'*|*'\'*|*$'\n'*|*$'\t'*)
    echo "review-pr-staging: rejected argument string (contains a quote, backtick, dollar sign, backslash, newline or tab) - nothing parsed" >&2
    STAGING_ARGS_REJECTED=true; STAGING_ARGS_RAW="" ;;
esac
PR_ARG="${STAGING_ARGS_RAW%% *}"
PR_ARG_NUM=$(printf '%s' "$PR_ARG" | sed -nE 's#^(https?://[^ ]*/pull/)?([0-9]+)$#\2#p')
if [ -n "$PR_ARG_NUM" ]; then
  PR_NUMBER="$PR_ARG_NUM"
elif [ "$STAGING_ARGS_REJECTED" = true ]; then
  # Rejected string: stop. Never fall through to the open staging PR lookup or run later phases with no PR. <!-- Added: forge#3466 -->
  echo "review-pr-staging: rejected argument string - stopping (nothing reviewed, nothing posted)" >&2
  exit 1
else
  # Find the open staging→main PR
  PR_NUMBER=$(gh pr list ${GH_FLAG} \
    --head "$STAGING_BRANCH" \
    --base "$DEFAULT_BRANCH" \
    --state open \
    --json number \
    --jq '.[0].number' 2>/dev/null || echo "")
fi

REVIEW_SHA_STAGING="n/a"  # gh pr view "" falls back to the current branch PR, so only look up a resolved number <!-- Added: forge#3466 -->
[ -n "$PR_NUMBER" ] && REVIEW_SHA_STAGING=$(gh pr view "$PR_NUMBER" ${GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null | cut -c1-7 || echo "n/a")
# Full head SHA (40/64 hex) for the Reviewed-SHA line in reviewer comments and the trusted-comment regexes. Empty or malformed stays empty; every consumer refuses on empty. <!-- Added: forge#3492 -->
REVIEW_SHA_FULL=""
[ -n "$PR_NUMBER" ] && REVIEW_SHA_FULL=$(gh pr view "$PR_NUMBER" ${GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
[ -n "$REVIEW_SHA_FULL" ] || echo "WARNING: could not resolve a full head SHA; reviewer trust checks will refuse (fail closed)." >&2
# Short SHA for the persona slice path (forge-slice-[PR_NUMBER]-[REVIEW_SHA_SHORT]-...): hex-only so a sentinel like n/a or an empty value can never put a / or -- into the path. <!-- Added: forge#3700 -->
REVIEW_SHA_SHORT=$(printf '%s' "${REVIEW_SHA_FULL:-}" | tr -cd '0-9a-f' | cut -c1-7); [ -n "$REVIEW_SHA_SHORT" ] || REVIEW_SHA_SHORT="unresolved"

if [ -n "$PR_NUMBER" ]; then
  gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:REVIEW_ROUTE mode=staging-deploy spec=review-pr-staging.md sha=${REVIEW_SHA_STAGING} -->"
else
  echo "WARNING: Could not resolve staging→main PR number. FORGE:REVIEW_ROUTE marker not posted."
fi
# Persist for later fences (each Bash call is a fresh shell). Remove a stale file from a previous run when nothing resolved.
_SD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"; mkdir -p "$_SD"
FORGE_RUN_KEY="${FORGE_RUN_KEY:-${FORGE_RUN_ID:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${OPENCODE_SESSION_ID:-$PPID}}}}}}"; FORGE_RUN_KEY=$(printf '%s' "$FORGE_RUN_KEY" | tr -c 'A-Za-z0-9_-' '_')
if [ -n "$PR_NUMBER" ]; then printf '%s\n' "$PR_NUMBER" > "$_SD/staging_pr_number.${FORGE_RUN_KEY}"; else rm -f "$_SD/staging_pr_number.${FORGE_RUN_KEY}"; fi
```

`$PR_NUMBER` is now set for all downstream phases that conditionally post gate comments to the PR. It is also persisted to the run-keyed pointer `$_SD/staging_pr_number.${FORGE_RUN_KEY}`, because every Bash call is a fresh shell and concurrent runs share `$_SD`. `FORGE_RUN_KEY` is a pre-exported `FORGE_RUN_KEY`, else `FORGE_RUN_ID` or the first available session id (Claude Code, Codex, OpenCode), else `$PPID` (best-effort, may not be stable across calls); `fence-bootstrap.sh` derives it identically and never falls back to an unkeyed pointer. Every fence that consumes cross-fence state (`PR_NUMBER`, `ALL_PR_NUMBERS`, `GH_REPO`, branch names) begins with the `# FENCE_BOOTSTRAP` stub, which sources `scripts/lib/fence-bootstrap.sh` (via `scripts/lib/forge-resolve.sh`) to re-derive it and exits 1 when the helper is unresolvable; `scripts/review-pr-staging-scope.test.sh` fails if a consuming fence omits it. The Phase 6.5 gate result and the Phase 6.75 launched-agent list are persisted to `$_SD` by their producers and reloaded (validated) by their consumers.

**Prior-finding awareness on re-entry**: On each re-invocation, load findings from prior review passes on the same PR before running any new checks. Previously-resolved findings (issues that are now closed or marked `false-positive`) are excluded from the current verdict to avoid re-surfacing already-fixed issues. Previously-unresolved findings (open issues from a prior pass) are carried forward as context so agents know what was previously flagged:

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
GH_FLAG="-R $GH_REPO"
# Load prior FORGE:REVIEW_ROUTE comments to detect re-entry
PRIOR_ROUTES=$(gh api repos/${GH_REPO}/issues/${PR_NUMBER}/comments \
  --jq '[.[] | select(.body | test("FORGE:REVIEW_ROUTE")) | .body] | length' 2>/dev/null || echo 0)

IS_REENTRY=0
if [ "$PRIOR_ROUTES" -gt 0 ]; then
  IS_REENTRY=1
  echo "Re-entry detected: $PRIOR_ROUTES prior review pass(es) on PR #${PR_NUMBER}"

  # Anchored post-filter: keep a search hit only if its title ends `PR #N)` or its body has a
  # `**Source**: PR #N` line. Hidden markers (issue-create-token, etc.) never count as references.
  FINDING_PR_FILTER='[.[] | select((.title | endswith("PR #" + $n + ")")) or ((.body // "") | test("(^|\\n)\\*\\*Source\\*\\*: PR #" + $n + "([^0-9]|$)")))] | .[] | "  - #\(.number): \(.title)"'  # FINDING_PR_FILTER

  # Load findings from prior passes that are still open
  PRIOR_OPEN_FINDINGS=$(gh issue list ${GH_FLAG} \
    --label "review-finding" \
    --state open \
    --search "PR #${PR_NUMBER}" \
    --limit 50 \
    --json number,title,labels,body 2>/dev/null \
    | jq -r --arg n "${PR_NUMBER}" "$FINDING_PR_FILTER" 2>/dev/null || true)  # uses FINDING_PR_FILTER

  # Load findings that were resolved (closed) since the last pass
  PRIOR_RESOLVED_FINDINGS=$(gh issue list ${GH_FLAG} \
    --label "review-finding" \
    --state closed \
    --search "PR #${PR_NUMBER}" \
    --limit 50 \
    --json number,title,body 2>/dev/null \
    | jq -r --arg n "${PR_NUMBER}" "$FINDING_PR_FILTER" 2>/dev/null || true)  # uses FINDING_PR_FILTER

  echo "Prior open findings (carry forward): $(echo "$PRIOR_OPEN_FINDINGS" | grep -c '.' || echo 0)"
  echo "Prior resolved findings (exclude from verdict): $(echo "$PRIOR_RESOLVED_FINDINGS" | grep -c '.' || echo 0)"
fi
```

Agents receive `$IS_REENTRY`, `$PRIOR_OPEN_FINDINGS`, and `$PRIOR_RESOLVED_FINDINGS` as context. They MUST NOT re-file issues that already exist in `$PRIOR_OPEN_FINDINGS` (dedup gate in Phase 7 covers this). Resolved findings do NOT contribute to the BLOCK verdict for the current pass.

---

## Phase 0A: Open Review-Finding Gate (BLOCKING — runs before scope analysis)

**Purpose**: Prevent deploying commits that have known, unfixed review findings. The review system catches bugs before merging; this gate ensures the merge path acts on that information.

**Why this matters**: Review findings are filed before the originating PR merges to staging. Without this gate, a staging→main bundle can include commits with known unfixed bugs — the review system caught the issue, but the deploy path ignored it. This gate closes the gap between issue discovery and deploy execution. <!-- Added: forge#303 -->

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
git fetch origin $DEFAULT_BRANCH $STAGING_BRANCH

# Step 1: Find all PR numbers in the staging→main bundle
# These are the PRs whose commits are included in staging but not yet in main
BUNDLE_PRS=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --oneline \
  | grep -oP '#\d+' \
  | sort -u \
  | tr -d '#')

# Also extract PR numbers from merge commit subjects (most reliable)
MERGE_PRS=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --merges --oneline \
  | grep -oP '(?<=pull request #)\d+' \
  | sort -u)

ALL_PR_NUMBERS=$(echo "$BUNDLE_PRS $MERGE_PRS" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$')

echo "PRs in staging→main bundle: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')"
# Persist for the 0B.1 fence (a later Bash call is a fresh shell); keyed by the PR number resolved in Phase -1.
if [ -n "${PR_NUMBER:-}" ]; then
  _SD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"; mkdir -p "$_SD"
  printf '%s\n' "$ALL_PR_NUMBERS" > "$_SD/${PR_NUMBER}_bundle-prs.txt"
fi

# Step 2: For each PR in the bundle, check for open review-finding issues and degraded panels
BLOCKING_FINDINGS=""
DEGRADED_REVIEWS=""
for pr_num in $ALL_PR_NUMBERS; do
  IS_REVIEW_DEGRADED=$(gh pr view "$pr_num" -R {GH_REPO} --json labels \
    --jq '[.labels[].name] | any(. == "review-degraded")' 2>/dev/null || echo "false")
  if [ "$IS_REVIEW_DEGRADED" = "true" ]; then
    DEGRADED_REVIEWS="${DEGRADED_REVIEWS}
**PR #${pr_num}** has a \`review-degraded\` label and requires a full fresh-context re-review."
  fi

  # Search for open review-finding issues that reference this PR. The search is only a coarse
  # candidate fetch (full-text, tokenized: it also hits hidden markers and longer numbers), so
  # narrow it with the anchored FINDING_PR_FILTER: title suffix `PR #N)` or a `**Source**: PR #N` line.
  FINDING_PR_FILTER='[.[] | select((.title | endswith("PR #" + $n + ")")) or ((.body // "") | test("(^|\\n)\\*\\*Source\\*\\*: PR #" + $n + "([^0-9]|$)")))] | .[] | "  - #\(.number): \(.title)"'  # FINDING_PR_FILTER
  OPEN_FINDINGS=$(gh issue list -R {GH_REPO} \
    --label "review-finding" \
    --state open \
    --search "PR #${pr_num}" \
    --limit 20 \
    --json number,title,body 2>/dev/null \
    | jq -r --arg n "${pr_num}" "$FINDING_PR_FILTER" 2>/dev/null)  # uses FINDING_PR_FILTER

  if [ -n "$OPEN_FINDINGS" ]; then
    BLOCKING_FINDINGS="${BLOCKING_FINDINGS}
**PR #${pr_num}** has open review findings:
${OPEN_FINDINGS}"
  fi
done

# A degraded panel is a review-integrity failure, not a finding that an override may waive.
if [ -n "$DEGRADED_REVIEWS" ]; then
  echo "⛔ DEPLOY BLOCKED — An included PR has an incomplete isolated review panel."
  echo "$DEGRADED_REVIEWS"
  if [ -n "$PR_NUMBER" ]; then
    gh pr comment "$PR_NUMBER" -R {GH_REPO} --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: review-panel-integrity

### Degraded Review Panels

${DEGRADED_REVIEWS}

Re-run the complete review panel in a fresh session before deployment.

<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->" 2>/dev/null || true
  fi
  exit 1
fi

# Step 3: Block deploy if open findings exist (unless human override present)
if [ -n "$BLOCKING_FINDINGS" ]; then
  # Check for human override comment on the staging→main PR
  if [ -n "$PR_NUMBER" ]; then
    # Trusted authors only (scripts/trusted-comments.sh: OWNER/MEMBER/COLLABORATOR or a Bot), all comment pages,
    # marker anchored at the start of the body. Fail closed: unresolvable script or unreadable comments = no override (#3492).
    type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
    TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
    OVR_SCRIPT="$TRUSTED_SCRIPT"
    OVR_COMMENTS=$(gh api --paginate "repos/{GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null) || OVR_COMMENTS=""
    if [ -n "$OVR_SCRIPT" ] && [ -n "$OVR_COMMENTS" ]; then
      OVERRIDE=$(printf '%s' "$OVR_COMMENTS" | bash "$OVR_SCRIPT" count '^OVERRIDE: shipping with open findings' 2>/dev/null || echo 0)
    else
      OVERRIDE=0
    fi
  else
    OVERRIDE=0
  fi

  if [ "${OVERRIDE:-0}" -eq 0 ]; then
    echo "⛔ DEPLOY BLOCKED — Open review-finding issues exist for PRs in this bundle."
    echo ""
    echo "$BLOCKING_FINDINGS"
    echo ""
    echo "Options:"
    echo "  1. Wait for the open findings to be fixed and merged to staging first."
    echo "  2. Post a comment on this PR starting with \"OVERRIDE: shipping with open findings — <reason>\" to bypass this gate."
    echo ""
    echo "This gate exists to prevent deploying commits with known unfixed review findings."
    echo "RESULT: BLOCK DEPLOY"

    # Post structured FORGE:GATE_FAILURE comment for pipeline-health tracking
    FINDING_COUNT=$(echo "$BLOCKING_FINDINGS" | grep -c '^\s*- #' || echo "unknown")
    GATE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [ -n "$PR_NUMBER" ]; then
      gh pr comment "$PR_NUMBER" -R {GH_REPO} --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: open-review-finding
**Timestamp**: ${GATE_TIMESTAMP}
**Blocking findings**: ${FINDING_COUNT}

### Open Review-Finding Issues

${BLOCKING_FINDINGS}

### Resolution

Fix the open findings above and merge fixes to staging before retrying the staging→main deploy.
To override (ship known issues with documented reason), post a comment starting with:
\`OVERRIDE: shipping with open findings — <reason>\`

<!-- FORGE:GATE_FAILURE:TYPE=open-review-finding|FINDINGS=${FINDING_COUNT} -->" 2>/dev/null || true
    fi
    exit 1
  else
    echo "⚠️  Open review findings exist but human override detected — proceeding with deploy."
    echo "$BLOCKING_FINDINGS"
    echo "Override comment found on PR #${PR_NUMBER}. Continuing."
  fi
else
  echo "✅ Open review-finding gate: PASSED — no open findings for PRs in this bundle."
  # Post FORGE:GATE_PASS for symmetric observability — bypass is indistinguishable from clean pass without this
  if [ -n "$PR_NUMBER" ]; then
    gh pr comment "$PR_NUMBER" -R {GH_REPO} --body "<!-- FORGE:GATE_PASS -->
## Deploy Gate: PASSED

**Gate**: open-review-finding check
**Result**: PASS — no open \`review-finding\` issues exist for PRs in this bundle.
**Bundle PRs**: ${ALL_PR_NUMBERS}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:GATE_PASS:TYPE=open-review-finding -->" 2>/dev/null || true
  fi
fi
```

If the gate exits with `RESULT: BLOCK DEPLOY` → **STOP**. Do NOT proceed to Phase 0B or any downstream phases. A `<!-- FORGE:GATE_FAILURE -->` structured comment is automatically posted on the staging→main PR (if `$PR_NUMBER` is set) for pipeline-health tracking. Report the blocking finding list.

If the gate exits with `RESULT: PASS` → a `<!-- FORGE:GATE_PASS -->` structured comment is posted on the staging→main PR so that `/pipeline-health` can distinguish a clean gate from a silently skipped one. A PR with no gate comment at all indicates a gate bypass — not a clean pass.

---

## Phase 0B: Scope Analysis

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
git fetch origin $DEFAULT_BRANCH $STAGING_BRANCH
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --stat | tail -20
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --numstat | awk '{add+=$(1); del+=$(2)} END {print "Added:", add, "Deleted:", del, "Total:", add+del}'
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --name-only | sort | uniq
```

Categorize by service (API, Worker, Web, Shared, Infra). Identify high-risk files (billing, credits, pricing, auth, security, migration, scraper).

Create review chunks by priority: Billing/Pricing (CRITICAL) → Security/Auth (CRITICAL) → Scraper Core (HIGH) → API Routers (HIGH) → Worker (HIGH) → Web (MEDIUM) → Shared (MEDIUM) → Infra (MEDIUM) → Other (LOW).


### 0B.1: Bundle Review Scope (already-reviewed commit set)

A bundle PR already got a full line-level review before it merged to staging, so re-reviewing its diff here re-files the same defects. Compute the already-reviewed commit set and scope line-level review to what a feature-PR review could not see. Consumes `ALL_PR_NUMBERS` (Phase 0A). Trust comes from `scripts/trusted-comments.sh` (resolved by the `forge_resolve` stub below, which sources `scripts/lib/forge-resolve.sh`: `FORGEDOCK_HOME` (authoritative), plugin root, `FORGE_ROOT`, `FORGE_HOME`, install symlink, Codex `forge-home`, pinned plugin cache (numeric-newest), marketplaces; never the working directory, which is author-controlled; an unresolved script leaves the variable empty).

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
SCOPE_MODE=full; REVIEWED_COMMITS=""; REVIEWED_MERGES=""; DEPLOY_WIRING_FILES=""; UNREVIEWED_COMMITS=""; UNREVIEWED_FILES=""; _LOG=""; CROSS_PR_FILES=""; REVIEWED_PR_COUNT=0
_PF="$_SD/${PR_NUMBER}_bundle-pr-files.txt"; : > "$_PF"
[ -n "${PR_NUMBER:-}" ] && [ -n "${GH_REPO:-}" ] || echo "SCOPE_MODE=full: scoping skipped (PR_NUMBER or GH_REPO empty after reload)"
[ -n "${ALL_PR_NUMBERS:-}" ] || echo "SCOPE_MODE=full: scoping skipped (ALL_PR_NUMBERS empty: Phase 0A did not persist a bundle list)"
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
[ -n "$TRUSTED_SCRIPT" ] || echo "SCOPE_MODE=full: scoping skipped (trusted-comments.sh not resolvable)"
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
REVIEW_DELTA_SCRIPT=$(forge_resolve review-delta.sh)
[ -n "$REVIEW_DELTA_SCRIPT" ] || echo "delta credit off: review-delta.sh not resolvable (stale-head PR commits stay UNREVIEWED)"
# BEGIN bundle-delta-credit
is_sha() { case "${1}" in *[!0-9a-f]*|"") return 1 ;; esac; [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; }
# Partial credit for a PR whose head moved after its last complete review. Only the shared resolver (scripts/review-delta.sh) decides; nothing is re-derived here.
# Needs pr _HEAD _J _CM _SD GH_REPO TRUSTED_SCRIPT REVIEW_DELTA_SCRIPT in scope. Sets DELTA_COMMITS (space-separated PR commit oids already covered by a trusted complete panel) and DELTA_FULL (1 = whole PR covered by a trusted carried-forward base sync).
# Every failure (script unresolved, FULL, error, malformed output, force-push, untrusted or absent carried record, git read failure) leaves DELTA_COMMITS empty and DELTA_FULL=0: those commits stay UNREVIEWED.
bundle_delta_credit() {
  local base labels top cf out l1 kind arg from to oid rc n
  DELTA_COMMITS=""; DELTA_FULL=0
  [ -n "$REVIEW_DELTA_SCRIPT" ] || return 0
  base=$(printf '%s' "$_J" | jq -r '.baseRefName // empty') || return 0
  labels=$(printf '%s' "$_J" | jq -r '[.labels[].name] | join(",")') || return 0
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  [ -n "$base" ] && [ -n "$top" ] || return 0
  cf=$(mktemp "$_SD/delta-comments.XXXXXX") || return 0
  printf '%s' "$_CM" > "$cf" || { rm -f "$cf"; return 0; }
  out=$(bash "$REVIEW_DELTA_SCRIPT" --pr "$pr" --head "$_HEAD" --base "$base" --trusted-script "$TRUSTED_SCRIPT" --comments-file "$cf" --labels "$labels" --repo "$GH_REPO" --repo-path "$top" 2>/dev/null) || out=""
  rm -f "$cf"
  l1=$(printf '%s\n' "$out" | sed -n 1p)
  kind="${l1%% *}"; arg="${l1#* }"
  case "$kind" in
    DELTA)
      from="${arg%%..*}"; to="${arg##*..}"
      is_sha "$from" && [ "$to" = "$_HEAD" ] && [ "$from" != "$to" ] || return 0
      for oid in $(printf '%s' "$_J" | jq -r '.commits[].oid'); do
        git merge-base --is-ancestor "$oid" "$from" 2>/dev/null; rc=$?
        [ "$rc" -eq 0 ] && DELTA_COMMITS="$DELTA_COMMITS $oid"   # rc 1 (not covered) and rc >1 (error) both stay UNREVIEWED
      done ;;
    BASE_SYNC_ONLY)
      is_sha "$arg" && [ "$arg" != "$_HEAD" ] || return 0
      # A marker alone never counts: a TRUSTED FORGE:REVIEW-CARRIED record for this head must name the same reviewed sha (shape owned by review-pr.md carry_verified_from).
      n=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "\\A(?=[\\s\\S]*\\nReviewed-SHA: ${_HEAD}\\r?(\\n|$))(?=[\\s\\S]*\\nCarried-From-SHA: ${arg}\\r?(\\n|$))<!-- FORGE:REVIEW-CARRIED -->" 2>/dev/null) || return 0
      case "$n" in ''|*[!0-9]*) return 0 ;; esac
      [ "$n" -ge 1 ] && DELTA_FULL=1 ;;
  esac
  return 0
}
# END bundle-delta-credit
if [ -n "$TRUSTED_SCRIPT" ] && [ -n "${ALL_PR_NUMBERS:-}" ] && [ -n "${PR_NUMBER:-}" ] && [ -n "${GH_REPO:-}" ]; then
  SCOPE_MODE=scoped
  for pr in $ALL_PR_NUMBERS; do
    _J=$(gh pr view "$pr" -R $GH_REPO --json headRefOid,mergeCommit,commits,state,baseRefName,labels 2>/dev/null) || { SCOPE_MODE=full; break; }
    _HEAD=$(printf '%s' "$_J" | jq -r '.headRefOid')
    case "$_HEAD" in *[!0-9a-f]*|"") SCOPE_MODE=full; break ;; esac   # a malformed head id would make the sha match accept any comment (fail open): review everything
    [ "${#_HEAD}" -eq 40 ] || [ "${#_HEAD}" -eq 64 ] || { SCOPE_MODE=full; break; }
    _HEAD7=$(printf '%s' "$_HEAD" | cut -c1-7)
    # Capture each gh read into a variable FIRST and test its own exit status: in a pipeline `||` only sees the last stage (no pipefail),
    # so a failed gh read piped into another command would silently look like "no comments" / "no files".
    _CM=$(gh api --paginate "repos/$GH_REPO/issues/$pr/comments" 2>/dev/null) || { SCOPE_MODE=full; break; }
    _FILES=$(gh pr diff "$pr" -R $GH_REPO --name-only 2>/dev/null) || { SCOPE_MODE=full; break; }
    # Reviewed = trusted FORGE:REVIEW_ROUTE (a real review mode) whose sha is the PR's FINAL head, plus at least one review-agent comment
    # carrying the full-length `Reviewed-SHA: <head>` line and a findings block (same predicate as review-pr.md Phase 5; a 7-char substring or a comment with no findings block never counts), and no degraded/blocked review marker. A PR pushed to after its review has a stale sha: the exact-head gate gives it no credit, and only the delta branch below (shared resolver `scripts/review-delta.sh`) may credit the commits an earlier trusted complete panel covered or a trusted `FORGE:REVIEW-CARRIED` base sync carried; everything else stays UNREVIEWED.
    _ROUTE=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "^<!-- FORGE:REVIEW_ROUTE mode=(?!spec-evolution-blocked)[^ ]+ spec=review-pr.md sha=${_HEAD7} -->") || { SCOPE_MODE=full; break; }
    _AGENT=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "^(?=[\\s\\S]*<!-- REVIEW-FINDINGS-START -->)<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA: ${_HEAD}(\\r?\\n|$)") || { SCOPE_MODE=full; break; }
    _DEGRADED=$(printf '%s' "$_CM" | bash "$TRUSTED_SCRIPT" count "^<!-- FORGE:(REVIEW_DEGRADED|REVIEW_BLOCKED)") || { SCOPE_MODE=full; break; }
    case "$_ROUTE$_AGENT$_DEGRADED" in ''|*[!0-9]*) SCOPE_MODE=full; break ;; esac
    if [ "$_ROUTE" -ge 1 ] && [ "$_AGENT" -ge 1 ] && [ "$_DEGRADED" -eq 0 ] && [ "$(printf '%s' "$_J" | jq '.commits|length')" -lt 100 ]; then
      REVIEWED_PR_COUNT=$((REVIEWED_PR_COUNT+1))
      REVIEWED_COMMITS="$REVIEWED_COMMITS $(printf '%s' "$_J" | jq -r '[.commits[].oid, .mergeCommit.oid // empty] | join(" ")')"
      REVIEWED_MERGES="$REVIEWED_MERGES $(printf '%s' "$_J" | jq -r '.mergeCommit.oid // empty')"
    elif [ "$_DEGRADED" -eq 0 ] && [ "$(printf '%s' "$_J" | jq '.commits|length')" -lt 100 ]; then
      # Stale head: the exact-head gate failed, so ask the shared resolver how much of the PR an earlier trusted complete panel covered. Additive only: it can move commits out of UNREVIEWED, never into it.
      bundle_delta_credit
      if [ "$DELTA_FULL" -eq 1 ]; then
        REVIEWED_PR_COUNT=$((REVIEWED_PR_COUNT+1))
        REVIEWED_COMMITS="$REVIEWED_COMMITS $(printf '%s' "$_J" | jq -r '[.commits[].oid, .mergeCommit.oid // empty] | join(" ")')"
        REVIEWED_MERGES="$REVIEWED_MERGES $(printf '%s' "$_J" | jq -r '.mergeCommit.oid // empty')"
      elif [ -n "$DELTA_COMMITS" ]; then
        REVIEWED_COMMITS="$REVIEWED_COMMITS$DELTA_COMMITS"   # the PR's merge commit is not credited: it contains the post-review commits
      fi
    fi
    printf '%s\n' "$_FILES" | sort -u | sed "s|^|$pr |" >> "$_PF"
  done
fi
if [ "$SCOPE_MODE" = "scoped" ]; then
  # Cross-PR interactions: files touched by 2+ bundle PRs.
  CROSS_PR_FILES=$(cut -d' ' -f2- "$_PF" | sort | uniq -d)
  # Unreviewed commits: on staging, not in main, and not a commit of any reviewed PR (direct pushes, fast-lane fixes, post-review pushes).
  # Merge commits are included: a merge that is not a reviewed PR's own merge commit may carry conflict-resolution content nobody reviewed.
  _LOG=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --format=%H) || SCOPE_MODE=full
fi
if [ "$SCOPE_MODE" = "scoped" ]; then
  for c in $_LOG; do
    case " $REVIEWED_COMMITS " in *" $c "*) continue ;; esac
    UNREVIEWED_COMMITS="$UNREVIEWED_COMMITS $c"
  done
  # Files of every unreviewed commit (--cc limits a merge commit to its conflict-resolution content), so 7B can test file membership.
  # Each git read is captured and its own status tested (a failure here must widen scope, never narrow it).
  UNREVIEWED_FILES=""
  for c in $UNREVIEWED_COMMITS; do
    _DT=$(git diff-tree --no-commit-id --name-only -r "$c") || { SCOPE_MODE=full; break; }
    _DC=$(git diff-tree --no-commit-id --name-only -r --cc "$c") || { SCOPE_MODE=full; break; }
    UNREVIEWED_FILES="$UNREVIEWED_FILES"$'\n'"$_DT"$'\n'"$_DC"
  done
  # A reviewed PR's own merge commit may carry conflict-resolution content its review never saw: count its --cc files as unreviewed too.
  for c in $REVIEWED_MERGES; do
    _DC=$(git diff-tree --no-commit-id --name-only -r --cc "$c") || { SCOPE_MODE=full; break; }
    UNREVIEWED_FILES="$UNREVIEWED_FILES"$'\n'"$_DC"
  done
  UNREVIEWED_FILES=$(printf '%s\n' "$UNREVIEWED_FILES" | sed '/^$/d' | sort -u)
fi
# Deploy/runtime readiness files are always in scope: migrations, env, workflows, compose/infra, dependency manifests.
_DW=$(git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --name-only) || { SCOPE_MODE=full; _DW=""; }
DEPLOY_WIRING_FILES=$(printf '%s\n' "$_DW" | grep -E '(^|/)(migrations?/|\.github/workflows/|infra/|deploy/|docker-compose[^/]*\.ya?ml$|\.env[^/]*$|Dockerfile[^/]*$|package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|requirements[^/]*\.txt$|pyproject\.toml$|poetry\.lock$|go\.(mod|sum)$|Cargo\.(toml|lock)$)' || true)
# Persist the results for 7A (a later Bash call is a fresh shell). %q keeps multi-line file lists intact.
printf 'SCOPE_MODE=%q\nCROSS_PR_FILES=%q\nUNREVIEWED_FILES=%q\nDEPLOY_WIRING_FILES=%q\n' "$SCOPE_MODE" "${CROSS_PR_FILES:-}" "${UNREVIEWED_FILES:-}" "${DEPLOY_WIRING_FILES:-}" > "$_SD/${PR_NUMBER}_scope.env"
echo "SCOPE_MODE=$SCOPE_MODE reviewed_prs=$REVIEWED_PR_COUNT unreviewed_commits=$(echo $UNREVIEWED_COMMITS | wc -w) unreviewed_files=$(echo "$UNREVIEWED_FILES" | grep -c .) cross_pr_files=$(echo "$CROSS_PR_FILES" | grep -c .)"
```

**Fail-open (never silently review less)**: every `gh`, `git log`, `git diff`, `git diff-tree` and marker-count read above is captured into a variable and tested on its own exit status (never through a pipe, where `||` sees only the last stage). If the trust script cannot be resolved, any such read fails, or a marker count is not an integer, `SCOPE_MODE=full` and Phases 2-6 review the full bundle diff as before. Only `SCOPE_MODE=scoped` narrows review.

**Stale-head delta credit (fail-closed)**: delta credit only ever moves commits out of UNREVIEWED, and only on a positive, trusted resolver answer. A resolver `FULL`, an error, malformed output, a force-push (reviewed sha not an ancestor), an untrusted or absent `FORGE:REVIEW-CARRIED` record, a degraded/blocked PR, 100+ commits or an unresolved `review-delta.sh` all leave the PR's commits UNREVIEWED (today's behaviour) and never force `SCOPE_MODE=full` by themselves. `DELTA <reviewed>..<head>` credits only the PR commits that are ancestors of `<reviewed>` (never its merge commit); `BASE_SYNC_ONLY` credits the whole PR only with a trusted carried record naming this head and that reviewed sha. A bundle that changes the review specs gets `FULL` from the resolver by design. <!-- Added: forge#3638 -->

**Scoped line-level review set** = `CROSS_PR_FILES` + `UNREVIEWED_FILES` (the files of `UNREVIEWED_COMMITS`, including merge-commit conflict resolutions) + `DEPLOY_WIRING_FILES`. Files and commits that belong only to an already-reviewed PR (the already-reviewed set) are excluded from line-level review.

---

### 0C: Prepare (one script call)

`scripts/review-prepare.sh` is the same preparation `/review-pr` Phase 1 runs, called with `--no-delta` (a bundle review always reviews the whole bundle: no FULL/DELTA resolver). It resolves the persona template source, the per-domain diff slices (`slices.<domain>.diff_file`, read from `origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH` when the API diff is too large), project config and the head SHA into one context file that Phase 5 and the Phase 7 `review-finalize.sh` calls read. A non-zero exit is `BLOCKED` (for example no template source, or an empty trusted build command on this full-build lane): STOP, never skip.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
[ -n "${PR_NUMBER:-}" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: PR_NUMBER unavailable after reload; nothing reviewed"; exit 1; }
RP=$(forge_resolve review-prepare.sh)   # install roots only, never the PR checkout; unresolvable is a stop (fail closed)
[ -n "$RP" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: scripts/review-prepare.sh not resolvable (set FORGEDOCK_HOME to the ForgeDock install); refusing to continue (fail closed)"; exit 1; }
CTX="$_SD/review-ctx-${PR_NUMBER}.json"
bash "$RP" --pr "$PR_NUMBER" --repo "$GH_REPO" --no-delta --out "$CTX"; RP_RC=$?
if [ "$RP_RC" -ne 0 ] || [ ! -s "$CTX" ]; then
  [ -s "$CTX" ] && jq -r '.blockers[]? | "BLOCKER: " + .' "$CTX"
  echo "REVIEW_RESULT: status: BLOCKED, blocker: review-prepare failed (exit ${RP_RC}); nothing reviewed (fail closed)"; exit 1
fi
echo "CONTEXT_FILE=$CTX"
jq -r '"TEMPLATE_SOURCE=\(.templates.source)", "TEMPLATE_BASE=\(.templates.base)", "MONOLITHIC_CATALOG=\(.templates.monolithic_catalog // "")"' "$CTX"
```

The context file lives at `$_SD/review-ctx-${PR_NUMBER}.json`; later fences recompute that path after their bootstrap line.

---

## Phase 1: Automated Checks

### 1A: Python Linting

Read `forge.yaml → verification.commands.python` for project-specific tool commands:

```bash
PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
PYTHON_LINT=$(yq '.verification.commands.python.lint // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$PYTHON_FORMAT" ]; then
    eval "$PYTHON_FORMAT" 2>&1 | head -30
else
    echo "SKIPPED — python.format not configured in verification.commands"
fi

if [ -n "$PYTHON_LINT" ]; then
    eval "$PYTHON_LINT" 2>&1 | head -30
else
    echo "SKIPPED — python.lint not configured in verification.commands"
fi
```

### 1B: TypeScript Type-Check + Build (MANDATORY)

Read `forge.yaml → verification.commands.typescript` for project-specific tool commands:

```bash
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1
    TS_EXIT=$?
    [ "$TS_EXIT" -ne 0 ] && echo "BLOCKING: typecheck failed — deploy WILL fail"
else
    echo "SKIPPED — typescript.typecheck not configured in verification.commands"
    TS_EXIT=0
fi

if [ -n "$TS_BUILD" ]; then
    eval "$TS_BUILD" 2>&1 | tail -50
    BUILD_EXIT=$?
    [ "$BUILD_EXIT" -ne 0 ] && echo "BLOCKING: build failed — deploy WILL fail"
else
    echo "SKIPPED — typescript.build not configured in verification.commands"
fi
```
Build failure is BLOCKING — deploy WILL fail. Typecheck alone misses SSG/prerender failures — configure `typescript.build` in `verification.commands`.

### 1C: Python Tests

Read `forge.yaml → verification.commands.python.test`:

```bash
PYTHON_TEST=$(yq '.verification.commands.python.test // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$PYTHON_TEST" ]; then
    eval "$PYTHON_TEST" 2>&1 | tail -50
else
    echo "SKIPPED — python.test not configured in verification.commands"
fi
```

### 1D: Secrets Scan
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH | grep -iE "(api[_-]?key|secret|password|token|credential)" | grep -vE "(#|//|\.example|placeholder)" | head -20
```

### 1E: CI Status Gate (BLOCKING)
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
gh pr checks "$PR_NUMBER" -R "$GH_REPO" 2>&1
```
Any CI failure → BLOCK DEPLOY (unless autofixed in Phase 1F).

### Phase 1F: CI Autofix

If CI fails, attempt automatic fix before blocking:

| Failure Pattern | Category | Autofixable? |
|----------------|----------|--------------|
| Black/isort formatting | FORMATTING | Yes |
| Type error in next build | TYPE_ERROR | Yes |
| Module not found | IMPORT_ERROR | Yes |
| Prerender error | PRERENDER | Maybe |
| Test assertion failure | TEST_FAILURE | No |
| Infrastructure flake | FLAKE | No |

For fixable failures: checkout staging, apply fix, verify locally, commit as `fix(ci): ...`, push, wait for CI re-run (max 10 min). Max 1 autofix attempt. If it fails → BLOCK DEPLOY.

---

## Phase 2: Material Change Analysis

**Reset launched-agent state (once, before any Phase 2-6 agent launches)**: the list is PR-keyed and append-only, so a prior run or `--retry` would otherwise leave stale domains behind.
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
[ -n "${PR_NUMBER:-}" ] && : > "$_SD/${PR_NUMBER}_launched_review_agents"
```

**Review scope (applies to Phases 2-6, from Phase 0B.1)**: when `SCOPE_MODE=scoped`, pass every agent `REVIEWED_COMMITS`, `UNREVIEWED_COMMITS`, `CROSS_PR_FILES` and `DEPLOY_WIRING_FILES` in its prompt. Line-level review is limited to `CROSS_PR_FILES`, the diffs of `UNREVIEWED_COMMITS`, and a runtime/deploy readiness checklist (required secrets and env vars present and documented, migration ordering and collisions, deploy wiring and workflow sibling drift). Agents report every finding they see, with its severity and file, whatever file or commit it lives in; a defect that lives only in an already-reviewed PR's files was visible to that PR's own review, so the 7B scope filter may demote it, but only when it is `MEDIUM`, `LOW` or `INFO`: a `CRITICAL` or `HIGH` finding is always reported and kept. Safety-domain agents (Security, Auth, Billing, Concurrency, Database) still read the whole diff of any in-scope file, not just the changed hunks. When `SCOPE_MODE=full`, review the full bundle diff. Report the scope used in the agent comment. <!-- Added: forge#3451 -->

Launch agent (model: {SUBAGENT_MODEL}) to analyze all commits since last deploy. Categorize as: NEW FEATURE, ENHANCEMENT, BUG FIX, REFACTOR, SECURITY, PERFORMANCE, INFRASTRUCTURE, DEPENDENCY. Separate user-facing vs internal. Document breaking changes and required pre-deploy actions.

Substitute `[REVIEW_SHA]` in the template below with the literal full head SHA (40 or 64 hex, Phase -1 `REVIEW_SHA_FULL`) before dispatch; the agent's fence runs in a fresh shell, so it MUST NOT reference `${REVIEW_SHA_FULL}` or invent a value (empty when no PR resolved: omit the value; Phase 7 consumers fail closed).

**MANDATORY — post findings as PR comment**: Before its first post attempt, the agent MUST persist the final report to a uniquely named durable file, then post it with `--body-file`. It MUST also return verdict, finding count, and one line per finding to the orchestrator whether the post succeeds or fails; on failure, return the file path and stop without retrying. After completing analysis, the agent posts its full report directly to the PR:
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:REVIEW-AGENT:material-change -->
Reviewed-SHA: [REVIEW_SHA]
## Material Change Analysis

[full analysis report here]

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:... -->
<!-- REVIEW-FINDINGS-END -->"
```
Include the structured `<!-- REVIEW-FINDINGS-START -->` block even if there are no findings (empty block). This ensures auditability even if the orchestrator crashes mid-review. <!-- Added: forge#1400 -->

---

## Phase 3: Bug Hunter Review (Per-Service)

Launch Bug Hunter agents for each service with changes:

**API Bug Hunter** (services/api/): Logic errors, error handling, type issues, resource leaks, state issues, auth bugs, data flow tracing. Prefix: BUG/AUTH.

**Worker Bug Hunter** (services/worker/): Job processing bugs, queue issues, tier escalation, reconciliation errors, scraping logic, async issues, Cortex integration. Prefix: BUG/SCRP/CONC.

**Web Bug Hunter** (web/src/): React issues (keys, closures, hydration), data fetching, security (XSS), UX, build-breaking patterns, type issues. Prefix: FE.

Each reads the service diff, hunts for bugs, traces context across imports, persists its finalized report before posting, and returns its verdict and findings independently of GitHub delivery.

**MANDATORY — each Bug Hunter agent MUST post its findings directly to the PR immediately upon completion** (do not wait for the orchestrator to batch-post):
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:REVIEW-AGENT:bug-hunter-{service} -->
Reviewed-SHA: [REVIEW_SHA]
## Bug Hunter Review — {service}

[full findings here]

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:BUG-N|CONFIDENCE|SEVERITY|file:line|summary -->
<!-- REVIEW-FINDINGS-END -->"
```
Where `{service}` is `api`, `worker`, or `web`. Post one comment per service agent. <!-- Added: forge#1400 -->

---

## Phase 4: Code Quality Review

Agent hunts for: dead code, duplicate logic, complexity (>50 line functions), naming issues, missing abstractions, logging quality, magic numbers. Prefix: QA.

**MANDATORY — post findings as PR comment**: Before its first post attempt, the agent MUST persist the final report to a uniquely named durable file, then post it with `--body-file`. It MUST also return verdict, finding count, and one line per finding to the orchestrator whether the post succeeds or fails; on failure, return the file path and stop without retrying. After completing analysis, the agent posts its full report directly to the PR:
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:REVIEW-AGENT:code-quality -->
Reviewed-SHA: [REVIEW_SHA]
## Code Quality Review

[full analysis here]

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:QA-N|CONFIDENCE|SEVERITY|file:line|summary -->
<!-- REVIEW-FINDINGS-END -->"
```
<!-- Added: forge#1400 -->

---

## Phase 5: Security & Billing Deep Dive

**Templates (resolved by `review-prepare.sh` in 0C, the same ordered chain `/review-pr` Phase 3C uses)**: `TEMPLATE_SOURCE` is `plugin_root`, `forge_home`, `repo_path` or `monolithic_catalog`; a missing source BLOCKED the review in 0C. **NEVER perform the review inline as a substitute.** Read `$TEMPLATE_BASE/protocols.md` and `$TEMPLATE_BASE/<persona>.md` per selected agent; for `monolithic_catalog` read `$MONOLITHIC_CATALOG` and extract the shared protocols plus each persona's section from that one file.

Launch domain-specific agents based on which domains have changes. Substitute PR diff commands with staging diff commands.

**Risk-tiered domain panel** <!-- Added: forge#3599 -->: choose the domain agents with `scripts/review-roster.sh` (resolve it with `forge_resolve review-roster.sh`, never from `$PWD`) instead of launching every domain with a change. Every PR in the bundle already had its own review, so this panel only needs to catch cross-PR interactions. Pass the bundle's changed lines (`git diff --numstat "origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH"`, added plus deleted), changed-file count and file list (`--files-file -`), optional `--scores` diff-text signals (omit for none), and `--fix-pr false`; a bundle of 60 lines or fewer runs Security only unless a path trigger fires, a larger one follows the medium and standard tiers, and Auth and Infra run only when auth/session/trust-filter or CI/docker/deploy files are in the bundle. Run the full union when `--thorough` was passed. When the script cannot be resolved or fails, launch the full union (fail toward more agents). Record the tier and reason in the final summary.

**Per-domain diff slices (MANDATORY)**: `protocols.md` tells agents to use a pre-supplied `[DOMAIN_DIFF_SLICE]` and not to re-fetch the diff, so staging MUST supply one (the staging→main diff is the largest in the pipeline). `review-prepare.sh` (0C) already sliced the uncapped bundle diff by domain and capped each slice at 100K chars: read `slices.<domain>.diff_file` from the context file (`jq -r '.slices["<domain>"].diff_file' "$_SD/review-ctx-${PR_NUMBER}.json"`; `security` and `spec-cli` get the full diff, a domain with no pattern hit the full diff) with the canonical key (`api-design`→`api`, `infrastructure`→`infra`, the others unchanged).

For each dispatched persona, substitute `[DOMAIN_DIFF_SLICE]` → the content of its `slices.<domain>.diff_file`. Also substitute `[AGENT_DOMAIN]` → the persona's marker domain (the `{domain}` used in its `FORGE:REVIEW-AGENT` marker), and bind `[PR_NUMBER]` to the staging review's PR number (`staging` when there is none) and `[REVIEW_SHA_SHORT]` to the literal Phase -1 `REVIEW_SHA_SHORT` value (hex, or `unresolved`; never `REVIEW_SHA_STAGING`, whose `n/a` sentinel would put a `/` in the path): personas derive their slice path `forge-slice-[PR_NUMBER]-[REVIEW_SHA_SHORT]-[AGENT_DOMAIN].diff` from them. Also substitute `[REVIEW_SHA]` → the literal full head SHA (40 or 64 hex, the orchestrator's Phase -1 `REVIEW_SHA_FULL` value) into the dispatch prompt: a reviewer runs its post fence in a fresh shell, so it MUST NOT reference `${REVIEW_SHA_FULL}` and MUST NOT invent a value; when no full SHA resolved (no PR), omit the `Reviewed-SHA:` line value rather than fabricate one (Phase 7 consumers then fail closed). Agents never run a full `gh pr diff`; only `--name-only` is allowed. Agents: General Security (always), Auth, Billing, Concurrency, Scraper, API Design, Database, Infrastructure.

**MANDATORY — each domain agent MUST persist its finalized body before posting its findings directly to the PR immediately upon completion** (not batched by the orchestrator). It MUST return verdict, finding count, and one line per finding to the orchestrator independently of delivery; if posting fails, return the durable file path and stop without retrying:
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:REVIEW-AGENT:{domain} -->
Reviewed-SHA: [REVIEW_SHA]
## {Domain} Review

[full analysis here]

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:{PREFIX}-N|CONFIDENCE|SEVERITY|file:line|summary -->
<!-- REVIEW-FINDINGS-END -->"
```
Where `{domain}` is `security`, `auth`, `billing`, `concurrency`, `scraper`, `api-design`, `database`, or `infrastructure`. Post one comment per domain agent. This ensures findings are posted even if the orchestrator crashes mid-review. <!-- Added: forge#1400 -->

---

## Phase 6: Regression Risk Assessment

Agent maps dependencies, assesses integration points (service boundaries, env vars, Docker changes, workflow sibling drift between ci.yml and deploy-production.yml), evaluates rollback difficulty (easy/hard/destructive/state-dependent), checks test coverage. Posts risk matrix with rollback plan. Prefix: REG.

**MANDATORY — post findings as PR comment**: Before its first post attempt, the agent MUST persist the final report to a uniquely named durable file, then post it with `--body-file`. It MUST also return verdict, finding count, and one line per finding to the orchestrator whether the post succeeds or fails; on failure, return the file path and stop without retrying. After completing analysis, the agent posts its full report directly to the PR:
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:REVIEW-AGENT:regression-risk -->
Reviewed-SHA: [REVIEW_SHA]
## Regression Risk Assessment

[full risk matrix and rollback plan here]

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:REG-N|CONFIDENCE|SEVERITY|file:line|summary -->
<!-- REVIEW-FINDINGS-END -->"
```
<!-- Added: forge#1400 -->

**Workflow sibling drift (MANDATORY)**: Deep-diff ci.yml and deploy-production.yml shared jobs. Compare PYTHONPATH, dependency install steps, step names. Pre-existing drift is invisible until deploy fails.

**Database container restart risk (MANDATORY when `docker-compose*.yml` changes touch `postgres` or `redis` service)**: Any change to a stateful container's `command:`, `image:`, `volumes:`, or `environment:` forces container recreation on deploy. Auto-escalate to HIGH risk. Verify: `stop_grace_period` is sufficient (≥30s for PG), `full_page_writes = on`, `fsync = on`, no active long-running transactions will be interrupted. Recommend maintenance window — stateful container restarts must NOT happen as a side effect of routine deploys. A Postgres restart under active write load can corrupt btree indexes and bypass UNIQUE constraints. <!-- Added: forge#146 -->

---

## Phase 6.5: Runtime Test Gate (BLOCKING — runs after static analysis, before finding triage)

**Purpose**: Verify the integrated bundle's acceptance criteria against running code before the deploy verdict. Catches runtime defects (cross-PR interactions, container/startup failures, regression in tested behaviour) that static review cannot surface.

**Why here**: Phase 6 completes all static analysis (regression risk, security, quality). Phase 6.5 adds the runtime dimension before Phase 7 triages findings — so any test-gate failures can be filed as `test-failure` issues by `/test-gate` itself, then surface in Phase 7's triage pass.

**Posture**: Controlled by `verification.test_gate.posture` in `forge.yaml` (resolved in Config Resolution as `$GATE_POSTURE`). Default: `blocking`. Set to `advisory` to surface failures without preventing deploy. <!-- Added: forge#906 -->

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
GH_FLAG="-R $GH_REPO"
GATE_POSTURE=$(yq '.verification.test_gate.posture // "blocking"' "$CONFIG_FILE" 2>/dev/null || echo "blocking")
OVERRIDE_PHRASE=$(yq '.verification.test_gate.override_phrase // "OVERRIDE: shipping with test failures —"' "$CONFIG_FILE" 2>/dev/null || echo "OVERRIDE: shipping with test failures —")
echo "=== Phase 6.5: Runtime Test Gate ==="
echo "Bundle PRs: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')"
echo "Posture: ${GATE_POSTURE}"

# Reset any stale gate result from a prior run before the Skill call (files are PR-keyed)
rm -f "$_SD/${PR_NUMBER}_test_gate_verdict" "$_SD/${PR_NUMBER}_test_gate_reason"
# Initialize test-gate verdict (default SKIP — safe if Phase 6.5 is bypassed)
TEST_GATE_VERDICT="SKIP"
TEST_GATE_REASON="Phase 6.5 not yet run"

# Invoke /test-gate with the bundle PRs already computed in Phase 0A
# ALL_PR_NUMBERS is the de-duplicated union of both scan methods (commit log + merge subjects)
GATE_OUTPUT=$(Skill("{FORGE_SKILL_PREFIX}test-gate", "--prs \"$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs)\" --base $DEFAULT_BRANCH"))

# Extract machine-readable verdict from Skill output. An absent/invalid marker stays EMPTY (never coerced to SKIP):
# the verdict-handling fence treats an empty verdict as missing/invalid and fails closed under blocking posture.
TEST_GATE_VERDICT=$(echo "$GATE_OUTPUT" | grep -oE 'FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP)' | sed 's/^FORGE:TEST_GATE:RESULT=//' | tail -1)
[ -n "$TEST_GATE_VERDICT" ] || TEST_GATE_REASON="gate result missing/invalid (no FORGE:TEST_GATE:RESULT marker in /test-gate output)"

echo "Test-gate verdict: ${TEST_GATE_VERDICT}"
# Persist the gate result: every Bash call is a fresh shell, and the verdict-handling fence and Phase 8 read it back (validated on reload).
printf '%s\n' "$TEST_GATE_VERDICT" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "$TEST_GATE_REASON" > "$_SD/${PR_NUMBER}_test_gate_reason"
```

**Verdict handling**:

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
GH_FLAG="-R $GH_REPO"
GATE_POSTURE=$(yq '.verification.test_gate.posture // "blocking"' "$CONFIG_FILE" 2>/dev/null || echo "blocking")
OVERRIDE_PHRASE=$(yq '.verification.test_gate.override_phrase // "OVERRIDE: shipping with test failures —"' "$CONFIG_FILE" 2>/dev/null || echo "OVERRIDE: shipping with test failures —")
# Reload the Phase 6.5 gate result persisted by its producer (validated: only a known verdict reaches a gate decision).
[ -n "${TEST_GATE_VERDICT:-}" ] || { [ -r "$_SD/${PR_NUMBER}_test_gate_verdict" ] && TEST_GATE_VERDICT=$(sed -n -E '1{/^(BLOCK|PASS|SKIP)$/p;q}' "$_SD/${PR_NUMBER}_test_gate_verdict"); }
[ -n "${TEST_GATE_REASON:-}" ] || { [ -r "$_SD/${PR_NUMBER}_test_gate_reason" ] && TEST_GATE_REASON=$(sed -n 1p "$_SD/${PR_NUMBER}_test_gate_reason" | tr -d '\r\000-\037' | cut -c1-400); }
# Fail closed: a missing, empty, or unrecognised verdict is never a SKIP. Normalize it to BLOCK so the BLOCK arm applies
# the override check, advisory/blocking posture, and exit 1; GATE_VERDICT_INVALID makes the reasons say missing/invalid.
GATE_VERDICT_INVALID=0
case "${TEST_GATE_VERDICT:-}" in
  BLOCK|PASS|SKIP) ;;
  *)
    GATE_VERDICT_INVALID=1
    if [ -r "$_SD/${PR_NUMBER}_test_gate_verdict" ]; then _GV_WHY="persisted verdict file present but empty/invalid"; else _GV_WHY="persisted verdict file missing"; fi
    echo "⚠️  Test gate: gate result missing/invalid (${_GV_WHY}) — treating as BLOCK, not SKIP."
    TEST_GATE_VERDICT="BLOCK"
    ;;
esac
case "$TEST_GATE_VERDICT" in

  SKIP)
    echo "ℹ️  Test gate: SKIP — no executable changes or tests not configured."
    echo "   This gap will appear in the Phase 8 summary. No deploy impact."
    TEST_GATE_REASON="SKIP — no runtime tests ran (docs-only bundle, no integration tests configured, or manual-only criteria)"
    ;;

  PASS)
    echo "✅ Test gate: PASS — all test clusters passed. Deploy may proceed."
    TEST_GATE_REASON="PASS — all automated test clusters passed"
    # Post FORGE:GATE_PASS for symmetric observability
    if [ -n "$PR_NUMBER" ]; then
      gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:GATE_PASS -->
## Deploy Gate: PASSED

**Gate**: test-gate (runtime acceptance criteria)
**Result**: PASS — all test clusters passed. Deploy may proceed.
**Bundle PRs**: ${ALL_PR_NUMBERS}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:GATE_PASS:TYPE=test-gate|BUNDLE=$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs) -->" 2>/dev/null || true
    fi
    ;;

  BLOCK)
    # Check for override comment on the staging→main PR (mirrors Phase 0A pattern)
    if [ -n "$PR_NUMBER" ]; then
      # Trusted authors only, all comment pages, anchored; fail closed (no override) if the script or comments are
      # unreadable (#3492). OVERRIDE_PHRASE comes from forge.yaml, so regex-escape it before using it as a pattern.
      type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
      TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
      TG_SCRIPT="$TRUSTED_SCRIPT"
      TG_COMMENTS=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null) || TG_COMMENTS=""
      TG_OVERRIDE=0; OVERRIDE_REASON="(reason not captured)"
      if [ -n "$TG_SCRIPT" ] && [ -n "$TG_COMMENTS" ]; then
        TG_RE="^$(printf '%s' "$OVERRIDE_PHRASE" | sed 's/[][\\.^$*+?(){}|\/]/\\&/g')"
        TG_OVERRIDE=$(printf '%s' "$TG_COMMENTS" | bash "$TG_SCRIPT" count "$TG_RE" 2>/dev/null || echo 0)
        [ "${TG_OVERRIDE:-0}" -gt 0 ] && OVERRIDE_REASON=$(printf '%s' "$TG_COMMENTS" | bash "$TG_SCRIPT" bodies "$TG_RE" 2>/dev/null | tail -1 | jq -r '.' 2>/dev/null || echo "(reason not captured)")
      fi
    else
      TG_OVERRIDE=0
    fi

    if [ "${TG_OVERRIDE:-0}" -gt 0 ]; then
      echo "⚠️  Test gate: BLOCK — but override comment detected on PR #${PR_NUMBER}."
      echo "   Override: ${OVERRIDE_REASON}"
      echo "   Proceeding with deploy. Override is logged in Phase 8 summary."
      TEST_GATE_VERDICT="PASS"
      TEST_GATE_REASON="BLOCK downgraded to PASS by override: ${OVERRIDE_REASON}"
      [ "$GATE_VERDICT_INVALID" = 1 ] && TEST_GATE_REASON="BLOCK (gate result missing/invalid) downgraded to PASS by override: ${OVERRIDE_REASON}"

    elif [ "$GATE_POSTURE" = "advisory" ]; then
      echo "⚠️  Test gate: BLOCK (advisory posture) — runtime failures detected but deploy is NOT prevented."
      echo "   Switch verification.test_gate.posture to 'blocking' in forge.yaml to enforce this gate."
      TEST_GATE_REASON="BLOCK (advisory) — runtime failures detected; deploy allowed by advisory posture"
      [ "$GATE_VERDICT_INVALID" = 1 ] && TEST_GATE_REASON="BLOCK (advisory) — gate result missing/invalid; deploy allowed by advisory posture"

    else
      # blocking posture (default) — STOP
      echo "⛔ DEPLOY BLOCKED — /test-gate returned BLOCK verdict."
      [ "$GATE_VERDICT_INVALID" = 1 ] && echo "   (gate result missing/invalid — failing closed; re-run /test-gate or post the override comment)"
      echo ""
      echo "Runtime failures were detected in the staging→${DEFAULT_BRANCH} bundle."
      echo "The failures were batch-introduced (not pre-existing on ${DEFAULT_BRANCH} baseline)."
      echo ""
      echo "Options:"
      echo "  1. Fix the failing tests and merge fixes to staging before retrying the deploy."
      echo "  2. Post a comment on this PR starting with \"${OVERRIDE_PHRASE} <reason>\" to bypass this gate."
      echo "  3. Set verification.test_gate.posture: advisory in forge.yaml to downgrade to a warning."
      echo ""
      echo "RESULT: BLOCK DEPLOY"

      # Post structured FORGE:GATE_FAILURE comment for pipeline-health tracking
      GATE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      if [ -n "$PR_NUMBER" ]; then
        gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: test-gate
**Timestamp**: ${GATE_TIMESTAMP}
**Bundle PRs**: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')
**Posture**: ${GATE_POSTURE}

### What Happened

\`/test-gate\` detected runtime failures in the staging→\`${DEFAULT_BRANCH}\` bundle that were NOT present on the \`${DEFAULT_BRANCH}\` baseline. These are batch-introduced regressions. (If the gate result was missing/invalid, no verdict could be read and the gate failed closed; re-run \`/test-gate\`.)

\`/test-gate\` has filed \`test-failure\` issues for each failing cluster — check the issue tracker for details.

### Resolution

1. Fix the failing tests and merge fixes to staging.
2. Retry the staging→\`${DEFAULT_BRANCH}\` deploy.

To override (ship known failures with documented reason), post a comment containing:
\`${OVERRIDE_PHRASE} <reason>\`

<!-- FORGE:GATE_FAILURE:TYPE=test-gate|BUNDLE=$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs) -->" 2>/dev/null || true
      fi
      _GV_REASON="BLOCK (blocking posture, no override)"; [ "$GATE_VERDICT_INVALID" = 1 ] && _GV_REASON="BLOCK (gate result missing/invalid; blocking posture, no override)"
      printf '%s\n' "$TEST_GATE_VERDICT" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "$_GV_REASON" > "$_SD/${PR_NUMBER}_test_gate_reason"
      exit 1
    fi
    ;;

  *)
    # Unreachable (normalized above); fail closed regardless — never SKIP.
    echo "⛔ Test gate: gate result missing/invalid ('${TEST_GATE_VERDICT}') — failing closed."
    printf '%s\n' "BLOCK" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "BLOCK (gate result missing/invalid)" > "$_SD/${PR_NUMBER}_test_gate_reason"
    exit 1
    ;;

esac
# Persist the gate result: every Bash call is a fresh shell, and the verdict-handling fence and Phase 8 read it back (validated on reload).
printf '%s\n' "$TEST_GATE_VERDICT" > "$_SD/${PR_NUMBER}_test_gate_verdict"; printf '%s\n' "$TEST_GATE_REASON" > "$_SD/${PR_NUMBER}_test_gate_reason"
```

If the gate exits with `RESULT: BLOCK DEPLOY` → **STOP**. A `<!-- FORGE:GATE_FAILURE -->` structured comment is automatically posted on the staging→main PR (if `$PR_NUMBER` is set) for pipeline-health tracking. `/test-gate` will have filed `test-failure` issues for each failing cluster before returning BLOCK.

---

**Incomplete-panel guard (MANDATORY):** Increment `SELECTED_AGENT_COUNT` for every reviewer selected across Phases 2–6 before launching it. If any dispatch fails, set `DISPATCH_FAILED=true`. Before Phase 7, count unique trusted, current-head `FORGE:REVIEW-AGENT` markers (author trusted per `scripts/trusted-comments.sh`, body starting with the marker, `Reviewed-SHA:` line matching the full head SHA, all comment pages read; an unresolvable script or unreadable comments count as 0). If the completed count is lower than selected, follow the same hard-stop path as pool exhaustion: create `review-degraded` if needed, label the PR, post `FORGE:GATE_FAILURE`, and exit. Do not create a deploy verdict from partial reviewer output.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# Each Bash call is a fresh shell: re-resolve the full head SHA if it is not set, and refuse when it is not a commit id
# (an empty SHA would make the Reviewed-SHA match accept any head).
[ -n "${REVIEW_SHA_FULL:-}" ] || REVIEW_SHA_FULL=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
ACTUAL_AGENT_COUNT=0
if [ -n "$REVIEW_SHA_FULL" ] && [ -n "$TRUSTED_SCRIPT" ]; then
  # Only TRUSTED, current-head reviewer comments count, over every page of comments. Unique domains, so a duplicate does not inflate the count.
  ACTUAL_AGENT_COUNT=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
    | bash "$TRUSTED_SCRIPT" bodies "^<!-- FORGE:REVIEW-AGENT:[a-z0-9-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA:[ ]${REVIEW_SHA_FULL}(\\r?\\n|$)" 2>/dev/null \
    | jq -r 'scan("^<!-- FORGE:REVIEW-AGENT:([a-z0-9-]+) -->") | .[0]' 2>/dev/null | sort -u | grep -c . || echo 0)
fi
case "$ACTUAL_AGENT_COUNT" in ''|*[!0-9]*) ACTUAL_AGENT_COUNT=0 ;; esac   # fail closed: unreadable or untrusted counts as not posted
# Fresh shell: SELECTED_AGENT_COUNT is not carried over. Reload it from the PR-keyed launched-agent file, then fail closed when it is empty, non-integer or zero (a staging review always selects at least one reviewer).
[ -n "${SELECTED_AGENT_COUNT:-}" ] || { [ -n "${PR_NUMBER:-}" ] && [ -r "$_SD/${PR_NUMBER}_launched_review_agents" ] && SELECTED_AGENT_COUNT=$(grep -E '^[a-z0-9-]+$' "$_SD/${PR_NUMBER}_launched_review_agents" | sort -u | grep -c .); }
SELECTED_COUNT_INVALID=false
case "${SELECTED_AGENT_COUNT:-}" in ''|*[!0-9]*|0) SELECTED_COUNT_INVALID=true; SELECTED_AGENT_COUNT=0 ;; esac
if [ "${DISPATCH_FAILED:-}" = "true" ] || [ "$SELECTED_COUNT_INVALID" = "true" ] || [ "$ACTUAL_AGENT_COUNT" -lt "$SELECTED_AGENT_COUNT" ]; then
  gh label create "review-degraded" --color "E4E669" --description "PR review panel was incomplete; re-review required before deployment. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null || true
  gh pr edit "$PR_NUMBER" -R "$GH_REPO" --add-label "review-degraded" --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
  gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body "<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->
## Deploy Review Blocked: Incomplete Isolated Review Panel

**Selected isolated reviewers**: ${SELECTED_AGENT_COUNT}
**Completed isolated reviewers**: ${ACTUAL_AGENT_COUNT}

Re-run the full staging review in a fresh session before deployment."
  exit 1
fi
```

## Phase 7: Finding Triage & Issue Creation

### Phase 6.75: Verify Agent Delivery

Before launching every Phase 2-6 review agent, append its lowercase marker domain (for example, `security`, `bug-hunter-api`, or `regression-risk`) to `LAUNCHED_REVIEW_AGENTS` and persist it with `printf '%s\n' "$AGENT_DOMAIN" >> "${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}/${PR_NUMBER}_launched_review_agents"` (each Bash call is a fresh shell; the fence below reloads the file, accepting only `^[a-z0-9-]+$` lines). The file is truncated by the executable fence at the start of Phase 2. A completed agent is accounted for only when its marker comment is present on the PR from a trusted author, starts with the marker, and carries the `Reviewed-SHA:` line for the current head.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# Reload the launched-agent list persisted at dispatch (validated: lowercase marker domains only).
[ -n "${LAUNCHED_REVIEW_AGENTS:-}" ] || { [ -r "$_SD/${PR_NUMBER}_launched_review_agents" ] && LAUNCHED_REVIEW_AGENTS=$(grep -E '^[a-z0-9-]+$' "$_SD/${PR_NUMBER}_launched_review_agents" | sort -u | tr '\n' ' '); }
# Fail closed: a staging review always launches at least the Phase 2 material-change agent, so an empty list means lost state or skipped bookkeeping, never "nothing to verify".
if [ -z "${PR_NUMBER:-}" ] || [ -z "${LAUNCHED_REVIEW_AGENTS:-}" ]; then
  echo "REVIEW DELIVERY FAILURE: launched-agent list is empty or unreadable (PR_NUMBER='${PR_NUMBER:-}')"
  echo "Recover the launched reviewer domains from the PR's FORGE:REVIEW-AGENT comments, re-append them to the launched-agent file, and rerun."
  exit 1
fi
MISSING_AGENT_COMMENTS=""
# Each Bash call is a fresh shell: re-resolve the full head SHA if it is not set, and refuse when it is not a commit id
# (an empty SHA would make the Reviewed-SHA match accept any head).
[ -n "${REVIEW_SHA_FULL:-}" ] || REVIEW_SHA_FULL=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
for AGENT_DOMAIN in $LAUNCHED_REVIEW_AGENTS; do
  AGENT_COMMENT_COUNT=0
  if [ -n "$REVIEW_SHA_FULL" ] && [ -n "$TRUSTED_SCRIPT" ]; then
    AGENT_COMMENT_COUNT=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
      | bash "$TRUSTED_SCRIPT" count "^<!-- FORGE:REVIEW-AGENT:${AGENT_DOMAIN} -->[\\s\\S]*(^|\\n)Reviewed-SHA:[ ]${REVIEW_SHA_FULL}(\\r?\\n|$)" 2>/dev/null || echo 0)
  fi
  case "$AGENT_COMMENT_COUNT" in ''|*[!0-9]*) AGENT_COMMENT_COUNT=0 ;; esac   # fail closed: counts as missing
  if [ "${AGENT_COMMENT_COUNT:-0}" -lt 1 ]; then
    MISSING_AGENT_COMMENTS="${MISSING_AGENT_COMMENTS} ${AGENT_DOMAIN}"
  fi
done

if [ -n "$MISSING_AGENT_COMMENTS" ]; then
  echo "REVIEW DELIVERY FAILURE: missing findings comment(s) for:${MISSING_AGENT_COMMENTS}"
  echo "Recover each agent's returned verdict, findings, and durable body path before rerunning review."
  exit 1
fi
```

An empty or unreadable launched-agent list is also a delivery failure (the fence exits 1), never evidence that nothing needed verifying; recover the list from the PR comments and rerun. Missing comments are an explicit failure, never evidence of no findings. Do not triage or synthesize a deploy verdict while any launched agent is unaccounted for.

### 7A: Extract, dedupe and gate (with the note-disposition dry run)

`scripts/review-finalize.sh` is the script `/review-pr` Phase 6 runs; staging adds `--scope-files` (the 0B.1 scoped review set) and `--prior-prs` (the bundle member PRs). It reads reviewer comments only through `scripts/trusted-comments.sh` (trusted author, body starting with the marker, the current-head `Reviewed-SHA` line), fails closed on an unreadable source or a marker extraction mismatch (a marker the parser cannot read never makes the review look clean), dedupes by file + line range ±5 and by title, and applies the `commands/review-pr.md` §6B.4 provenance and concreteness gates (head SHA, introduced-line against the PR diff, failure scenario): a stale finding is dropped, a MEDIUM-or-lower finding outside the diff is `pre-existing`, and **CRITICAL/HIGH are never routed as pre-existing**, whatever their confidence. **Exit 3 means `REVIEW_RESULT: status: BLOCKED` was printed** (unresolvable classifier or cap helper, unreadable comments, extraction mismatch, no trusted reviewer comment for the head): STOP, file nothing, emit no deploy approval and report `RESULT: BLOCK DEPLOY` with the blocker (`exit` ends only that Bash block).

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
CTX="$_SD/review-ctx-${PR_NUMBER}.json"; [ -s "$CTX" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: review context $CTX missing (0C did not run); nothing triaged (fail closed)"; exit 1; }   # STOP
RF=$(forge_resolve review-finalize.sh)   # install roots only, never the PR checkout; unresolvable is a stop (fail closed), never a skipped gate
[ -n "$RF" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: scripts/review-finalize.sh not resolvable (set FORGEDOCK_HOME to the ForgeDock install); refusing to continue (fail closed)"; exit 1; }   # STOP
OUT_DIR="$_SD/review-finalize-${PR_NUMBER}"
# 0B.1 results were written to a scope file by the Phase 0B.1 block; a missing or unreadable file means SCOPE_MODE=full (no demotion, fail open), announced rather than silent.
SCOPE_MODE=full; CROSS_PR_FILES=""; UNREVIEWED_FILES=""; DEPLOY_WIRING_FILES=""
if [ -r "$_SD/${PR_NUMBER}_scope.env" ]; then . "$_SD/${PR_NUMBER}_scope.env"; else echo "WARNING: $_SD/${PR_NUMBER}_scope.env unreadable: SCOPE_MODE=full (no out-of-scope demotion)"; fi
SCOPE_FILE="$_SD/${PR_NUMBER}_scope-files.txt"; rm -f "$SCOPE_FILE"
if [ "$SCOPE_MODE" = "scoped" ]; then printf '%s\n%s\n%s\n' "$CROSS_PR_FILES" "$UNREVIEWED_FILES" "$DEPLOY_WIRING_FILES" | sed '/^$/d' | sort -u > "$SCOPE_FILE"; else SCOPE_FILE=""; fi
PRIOR_PRS=$(printf '%s ' $ALL_PR_NUMBERS)
bash "$RF" extract --pr "$PR_NUMBER" --repo "$GH_REPO" --context "$CTX" --out-dir "$OUT_DIR"; RC=$?
[ "$RC" -eq 0 ] || exit 1   # STOP: REVIEW_RESULT: status: BLOCKED was printed
# note-disposition dry run (posts nothing): classifies every kept finding and prints the NOTE list
bash "$RF" classify --pr "$PR_NUMBER" --repo "$GH_REPO" --context "$CTX" --out-dir "$OUT_DIR" --auto-merge false ${SCOPE_FILE:+--scope-files "$SCOPE_FILE"} --prior-prs "$PRIOR_PRS" --dry-run; RC=$?
[ "$RC" -eq 0 ] || exit 1   # STOP
cat "$OUT_DIR/note-list.txt" 2>/dev/null
```

Read `FINDINGS_KEPT`, `FINDINGS_DROPPED_STALE`, `FINDINGS_PREEXISTING` and `NOTES_DEMOTED_NO_SCENARIO` for the summary. With no kept finding and no unstructured finding in the trusted reviewer bodies, skip to Phase 8.

### 7B: Note disposition (same damper and classifier as `/review-pr` §6B.5)

`classify` runs `scripts/classify-finding.sh` (never hand-classify) on every finding that survived 7A, then `scripts/cap-findings.sh`; the rules live there (HIGH/CRITICAL always ISSUE; a content-based safety exemption; otherwise LOW/POSSIBLE become NOTEs). The staging PR is not a finding fix, so `lineage=none`. **Scope**: with `SCOPE_MODE=scoped` a MEDIUM, LOW or INFO finding whose cited files are all outside the 0B.1 set becomes `NOTE out_of_scope` (listed, never dropped; never HIGH/CRITICAL, never a safety-exempt or re-flagged finding, never a finding that cites no file). **Cross-PR re-flag** (`--prior-prs`): a finding a bundle member PR's review or `FORGE:NOTE_DISPOSITION` list already covered becomes `NOTE reflag-*` and files nothing (never for HIGH/CRITICAL). **Per-review cap**: at most `review.max_filed_findings` ISSUEs (default 2), the overflow is `NOTE capped`. Each NOTE gets one disposition: list it in the PR body under `## Non-blocking notes` (edit, never replace) or drop a duplicate or nit; NOTEs never reach the filing call. The 7C fence runs `classify` for real, which posts the `FORGE:NOTE_DISPOSITION` record (counts, `out_of_scope=`, `scope=`, then the NOTE list, dropped NOTEs included) whenever findings were extracted. Read `FINDINGS_FILED`, `NOTES_LISTED`, `NOTES_CAPPED`, `NOTES_REFLAG` and `NOTE_DISPOSITION_POSTED`.

### 7C: Prepare and create issues

`file-prepare` does every pre-filing step for the ISSUE findings: managed labels, the milestone (`scripts/derive-finding-milestone.sh`), the title dedup (`scripts/issue-dedup.sh`) and the line-range check against open `review-finding` issues, a regression flag when a closed `review-finding` sits at the same location (elevated one priority level), `priority:*` from `**Severity**` only via `scripts/severity-to-priority.sh` (never from Confidence), and the pattern recurrence check. A dedup helper or lookup failure never suppresses a finding. Staging reviews long-lived branches (`staging`, `milestone/*`), so the code branch is the PR's `headRefName`, not a short-lived head.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
CTX="$_SD/review-ctx-${PR_NUMBER}.json"; [ -s "$CTX" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: review context $CTX missing (0C did not run); nothing triaged (fail closed)"; exit 1; }   # STOP
RF=$(forge_resolve review-finalize.sh)   # install roots only, never the PR checkout; unresolvable is a stop (fail closed), never a skipped gate
[ -n "$RF" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: scripts/review-finalize.sh not resolvable (set FORGEDOCK_HOME to the ForgeDock install); refusing to continue (fail closed)"; exit 1; }   # STOP
OUT_DIR="$_SD/review-finalize-${PR_NUMBER}"
SCOPE_FILE="$_SD/${PR_NUMBER}_scope-files.txt"; [ -r "$SCOPE_FILE" ] || SCOPE_FILE=""   # written by 7A only for a scoped review
PRIOR_PRS=$(printf '%s ' $ALL_PR_NUMBERS)
# 7B for real: posts FORGE:NOTE_DISPOSITION with the caller's NOTE counts.
bash "$RF" classify --pr "$PR_NUMBER" --repo "$GH_REPO" --context "$CTX" --out-dir "$OUT_DIR" --auto-merge false ${SCOPE_FILE:+--scope-files "$SCOPE_FILE"} --prior-prs "$PRIOR_PRS" \
  --notes-fixed 0 --notes-dropped "${NOTES_DROPPED:-0}"; RC=$?
[ "$RC" -eq 0 ] || exit 1   # STOP: REVIEW_RESULT: status: BLOCKED was printed
PATTERNS_FILE="$OUT_DIR/patterns.json"; [ -s "$PATTERNS_FILE" ] || PATTERNS_FILE=""
bash "$RF" file-prepare --pr "$PR_NUMBER" --repo "$GH_REPO" --context "$CTX" --out-dir "$OUT_DIR" ${PATTERNS_FILE:+--patterns "$PATTERNS_FILE"}; RC=$?
[ "$RC" -eq 0 ] || exit 1   # STOP
gh label create "staging-review" --color "1D76DB" --description "Finding from a staging branch review before deploy to main. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null || true
echo "CODE_BRANCH=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefName --jq '.headRefName')"
jq -c '.items[] | select(.action == "file")' "$OUT_DIR/worklist.json"
```

Each printed line is one item to file (`skip-*` items are covered or unfilable: record them in the Phase 8 summary as `deduped: #N`, `regression: #N` or `dedup-unavailable`). An item carries `title`, `labels` (with `priority:*`), `milestone`, `batchable`, `regression_of`, `file`, `line`, `severity`, `agent` and `pattern`; pattern consolidation follows `commands/review-pr.md` §6C. **For each item to file**, write the issue body, then create it through the `/issue` programmatic invocation contract (`commands/issue.md` § "Programmatic Invocation Contract"), never the raw issue-creation command:

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
SCRATCHPAD="$_SD"; REVIEW_AGENT_TOKEN="${AGENT_ID:-${HOSTNAME:-reviewer}-$$}"
STAGING_FINDING_BODY_MARKER="FORGE:BODY-INTEGRITY:${PR_NUMBER}_staging-review_${REVIEW_AGENT_TOKEN}"
STAGING_FINDING_BODY_FILE=$(mktemp "$SCRATCHPAD/${PR_NUMBER}_staging-review_${REVIEW_AGENT_TOKEN}.XXXXXX.md")
cat <<'ISSUE_EOF' > "$STAGING_FINDING_BODY_FILE"
## Problem

[One sentence: what bug was found, where (`file:line`) and what it causes.]

**Source**: PR #[PR_NUMBER] — [TITLE]
**Confidence**: [CONFIRMED/LIKELY/POSSIBLE]
**Severity**: [CRITICAL/HIGH/MEDIUM/LOW]
**Review comment**: [permalink to agent comment]

## Affected Files

Files that need changes:
1. `[file:line]` — [what needs to change to fix this finding]

## Source Branch Context

**Code branch**: `[CODE_BRANCH]` (worktree base `origin/[CODE_BRANCH]`)

## Code Context
[10 lines around the finding]

## Evidence
[From the agent comment]

## Acceptance Criteria

- [ ] Finding validated: VALIDATED / FALSE_POSITIVE / INCONCLUSIVE
- [ ] If VALIDATED: fix implemented and tested on the correct branch
[BATCHABLE_ANNOTATION]
ISSUE_EOF
printf '\n<!-- %s -->\n' "$STAGING_FINDING_BODY_MARKER" >> "$STAGING_FINDING_BODY_FILE"
echo "STAGING_FINDING_BODY_FILE=$STAGING_FINDING_BODY_FILE"
```

Replace `[BATCHABLE_ANNOTATION]` with `<!-- FORGE:BATCHABLE -->` when the item's `batchable` is true, else remove it; add "Previously fixed in #N: regression" when `regression_of` is set. The filing call is a skill invocation, not a shell fence: `--label` repeats for every item label plus `staging-review` (never comma-joined), `--milestone` only when the item's is non-empty:

```
>>> INVOKE: Skill(skill="{FORGE_SKILL_PREFIX}issue", args="--title \"<item.title>\" --body-file \"{STAGING_FINDING_BODY_FILE}\" --label review-finding --label needs-validation --label staging-review --label \"<item.priority>\" [--milestone \"<item.milestone>\"]")
```

For a pre-existing item use the item's `labels` (`pre-existing` plus priority) plus `staging-review`. `/issue` succeeds only after its API create-token read-back and prints `ISSUE_CREATE_RESULT:CREATED number=N` or `ISSUE_CREATE_RESULT:DEDUP number=N`; pass that line to `file-verify`, which prints `ISSUE_NUM=N` and exits 1 when no number was reported (the review then stops instead of silently dropping the finding):

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
RF=$(forge_resolve review-finalize.sh)   # install roots only, never the PR checkout; unresolvable is a stop (fail closed)
[ -n "$RF" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: scripts/review-finalize.sh not resolvable (set FORGEDOCK_HOME to the ForgeDock install); refusing to continue (fail closed)"; exit 1; }   # STOP
printf '%s\n' "{ISSUE_RESULT_LINE}" | bash "$RF" file-verify || exit 1   # STOP: the finding was not verified as filed
```

### 7D: Project board and PR description

Add each created issue to the project board (`forge.yaml → project_board`; a missing config skips this silently) and append a `## Review Findings` table (summaries and issue links) to the PR body: edit, never replace.

---

## Phase 8: Final Summary & Deployment Checklist

Post summary with verdict:
1. CI failed + autofix failed → BLOCK DEPLOY
2. CI failed + autofix succeeded → continue
2.5. Test gate returned BLOCK (blocking posture, no override) → BLOCK DEPLOY *(handled in Phase 6.5 — if Phase 8 is reached, BLOCK was either overridden or posture is advisory)*
3. CONFIRMED CRITICAL (non-CI) → BLOCK DEPLOY
4. CONFIRMED HIGH blocking (crashes, data loss) → NEEDS FIXES FIRST
5. All else → APPROVE FOR DEPLOY

Include in Finding Triage Results: `SCOPE_MODE`, `reviewed_prs`, `unreviewed_commits`, `cross_pr_files` counts (Phase 0B.1), `notes_fixed`/`notes_listed`/`notes_dropped`, `findings_filed`, `out_of_scope`, and the deduped list (the `skip-*` worklist items). **Idempotency**: re-running the staging review on an unchanged bundle files 0 new findings (reviewed-set exclusion plus 7E dedup); a re-run that files anything must cite what changed in the bundle.

Include: Material Changes Summary, Risk Matrix (CI, Build, Bugs, Security, Billing, Quality, Regression, **Test Gate**), Finding Triage Results, Blocking Issues, Deployment Checklist (pre-deploy, deploy, post-deploy verification, rollback triggers), Stats.

**Risk Matrix must include a Test Gate row** (use `$TEST_GATE_VERDICT` and `$TEST_GATE_REASON` set in Phase 6.5; both are persisted to `$_SD/${PR_NUMBER}_test_gate_verdict` / `$_SD/${PR_NUMBER}_test_gate_reason` by that phase, so reload them in a fresh shell with the validated `TEST_GATE_VERDICT` / `TEST_GATE_REASON` reload lines carried by the Phase 6.5 verdict-handling fence):

| Domain | Result | Notes |
|--------|--------|-------|
| CI | ... | ... |
| Build | ... | ... |
| Bugs | ... | ... |
| Security | ... | ... |
| Billing | ... | ... |
| Quality | ... | ... |
| Regression | ... | ... |
| **Test Gate** | `${TEST_GATE_VERDICT:-SKIP}` | `${TEST_GATE_REASON:-Phase 6.5 not run}` |

If `TEST_GATE_VERDICT` is `SKIP`, surface the gap explicitly in the summary:

> **Test Gate: SKIP** — No runtime tests ran for this bundle. This means acceptance criteria were NOT verified against running code before deploy. Cause: `${TEST_GATE_REASON}`. To enable runtime testing, configure `verification.integration_tests` in `forge.yaml`.

If `TEST_GATE_VERDICT` is `PASS`, note it as a positive signal:

> **Test Gate: PASS** — Acceptance criteria verified against running code. No batch-introduced runtime failures detected.

If `TEST_GATE_VERDICT` is `BLOCK` and Phase 8 was reached (advisory posture or override active), note it as a risk:

> **Test Gate: BLOCK (override/advisory)** — Runtime failures were detected but deploy is proceeding. Reason: `${TEST_GATE_REASON}`. Filed `test-failure` issues track the failures.

**Pipeline cost** (fail-soft, informational; never changes the verdict) <!-- Added: forge#3824 -->: add a "Pipeline cost" table from `scripts/cost-report.sh` (current version vs the previous two). An unresolvable script or an empty runs dir omits the table.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
COST_SCRIPT=$(forge_resolve cost-report.sh)
[ -n "$COST_SCRIPT" ] && bash "$COST_SCRIPT" --last 3 2>/dev/null || echo "Pipeline cost: unavailable"
```

**Pipeline stats** (fail-soft, informational; never changes the verdict or any `FORGE:GATE_*` marker; additive to the cost table above) <!-- Added: forge#3835 -->: embed the compact `forgedock stats` table (per version: cost, merged / needs-human / remediation rates, wall time, findings per review, acceptance block rate, delta vs the previous version). A missing CLI, no `gh` auth or no data omits the table.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
STATS_OUT=$(forgedock stats --compact --repo "${GH_REPO}" 2>/dev/null || npx --no-install forgedock stats --compact --repo "${GH_REPO}" 2>/dev/null) || STATS_OUT=""
[ -n "$STATS_OUT" ] && printf '%s\n' "$STATS_OUT" || echo "Pipeline stats: unavailable"
```

**CRITICAL**: This review NEVER merges staging → main. User makes deploy decision via GitHub web UI.

---

## Gate Marker Contract

Every completed staging review MUST leave one of the following structured markers on the PR:

| Marker | Meaning |
|--------|---------|
| `<!-- FORGE:GATE_PASS -->` | Gate ran and passed — deploy may proceed |
| `<!-- FORGE:GATE_FAILURE -->` | Gate ran and blocked — do NOT deploy |

**Absence of both markers = bypass detected.** The `.github/workflows/gate-marker-check.yml` workflow enforces this: it scans the PR timeline after review completes and fails CI if no gate marker is present within 30 minutes of the PR being opened/updated. A missing marker is treated as a deploy blocker — not a pass.

This symmetry closes the silent-bypass gap identified in forge#1387: previously, gate PASS posted nothing, making a clean pass indistinguishable from a skipped spec.
