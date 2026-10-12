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

**Prior-finding awareness on re-entry**: On each re-invocation, load findings from prior review passes on the same PR before running any new checks. Previously-resolved findings (issues that are now closed or marked `false-positive`) are excluded from the current verdict to avoid re-surfacing already-fixed issues. Previously-unresolved findings (open issues from a prior pass) are carried forward as context so agents know what was previously flagged:

```bash
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

Resolve the staging→main PR number and post a routing marker immediately. This creates an audit trail — if a staging→main PR has no `FORGE:REVIEW_ROUTE` comment after this command was invoked, the review was bypassed or never started.

```bash
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

---

## Phase 0A: Open Review-Finding Gate (BLOCKING — runs before scope analysis)

**Purpose**: Prevent deploying commits that have known, unfixed review findings. The review system catches bugs before merging; this gate ensures the merge path acts on that information.

**Why this matters**: Review findings are filed before the originating PR merges to staging. Without this gate, a staging→main bundle can include commits with known unfixed bugs — the review system caught the issue, but the deploy path ignored it. This gate closes the gap between issue discovery and deploy execution. <!-- Added: forge#303 -->

```bash
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
# Persist the results for 7B.5 (a later Bash call is a fresh shell). %q keeps multi-line file lists intact.
printf 'SCOPE_MODE=%q\nCROSS_PR_FILES=%q\nUNREVIEWED_FILES=%q\nDEPLOY_WIRING_FILES=%q\n' "$SCOPE_MODE" "${CROSS_PR_FILES:-}" "${UNREVIEWED_FILES:-}" "${DEPLOY_WIRING_FILES:-}" > "$_SD/${PR_NUMBER}_scope.env"
echo "SCOPE_MODE=$SCOPE_MODE reviewed_prs=$REVIEWED_PR_COUNT unreviewed_commits=$(echo $UNREVIEWED_COMMITS | wc -w) unreviewed_files=$(echo "$UNREVIEWED_FILES" | grep -c .) cross_pr_files=$(echo "$CROSS_PR_FILES" | grep -c .)"
```

**Fail-open (never silently review less)**: every `gh`, `git log`, `git diff`, `git diff-tree` and marker-count read above is captured into a variable and tested on its own exit status (never through a pipe, where `||` sees only the last stage). If the trust script cannot be resolved, any such read fails, or a marker count is not an integer, `SCOPE_MODE=full` and Phases 2-6 review the full bundle diff as before. Only `SCOPE_MODE=scoped` narrows review.

**Stale-head delta credit (fail-closed)**: delta credit only ever moves commits out of UNREVIEWED, and only on a positive, trusted resolver answer. A resolver `FULL`, an error, malformed output, a force-push (reviewed sha not an ancestor), an untrusted or absent `FORGE:REVIEW-CARRIED` record, a degraded/blocked PR, 100+ commits or an unresolved `review-delta.sh` all leave the PR's commits UNREVIEWED (today's behaviour) and never force `SCOPE_MODE=full` by themselves. `DELTA <reviewed>..<head>` credits only the PR commits that are ancestors of `<reviewed>` (never its merge commit); `BASE_SYNC_ONLY` credits the whole PR only with a trusted carried record naming this head and that reviewed sha. A bundle that changes the review specs gets `FULL` from the resolver by design. <!-- Added: forge#3638 -->

**Scoped line-level review set** = `CROSS_PR_FILES` + `UNREVIEWED_FILES` (the files of `UNREVIEWED_COMMITS`, including merge-commit conflict resolutions) + `DEPLOY_WIRING_FILES`. Files and commits that belong only to an already-reviewed PR (the already-reviewed set) are excluded from line-level review.

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

**MANDATORY TEMPLATE-RESOLUTION GUARD — run BEFORE reading the agent catalog:**

Missing persona templates are a fatal setup error, not permission to skip multi-agent review. Resolve the template source through this ordered chain (identical to the one used by `/review-pr` Phase 3C — do not diverge) and STOP if none resolve — never fall through to reviewing inline in the main context:

```bash
TEMPLATE_BASE=""
# Tier 0: the running plugin's own root (Claude Code substitutes this exact spelling; elsewhere it stays a
# literal that the /* check rejects). Wins over an exported FORGE_HOME, which may name an older checkout.
_PLUGIN_ROOT='${CLAUDE_PLUGIN_ROOT}'; case "$_PLUGIN_ROOT" in /*) ;; *) _PLUGIN_ROOT="" ;; esac
if [[ -n "$_PLUGIN_ROOT" && -f "$_PLUGIN_ROOT/commands/review-pr-agents/protocols.md" ]]; then
  TEMPLATE_BASE="$_PLUGIN_ROOT/commands/review-pr-agents"
  TEMPLATE_SOURCE="plugin_root"
elif [[ -f "$FORGE_HOME/commands/review-pr-agents/protocols.md" ]]; then
  TEMPLATE_BASE="$FORGE_HOME/commands/review-pr-agents"
  TEMPLATE_SOURCE="forge_home"
else
  FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
  REPO_PATH=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
  if [[ -f "$REPO_PATH/commands/review-pr-agents/protocols.md" ]]; then
    TEMPLATE_BASE="$REPO_PATH/commands/review-pr-agents"
    TEMPLATE_SOURCE="repo_path"
  elif [[ -f "$REPO_PATH/commands/review-pr-agents.md" ]] && grep -q "^### Agent:" "$REPO_PATH/commands/review-pr-agents.md" 2>/dev/null; then
    # Content check (not just existence) required: a post-split repo still ships a small
    # router stub at this same path that only points back to the (missing) persona
    # directory — reading it would provide no actual protocol/persona content.
    MONOLITHIC_CATALOG="$REPO_PATH/commands/review-pr-agents.md"
    TEMPLATE_SOURCE="monolithic_catalog"
  else
    TEMPLATE_SOURCE="none"
  fi
fi

if [[ "$TEMPLATE_SOURCE" == "none" ]]; then
  echo "FATAL: no review-pr-agents template source resolved (checked \$FORGE_HOME, repo-path fallback, monolithic catalog)."
  # HARD STOP — post error, add needs-human, do NOT review
fi
```

**If `TEMPLATE_SOURCE` is `none`**: HARD STOP. Post a PR comment explaining the setup is broken, instructing the user to run `npx forgedock update` to repair the install, add `needs-human`, and exit without posting any findings or a verdict. **NEVER perform the review inline in the main agent context as a substitute.**

**If `TEMPLATE_SOURCE` is `plugin_root`, `forge_home` or `repo_path`** (normal cases — behavior unchanged): `Read: $TEMPLATE_BASE/protocols.md` and `Read: $TEMPLATE_BASE/<persona>.md` per selected agent.

**If `TEMPLATE_SOURCE` is `monolithic_catalog`** (last resort): `Read: $MONOLITHIC_CATALOG` and extract the shared protocols section plus each selected persona's section from within that single file.

Launch domain-specific agents based on which domains have changes. Substitute PR diff commands with staging diff commands.

**Risk-tiered domain panel** <!-- Added: forge#3599 -->: choose the domain agents with `scripts/review-roster.sh` (resolve it with `forge_resolve review-roster.sh`, never from `$PWD`) instead of launching every domain with a change. Every PR in the bundle already had its own review, so this panel only needs to catch cross-PR interactions. Pass the bundle's changed lines (`git diff --numstat "origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH"`, added plus deleted), changed-file count and file list (`--files-file -`), optional `--scores` diff-text signals (omit for none), and `--fix-pr false`; a bundle of 60 lines or fewer runs Security only unless a path trigger fires, a larger one follows the medium and standard tiers, and Auth and Infra run only when auth/session/trust-filter or CI/docker/deploy files are in the bundle. Run the full union when `--thorough` was passed. When the script cannot be resolved or fails, launch the full union (fail toward more agents). Record the tier and reason in the final summary.

**Per-domain diff slices (MANDATORY)**: `protocols.md` tells agents to use a pre-supplied `[DOMAIN_DIFF_SLICE]` and not to re-fetch the diff, so staging MUST supply one — the staging→main diff is the largest diff in the pipeline. Slice the uncapped diff first, then cap each slice at ~100K chars with `truncate_slice` (same order as `commands/review-pr.md` "Domain Diff Slicing"). Compute the slices once, then substitute `[DOMAIN_DIFF_SLICE]` in each persona's prompt before dispatch:
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# Fetched once, UNCAPPED; agents do NOT re-fetch it. Never cap here: slicing must see the whole bundle.
FULL_DIFF=$(git diff "origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH")

# --- Security agent: always receives the full diff (cross-cutting domain) ---
DIFF_SLICE_SECURITY="$FULL_DIFF"

# --- Auth agent: auth, session, jwt, oauth, middleware, permission files ---
DIFF_SLICE_AUTH=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(auth|session|jwt|oauth|permission|middleware|login|token)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_AUTH" ] && DIFF_SLICE_AUTH="$FULL_DIFF"

# --- Billing agent: billing, payment, credit, pricing, stripe, subscription files ---
DIFF_SLICE_BILLING=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(billing|payment|credit|pricing|stripe|subscription|invoice|charge|refund)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_BILLING" ] && DIFF_SLICE_BILLING="$FULL_DIFF"

# --- Concurrency agent: transaction, lock, queue, async, worker, race-condition files ---
DIFF_SLICE_CONCURRENCY=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(worker|queue|task|async|lock|transaction|pipeline|job)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_CONCURRENCY" ] && DIFF_SLICE_CONCURRENCY="$FULL_DIFF"

# --- Database agent: migration, model, schema, ORM, SQL files ---
DIFF_SLICE_DATABASE=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(migration|model|schema|\.sql$|orm|database|db)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_DATABASE" ] && DIFF_SLICE_DATABASE="$FULL_DIFF"

# --- API Design agent: router, endpoint, openapi, schema, serializer files ---
DIFF_SLICE_API=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(router|route|endpoint|openapi|serializer|schema|api)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_API" ] && DIFF_SLICE_API="$FULL_DIFF"

# --- Infrastructure agent: docker, nginx, ci, deploy, infra, workflow files ---
DIFF_SLICE_INFRA=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(docker|nginx|infra|\.github|deploy|ci|traefik|k8s|helm)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_INFRA" ] && DIFF_SLICE_INFRA="$FULL_DIFF"

# --- Domain Logic agent: scraping/browser-automation files (does not match bare playwright/E2E test files) ---
DIFF_SLICE_SCRAPER=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(scrape|scraper|stealth|browser_pool|headless|anti_bot|captcha|crawl)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_SCRAPER" ] && DIFF_SLICE_SCRAPER="$FULL_DIFF"

# Cap each slice AFTER slicing and after the empty-slice fallback (a fallback slice is the truncated full diff)
truncate_slice() {
  local slice="${1}"
  local limit=102400
  if [ "${#slice}" -gt "$limit" ]; then
    echo "${slice:0:$limit}"
    echo "... [TRUNCATED — diff exceeded 100K chars; focus on the files listed above]"
  else
    echo "$slice"
  fi
}
DIFF_SLICE_SECURITY=$(truncate_slice "$DIFF_SLICE_SECURITY")
DIFF_SLICE_AUTH=$(truncate_slice "$DIFF_SLICE_AUTH")
DIFF_SLICE_BILLING=$(truncate_slice "$DIFF_SLICE_BILLING")
DIFF_SLICE_CONCURRENCY=$(truncate_slice "$DIFF_SLICE_CONCURRENCY")
DIFF_SLICE_DATABASE=$(truncate_slice "$DIFF_SLICE_DATABASE")
DIFF_SLICE_API=$(truncate_slice "$DIFF_SLICE_API")
DIFF_SLICE_INFRA=$(truncate_slice "$DIFF_SLICE_INFRA")
DIFF_SLICE_SCRAPER=$(truncate_slice "$DIFF_SLICE_SCRAPER")
```
For each dispatched persona, substitute `[DOMAIN_DIFF_SLICE]` → its matching `$DIFF_SLICE_*` variable (an empty slice falls back to the full diff, which is then truncated like every other slice). Also substitute `[AGENT_DOMAIN]` → the persona's marker domain (the `{domain}` used in its `FORGE:REVIEW-AGENT` marker), and bind `[PR_NUMBER]` to the staging review's PR number (`staging` when there is none) and `[REVIEW_SHA_SHORT]` to the literal Phase -1 `REVIEW_SHA_SHORT` value (hex, or `unresolved`; never `REVIEW_SHA_STAGING`, whose `n/a` sentinel would put a `/` in the path): personas derive their slice path `forge-slice-[PR_NUMBER]-[REVIEW_SHA_SHORT]-[AGENT_DOMAIN].diff` from them. Also substitute `[REVIEW_SHA]` → the literal full head SHA (40 or 64 hex, the orchestrator's Phase -1 `REVIEW_SHA_FULL` value) into the dispatch prompt: a reviewer runs its post fence in a fresh shell, so it MUST NOT reference `${REVIEW_SHA_FULL}` and MUST NOT invent a value; when no full SHA resolved (no PR), omit the `Reviewed-SHA:` line value rather than fabricate one (Phase 7 consumers then fail closed). Agents never run a full `gh pr diff`; only `--name-only` is allowed. Agents: General Security (always), Auth, Billing, Concurrency, Scraper, API Design, Database, Infrastructure.

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

### 7A: Extract Findings
Only findings inside trusted, current-head reviewer comments count: the head SHA is public, so an untrusted commenter must never be able to inject `FINDING` markers that get filed as issues. Read every page of comments, fail closed when the trust script or comments are unreadable (never fall through to "no findings").

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# Each Bash call is a fresh shell: re-resolve the full head SHA if it is not set, and refuse when it is not a commit id
# (an empty SHA would make the Reviewed-SHA match accept any head).
[ -n "${REVIEW_SHA_FULL:-}" ] || REVIEW_SHA_FULL=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
case "$REVIEW_SHA_FULL" in *[!0-9a-f]*|"") REVIEW_SHA_FULL="" ;; *) [ "${#REVIEW_SHA_FULL}" -eq 40 ] || [ "${#REVIEW_SHA_FULL}" -eq 64 ] || REVIEW_SHA_FULL="" ;; esac
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
[ -n "$REVIEW_SHA_FULL" ] || { echo "STAGING_REVIEW: BLOCKED - head SHA is not a commit id; refusing to extract findings (fail closed)"; exit 1; }
COMMENTS_JSON=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null || echo "")
if [ -z "$TRUSTED_SCRIPT" ] || [ -z "$COMMENTS_JSON" ]; then
  echo "STAGING_REVIEW: BLOCKED - scripts/trusted-comments.sh unresolvable or PR comments unreadable; refusing to extract findings (fail closed)"; exit 1
fi
AGENT_RE="^<!-- FORGE:REVIEW-AGENT:[a-z0-9-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA:[ ]${REVIEW_SHA_FULL}(\\r?\\n|$)"
AGENT_BODIES=$(printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" bodies "$AGENT_RE" 2>/dev/null) \
  || { echo "STAGING_REVIEW: BLOCKED - trusted reviewer comments unreadable (fail closed)"; exit 1; }
ALL_FINDINGS=$(printf '%s\n' "$AGENT_BODIES" | jq -r 'scan("<!-- FINDING:([^>]+) -->") | .[0]' 2>/dev/null)
```

Extract structured findings (`<!-- FINDING:... -->`) from `ALL_FINDINGS`. If none found, scan the trusted bodies for unstructured findings. If still 0 → skip to Phase 8.

### 7B: Filter & Deduplicate
Keep ALL findings (CONFIRMED/LIKELY/POSSIBLE) for the 7B.6 provenance gates and then classification (7B.5). Deduplicate within this run by file + pattern + location: same file, location within +-5 lines, and 3+ shared title keywords (a shared explicit finding id is an additional match, never a substitute for the keyword test) are one finding (keep higher confidence). When `SCOPE_MODE=scoped`, a finding is `out_of_scope` only when it cites at least one file and EVERY cited file is outside `CROSS_PR_FILES`, `UNREVIEWED_FILES` and `DEPLOY_WIRING_FILES` (0B.1; a finding with any in-scope file, such as a cross-file interaction, stays in scope), and the filter may only DEMOTE it, never drop it: only a finding whose normalised severity is `MEDIUM`, `LOW` or `INFO` becomes a listed note. `CRITICAL` and `HIGH` (any confidence), and any missing or unrecognised severity, are always kept and go to 7B.5 as usual, so scope can never remove a blocking finding. Every demoted finding is listed (id, file:line, reason `out_of_scope`) in the 7B.5 disposition; none is silently dropped. Findings with no file (readiness-checklist items such as undocumented env vars or a migration-number collision across PRs) are never demoted. The executable rule is the two `SCOPE_RULE` lines inside `classify_one` in 7B.5 (`scripts/review-pr-staging-scope.test.sh` evaluates them).

Sort: CONFIRMED first, then by severity.

### 7B.6: Provenance and concreteness gates (forge#3452)

Before filing, apply the three gates defined in `commands/review-pr.md` §6B.4 (head-SHA, introduced-line, failure scenario), in that order, to every finding — do not duplicate the algorithm here. Use the staging diff (`git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH`, or the reviewed PR's diff) as the introduced-line source and the full 40-hex head SHA (`git rev-parse origin/$STAGING_BRANCH`, never an abbreviated one) as the reviewed SHA. Stale findings are dropped (`findings_dropped_stale`), findings outside the diff are `pre-existing` (`findings_preexisting`: listed in the summary, MEDIUM or lower only, since CRITICAL/HIGH, any confidence, are never routed as pre-existing and a file with no `patch` in the diff API is UNKNOWN and kept; filed only when safety-domain with the `pre-existing` label and never `review-finding`, so they are excluded from findings-per-PR and the amplification ratio), and findings without a `**Failure scenario**` are demoted to notes (`notes_demoted_no_scenario`) unless CRITICAL/HIGH, any confidence. Unreadable inputs keep the finding. Report the three counts in the staging review summary using the same names, and record every demoted or listed note in a `FORGE:NOTE_DISPOSITION` record in the same format as `commands/review-pr.md` §6B.5.

### 7B.5: Note Disposition (same damper and classifier as `/review-pr` §6B.5)

Classify every deduped finding with `scripts/classify-finding.sh` before filing, exactly as `commands/review-pr.md` §6B.5 does (the rules live in the script, not here: HIGH/CRITICAL always ISSUE, content-based safety exemption where LOW needs a keyword AND CONFIRMED and a domain agent rescues MEDIUM only, otherwise LOW/POSSIBLE become NOTEs). Resolve it with the same `forge_resolve` stub. There is no `$PWD` tier: the repo under review is author-controlled. The staging PR is not a finding fix, so `FINDING_LINEAGE=none`.

**Cross-PR re-flag** <!-- Added: forge#3641 -->: the 7B.6 gates run first, so re-flag counts cover only findings that survived them. A finding that a bundle member PR's review already posted, or that a member PR's `FORGE:NOTE_DISPOSITION` list recorded, is not filed or noted again. The fence builds a prior-findings TSV (file, line-start, line-end, title, prior-disposition, issue#) from each member PR in `ALL_PR_NUMBERS`, reading every comment through `scripts/trusted-comments.sh` (never an untrusted author), and passes it to the classifier as `--prior-findings`. A finding re-flags a row when it is the same file AND (line IoU >= 0.6 AND >= 1 shared non-stopword title token, OR >= 3 shared title tokens of which >= 2 are non-stopword; generic stopwords never count as topical similarity); the classifier answers `NOTE reflag-filed #N` (the prior issue is still open) or `NOTE reflag-note`, never a new ISSUE. HIGH/CRITICAL are never demoted (they keep blocking via §7B), and a row whose linked issue is closed is ignored so a regressed defect is classified normally. Reviewer-body rows whose issue linkage fails are passed as `unknown` (recorded NOTE_DISPOSITION rows as `note`); an `unknown` row never demotes a MEDIUM CONFIRMED/LIKELY re-flag. Re-flag NOTEs are listed with the other NOTEs and counted in `notes_reflag` only. An unreadable member PR only shrinks the TSV; it never blocks.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
CLASSIFY_SCRIPT=$(forge_resolve classify-finding.sh)
# Fail closed (#3639): no hand classification and no ISSUE fallback. Kept OUTSIDE classify_one (the scope test sources that function with a stubbed CLASSIFY_SCRIPT).
if [ -z "$CLASSIFY_SCRIPT" ]; then
  echo "REVIEW_RESULT: status: BLOCKED, blocker: classifier unavailable (classify-finding.sh not resolvable through the trusted resolver)"
  exit 0
fi
# Per-review cap (#3642): same resolver, same fail-closed rule.
CAP_SCRIPT=$(forge_resolve cap-findings.sh)
if [ -z "$CAP_SCRIPT" ]; then
  echo "REVIEW_RESULT: status: BLOCKED, blocker: cap helper unavailable (cap-findings.sh not resolvable through the trusted resolver)"
  exit 0
fi
# review.max_filed_findings (optional; helper default 2, falls back on invalid)
MAX_FILED_FINDINGS=$(yq '.review.max_filed_findings // ""' forge.yaml 2>/dev/null || echo '')
# Per-finding inputs come from each structured block: FINDING_ID, FINDING_SEVERITY, FINDING_CONFIDENCE, FINDING_AGENT, FINDING_TITLE, FINDING_BODY,
# FINDING_FILE (primary) and FINDING_PATHS (newline-separated, every cited file). Run THIS WHOLE BLOCK in ONE Bash call, looping over every deduped finding
# (init once, then classify_one per finding, then the disposition record), because counters and the note list live in shell state and a fresh shell loses them.
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# An empty PR_NUMBER would key every scratch file as "_notes.md" / "_scope.env" and the disposition record could not be posted: stop and report it.
[ -n "${PR_NUMBER:-}" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: PR_NUMBER unavailable (Phase -1 did not persist the run-keyed staging_pr_number pointer); FORGE:NOTE_DISPOSITION cannot be recorded"; exit 0; }
NOTE_LIST_FILE="$_SD/${PR_NUMBER}_notes.md"; : > "$NOTE_LIST_FILE"
NOTES_LISTED=0; NOTES_DROPPED=0; FINDINGS_FILED=0; OUT_OF_SCOPE=0; NOTES_CAPPED=0
CAP_ROWS_FILE="$_SD/${PR_NUMBER}_cap-rows.tsv"; : > "$CAP_ROWS_FILE"   # ISSUE rows awaiting the cap
CAPPED_IDS_FILE="$_SD/${PR_NUMBER}_capped-ids.txt"; : > "$CAPPED_IDS_FILE"   # capped ids: 7E/7F skip them
# 0B.1 results were written to a scope file by the Phase 0B.1 block; a missing or unreadable file means SCOPE_MODE=full (no demotion, fail open), announced rather than silent.
SCOPE_MODE=full; CROSS_PR_FILES=""; UNREVIEWED_FILES=""; DEPLOY_WIRING_FILES=""
if [ -r "$_SD/${PR_NUMBER}_scope.env" ]; then . "$_SD/${PR_NUMBER}_scope.env"; else echo "WARNING: $_SD/${PR_NUMBER}_scope.env unreadable: SCOPE_MODE=full (no out-of-scope demotion)"; fi
# Cross-PR re-flag input (forge#3641): prior findings and NOTE lists of every bundle member PR, trusted authors only. Unresolvable script or unreadable PRs leave PRIOR_FILE empty (no demotion).
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
REPO="$GH_REPO"; _pscr="$_SD"; NOTES_REFLAG=0; PRIOR_FILE=""
# Cross-head re-flag input (#3641). Fail soft: every unreadable source just leaves the TSV smaller, never blocks the review.
# PF_SKIP="<sha or empty>" PF_PRS="<pr numbers>" prior_findings_tsv prints file<TAB>line-start<TAB>line-end<TAB>title<TAB>disposition<TAB>issue# rows
# (disposition: filed = linked issue OPEN, filed-closed = linked issue CLOSED, note = a recorded NOTE_DISPOSITION with no linked issue, unknown = a reviewer-body finding whose issue linkage failed, so the classifier must not let it demote a MEDIUM CONFIRMED/LIKELY re-flag). Every comment is read through
# scripts/trusted-comments.sh, so an untrusted commenter cannot pre-post a finding to suppress a real one. With PF_SKIP set, reviewer
# bodies for that head are skipped and only NOTE_DISPOSITION records carrying a different `reviewed_sha=` count (this head's own record,
# from an earlier run of this same review, must never swallow its findings).
pf_split_loc() { # PF_LOC="file[:N[-M]]" -> file<TAB>N<TAB>M (`-` sentinel when a line column is absent: a tab IFS read collapses empty fields)
  local _loc="$PF_LOC" _file _r _a="" _b=""; _file="$_loc"
  case "$_loc" in *:[0-9]*) _r="${_loc##*:}"; case "$_r" in *[!0-9-]*|"") ;; *) _file="${_loc%:*}"; _a="${_r%%-*}"; _b="${_r#*-}"; [ "$_b" != "$_r" ] || _b="$_a" ;; esac ;; esac
  printf '%s\t%s\t%s\n' "$_file" "${_a:--}" "${_b:--}"
}
prior_findings_tsv() {
  local pr cj rows issues _id _c _s _loc _t _p _hit _f _a _b _src _dflt
  [ -n "${TRUSTED_SCRIPT:-}" ] || return 0
  rows=$(mktemp "${_pscr}/prior-rows.XXXXXX"); issues=$(mktemp "${_pscr}/prior-issues.XXXXXX")
  for pr in $PF_PRS; do
    case "$pr" in ''|*[!0-9]*) continue ;; esac
    cj=$(gh api --paginate "repos/${REPO}/issues/${pr}/comments" 2>/dev/null) || continue
    [ -n "$cj" ] || continue
    printf '%s' "$cj" | bash "$TRUSTED_SCRIPT" bodies '^<!-- (FORGE:REVIEW-AGENT:[a-z-]+|REVIEW-FINDINGS-SYNTHESIZED-START) -->[\s\S]*(^|\n)Reviewed-SHA: [0-9a-f]{40,64}' 2>/dev/null \
      | jq -r --arg skip "${PF_SKIP:-}" 'select($skip == "" or (test("(^|\\n)Reviewed-SHA: " + $skip + "\\r?(\\n|$)") | not)) | scan("<!-- FINDING:([^>]+) -->") | .[0]' 2>/dev/null \
      | while IFS='|' read -r _id _c _s _loc _t; do
          [ -n "$_t" ] || continue
          _p=$(PF_LOC="$_loc" pf_split_loc); printf 'F\t%s\t%s\n' "$_p" "$(printf '%s' "$_t" | tr '\t' ' ')"
        done >> "$rows"
    printf '%s' "$cj" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:NOTE_DISPOSITION' 2>/dev/null \
      | jq -r --arg skip "${PF_SKIP:-}" 'select($skip == "" or ((capture("^<!-- FORGE:NOTE_DISPOSITION:[^>]*reviewed_sha=(?<s>[0-9a-f]{40,64})") | .s) as $s | $s != $skip)) | split("\n")[] | select(startswith("- "))' 2>/dev/null \
      | sed -n 's/^- [^ ]* \([^ ]*\) \[[A-Za-z?]*\] \(.*\): [^:]*$/\1\t\2/p' \
      | while IFS="$(printf '\t')" read -r _loc _t; do
          [ "$_loc" != "?" ] || continue
          _p=$(PF_LOC="$_loc" pf_split_loc); printf 'N\t%s\t%s\n' "$_p" "$_t"
        done >> "$rows"
    gh issue list -R "$REPO" --label review-finding --state all --search "${pr} in:body" --limit 100 --json number,state,title,body 2>/dev/null \
      | jq -c '.[]' >> "$issues" 2>/dev/null || true
  done
  # Linkage: a filed issue whose body names the file and whose title shares >= 3 tokens with the finding (open preferred).
  # Rows carry a leading source column (F = reviewer FINDING marker, N = NOTE_DISPOSITION record), stripped on output. An unlinked F row may
  # have been filed under a reworded title, so it is `unknown` (never demotes MEDIUM CONFIRMED/LIKELY); an unlinked N row is a true `note`.
  sort -u "$rows" | while IFS="$(printf '\t')" read -r _src _f _a _b _t; do
    [ -n "$_f" ] || continue
    [ "$_a" != "-" ] || _a=""; [ "$_b" != "-" ] || _b=""
    case "$_src" in N) _dflt=note ;; *) _dflt=unknown ;; esac
    _hit=$(jq -rs --arg f "$_f" --arg t "$_t" 'def toks: ascii_downcase | [scan("[a-z0-9]{3,}")] | unique;
      ($t | toks) as $a | [ .[] | select((.body // "") | contains($f))
        | select((((.title // "") | toks) as $b | [$a[] | select(. as $x | $b | index($x))] | length) >= 3)
        | {n: .number, s: (.state | ascii_downcase)} ]
      | (map(select(.s == "open")) + map(select(.s != "open"))) | .[0] // empty | "\(.s)\t\(.n)"' "$issues" 2>/dev/null) || _hit=""
    case "$_hit" in
      open*) printf '%s\t%s\t%s\t%s\tfiled\t%s\n' "$_f" "$_a" "$_b" "$_t" "${_hit#*	}" ;;
      closed*) printf '%s\t%s\t%s\t%s\tfiled-closed\t%s\n' "$_f" "$_a" "$_b" "$_t" "${_hit#*	}" ;;
      *) printf '%s\t%s\t%s\t%s\t%s\t\n' "$_f" "$_a" "$_b" "$_t" "$_dflt" ;;
    esac
  done
  rm -f "$rows" "$issues"
}
PRIOR_ROWS=$(PF_SKIP="" PF_PRS="$ALL_PR_NUMBERS" prior_findings_tsv)
if [ -n "$PRIOR_ROWS" ]; then PRIOR_FILE="$_SD/${PR_NUMBER}_prior-findings.tsv"; printf '%s\n' "$PRIOR_ROWS" > "$PRIOR_FILE"; fi
classify_one() {
  # FINDING_TEXT_FILE holds the finding text: the classifier's content-based safety exemption reads it, so an empty file silently disables the exemption.
  local FINDING_TEXT_FILE; FINDING_TEXT_FILE=$(mktemp "$_SD/staging-finding.XXXXXX")
  printf '%s\n%s\n%s\n' "${FINDING_TITLE:-}" "${FINDING_BODY:-}" "${FINDING_PATHS:-${FINDING_FILE:-}}" > "$FINDING_TEXT_FILE"
  DISPOSITION=""
  if [ -n "$CLASSIFY_SCRIPT" ]; then
    DISPOSITION=$(bash "$CLASSIFY_SCRIPT" --severity "$FINDING_SEVERITY" --confidence "$FINDING_CONFIDENCE" \
      --agent "$FINDING_AGENT" --lineage none --text-file "$FINDING_TEXT_FILE" \
      ${PRIOR_FILE:+--prior-findings "$PRIOR_FILE" --title "${FINDING_TITLE:-}" --file "${FINDING_FILE:-}"}) || DISPOSITION=""
  fi
  rm -f "$FINDING_TEXT_FILE"
  # Fail toward filing, never drop: a classifier runtime failure or garbled result on one finding is ISSUE (the classifier's own convention); an unresolvable classifier never reaches here (guard above). INPR_FIX is never emitted (no --inpr-diff on a bundle).
  case "$DISPOSITION" in ISSUE*|NOTE*) ;; *) DISPOSITION="ISSUE classifier-error" ;; esac
  # 7B scope rule (the two SCOPE_RULE lines are executed here and evaluated by scripts/review-pr-staging-scope.test.sh):
  SEV=$(printf '%s' "$FINDING_SEVERITY" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')   # SCOPE_RULE
  case "$SEV" in MEDIUM|LOW|INFO) OOS_DEMOTE=1 ;; *) OOS_DEMOTE=0 ;; esac   # SCOPE_RULE
  # Demote ONLY when scoped, the rule allows it, the classifier did not apply its safety exemption, and EVERY cited file is out of scope.
  # A finding with no file, or with any file in scope, is never demoted. The demotion is recorded as a listed note, never dropped.
  case "$DISPOSITION" in *safety-exemption*|"NOTE reflag"*) OOS_DEMOTE=0 ;; esac   # a re-flag is already a recorded NOTE: never double-count it as out_of_scope
  if [ "$SCOPE_MODE" = "scoped" ] && [ "$OOS_DEMOTE" = "1" ] && [ -n "${FINDING_PATHS:-${FINDING_FILE:-}}" ]; then
    local _ANY_IN=false _f
    while IFS= read -r _f; do
      [ -n "$_f" ] || continue
      printf '%s\n' "$CROSS_PR_FILES" "$UNREVIEWED_FILES" "$DEPLOY_WIRING_FILES" | grep -qxF -- "$_f" && _ANY_IN=true
    done <<< "${FINDING_PATHS:-$FINDING_FILE}"
    if [ "$_ANY_IN" = "false" ]; then DISPOSITION="NOTE out_of_scope"; OUT_OF_SCOPE=$((OUT_OF_SCOPE+1)); fi
  fi
  case "$DISPOSITION" in
    "NOTE reflag"*) NOTES_REFLAG=$((NOTES_REFLAG+1)); printf '%s\n' "- ${FINDING_ID:-?} ${FINDING_FILE:-?} [${SEV:-?}] ${FINDING_TITLE:-}: ${DISPOSITION}" >> "$NOTE_LIST_FILE" ;;   # counted in notes_reflag only
    NOTE*) NOTES_LISTED=$((NOTES_LISTED+1)); printf '%s\n' "- ${FINDING_ID:-?} ${FINDING_FILE:-?} [${SEV:-?}] ${FINDING_TITLE:-}: ${DISPOSITION}" >> "$NOTE_LIST_FILE" ;;
    *) [ -n "${CAP_ROWS_FILE:-}" ] && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${FINDING_ID:--}" "${SEV:--}" "${FINDING_CONFIDENCE:--}" "$DISPOSITION" "${FINDING_AGENT:--}" "${FINDING_FILE:--}" "$(printf '%s' "${FINDING_TITLE:--}" | tr '\t\n' '  ')" >> "$CAP_ROWS_FILE" ;; # ISSUE: counted by cap_pass after the cap
  esac
}
cap_pass() {
  # #3642: run ONCE after the last classify_one, before 7E; sets FINDINGS_FILED (post-cap) and NOTES_CAPPED.
  local _out="$_SD/${PR_NUMBER}_cap-out.tsv" _total
  FINDINGS_FILED=0; NOTES_CAPPED=0; : > "$CAPPED_IDS_FILE"
  [ -s "$CAP_ROWS_FILE" ] || return 0
  _total=$(grep -c . "$CAP_ROWS_FILE")
  # Helper failure keeps every ISSUE (fail toward filing).
  if ! bash "$CAP_SCRIPT" --lineage none ${MAX_FILED_FINDINGS:+--cap "$MAX_FILED_FINDINGS"} --input "$CAP_ROWS_FILE" > "$_out" 2>/dev/null || ! grep -q '^CAPPED=' "$_out"; then
    FINDINGS_FILED="$_total"; echo "WARNING: cap-findings.sh failed: all $_total ISSUE findings kept"; return 0
  fi
  NOTES_CAPPED=$(sed -n 's/^CAPPED=//p' "$_out" | tail -n 1); NOTES_CAPPED="${NOTES_CAPPED:-0}"
  awk -F'\t' -v ids="$CAPPED_IDS_FILE" 'NR == FNR { if ($0 !~ /^CAPPED=/) o[++n] = $2; next }   # allowlist:positional-arg (awk fields)
    { k++; if (o[k] == "NOTE capped") { printf "%s\n", $1 > ids; printf "- %s %s [%s] %s: NOTE capped (over review.max_filed_findings)\n", $1, $6, $2, $7 } }' "$_out" "$CAP_ROWS_FILE" >> "$NOTE_LIST_FILE"   # allowlist:positional-arg (awk fields)
  FINDINGS_FILED=$((_total - NOTES_CAPPED))
  echo "cap_pass: findings_filed=$FINDINGS_FILED notes_capped=$NOTES_CAPPED"
}
# per deduped finding: set FINDING_*, call classify_one; then cap_pass ONCE. Ids in $CAPPED_IDS_FILE are capped NOTEs: skip them in 7E/7F.
```

If the guard printed `REVIEW_RESULT: status: BLOCKED` (`classifier unavailable` or `cap helper unavailable`), STOP: `exit 0` only ends that Bash block, so do not run 7E/7F or any later phase, file no issues, emit no deploy approval, and report `RESULT: BLOCK DEPLOY` with the blocker.

**Per-review cap** <!-- Added: forge#3642 -->: `cap_pass` (once, before 7E) runs `scripts/cap-findings.sh`: at most `review.max_filed_findings` ISSUEs (default 2) are kept, ranked by severity, confidence, safety domain. The overflow is a listed `NOTE capped` (counted in `notes_capped`, never filed or dropped); HIGH/CRITICAL are never capped.

Only `ISSUE` findings that are not in `CAPPED_IDS_FILE` continue to 7E/7F. Each `NOTE` is listed in the PR body (`## Non-blocking notes`, edit never replace) or dropped as a duplicate or nit; NOTEs are NEVER passed to `Skill(issue)`. Post one disposition record (counts only plus the NOTE list; every NOTE is recorded, never silently dropped), whenever 7A extracted at least one finding:

```bash
CLASSIFIER_MODE=script   # the 7B.5 guard blocks the review when the classifier is unresolvable, so this is always script
# This is a separate Bash call: shell state is lost. Re-derive PR_NUMBER and GH_REPO; counters the caller did not carry over are recomputed from the note list file (NOTES_LISTED) or flagged.
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
if [ -z "${PR_NUMBER:-}" ]; then
  echo "REVIEW_RESULT: status: BLOCKED, blocker: PR_NUMBER unavailable; FORGE:NOTE_DISPOSITION not posted (record lost)"
else
NOTE_LIST_FILE="${NOTE_LIST_FILE:-$_SD/${PR_NUMBER}_notes.md}"
[ -n "${NOTES_LISTED:-}" ] || { NOTES_LISTED=$(grep -v ': NOTE capped (' "$NOTE_LIST_FILE" 2>/dev/null | grep -c '^- ' || true); echo "WARNING: classification counters lost (fresh shell): notes_listed recomputed from $NOTE_LIST_FILE; set SCOPE_MODE, FINDINGS_FILED, OUT_OF_SCOPE, NOTES_REFLAG and NOTES_CAPPED from the 7B.5 block output before posting"; }
[ -n "${NOTES_CAPPED:-}" ] || NOTES_CAPPED=$(grep -c ': NOTE capped (' "$NOTE_LIST_FILE" 2>/dev/null || true)
[ -n "${SCOPE_MODE:-}" ] || { SCOPE_MODE=full; echo "WARNING: SCOPE_MODE lost (fresh shell): recording scope=full"; }
_DISP_BODY="$_SD/${PR_NUMBER}_note_disposition.md"
{ printf '%s\n' "<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=${NOTES_LISTED:-0} notes_dropped=${NOTES_DROPPED:-0} findings_filed=${FINDINGS_FILED:-0} out_of_scope=${OUT_OF_SCOPE:-0} notes_reflag=${NOTES_REFLAG:-0} notes_capped=${NOTES_CAPPED:-0} lineage=none classifier=${CLASSIFIER_MODE} scope=${SCOPE_MODE} -->"; cat "$NOTE_LIST_FILE" 2>/dev/null; } > "$_DISP_BODY"
gh pr comment "$PR_NUMBER" -R "$GH_REPO" --body-file "$_DISP_BODY" # allowlist:check-command-side-effects
fi
```

### 7C: Ensure Labels
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# Colors match the canonical ForgeDock label manifest (bin/labels.json).
# Run `npx forgedock labels setup` to bootstrap all managed labels at once.
gh label create "review-finding" --color "D93F0B" --description "Defect or improvement found during automated PR review. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null
gh label create "needs-validation" --color "FBCA04" --description "Review finding awaiting human validation. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null
gh label create "pre-existing" --color "BFD4F2" --description "Defect noticed during PR review that the PR did not introduce. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null
gh label create "staging-review" --color "1D76DB" --description "Finding from a staging branch review before deploy to main. Managed by ForgeDock." --force -R "$GH_REPO" 2>/dev/null
```

### 7D: Milestone & Code Branch Detection

Derive both `CODE_BRANCH` and `MILESTONE_FLAG` from the reviewed PR before creating any findings. Unlike `commands/review-pr.md` (feature-lane PRs with short-lived HEAD branches that get deleted post-merge — see the rationale comment on that spec's finding template), `review-pr-staging.md` reviews long-lived branches (`staging`, `milestone/*`) that persist after merge, so `CODE_BRANCH` uses `headRefName` (the PR's HEAD — the branch actually being reviewed), consistent with forge#1391's original fix. This replaces the previous hardcoded `staging` literal, which was silently wrong whenever this spec reviewed a `milestone/X → staging` PR instead of a `staging → main` PR — `CODE_BRANCH` used to always say `staging` even when the reviewed branch was `milestone/X`.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
CODE_BRANCH=$(gh pr view "$PR_NUMBER" -R "$GH_REPO" --json headRefName --jq '.headRefName')
MILESTONE_FLAG=""

# scripts/derive-finding-milestone.sh is the single source of truth for
# milestone derivation — commands/review-pr.md and commands/review-pr-staging.md
# both call it identically so the two specs cannot independently drift.
# <!-- forge#2443 -->
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
DERIVE_MILESTONE_SCRIPT=$(forge_resolve derive-finding-milestone.sh)
# Unresolved helper: empty milestone (non-blocking), never a cwd-relative fallback.
MILESTONE_TITLE=""
[ -n "$DERIVE_MILESTONE_SCRIPT" ] && MILESTONE_TITLE=$(bash "$DERIVE_MILESTONE_SCRIPT" "${PR_NUMBER}" -R "$GH_REPO")
# Quoted so multi-word milestone titles survive as a single value wherever
# MILESTONE_FLAG is later interpolated — matches the quoting convention already
# used for --title/--body-file/--label below.
[ -n "$MILESTONE_TITLE" ] && MILESTONE_FLAG="--milestone \"$MILESTONE_TITLE\""
```

Plain staging→main reviews resolve `CODE_BRANCH` to `staging` dynamically (same value as before, now derived rather than hardcoded) and typically resolve no milestone. A milestone→staging review resolves `CODE_BRANCH` to `milestone/X` and (via the shared script) the matching milestone.

### 7E: Deduplicate Against Existing Issues (BEFORE every filing)

Re-reviewing the same bundle must not re-file existing findings. For each `ISSUE` finding, check open AND closed `review-finding` issues by file + pattern + location before creating anything:

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
GH_FLAG="-R $GH_REPO"
# FINDING_FILE/FINDING_LINE come from the finding's structured block. Define the title and scratch dir BEFORE use (7F reuses them).
SCRATCHPAD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"; mkdir -p "$SCRATCHPAD"
STAGING_FINDING_TITLE="chore: ${FINDING_TITLE:-[summary]} (staging review — PR #${PR_NUMBER})"
EXISTING_ISSUE_EXCLUDE="${EXISTING_ISSUE_EXCLUDE:-}"   # optional comma-separated issue numbers already linked to this bundle
_SAFE_FILE=$(printf '%s' "$FINDING_FILE" | tr -d '"\\')
# issue-dedup.sh ships with ForgeDock next to classify-finding.sh (resolved in 7B.5, install-root only, never the repo under review).
DEDUP_SCRIPT=""; [ -n "${CLASSIFY_SCRIPT:-}" ] && [ -f "$(dirname "$CLASSIFY_SCRIPT")/issue-dedup.sh" ] && DEDUP_SCRIPT="$(dirname "$CLASSIFY_SCRIPT")/issue-dedup.sh"
if [ -n "$DEDUP_SCRIPT" ]; then
  DEDUP_OUT=$(bash "$DEDUP_SCRIPT" "${FINDING_TITLE:-$STAGING_FINDING_TITLE}" "$GH_FLAG" ${EXISTING_ISSUE_EXCLUDE:+--exclude "$EXISTING_ISSUE_EXCLUDE"} 2>&1)   # open issues, token match
  DEDUP_EXIT=$?
else
  DEDUP_EXIT=127   # dedup unavailable
fi
# The title token match alone is weak (any two findings share words like "staging" and "review" in the boilerplate, which is why only the finding's own
# title is matched above): an exit 1 is a duplicate ONLY when the matched open issue also cites this finding's file. Otherwise it is not a duplicate.
if [ "$DEDUP_EXIT" -eq 1 ]; then
  _DUP_N=$(printf '%s' "$DEDUP_OUT" | sed -n 's/^DUPLICATE: #\([0-9][0-9]*\).*/\1/p' | head -1)
  _DUP_BODY=$(gh issue view "${_DUP_N:-0}" -R "$GH_REPO" --json body --jq '.body' 2>/dev/null) || _DUP_BODY=""
  printf '%s' "$_DUP_BODY" | grep -qF -- "$_SAFE_FILE" || DEDUP_EXIT=0
fi
# Closed issues that cite this file at a line within +-5 of the finding. FINDING_FILE is finding content: strip quotes/backslashes so it cannot add search qualifiers.
_FILE_RE=$(printf '%s' "$_SAFE_FILE" | sed 's/[][\.^$*+?(){}|\/]/\\&/g')
REGRESSION_CHECK=ok; CLOSED_HIT=""
# Capture the gh read first and test its own status: through a pipe a failed read looks like "no closed hit".
_CL=$(gh issue list -R "$GH_REPO" --label review-finding --state closed --search "\"${_SAFE_FILE}\" in:body" --json number,title,body,stateReason --limit 100 2>/dev/null) || REGRESSION_CHECK=unavailable
# FINDING_LINE may be a range such as 12-15: use its first integer, and 0 when there is none.
_L=$(printf '%s' "${FINDING_LINE:-0}" | grep -oE '[0-9]+' | head -1); _L="${_L:-0}"
_HITS=""; [ "$REGRESSION_CHECK" = "ok" ] && { _HITS=$(printf '%s' "$_CL" | jq -r --arg re "$_FILE_RE" --argjson l "$_L" '.[] | select((.body // "") != "") | select(.stateReason != "NOT_PLANNED")
      | select([.body | scan($re + "[:#L]+([0-9]+)") | .[0] | tonumber | select((. - $l) <= 5 and ($l - .) <= 5)] | length > 0) | "#\(.number) \(.title)"') || REGRESSION_CHECK=unavailable; }
CLOSED_HIT=$(printf '%s\n' "$_HITS" | sed '/^$/d' | head -3)
# Confirm the 3+ shared title keywords against each hit before treating it as a regression.
```

- `DEDUP_EXIT=1` (open duplicate): skip creation, record `deduped: #N`. Exit `0` means no duplicate. Any other exit (usage error 2, script unavailable 126/127) means dedup is unavailable: record `dedup-unavailable` in the Phase 8 summary and file the finding normally (the `/issue` Phase 2D dedup remains as the second pass); a broken dedup helper must never suppress a finding, least of all a CRITICAL or HIGH. Pass `--exclude` for any issue already linked to this bundle.
- `REGRESSION_CHECK=unavailable` (the closed-issue read or its filter failed): record `regression-check-unavailable` in the Phase 8 summary; it never suppresses filing.
- `CLOSED_HIT` non-empty (closed issue, not closed as not-planned, at the same file with a location within +-5 lines and 3+ shared title keywords): potential regression: file it (it is not a duplicate of a fixed defect), elevate its priority one level, link the closed issue, and record it as `regression: #N`. A closed hit never suppresses a finding.
- Record every deduped item (finding id, matched issue) for the Phase 8 summary and audit.

### 7F: Create Issues
Sequential creation. Title: `Staging Review: {summary} (staging → main)`. Labels: review-finding, needs-validation, staging-review, priority:P0-P3 (derived from Severity — see below). Body includes: source branch context (`${CODE_BRANCH}`, derived in Phase 7D — not a hardcoded `staging` literal), code context, evidence, validation checklist.

**For each finding** (classified `ISSUE` in 7B.5 and not deduped in 7E), create issue through the `/issue` create-hook's programmatic invocation contract (see `commands/issue.md` § "Programmatic Invocation Contract") instead of calling the raw issue-creation command directly:
```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
# STAGING_FINDING_TITLE was built in 7E; re-assert it here if 7E was skipped.
STAGING_FINDING_TITLE="${STAGING_FINDING_TITLE:-chore: [summary] (staging review — PR #${PR_NUMBER})}"
# Defense-in-depth: /issue's arg tokenizer (commands/issue.md, forge#2094) uses
# an xargs-based tokenizer that never expands backtick/$(...) substitution, so
# this is no longer required for safety — but strip it anyway so the raw title
# stays readable if it round-trips through any other eval-based consumer.
STAGING_FINDING_TITLE=$(printf '%s' "$STAGING_FINDING_TITLE" | tr '`' "'" | sed 's/\$(/$ (/g')
SCRATCHPAD="${SCRATCHPAD:-${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}}"
REVIEW_AGENT_TOKEN="${AGENT_ID:-${HOSTNAME:-reviewer}-$$}"
mkdir -p "$SCRATCHPAD"
STAGING_FINDING_BODY_MARKER="FORGE:BODY-INTEGRITY:${PR_NUMBER}_staging-review_${REVIEW_AGENT_TOKEN}"
STAGING_FINDING_BODY_FILE=$(mktemp "$SCRATCHPAD/${PR_NUMBER}_staging-review_${REVIEW_AGENT_TOKEN}.XXXXXX.md")
cat <<'ISSUE_EOF' > "$STAGING_FINDING_BODY_FILE"
## Problem

[One sentence: what bug or issue was found. Where it occurs (`file:line`) and what it causes.]

**Source**: PR #[PR_NUMBER] — [TITLE]
**Confidence**: [CONFIRMED/LIKELY/POSSIBLE]
**Severity**: [CRITICAL/HIGH/MEDIUM/LOW]
**Review comment**: [permalink to agent comment]

## Affected Files

Files that need changes:
1. `[file:line]` — [what needs to change to fix this finding]

## Source Branch Context

**Code branch**: `[CODE_BRANCH]`
**Worktree base**: `origin/[CODE_BRANCH]`

> When fixing: `git worktree add ../fix-{slug} -b fix/{slug} origin/[CODE_BRANCH]`

## Code Context
[10 lines around finding]

## Evidence
[From agent comment]

## Acceptance Criteria

- [ ] Finding validated: VALIDATED / FALSE_POSITIVE / INCONCLUSIVE
- [ ] If VALIDATED: fix implemented and tested on correct branch
ISSUE_EOF
printf '\n<!-- %s -->\n' "$STAGING_FINDING_BODY_MARKER" >> "$STAGING_FINDING_BODY_FILE"

# STAGING_FINDING_SEVERITY is extracted from the finding's own **Severity**
# body field (set above in the heredoc) — example assignment shown here for
# clarity, same convention as STAGING_FINDING_TITLE etc.
STAGING_FINDING_SEVERITY="LOW"

# priority:* label is a deterministic function of the finding's **Severity**
# (CRITICAL/HIGH/MEDIUM/LOW) — NEVER of its Confidence
# (CONFIRMED/LIKELY/POSSIBLE). scripts/severity-to-priority.sh is the single
# source of truth for this mapping; commands/review-pr.md calls the identical
# script so the two specs cannot independently drift. <!-- forge#2447 -->
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
PRIORITY_SCRIPT=$(forge_resolve severity-to-priority.sh)
# Unresolved helper: non-zero status so finding creation is skipped (never defaulted to a priority).
if [ -n "$PRIORITY_SCRIPT" ]; then
  STAGING_FINDING_PRIORITY=$(bash "$PRIORITY_SCRIPT" "$STAGING_FINDING_SEVERITY")
  STAGING_FINDING_PRIORITY_EXIT=$?
else
  STAGING_FINDING_PRIORITY=""; STAGING_FINDING_PRIORITY_EXIT=127
fi

# Exit code MUST be checked before use — severity-to-priority.sh exits 1 (empty stdout)
# on a missing/unrecognized severity. Proceeding with an empty $STAGING_FINDING_PRIORITY
# would call Skill(issue, --label "") instead of aborting issue creation for this finding.
# Mirrors the identical check in commands/review-pr.md. <!-- forge#2479 -->
if [ "$STAGING_FINDING_PRIORITY_EXIT" -ne 0 ]; then
  echo "PRIORITY: severity-to-priority.sh failed (exit $STAGING_FINDING_PRIORITY_EXIT) for severity '$STAGING_FINDING_SEVERITY' — skipping finding issue creation"
  # Skip this finding — do NOT fall through to issue creation with an empty label
else

# --label is repeatable (not comma-joined) per the /issue programmatic contract.
# ${MILESTONE_FLAG} carries the Phase 7D derivation through — empty string is
# a no-op arg when the reviewed branch has no milestone (plain staging→main).
ISSUE_SKILL_OUTPUT=$(Skill(skill="{FORGE_SKILL_PREFIX}issue", args="--title \"$STAGING_FINDING_TITLE\" --body-file \"$STAGING_FINDING_BODY_FILE\" --label review-finding --label needs-validation --label staging-review --label \"$STAGING_FINDING_PRIORITY\" ${MILESTONE_FLAG}"))
# /issue re-reads the created issue and hard-fails unless this exact marker is present.
rm -f "$STAGING_FINDING_BODY_FILE"

# /issue succeeds only after its API create-token read-back (Phase 4B). Its
# explicit result marker distinguishes a verified create from an intentional
# dedup STOP; do not use title search to mask a swallowed 403.
ISSUE_NUM=$(printf '%s\n' "$ISSUE_SKILL_OUTPUT" | sed -n 's/.*ISSUE_CREATE_RESULT:CREATED number=\([0-9][0-9]*\).*/\1/p' | head -1)
DEDUP_NUMBER=$(printf '%s\n' "$ISSUE_SKILL_OUTPUT" | sed -n 's/.*ISSUE_CREATE_RESULT:DEDUP number=\([0-9][0-9]*\).*/\1/p' | head -1)
if [ -n "$DEDUP_NUMBER" ]; then
  ISSUE_NUM="$DEDUP_NUMBER"
  echo "Staging review finding deduped against existing issue #${ISSUE_NUM}."
elif [ -z "$ISSUE_NUM" ]; then
  echo "ERROR: /issue did not report a verified staging review-finding number; stopping review instead of silently dropping the finding." >&2
  exit 1
fi
fi
```

Labels: `review-finding` + `needs-validation` + `staging-review` + priority. `priority:*` is derived from the finding's `**Severity**` field via `scripts/severity-to-priority.sh` (identical script used by `commands/review-pr.md` — single documented mapping, see that script's header comment): `CRITICAL` → `priority:P0`, `HIGH` → `priority:P1`, `MEDIUM` → `priority:P2`, `LOW` → `priority:P3`. **Never derive `priority:*` from Confidence** (CONFIRMED/LIKELY/POSSIBLE) — conflating the two axes previously mislabeled LOW-severity CONFIRMED findings as `priority:P1`, defeating orchestrate's P3 batching rule. <!-- forge#2447 -->

**Filing disposition**: Filing follows §7B.5 and the `commands/review-pr.md` §6B.4/§6B.5 rules — LOW severity and POSSIBLE confidence findings are non-blocking NOTEs (recorded in `FORGE:NOTE_DISPOSITION`), not standalone issues. Only findings that are `ISSUE` after 7B.5 and not deduped in 7E become issues; NOTEs and duplicates are recorded, never silently dropped. Validation agents sort out false positives downstream for the findings that are filed.

### 7G: Add to Project Board
### 7H: Update PR Description with Findings Table

---

## Phase 8: Final Summary & Deployment Checklist

Post summary with verdict:
1. CI failed + autofix failed → BLOCK DEPLOY
2. CI failed + autofix succeeded → continue
2.5. Test gate returned BLOCK (blocking posture, no override) → BLOCK DEPLOY *(handled in Phase 6.5 — if Phase 8 is reached, BLOCK was either overridden or posture is advisory)*
3. CONFIRMED CRITICAL (non-CI) → BLOCK DEPLOY
4. CONFIRMED HIGH blocking (crashes, data loss) → NEEDS FIXES FIRST
5. All else → APPROVE FOR DEPLOY

Include in Finding Triage Results: `SCOPE_MODE`, `reviewed_prs`, `unreviewed_commits`, `cross_pr_files` counts (Phase 0B.1), `notes_fixed`/`notes_listed`/`notes_dropped`, `findings_filed`, `out_of_scope`, and the deduped list (7E). **Idempotency**: re-running the staging review on an unchanged bundle files 0 new findings (reviewed-set exclusion plus 7E dedup); a re-run that files anything must cite what changed in the bundle.

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
