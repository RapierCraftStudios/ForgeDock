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
4. **Dispatch pool exhausted or dispatch call fails**: this is not tool absence. If any Bug Hunter, quality, domain, material-change, or regression reviewer cannot be launched because the sub-agent pool/session limit is exhausted (or any dispatch call fails), HARD STOP. Do not substitute inline review or silently continue with a partial panel. Mark the PR `review-degraded`, post `<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->` with the selected and completed counts, and exit without a deploy verdict. A fresh session must re-run the full panel. **Disk-full carve-out**: if the failure text matches `EDQUOT`, `ENOSPC`, `No space left`, or `Disk quota exceeded` (errno -28/-122), it is a transient infrastructure failure, not a panel integrity failure: do NOT add `needs-human`, do NOT post `review-panel-integrity`, and do NOT mark `review-degraded`; exit with `REVIEW_RESULT: status: BLOCKED, blocker: infra disk full (EDQUOT/ENOSPC)` so the engine ends a retryable `engine-error` that `--retry` resumes once space is freed.

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

## Step 1: Pre-dispatch (`forgedock review-staging`)

**This step is MANDATORY and runs first. No step may be skipped.** One CLI call runs the deterministic pre-dispatch (forge#4358): the `FORGE:REVIEW_ROUTE` marker (route assertion and audit trail), prior-finding awareness on re-entry, the Phase 0A bundle PR set and open review-finding gate (it posts `FORGE:GATE_FAILURE` / `FORGE:GATE_PASS` and stops on a block, including degraded bundle panels), the 0B.1 bundle review scope (`scripts/review-staging-pre.sh`), the 0C prepare (`scripts/review-prepare.sh --no-delta --build-gate advisory`) and the risk-tiered roster (`scripts/review-roster.sh`, inside prepare). It writes one reviewer brief per roster domain and truncates the PR-keyed launched-agent file. All state lives in `$FORGE_SCRATCHPAD` (default `$PWD/.forge-scratch`) under the PR-keyed names the later steps read. Every helper comes from the ForgeDock install, never from the repo under review.

**Idempotent re-review (merge-train aware)**: <!-- Added: forge#1328, extended: forge#1332 --> This spec is safe to invoke multiple times on the same PR. Each invocation posts a new `FORGE:REVIEW_ROUTE` marker with the current SHA, so re-review passes are distinguished by SHA, not by PR number. Prior open findings are carried forward into the briefs (do not re-file them). Prior resolved findings are excluded from the verdict.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
# Resolve the PR ref from the argument string (never name the loader placeholder in this block: every
# occurrence is substituted textually, comments included) <!-- Added: forge#3466 -->
# The argument string may be: a PR number or PR URL, "staging", "feature", or "staging:feature" (no number: the open staging->default PR)
# Only the first token is the PR ref; later tokens are flags (--thorough, ...) <!-- allowlist:check-command-side-effects -->
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
if [ "$STAGING_ARGS_REJECTED" = true ]; then
  # Rejected string: stop. Never fall through to the open staging PR lookup or run later steps with no PR. <!-- Added: forge#3466 -->
  echo "review-pr-staging: rejected argument string - stopping (nothing reviewed, nothing posted)" >&2
  exit 1
fi
STAGING_THOROUGH=""; case " $STAGING_ARGS_RAW " in *" --thorough "*) STAGING_THOROUGH="--thorough" ;; esac
STAGING_DELTA=$(printf '%s\n' " $STAGING_ARGS_RAW " | sed -nE 's/.* --delta ([0-9a-f]{40}|[0-9a-f]{64}) .*/\1/p')   # forge#4360, hex only
# The CLI writes the run-keyed PR pointer later fences reload, so it must derive the same key as scripts/lib/fence-bootstrap.sh.
FORGE_RUN_KEY="${FORGE_RUN_KEY:-${FORGE_RUN_ID:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${OPENCODE_SESSION_ID:-$PPID}}}}}}"; FORGE_RUN_KEY=$(printf '%s' "$FORGE_RUN_KEY" | tr -c 'A-Za-z0-9_-' '_')
export FORGE_RUN_KEY
FD_ROOT=$(forge_resolve review-staging-post.sh); FD_ROOT="${FD_ROOT%/scripts/review-staging-post.sh}"   # install root, never the PR checkout
[ -n "$FD_ROOT" ] && [ -f "$FD_ROOT/bin/forgedock.mjs" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: the forgedock CLI is not resolvable (set FORGEDOCK_HOME to the ForgeDock install); nothing reviewed (fail closed)"; exit 1; }
node "$FD_ROOT/bin/forgedock.mjs" review-staging ${PR_ARG_NUM:+"$PR_ARG_NUM"} ${STAGING_THOROUGH:+"$STAGING_THOROUGH"} ${STAGING_DELTA:+--delta "$STAGING_DELTA"}
```

Exit 0 prints the manifest. `REVIEW_STAGING: PR #N head <sha>` gives the PR number and the full head SHA. `BUNDLE_PRS:` lists the bundle member PRs. `SCOPE_MODE=` gives the 0B.1 mode. `ROSTER:` gives the tier and reason (record them in the final summary). `CONTEXT_FILE=` names the 0C context. There is one `DISPATCH <domain> <brief file>` line per roster domain. Exit 1 is a stop: the gate printed `RESULT: BLOCK DEPLOY` (report the blocking finding list), or a `REVIEW_RESULT: status: BLOCKED` line names the blocker. Report it and do not continue. A PR with no gate comment at all indicates a gate bypass, not a clean pass.

**Delta pass** (forge#4360): after a fix lands on staging mid-review, re-run with `--delta <previous full head SHA>`. Only that range is reviewed, by the domains it touches (a `DELTA:` manifest line), and the earlier pass is credited. Dispatch only the DISPATCH lines.

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
# forgedock/verify (the lean engine's report-only gate summary) is not a code failure: ignored, as wait-ci-green.sh does.
# Fail closed: an unreadable result counts as failing.
CI_FAILING=$(gh pr checks "$PR_NUMBER" -R "$GH_REPO" --json name,bucket \
  --jq '[.[] | select(.name != "forgedock/verify") | select(.bucket == "fail" or .bucket == "cancel")] | length' 2>/dev/null || echo "1")
echo "CI_FAILING: $CI_FAILING"
```
`CI_FAILING` > 0 → BLOCK DEPLOY (unless autofixed in Phase 1F). A red `forgedock/verify` alone does not block.

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

**Launched-agent bookkeeping (MANDATORY)**: Step 1 truncated the PR-keyed launched-agent file. Before launching **every** Phase 2-6 reviewer (the DISPATCH briefs and the spec-owned panel), append its lowercase marker domain (for example `security`, `bug-hunter-api` or `regression-risk`) to that file: `printf '%s\n' "<domain>" >> "${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}/<PR>_launched_review_agents"`. Step 7A checks delivery for exactly these domains.

**Head SHA binding**: substitute `[REVIEW_SHA]` in every template below with the literal full head SHA from the manifest's `REVIEW_STAGING:` line before dispatch. The reviewer's post fence runs in a fresh shell, so it must never reference a shell variable and must never invent a value.

**Review scope (applies to Phases 2-6, from 0B.1)**: when `SCOPE_MODE=scoped`, pass every spec-panel agent `REVIEWED_COMMITS`, `UNREVIEWED_COMMITS`, `CROSS_PR_FILES` and `DEPLOY_WIRING_FILES` in its prompt (the DISPATCH briefs already carry them; the lists are in `$FORGE_SCRATCHPAD/<PR>_scope.json`). Line-level review is limited to `CROSS_PR_FILES`, the diffs of `UNREVIEWED_COMMITS`, and a runtime/deploy readiness checklist (required secrets and env vars present and documented, migration ordering and collisions, deploy wiring and workflow sibling drift). Agents report every finding they see, with its severity and file, whatever file or commit it lives in; a defect that lives only in an already-reviewed PR's files was visible to that PR's own review, so the 7B scope filter may demote it, but only when it is `MEDIUM`, `LOW` or `INFO`: a `CRITICAL` or `HIGH` finding is always reported and kept. Safety-domain agents (Security, Auth, Billing, Concurrency, Database) still read the whole diff of any in-scope file, not just the changed hunks. When `SCOPE_MODE=full`, review the full bundle diff. Report the scope used in the agent comment. <!-- Added: forge#3451 -->

Launch agent (model: {SUBAGENT_MODEL}) to analyze all commits since last deploy. Categorize as: NEW FEATURE, ENHANCEMENT, BUG FIX, REFACTOR, SECURITY, PERFORMANCE, INFRASTRUCTURE, DEPENDENCY. Separate user-facing vs internal. Document breaking changes and required pre-deploy actions.

Substitute `[REVIEW_SHA]` in the template below with the literal full head SHA from the manifest (see **Head SHA binding** above).

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

**Dispatch the briefs (MANDATORY)**: dispatch one isolated reviewer per `DISPATCH <domain> <brief file>` line of the Step 1 manifest, all in a single message. Each prompt is the brief file's content, verbatim. Step 1 already did the following, through the same template chain `/review-pr` Phase 3C uses:
- chose the risk-tiered domain panel (`scripts/review-roster.sh`) <!-- Added: forge#3599 -->;
- rendered each persona (`protocols.md` + persona) with its per-domain diff slice, PR number, short and full head SHA, marker domain, scope lists and prior findings.

A missing persona template BLOCKED Step 1. **NEVER perform the review inline as a substitute.** Agents never run a full `gh pr diff`; only `--name-only` is allowed. Run Step 1 with `--thorough` for the full union of domains.

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

**Purpose**: Verify the integrated bundle's acceptance criteria against running code before the deploy verdict. Catches runtime defects (cross-PR interactions, container/startup failures, regression in tested behaviour) that static review cannot surface. `/test-gate` files a `test-failure` issue for each failing cluster itself.

**Posture**: Controlled by `verification.test_gate.posture` in `forge.yaml`. Default: `blocking`. Set to `advisory` to surface failures without preventing deploy. A BLOCK is downgraded by a trusted PR comment starting with `verification.test_gate.override_phrase` (default `OVERRIDE: shipping with test failures —`). <!-- Added: forge#906 -->

Invoke `/test-gate` with the manifest's `BUNDLE_PRS` and the default branch. Save its **complete output** to `$FORGE_SCRATCHPAD/<PR>_test_gate_output.txt` (default `.forge-scratch/`), using the PR number from the manifest:

```
>>> INVOKE: Skill(skill="{FORGE_SKILL_PREFIX}test-gate", args="--prs \"<BUNDLE_PRS>\" --base <default branch>")
```

Do not judge the result yourself. Step 7A reads the output's last `FORGE:TEST_GATE:RESULT=` marker through `scripts/review-staging-post.sh test-gate`. A missing or invalid marker (gate result missing/invalid) is BLOCK, never SKIP (fail closed). The step then applies the override and the posture. It posts `FORGE:GATE_PASS` (PASS) or `FORGE:GATE_FAILURE` (blocking BLOCK, with `RESULT: BLOCK DEPLOY`), and persists the verdict for Phase 8.

**Incomplete-panel guard (MANDATORY):** Every reviewer selected in Phases 2–6 is appended to the launched-agent file before it is launched. If any dispatch fails, follow step 4 of Sub-Agent Dispatch Tool Resolution (hard stop). Before triage, step 7A counts unique trusted, current-head `FORGE:REVIEW-AGENT` markers. A marker counts only when all of these hold: the author is trusted per `scripts/trusted-comments.sh`, the body starts with the marker, the `Reviewed-SHA:` line matches the full head SHA, and the findings block is present. All comment pages are read. An unresolvable script or unreadable comments count as 0. If the completed count (`ACTUAL_AGENT_COUNT`) is lower than the selected count (`SELECTED_AGENT_COUNT`), the step labels the PR `review-degraded` and `needs-human`. It posts `FORGE:GATE_FAILURE:TYPE=review-panel-integrity` and stops. Do not create a deploy verdict from partial reviewer output.

---

## Phase 7: Finding Triage & Issue Creation

### 7A: Delivery, test gate, extract, classify and prepare (one CLI call)

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
[ -n "${PR_NUMBER:-}" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: PR_NUMBER unavailable after reload; nothing triaged (fail closed)"; exit 1; }
FD_ROOT=$(forge_resolve review-staging-post.sh); FD_ROOT="${FD_ROOT%/scripts/review-staging-post.sh}"   # install root, never the PR checkout
[ -n "$FD_ROOT" ] && [ -f "$FD_ROOT/bin/forgedock.mjs" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: the forgedock CLI is not resolvable (set FORGEDOCK_HOME to the ForgeDock install); nothing triaged (fail closed)"; exit 1; }
node "$FD_ROOT/bin/forgedock.mjs" review-staging "$PR_NUMBER" --finalize --test-gate-output "$_SD/${PR_NUMBER}_test_gate_output.txt" --notes-dropped "${NOTES_DROPPED:-0}"
```

The call runs these steps in order:
1. The incomplete-panel guard and Phase 6.75 delivery verification. A launched reviewer without a trusted current-head comment that carries a findings block is a delivery failure. An empty or unreadable launched-agent list also fails, and is never evidence that nothing needed verifying.
2. The Phase 6.5 verdict handling.
3. `scripts/review-finalize.sh`:
   - `extract`: trusted comments only, dedup, and the `commands/review-pr.md` §6B.4 provenance and concreteness gates. **CRITICAL/HIGH are never routed as pre-existing**, whatever their confidence.
   - `classify --dry-run`, then `classify` for real. This passes `--scope-files` (the 0B.1 scoped set when `SCOPE_MODE=scoped`) and `--prior-prs` (the bundle members), and posts `FORGE:NOTE_DISPOSITION`.
   - `file-prepare`.

Findings come only from `FINDING:` markers, never from free text. **Exit 1 is a stop**: a `REVIEW DELIVERY FAILURE`, `RESULT: BLOCK DEPLOY` or `REVIEW_RESULT: status: BLOCKED` line names the cause. File nothing and emit no deploy approval. On a delivery failure, re-dispatch each missing reviewer once with the note "structured findings block required". A second miss is a degraded panel. Then rerun 7A.

Exit 0 prints the following:
- `TEST_GATE:`, `SCOPE_MODE=`.
- The counters (`FINDINGS_KEPT`, `FINDINGS_DROPPED_STALE`, `FINDINGS_PREEXISTING`, `NOTES_DEMOTED_NO_SCENARIO`, `FINDINGS_FILED`, `NOTES_LISTED`, `NOTES_CAPPED`, `NOTES_REFLAG`, `OUT_OF_SCOPE`).
- `CODE_BRANCH=`.
- One `NOTE` line per NOTE.
- One `SKIP` line per covered or unfilable worklist item (recorded in the Phase 8 summary).
- One `FILE <item json>` line per finding to file.

### 7B: Note disposition (same damper and classifier as `/review-pr` §6B.5)

`classify` runs `scripts/classify-finding.sh` and `scripts/cap-findings.sh`. Never hand-classify. HIGH and CRITICAL findings are always ISSUEs. Under `SCOPE_MODE=scoped`, a MEDIUM, LOW or INFO finding whose cited files are all outside the 0B.1 set becomes `NOTE out_of_scope`. A finding a bundle member PR's review already covered becomes `NOTE reflag-*`. At most `review.max_filed_findings` ISSUEs are filed (default 2); the overflow becomes `NOTE capped`. Give each `NOTE` line one disposition: list it in the PR body under `## Non-blocking notes` (edit, never replace), or drop it as a duplicate or nit. NOTEs never reach the filing call.

### 7C: Create issues

`file-prepare` already did every pre-filing step for each `FILE` item:
- managed labels and the milestone;
- title and line-range dedup;
- regression elevation;
- `priority:*` from `**Severity**` only;
- the pattern recurrence check.

Each item carries `title`, `labels` (with `priority:*`), `milestone`, `batchable`, `regression_of`, `file`, `line`, `severity`, `agent` and `pattern`. Pattern consolidation follows `commands/review-pr.md` §6C. The code branch is the printed `CODE_BRANCH` (the PR's `headRefName`). **For each `FILE` item**, write the issue body, then create the issue through the `/issue` programmatic invocation contract (`commands/issue.md` § "Programmatic Invocation Contract"), never the raw issue-creation command:

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

## Phase 8: Final Summary & Gate Marker (one CLI call)

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
. "$(forge_resolve lib/fence-bootstrap.sh)" || { echo "BLOCKED: ForgeDock helper lib/fence-bootstrap.sh not resolvable"; exit 1; }   # FENCE_BOOTSTRAP
[ -n "${PR_NUMBER:-}" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: PR_NUMBER unavailable after reload; no verdict (fail closed)"; exit 1; }
FD_ROOT=$(forge_resolve review-staging-post.sh); FD_ROOT="${FD_ROOT%/scripts/review-staging-post.sh}"   # install root, never the PR checkout
[ -n "$FD_ROOT" ] && [ -f "$FD_ROOT/bin/forgedock.mjs" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: the forgedock CLI is not resolvable (set FORGEDOCK_HOME to the ForgeDock install); no verdict (fail closed)"; exit 1; }
FILED_ARGS=""; for _n in ${FILED_ISSUES:-}; do case "$_n" in *[!0-9]*|"") ;; *) FILED_ARGS="$FILED_ARGS --filed $_n" ;; esac; done   # the ISSUE_NUM values file-verify printed
# shellcheck disable=SC2086  # FILED_ARGS is a validated list of flags
node "$FD_ROOT/bin/forgedock.mjs" review-staging "$PR_NUMBER" --summary $FILED_ARGS
```

Set `FILED_ISSUES` to the space-separated `ISSUE_NUM` values from 7C. The call computes the verdict:
1. CI failing (the Phase 1E read; a red `forgedock/verify` alone does not count, and an unreadable result counts as failing) → BLOCK DEPLOY. A CI fixed by the 1F autofix is green again by now.
2. A missing or invalid persisted test-gate verdict → BLOCK DEPLOY. A blocking BLOCK already stopped in 7A, so a BLOCK seen here was either overridden or advisory.
3. A CONFIRMED CRITICAL → BLOCK DEPLOY.
4. A CONFIRMED HIGH → NEEDS FIXES FIRST.
5. All else → APPROVE FOR DEPLOY.

It posts one summary comment holding the following:
- The Risk Matrix. It includes CI, the findings counts and the **Test Gate** row. A SKIP is surfaced explicitly as a gap: acceptance criteria were not verified against running code.
- The Finding Triage Results: `SCOPE_MODE`, `reviewed_prs`, `unreviewed_commits`, `cross_pr_files`, `notes_listed`/`notes_dropped`/`notes_capped`, `findings_filed` with the filed issues, `out_of_scope`, and the deduped list.
- The fail-soft pipeline cost (`scripts/cost-report.sh`) and stats (`forgedock stats --compact`) tables. These are informational and never change the verdict.
- **Exactly one gate marker kind**: `<!-- FORGE:GATE_PASS -->` on APPROVE FOR DEPLOY, `<!-- FORGE:GATE_FAILURE -->` otherwise, each with a `TYPE=staging-review|BUNDLE=...` line.

The call exits 0 on APPROVE FOR DEPLOY and 1 otherwise (`RESULT: BLOCK DEPLOY`). A head that moved since 7A is a stop: re-run the review. **Idempotency**: re-running the staging review on an unchanged bundle files 0 new findings (reviewed-set exclusion plus dedup). A re-run that files anything must cite what changed in the bundle. In your final report, add the Material Changes Summary (Phase 2), the per-domain reviewer verdicts, Blocking Issues and the Deployment Checklist: pre-deploy, deploy, post-deploy verification and rollback triggers.

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
