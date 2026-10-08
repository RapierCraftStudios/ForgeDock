---
description: Pick up a GitHub issue and run the full investigate-build-review-merge pipeline
argument-hint: "[issue number or \"next\" to pick highest priority]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on — Full Issue Pipeline

**Input**: $ARGUMENTS

Orchestrator for the full issue lifecycle: investigate → decompose (if needed) → build → review → merge → close. GitHub issues are the persistent context layer — read existing comments before starting, write structured reports back, use `workflow:*` labels to track state.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — this spec uses `Skill(...)` for sub-phase dispatch. The Agent tool spawns opaque subprocesses that bypass phase protocols, skip FORGE annotations, and cannot be constrained by allowed-tools. Always use `Skill(skill="...", args="...")` for sub-phase invocations.

<!-- FORGE:SPEC_LOADED — work-on.md loaded and active. Agent is bound by this spec. -->

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **This file is a router. Every phase runs as a forked sub-skill via `Skill(...)`; the router never executes phase logic itself.** Each phase sub-skill (`work-on:investigate`, `work-on:decompose`, `work-on:build`, `work-on:review`, `work-on:close`, `work-on:remediate`) declares `context: fork`, so Claude Code runs it in an isolated sub-agent context that holds only that phase's spec and the args you pass. The phase re-reads everything else from GitHub/git and returns exactly one `*_RESULT:` block — that block is all the router sees. Do not read phase spec files, do not re-implement a phase step here, and do not "help" a phase by posting its markers or labels. If a skill name does not resolve, STOP with "skill not found" (see Skill Name Resolution) — never run a phase inline.

1a. **Dispatching phases are invoked only by this router.** `work-on:review` and `work-on:remediate` spawn sub-agents (the `/review-pr` domain reviewers), and Claude Code only grants the `Agent` tool down to a fixed depth (see Depth Budget). Invoking them from here keeps them one level below the router, where `Agent` works. No phase may invoke them; a phase that needs one returns `status: NEXT` with `next: <phase>`, and the router runs it (Phase 4R). Non-dispatching phases may nest forks freely. <!-- forge#3398 -->

2. **Route only on `*_RESULT` blocks and GitHub state.** After each phase returns, apply the routing table for that phase (below). Never infer success from a phase's prose; never continue past a `BLOCKED`/`FAILED` result.

3. **Follow the Phase Dispatcher.** Do not skip, reorder, or treat an intermediate completion as terminal. Only the terminal states listed in the Dispatcher allow stopping. Between phases: no narration, no summary, no end of turn — invoke the next phase immediately.

3a. **Phase calls run synchronously to completion in your own turn.** Every phase sub-skill declares `background: false`, so its `Skill(...)` call returns its `*_RESULT:` block in your turn (a forked skill without it runs in the background and reports to the root session instead). Every phase `Skill(...)` call is consumed by you, in the turn that issued it. Never end or yield your turn, narrate that you are waiting, or "wait for the notification" — completion notifications for forked phases are delivered to the root session, never to this worker, so a turn that ends while a phase is pending is never resumed. A non-final, "running", backgrounded or empty return that carries no `*_RESULT:` block is not a phase result: re-read the issue's labels and `FORGE:*` markers on GitHub (consume a present marker instead of re-invoking), then re-invoke the router or the same phase at most 2 times per phase. After the cap, stop with BLOCKED / the existing GATE_FAILURE path (needs-human via the existing exit) using `child-stalled: <phase>`; a build `BLOCKED` with `child-stalled:` is terminal and is not re-invoked. While the issue is non-terminal, keep working until a terminal state is reached.

4. **PRs NEVER target `main`.** Target `staging` (fast lane) or `milestone/{slug}` (feature lane). The router computes and validates the target (Lane Resolution) and passes it to the phases as `--base`.

5. **`needs-human` is for genuine decisions and external actions only.** A phase that can fix its own problem (failing checks, review findings, a moved PR head, a missing marker it can produce) does so inside its own fork; the router never adds `needs-human` for a condition a phase reported as fixable.

### Skill Name Resolution (`{FORGE_SKILL_PREFIX}`)

ForgeDock skills register under different names per install:

| Runtime / install | `{FORGE_SKILL_PREFIX}` | Nesting separator | `work-on` / `work-on` + `build` |
|---|---|---|---|
| Claude Code plugin | `forgedock:` | `:` | `forgedock:work-on` / `forgedock:work-on:build` |
| Claude Code `install.sh` symlinks (`~/.claude/commands/work-on/build.md`) | empty | `:` | `work-on` / `work-on:build` |
| Codex (`install-codex.sh`) | `forge-` | `-` | `forge-work-on` / `forge-work-on-build` |
| OpenCode (`forgedock opencode install`) | empty | `-` | `work-on` / `work-on-build` |

Every `Skill(skill="...")` call to a ForgeDock skill (any command under `commands/`: `work-on*`, `review-pr*`, `quality-gate`, `issue`, `orchestrate`, `cleanup`, `deploy-pr`, etc.) is written `{FORGE_SKILL_PREFIX}<name>`, with `:` between nesting levels as the canonical spelling. Resolve the prefix AND the nesting separator ONCE per run, before the first Skill dispatch. Substitute the prefix literally; when the separator is `-`, also rewrite every `:` nesting level in the name to `-` (`{FORGE_SKILL_PREFIX}work-on:build` becomes `forge-work-on-build`). Apply the result to every call and every sub-agent prompt:

1. If env `FORGE_SKILL_NAMESPACE` is set: `forgedock` → prefix `forgedock:`, separator `:`; `none` → empty prefix, separator `:`; `codex` → prefix `forge-`, separator `-`; `opencode` → empty prefix, separator `-`. Any other value is an error.
2. Else if env `FORGE_RUNTIME` is `codex` or `opencode`, use that runtime's row above.
3. Else read the available-skills list: if it contains `forgedock:work-on` → `forgedock:`/`:`; else if it contains `forge-work-on` → `forge-`/`-`; else if it contains `work-on:build` → empty/`:`; else if it contains `work-on-build` → empty/`-`; else if it contains `work-on` → empty/`:`.
4. If none of these resolves, or a later `Skill(...)` call reports the resolved name unknown, this is a **HARD ERROR**: STOP and report "skill not found: <name>" (post a `needs-human` comment when running against an issue). NEVER fall back to running the phase inline or via the Agent tool — an inline phase has no paper trail.

A sub-agent that receives no resolved value applies the same rule itself.

### Compaction Resilience

1. Every phase writes its state to GitHub (FORGE annotations + `workflow:*` labels) before returning.
2. The router keeps only small routing values in context: `NUMBER`, `GH_REPO`, `GH_FLAG`, `PR_BASE`, `CLASSIFIED_LANE`, `BRANCH`, `WORKTREE_PATH`, `PR_NUMBER`, `UNDER_ORCHESTRATION`. Phase results carry the rest.
3. After a compaction (or in a new session), re-run Phase 0: it reconstructs the resume point from GitHub state alone, and every phase is idempotent (each starts with its own resume check).
4. **Shell state does not persist between Bash tool calls.** Any bash snippet below that uses `resolve_script`/`FORGE_ROOT` must include the Script resolution block from Phase 0 in the same command; substitute `{PLACEHOLDER}` values literally.

### Orchestration Flag

`UNDER_ORCHESTRATION` — resolved once in Phase 0A. Defaults to `false` (solo run). Set to `true` when the invocation args include `--under-orchestration` (this is how `/orchestrate` dispatches `/work-on`; see `commands/orchestrate/phase-4-execution.md`). This flag gates the phase-entry heartbeat comments posted by the router (Phases 1, 3 and 5 below, plus Phase 0A.5); solo runs skip them.

### Phase Dispatcher

<!-- FORGE:DISPATCHER — This is the SINGLE source of truth for phase transitions. -->

| Step | Phase | Skill (forked) | Entry condition |
|------|-------|----------------|-----------------|
| 0 | Resolve & resume | — (router) | Always first |
| 1 | Investigate | `work-on:investigate` | No `FORGE:INVESTIGATOR` comment containing `INVESTIGATION:COMPLETE` or `INVESTIGATION:INVALID` |
| 2 | Decompose | `work-on:decompose` | `INVESTIGATE_RESULT.decompose: YES` (or resume: investigation says decompose YES and no `FORGE:DECOMPOSED`) |
| 3 | Build | `work-on:build` | Investigation complete, decompose NO, no `FORGE:BUILDER:COMPLETE` |
| 4 | Review (push, PR, review, merge) | `work-on:review` | `FORGE:BUILDER:COMPLETE` present and PR not merged |
| 4R | Remediation handoff | `work-on:remediate` | `REVIEW_RESULT: status: NEXT, next: remediate` (CI gate red or in-PR fix requested) |
| 5 | Close & trajectory | `work-on:close` | PR merged, or a PR-less terminal outcome (investigation deliverables, decomposed, invalid) |

**Terminal states** (only these allow stopping): `workflow:merged` with the issue closed; `workflow:invalid`; `workflow:decomposed` (sub-issues own the work); `needs-human`; `workflow:awaiting-merge` (held for a human merge decision on the deploy gate); a `CLOSE_RESULT` with `status: COMPLETE | ALREADY_DONE`. Anything else → run the next phase immediately.

---

## Spawn-Decision Policy

<!-- FORGE:SPAWN_POLICY — Canonical spawn-decision table. Sibling specs (orchestrate.md, review-pr.md) link to this section. -->

**Phases are forked by declaration, not by judgement.** Every `/work-on` phase sub-skill declares `context: fork` in its frontmatter, so each phase (and each build child: context, architect, implement, validate, and the quality gate) runs in its own isolated context with only its own spec loaded. This replaces the former "default inline" rule and its Row (c)/(d) exceptions: phase-at-a-time spec delivery is what keeps every worker's context small and its instructions unambiguous (field evidence: inline delivery put 230k–360k tokens of overlapping spec into each orchestrated worker and produced phase shortcuts).

`Agent(...)` sub-agents remain the mechanism for work that is not a phase:

| Row | Criterion | Example |
|-----|-----------|---------|
| a | **Parallel fan-out** — independent work units run concurrently | `/orchestrate` dispatching one `/work-on` worker per issue; `review-pr` dispatching domain reviewers |
| b | **Fresh-context isolation for a load-bearing review** | `review-pr` domain reviewers (they must not see the builder's reasoning) |

### Depth Budget

Layers are counted below the main conversation (layer 0). Claude Code grants the `Agent` tool down to `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` layers (default 3 since 2.1.219): **a sub-agent at layer 1 or 2 can spawn, one at layer 3 cannot**. A `context: fork` skill always runs at any depth, but it gets `Agent` only by the same rule (measured on 2.1.294, forge#3398). Full rationale: `docs/WORK-ON-RUNTIME.md`.

| Layer (solo / orchestrated) | Runs here | Spawns sub-agents |
|-----------------------------|-----------|-------------------|
| 0 / 0 | solo `/work-on` router / `/orchestrate` | orchestrate: one worker per issue |
| — / 1 | `/work-on` router (orchestrated worker) | no (`Skill` only) |
| 1 / 2 | every phase invoked by the router, including `work-on:review` and `work-on:remediate` | review/remediate: `/review-pr` domain reviewers |
| 2 / 3 | domain reviewers (leaves); build children (context, architect, implement, validate) | no |
| 3 / 4 | quality gate (inside validate or review) | no |

The only layer constraint that matters is the spawner: `work-on:review` and `work-on:remediate` must sit at layer ≤ 2, which Hard Rule 1a guarantees. The Phase 0A spawn-depth preflight checks the effective depth before any work starts.

### Model and Effort Tiering — What Actually Applies

<!-- FORGE:MODEL_TIER_NOTE — Canonical explanation of the real vs. aspirational tiering mechanism. Every work-on/*.md "Agent model policy" line cross-references this section instead of restating it. -->

Every `work-on/*.md` phase file carries an "Agent model policy" line naming a `model` and an `effort`. Phase files now run with `context: fork` (an isolated sub-agent per phase), so the line documents the intended tier for that phase. `effort` applies per invocation on Claude Code >= 2.1.154. A `model` value only takes effect where the runtime honours it for a forked skill or an `Agent(model=...)` dispatch; otherwise the phase runs on the session's model. Mechanical work (labels, annotations, heartbeats) lives in the same phase file as the reasoning it belongs to, so no separate tiering split is needed.

---

## Pipeline Rules

- **NEVER merge to main.** PRs target `staging` (fast lane) or `milestone/{slug}` (feature lane).
- **`Closes #N` does not auto-close for non-default-branch PRs.** You MUST explicitly `gh issue close`.
- **Review findings are NOT merge blockers.** They become separate issues.

---

## Project Configuration

Read `forge.yaml` from the repository root before processing any issue.

If `forge.yaml` is missing: stop and tell the user to run `npx forgedock init` to generate it.

**Resolve these values from `forge.yaml`**:

| Variable | Source field | Notes |
|----------|-------------|-------|
| `GH_REPO` | `project.owner` + `/` + `project.repo` | e.g. `acme-org/acme-platform` |
| `GH_FLAG` | `-R {GH_REPO}` | Passed to all `gh` commands |
| `REPO_PATH` | `paths.root` | Absolute path to repo root |
| `WORKTREE_BASE` | `paths.worktree_base` | Base dir for git worktrees |
| `STAGING_BRANCH` | `branches.staging` | Fast-lane PR target |
| `PROJECT_BOARD_OWNER` | `project_board.owner` (or `project.owner` as fallback) | For `gh project` commands |
| `PROJECT_BOARD_NUMBER` | `project_board.project_number` (or `1` as fallback) | Project number in `gh project` commands |

**Multi-repo routing** (when `forge.yaml → repos` section is present):

Parse issue input for a prefix (`<prefix>:<number>`). Look up `<prefix>` in `forge.yaml → repos.satellites[]`. Use that satellite's `repo` and `staging_branch` as `GH_REPO` and `STAGING_BRANCH`. If no prefix is given, use the default (`project.owner/project.repo`).

If `forge.yaml → repos` is absent, only the default repo is available — prefixed issue numbers are invalid.

Satellite repos (those without a `staging` branch) receive fast-lane PRs directly to `main`.

---

## Phase 0: Resolve Issue & Load Context

### 0.0: Pre-Flight Checks (MANDATORY — run before any other Phase 0 step)

Validate the environment before the pipeline spends tokens. Each check fails fast with an actionable error and a pointer to the troubleshooting guide (`docs/site/troubleshooting.md`). Run all checks; report every failure, then STOP if any HARD check fails. <!-- Added: forge#1149 -->

```bash
PREFLIGHT_FAILED=0

# Check 1 — forge.yaml present (HARD)
if [ ! -f forge.yaml ]; then
  echo "ERROR: forge.yaml not found in the repository root."
  echo "  Fix: run \`npx forgedock init\` to generate one, or copy forge.yaml.example."
  echo "  See: docs/site/troubleshooting.md#1-forgeyaml-not-found"
  PREFLIGHT_FAILED=1
fi

# Check 2 — yq installed; forge.yaml is valid YAML (HARD, only if present)
if [ -f forge.yaml ]; then
  if ! command -v yq >/dev/null 2>&1; then
    echo "ERROR: yq is not installed. The pipeline requires yq to parse forge.yaml."
    echo "  Fix: install yq — https://github.com/mikefarah/yq#install"
    echo "  See: docs/site/troubleshooting.md#2-forgeyaml-has-a-syntax-error"
    PREFLIGHT_FAILED=1
  elif ! yq '.' forge.yaml >/dev/null 2>&1; then
    echo "ERROR: forge.yaml has a YAML syntax error."
    echo "  Fix: run \`yq '.' forge.yaml\` to locate the offending line, then correct the indentation/quoting."
    echo "  See: docs/site/troubleshooting.md#2-forgeyaml-has-a-syntax-error"
    PREFLIGHT_FAILED=1
  fi
fi

# Check 3 — gh CLI authenticated (HARD)
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh CLI is not authenticated. The pipeline cannot read or write GitHub state."
  echo "  Fix: run \`gh auth login\` (ensure repo scope), then \`gh auth status\` to confirm."
  echo "  See: docs/site/troubleshooting.md#3-gh-cli-not-authenticated"
  PREFLIGHT_FAILED=1
fi

# Check 4 — workflow labels exist on the repo (SOFT — warn, auto-recoverable)
if [ -f forge.yaml ] && gh auth status >/dev/null 2>&1; then
  GH_REPO_PF="$(yq -r '.project.owner + "/" + .project.repo' forge.yaml 2>/dev/null)"
  if [ -n "$GH_REPO_PF" ] && ! gh label list -R "$GH_REPO_PF" --search "workflow:" 2>/dev/null | grep -q "workflow:"; then
    echo "WARNING: ForgeDock workflow:* labels not found on $GH_REPO_PF."
    echo "  Fix: run \`npx forgedock labels setup\` (or \`--repo $GH_REPO_PF\`) to bootstrap them."
    echo "  See: docs/site/troubleshooting.md#9-missing-workflow-labels"
  fi
fi

# Check 5 — GitHub API rate limit headroom (SOFT — warn)
if gh auth status >/dev/null 2>&1; then
  RL_REMAINING="$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo '')"
  if [ -n "$RL_REMAINING" ] && [ "$RL_REMAINING" -lt 100 ] 2>/dev/null; then
    RL_RESET="$(gh api rate_limit --jq '.resources.core.reset' 2>/dev/null)"
    echo "WARNING: GitHub API rate limit low ($RL_REMAINING remaining; resets at epoch $RL_RESET)."
    echo "  Fix: wait for the reset, reduce orchestration parallelism, or use a higher-limit PAT."
    echo "  See: docs/site/troubleshooting.md#10-github-api-rate-limit-exceeded"
  fi
fi

if [ "$PREFLIGHT_FAILED" -eq 1 ]; then
  echo "Pre-flight checks failed. Resolve the errors above and re-run /work-on {NUMBER}."
  echo "Full recovery guide: docs/site/troubleshooting.md"
  exit 1
fi
```

Worktree/branch-already-exists and stale-label conditions are surfaced later (by the build phase's worktree step and the `## Error Handling` section) with their own recovery guidance in `docs/site/troubleshooting.md`.

### 0A: Parse input
Extract project prefix and issue number. If `next`/`pick`: list open issues sorted by priority, skip `needs-human`, `workflow:decomposed`, and `workflow:awaiting-merge`, pick highest priority.

**Resolve `UNDER_ORCHESTRATION`**: `true` if the invocation args contain `--under-orchestration`, else `false`. This is a single parse done once, here — every later gated block (heartbeats) just checks this variable, no re-parsing.

**Spawn-depth preflight (before 0A.1 and before any GitHub write)** <!-- forge#3398 -->: confirm the dispatching phases will have the `Agent` tool (Depth Budget). The router runs at layer 1 under `/orchestrate`, else layer 0. The block is self-contained (it carries the canonical `FORGE_ROOT` bootstrap).

```bash
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
_v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ -v mk="$_mk" '$(NF-2)==mk && $(NF-1)=="forgedock" && $NF ~ /^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$/{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$(0)}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5- || true)"
_m="$HOME/.claude/plugins/marketplaces/$_mk"
# '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
_k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_x" "$_v" "$_m")"
while IFS= read -r _c; do
case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
done <<< "$_k"
fi
ROUTER_LAYER=0; [ "$UNDER_ORCHESTRATION" = "true" ] && ROUTER_LAYER=1
if [ -n "$FORGE_ROOT" ] && [ -f "$FORGE_ROOT/scripts/spawn-depth-check.sh" ]; then
  DEPTH_OUT=$(bash "$FORGE_ROOT/scripts/spawn-depth-check.sh" --router-layer "$ROUTER_LAYER"); DEPTH_RC=$?
else
  DEPTH_OUT="SPAWN_DEPTH: UNKNOWN (spawn-depth-check.sh not resolvable)"; DEPTH_RC=0
fi
echo "$DEPTH_OUT"
```

`DEPTH_RC=0` (`OK`, `SKIP`, `UNKNOWN`) or `2` (usage error — treat as `UNKNOWN`): continue. `DEPTH_RC=1` (`FAIL`): the review phase could not spawn reviewers, so nothing built now could be reviewed. When an issue number is known, post `DEPTH_OUT` as a comment with `<!-- FORGE:GATE_FAILURE:TYPE=spawn-depth -->` and add `needs-human` (raising `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is an operator action). STOP either way.

**Resolve `RECOVERY_SWEEP_ID`**: the value after `--recovery-sweep` in the invocation args, else empty (consumed by 0A.4; only `/recover-orphans` passes it).

**Optional pre-flight**: Before committing to the full pipeline, run `/scope {NUMBER}` to get a complexity estimate (affected files, blast radius, risk flags, and decomposition recommendation). Especially useful for large or ambiguous issues.

### 0A.1: Remediation Mode Detection (`--remediate`) <!-- Added: forge#1813 -->

**Engine coverage** (forge#2379): `remediate` is now a registered phase in the headless engine's phase table (`packages/protocol/src/phases.js`, `bin/engine/phases.mjs`) — see `commands/work-on/remediate.md`'s own "Engine coverage" note for the current, documented limitation (a single continuous headless `runIssue()` walk cannot yet reach it; this prose-layer standalone-invocation path below remains the only way `remediate` actually runs today).

**Check first, before any other Phase 0 routing** — if `$ARGUMENTS` contains `--remediate`, this is NOT a normal issue-pipeline invocation. The first positional argument is a **PR number**, not an issue number:

```bash
if echo "$ARGUMENTS" | grep -qE -- '--remediate\b'; then
  REMEDIATE_PR_NUMBER=$(echo "$ARGUMENTS" | sed -n 's/^[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
  REMEDIATE_ISSUE_FLAG=""
  REMEDIATE_ISSUE_NUMBER=$(echo "$ARGUMENTS" | sed -n 's/.*--issue[[:space:]][[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
  [ -n "$REMEDIATE_ISSUE_NUMBER" ] && REMEDIATE_ISSUE_FLAG="--issue ${REMEDIATE_ISSUE_NUMBER}"

  if [ -z "$REMEDIATE_PR_NUMBER" ]; then
    echo "ERROR: --remediate requires a PR number as the first argument, e.g. /work-on 1234 --remediate"
    exit 1
  fi

  echo "Remediation mode: routing PR #${REMEDIATE_PR_NUMBER} to work-on/remediate (issue flag: ${REMEDIATE_ISSUE_FLAG:-<resolved from PR body>})"
fi
```

If detected, dispatch immediately and STOP — do NOT fall through to Phase 0B's normal issue-number resume logic (an issue number is not even known yet; `work-on/remediate.md` Phase M0 resolves it):

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:remediate", args="${REMEDIATE_PR_NUMBER} ${REMEDIATE_ISSUE_FLAG} --repo {GH_REPO} --gh-flag {GH_FLAG}")
```

**If `REMEDIATE_RESULT: status: REREVIEW_REQUIRED`** (forge#3240, fallback only since forge#3398: fix pushed, but remediation had no sub-agent dispatch tool, which cannot happen when the Phase 0A spawn-depth preflight passed and remediation is invoked from this router): run the re-review from this top-level session, which has dispatch — `Skill(skill="{FORGE_SKILL_PREFIX}review-pr", args="${REMEDIATE_PR_NUMBER} --auto-merge --issue ${ISSUE} --base ${PR_BASE} --gh-flag {GH_FLAG}")` (`ISSUE` and `PR_BASE` from the result and the PR) — never review inline. If it returns `REVIEW_RESULT: status: COMPLETE` (merged), invoke `Skill("{FORGE_SKILL_PREFIX}work-on:close", ...)` as remediate M8 does for `AUTO-LANDED`. If the `review-pr` skill does not resolve, cannot dispatch, or returns anything other than `REVIEW_RESULT: status: COMPLETE` while the issue is still at `workflow:in-review` with no `needs-human` (no state anything will advance), apply the **terminal fallback**. Single attempt: no retry loop, no polling. Then STOP. <!-- Added: forge#3406 -->

**Terminal fallback** (canonical definition; Phase 4R and `commands/orchestrate/phase-4-execution.md` item 6.4 reference it, so the review and remediate paths share one): a re-review that cannot run must never leave the issue at `workflow:in-review` with nothing to advance it. Post a comment naming the PR and the reason (e.g. `review-pr could not be dispatched: <reason>`), then in ONE `gh issue edit` add `needs-human` and remove `workflow:in-review` (never one without the other), and re-read the labels to verify the write. If the label write failed, report that failure as the outcome instead of treating the fallback as done. Never review inline, and never re-nest remediation to retry.

**After `REMEDIATE_RESULT` returns (any other status), STOP unconditionally** — do not run any further Phase 0–7 logic in this file. `work-on/remediate.md` is self-contained: a FIXABLE remediation replaces `needs-human` with the active `workflow:in-review` state only while it is running, then ends at `workflow:merged`, `workflow:awaiting-merge`, or a newly asserted `needs-human` label. When `re_gate_outcome: AUTO-LANDED`, it drives its own close phase internally (Phase M8 invokes `Skill("{FORGE_SKILL_PREFIX}work-on:close", ...)` directly) before returning. For every other outcome (`HELD-AWAITING-MERGE`, `RE-ESCALATED`, `UNFIXABLE`, `BLOCKED`, `ALREADY_DONE`), the issue is already at a terminal state (`workflow:awaiting-merge` or `needs-human`, or already closed) per the Universal Phase Dispatcher — nothing further to do.

This mode is reachable both standalone (a human or script running `/work-on <pr> --remediate` directly) and via the orchestrator (`commands/orchestrate/phase-4-execution.md` item 6.4 auto-dispatches the identical `Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='{PR} --remediate --issue {N} ...')` invocation against a `needs-human`-gated predecessor's own PR).

**Skip this entire section if `--remediate` is absent from `$ARGUMENTS`** — proceed to the normal parse below.

### 0A.4: Recovery-Claim Gate (MANDATORY — before any heartbeat, label, or comment write) <!-- Added: forge#3172 -->

A `/recover-orphans` sweep that resumes this issue inline holds an issue-scoped `<!-- FORGE:RECOVERY_CLAIM -->` comment (see `commands/recover-orphans.md` Phase 3). Starting the pipeline underneath a live claim double-runs the issue. Before the 0A.5 heartbeat and before 0B, ask the shared predicate `scripts/recovery-claim-live.sh` (the single copy of the claim logic: unreleased claim, `updated_at` within `RECOVERY_CLAIM_TTL_MIN` (default 30), and no `FORGE:RECOVERY_CLAIM_RELEASED` marker naming the claim's sweep id).

**Resolve `RECOVERY_SWEEP_ID`**: the value following `--recovery-sweep` in the invocation args, else empty. Only `/recover-orphans` passes it (its inline resume passes its own `SWEEP_ID`); it exempts the claim held by that sweep so the holder is not blocked by its own claim. Never combine it with `--under-orchestration`.

```bash
# Shell state does not persist: the bootstrap is repeated here.
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
_v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ -v mk="$_mk" '$(NF-2)==mk && $(NF-1)=="forgedock" && $NF ~ /^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$/{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$(0)}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5- || true)"
_m="$HOME/.claude/plugins/marketplaces/$_mk"
# '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
_k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_x" "$_v" "$_m")"
while IFS= read -r _c; do
case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
done <<< "$_k"
fi
RECOVERY_SWEEP_ID=$(printf '%s' "$ARGUMENTS" | sed -n 's/.*--recovery-sweep[[:space:]][[:space:]]*\([^[:space:]][^[:space:]]*\).*/\1/p' | head -1)
if [ -n "$FORGE_ROOT" ] && [ -f "$FORGE_ROOT/scripts/recovery-claim-live.sh" ]; then
  CLAIM_OUT=$(bash "$FORGE_ROOT/scripts/recovery-claim-live.sh" {NUMBER} -R {GH_REPO} ${RECOVERY_SWEEP_ID:+--exempt-sweep "$RECOVERY_SWEEP_ID"}); CLAIM_RC=$?
else
  CLAIM_OUT="CLAIM: ERROR"; CLAIM_RC=2   # fail closed: an unresolvable predicate is never treated as "free"
fi
echo "$CLAIM_OUT"
```

- `CLAIM_RC=0` (`CLAIM: FREE`): continue to 0A.5 / 0B.
- `CLAIM_RC=1` (`CLAIM: LIVE <sweep-id>`): STOP with "issue #{NUMBER} is held by recovery sweep <sweep-id>; retry after its `FORGE:RECOVERY_CLAIM_RELEASED` marker or `RECOVERY_CLAIM_TTL_MIN` expiry". Write nothing: no heartbeat, no label change, and NO `needs-human` (the claim is transient).
- `CLAIM_RC=2` (unreadable comments or missing script): fail closed, same STOP and same no-write rule (transient, not `needs-human`).

### 0A.5: Post Heartbeat Annotation (orchestration-only)

**Skip entirely if `UNDER_ORCHESTRATION` is `false`** — a solo run has no stall detector polling comment timestamps, so this write has zero consumer. Do not post it "just in case."

When `UNDER_ORCHESTRATION` is `true`: post a lightweight activity signal immediately after resolving the issue number. This gives the stall detector (orchestrate Step 4B.5) a fresh timestamp to compare against `STALL_TIMEOUT`. Without this, the stall detector can only see the last structured comment (INVESTIGATOR, BUILDER, etc.) which may be hours old during a valid long-running phase.

```bash
PHASE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: Phase 0 — starting pipeline
**Timestamp**: ${PHASE_START_TIMESTAMP}
**Issue**: #{NUMBER}"
```

**Also posted at phase entry points** (Phases 1, 3 and 4) by the router — see "Phase Heartbeat (router-owned)" below. Phases never post heartbeats. <!-- Added: forge#740 -->

**Skip if**: Issue already has a terminal label (`workflow:merged`, `workflow:invalid`, `needs-human`, `workflow:awaiting-merge`) — no heartbeat needed on a completed issue. (This is in addition to, not instead of, the `UNDER_ORCHESTRATION` gate above.)

### 0B: Load issue + existing context
```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments,milestone
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | {id: .id, author: .user.login, body: .body}'
```

**Check**: state (closed → STOP), terminal labels (`workflow:merged`/`workflow:invalid`/`workflow:awaiting-merge` → STOP), existing agent comments (`FORGE:INVESTIGATOR`, `FORGE:DECOMPOSED`, `FORGE:CONTRACT`, `FORGE:BUILDER`, `FORGE:TRAJECTORY`, `FORGE:DECISION_RECORD`), parent tracker status, sub-issue status.

**Resume preflight (MANDATORY on any resume past Phase 1)** <!-- Added: forge#3061 -->: before routing to Phase 3 (build), 4 (review) or 5 (close) from existing state, run `bash "$FORGE_ROOT/scripts/verify-phase-trail.sh" {NUMBER} -R {GH_REPO}` (add `--docs-only` for docs-only diffs, or `--code-diff` when the diff has any non-docs file so an INVESTIGATION band cannot waive requirements), with `FORGE_ROOT` resolved by the bootstrap in "Script resolution" below. If `FORGE_ROOT` is empty or the script is missing, treat it as `PHASE_TRAIL: ERROR` (fail closed: stop and add `needs-human`; never skip the preflight). On `PHASE_TRAIL: FAIL`, go BACK and run each missing phase through its `Skill(...)` (investigate, Phase 3B classification, build contract/context/architect, validate) before continuing — never continue forward over a gap, never hand-post a missing marker, and never treat a recovered uncommitted worktree as a substitute for the skipped phases. The same verifier gates PR creation (`work-on/review.md` Phase R1.5) and auto-merge (`review-pr.md` Phase 8).

**Determine resume point**: no `FORGE:INVESTIGATOR` → Phase 1 (investigate). Investigation complete with decompose YES and no `FORGE:DECOMPOSED` → Phase 2 (decompose); with `FORGE:DECOMPOSED` → Phase 5 (`--terminal-state decomposed`). Investigation complete (decompose NO) without `FORGE:BUILDER:COMPLETE` → Phase 3 (build; a partial BUILDER comment is cleaned up by the build phase). `FORGE:BUILDER:COMPLETE` and no merged PR → Phase 4 (review), except an **unfinished remediation handoff**, which is checked first and overrides the checkpoint routing in 0B.5: the issue does NOT carry `needs-human`, and its latest `FORGE:CI_REMEDIATION: pr={PR}`/`FORGE:INPR_REMEDIATION: pr={PR}` marker (for the open PR) has no `FORGE:REMEDIATION:COMPLETE` trail comment on that PR created after it (a trail comment is one that STARTS with `<!-- FORGE:REMEDIATION -->`, contains `<!-- FORGE:REMEDIATION:COMPLETE -->` and comes from a trusted author, read with `scripts/trusted-comments.sh`; a comment that merely quotes the marker never counts, forge#3412; if the comments or the helper are unreadable, fail closed to `needs-human` instead of resuming) → first re-add `needs-human` with a comment ("resuming an interrupted remediation of PR #{PR}"), because remediation's Phase M0 only accepts `needs-human`-gated issues and its M1 clears the label again for a FIXABLE run; then Phase 4R with that marker's kind, skipping the marker post (it is already recorded). This is the silent strand: M1 cleared `needs-human` and the run was lost before M8. It cannot loop: a remediation that finishes posts `FORGE:REMEDIATION:COMPLETE` (its single-attempt guard then returns `ALREADY_DONE`), and any other exit leaves `needs-human` on the issue (Phase 4R adds it on a `BLOCKED` result), so this rule no longer matches. A run lost before M1 still has `needs-human`, so it routes to review, which finds the bound used and stops visibly at `needs-human`. Re-entering review instead would find the bound used and stop without remediation ever finishing. PR merged and issue open → Phase 5 (close). `workflow:invalid` → STOP.

### 0B.5: Read Phase Checkpoint (MANDATORY — executes before any phase-skip decision)

Query for the latest `<!-- FORGE:CHECKPOINT -->` comment. This is the machine-readable source of truth for the pipeline's current phase position — it takes priority over all prose-based resume heuristics above.

```bash
CHECKPOINT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:CHECKPOINT"))] | last | .body // ""')

if [ -n "$CHECKPOINT" ]; then
  # Extract next_phase from the JSON block inside the comment
  NEXT_PHASE=$(echo "$CHECKPOINT" | grep -A5 '```json' | grep '"next_phase"' \
    | sed -n 's/.*"next_phase": "\([^"]*\)".*/\1/p')
  echo "Checkpoint found: next_phase=${NEXT_PHASE}"
fi
```

**Routing from checkpoint** (overrides prose heuristics above when a checkpoint exists, except the unfinished-remediation-handoff rule in 0B, which is evaluated first and routes to Phase 4R):

| `next_phase` value | Resume at |
|--------------------|-----------|
| `BUILD` | Phase 3 — build (skip investigation) |
| `DECOMPOSE` | Phase 2 — decompose (skip investigation) |
| `REVIEW` | Phase 4 — review (skip investigation and build) |
| `CLOSE` | Phase 5 — close (skip everything before it) |
| *(absent or unrecognized)* | Fall back to prose heuristics above |

Note: the investigate phase no longer writes `next_phase: BUILD`/`DECOMPOSE` CHECKPOINT comments (removed as redundant with the `workflow:ready-to-build`/`workflow:decomposed` label transition — see Phase 1D). Those two rows remain here only to route older, pre-existing CHECKPOINT comments correctly; new runs land on the prose-heuristic fallback for those two cases instead, which is equally precise. `REVIEW` and `CLOSE` are still written (Phase 3M and Phase 5D) because each covers a real gap before the corresponding label transition.

**If no checkpoint exists**: fall back to prose resume heuristics in Phase 0B above — treat as fresh start at Phase 1.

**Classify lane**: Milestone → feature lane (`milestone/{slug}`). No milestone → fast lane (`staging`).

**Batch issue detection**: <!-- Added: forge#1333 --> If the issue body contains `<!-- FORGE:BATCH_MEMBERS -->`, this is a P3 batch issue. Set `IS_BATCH=true` and extract the member issue list:

```bash
IS_BATCH=0
BATCH_MEMBERS=()

BATCH_MEMBERS_BLOCK=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' \
  | sed -n '/<!-- FORGE:BATCH_MEMBERS -->/,/<!-- \/FORGE:BATCH_MEMBERS -->/p' 2>/dev/null || true)

if [ -n "$BATCH_MEMBERS_BLOCK" ]; then
  IS_BATCH=1
  # Extract member issue numbers (- [ ] #NNN: title lines)
  BATCH_MEMBERS=($(echo "$BATCH_MEMBERS_BLOCK" | sed -n 's/^.*- \[ \] #\([0-9][0-9]*\).*/\1/p' || true))
  echo "Batch issue detected — member issues: ${BATCH_MEMBERS[*]}"
fi
```

**Batch issue pipeline rules** (when `IS_BATCH=true`):
- Build phases execute exactly as normal (the batch issue body IS the spec for what to fix)
- Batch members are referenced in the PR body with `Refs #N`, never `Closes #N`; the batch issue is the only issue the PR may close.
- After successful merge, re-read every member's live state and labels before closing it. A member that is `needs-human`, `blocked`, or `operator-only` remains open and is reported as a split outcome:
  ```bash
  for MEMBER in "${BATCH_MEMBERS[@]}"; do
    MEMBER_SNAPSHOT=$(gh issue view "$MEMBER" {GH_FLAG} --json state,labels \
      --jq '{state: .state, labels: [.labels[].name]}' 2>/dev/null) || {
      echo "WARNING: could not verify batch member #${MEMBER}; leaving it open"
      continue
    }
    MEMBER_GATED=$(echo "$MEMBER_SNAPSHOT" | jq -r \
      '(.state != "OPEN") or ([.labels[] | select(. == "needs-human" or . == "blocked" or . == "operator-only")] | length > 0)')
    if [ "$MEMBER_GATED" = "true" ]; then
      echo "SPLIT OUTCOME: #${MEMBER} remains open because it requires a human or operator action."
      continue
    fi
    gh issue close "$MEMBER" {GH_FLAG} \
      --comment "Resolved as part of batch PR #{PR_NUMBER} (#{ISSUE_NUMBER}). See batch issue for details."
    gh issue edit "$MEMBER" {GH_FLAG} --add-label "workflow:merged" 2>/dev/null || true
  done
  ```
- Member issues are closed by the router after Phase 5 (close) returns COMPLETE — NOT before (see "Batch-member closure").

**Source branch for review-findings**: Parse `**Code branch**: \`{branch}\`` from body. Branch from there, not main.

**Script resolution** — Use the following `resolve_script()` function whenever calling a pipeline script. It enforces the 4-level precedence hierarchy (see `devdocs/project/architecture.md → Script Precedence`):

```bash
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
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ -v mk="$_mk" '$(NF-2)==mk && $(NF-1)=="forgedock" && $NF ~ /^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$/{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$(0)}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5- || true)"
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

# Canonical tier-dispatch usage pattern — inline at every resolve_script() call site:
#
# There is no centralised run_script() function. The pattern below is inlined
# directly at each call site because each operation has a different prose
# fallback. Copy and adapt this block wherever resolve_script() is called.
#
# Usage pattern at each call site:
#   RESOLUTION=$(resolve_script 'op')
#   TIER="${RESOLUTION%%:*}"
#   SCRIPT_PATH="${RESOLUTION#*:}"
#   case "$TIER" in
#     adaptive|universal) bash "$SCRIPT_PATH" ARGS ;;
#     prose)              # inline fallback here ;;
#   esac
#
# The case pattern is inlined at every call site (rather than centralised here)
# because each operation has a different prose fallback — transition-label falls
# back to inline gh issue edit; classify-lane has no valid prose fallback and
# must exit 1; validate-pr-target emits a WARNING and continues (the PR review
# step catches any mismatch before merge). <!-- Added: forge#822 -->
```

When invoking a resolved script, log the tier in the FORGE annotation: `Script tier: {adaptive|universal|prose} ({path})`. This provides full pipeline observability. <!-- Added: forge#670 -->

### 0B.1: Apply learned overrides (MANDATORY — run after 0B, before any routing)

Read `forge.yaml → learned:` and override runtime variables. If the `learned:` key is absent or empty, all steps below are no-ops — continue to 0C.

```bash
# Read learned section — all reads use // "" fallback so absent keys are silent no-ops
LEARNED_STAGING=$(yq '.learned.branch_targets.staging // ""' forge.yaml 2>/dev/null || echo '')
LEARNED_TEST_COMMANDS=$(yq '.learned.test_commands // []' forge.yaml 2>/dev/null || echo '[]')
LEARNED_LABEL_MAP=$(yq '.learned.label_map // {}' forge.yaml 2>/dev/null || echo '{}')
LEARNED_COMMIT_STYLE=$(yq '.learned.commit_style // ""' forge.yaml 2>/dev/null || echo '')
```

**Apply overrides**:

1. **Branch target override** — If `LEARNED_STAGING` is non-empty, replace `STAGING_BRANCH` with its value:
   ```bash
   [ -n "$LEARNED_STAGING" ] && STAGING_BRANCH="$LEARNED_STAGING" && \
     echo "Learned override: STAGING_BRANCH → $STAGING_BRANCH (from learned.branch_targets.staging)"
   ```

2. **Test commands** — Read by the validate phase itself from `forge.yaml → learned.test_commands` (a forked phase cannot see router variables). Nothing to pass.

3. **Label map** — If `LEARNED_LABEL_MAP` is non-empty, export it as `FORGE_LABEL_MAP` so that all subsequent `resolve_script 'transition-label'` invocations (which are child processes) can read it. The script performs the substitution internally: if the canonical label (e.g. `workflow:investigating`) appears as a key in the map, it uses the mapped value instead.
   ```bash
   # Export as FORGE_LABEL_MAP so child processes (resolve_script 'transition-label') can read it.
   # All 8 resolve_script 'transition-label' call sites in this command inherit this env var automatically.
   # The script substitutes the canonical workflow:* label with the mapped value when found.
   export FORGE_LABEL_MAP="$LEARNED_LABEL_MAP"
   [ -n "$LEARNED_LABEL_MAP" ] && [ "$LEARNED_LABEL_MAP" != "{}" ] && \
     echo "Learned override: FORGE_LABEL_MAP active — label_map will be applied by resolve_script 'transition-label'"
   ```

4. **Commit style** — Read by the build children (implement/validate) from `forge.yaml → learned.commit_style`; the router only logs it:
   ```bash
   [ -n "$LEARNED_COMMIT_STYLE" ] && COMMIT_STYLE="$LEARNED_COMMIT_STYLE" && \
     echo "Learned override: COMMIT_STYLE → $COMMIT_STYLE"
   ```

<!-- Added: forge#667 — learned section reader -->

### 0C: Sync to Project board
Add issue to project, set Status=In Progress, Lane, Component, Priority, Workflow=Investigating.

### 0C.5: Spec loading

The router never reads phase spec files. Each phase loads exactly its own spec when it runs, because every phase sub-skill is forked (`context: fork`): the phase's context holds only that phase's instructions plus its args. Do not pre-read `commands/work-on/*.md`, `review-pr.md` or any other command spec into the router's context.

---

## Phase Heartbeat (router-owned)

Posted at the entry of Phases 1, 3 and 4 — **only** when `UNDER_ORCHESTRATION` is `true`, and skipped when the issue already carries a terminal label (`workflow:merged`, `workflow:invalid`, `needs-human`, `workflow:awaiting-merge`). `/orchestrate`'s stall detector reads these timestamps. Phases never post heartbeats.

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: {PHASE_LABEL}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Issue**: #{NUMBER}" 2>/dev/null || true # allowlist:check-command-side-effects
```

`{PHASE_LABEL}`: `Phase 1 — Investigation`, `Phase 3 — Build`, `Phase 4 — Review`.

---

## Transient GitHub failures (router-owned retry)

Any phase result whose blocker starts with `github-unavailable:` is an infrastructure outage, not a decision: do not add `needs-human`. Wait 2 minutes, then re-invoke the **same phase with the same args**; repeat at most twice (5 minutes before the second retry). Phases are idempotent and resume from GitHub state. If the third attempt still returns `github-unavailable:`, post one comment with the blocker, add `needs-human`, and STOP — at that point GitHub has been unavailable for 10+ minutes.

---

## Phase 1: Investigate

**Skip if**: a `<!-- FORGE:INVESTIGATOR -->` comment contains `<!-- INVESTIGATION:COMPLETE -->` or `<!-- INVESTIGATION:INVALID -->` (route on the existing verdict as below — the skill's own resume check returns it if invoked).

Post the Phase 1 heartbeat, then:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:investigate", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\"")
```

| `INVESTIGATE_RESULT` | Router action |
|---|---|
| `status: COMPLETE` or `ALREADY_DONE`, `decompose: NO` | Marker gate (below) → Lane Resolution → Phase 3 |
| `status: COMPLETE` or `ALREADY_DONE`, `decompose: YES` | Phase 2 |
| `status: INVALID` | Terminal (the phase labelled `workflow:invalid` and closed the issue) → Phase 5 with `--terminal-state invalid` |
| `status: BLOCKED` | Terminal: confirm `needs-human` is on the issue (add it with the blocker as a comment if not) and STOP |

**Marker gate — Phase 1 exit** (decompose NO path only): the issue must have a `FORGE:INVESTIGATOR` comment containing `INVESTIGATION:COMPLETE`. If absent, invoke the skill once more; if still absent, post `<!-- FORGE:GATE_FAILURE -->` ("investigation marker missing after one re-invoke"), add `needs-human`, STOP. <!-- forge#1419 -->

---

## Phase 2: Decompose

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:decompose", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\"")
```

| `DECOMPOSE_RESULT` | Router action |
|---|---|
| `COMPLETE` / `ALREADY_DONE` | Phase 5 with `--terminal-state decomposed` (the parent stays open as a tracker; each sub-issue runs its own `/work-on`) |
| `BLOCKED` | Terminal: the phase already added `needs-human` and posted the blocker. STOP. |

---

## Lane Resolution (router, before Phase 3 and again before Phase 4)

`PR_BASE` (the branch the PR targets and the worktree is based on) and `CLASSIFIED_LANE` are computed by the router and passed to the phases as `--base`. Include the Phase 0 Script resolution block in the same command.

```bash
RESOLUTION=$(resolve_script 'classify-lane')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    if ! PR_BASE=$(bash "$SCRIPT_PATH" {NUMBER} -R {GH_REPO}); then
      gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh failed to compute the PR target — see the script error. Adding needs-human." # allowlist:check-command-side-effects
      gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
      exit 1
    fi
    ;;
  prose)
    gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh not installed (prose tier). Cannot compute the PR target. Adding needs-human." # allowlist:check-command-side-effects
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
    exit 1
    ;;
esac
CLASSIFIED_LANE="$PR_BASE"
echo "PR_BASE=$PR_BASE"
```
Output is authoritative — no prose fallback. A non-zero exit means `needs-human` and STOP. <!-- Added: forge#669, forge#639 -->

**Before Phase 4 only — validate the target against the classified lane** (guards against a resumed run or a hand-edited branch targeting the wrong branch):

```bash
RESOLUTION=$(resolve_script 'validate-pr-target')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    if ! bash "$SCRIPT_PATH" {PR_BASE} {CLASSIFIED_LANE}; then
      gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKING: validate-pr-target.sh — PR base \`{PR_BASE}\` does not match classified lane \`{CLASSIFIED_LANE}\`. Manual intervention required." # allowlist:check-command-side-effects
      gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" # allowlist:check-command-side-effects
      exit 1
    fi
    ;;
  prose)
    echo "WARNING: validate-pr-target.sh not installed (prose tier) — lane validation skipped; the review phase still refuses to merge into main." >&2
    ;;
esac
```
On a mismatch → STOP; do not invoke Phase 4. <!-- Added: forge#671 -->

---

## Phase 3: Build

**Skip if**: a `FORGE:BUILDER` comment contains `<!-- FORGE:BUILDER:COMPLETE -->` (go to Phase 4).

Post the Phase 3 heartbeat, run Lane Resolution, then:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:build", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --base {PR_BASE}")
```

The build phase owns classification (`FORGE:FAST_PATH`), the worktree, the `workflow:building` label, the contract, and runs its children — context, architect, implement, validate (with the quality gate) — each as its own forked skill, then the acceptance gate and the build checkpoint.

| `BUILD_RESULT` | Router action |
|---|---|
| `COMPLETE` | Marker gate (below) → record `BRANCH` and `WORKTREE_PATH` from the result → Phase 4 |
| `ALREADY_DONE` | Record `BRANCH`/`WORKTREE_PATH` (from the result, or `git worktree list` for the issue branch) → Phase 4 |
| `INVESTIGATION_COMPLETE` | Investigation-type task: deliverable issues were filed and the original closed by the phase → Phase 5 with `--terminal-state investigation` (no review) |
| `BLOCKED` | Terminal: confirm `needs-human` is present (the phase adds it with the blocker) and STOP |

**Marker gate — Phase 3 exit**: a `FORGE:BUILDER` comment must contain `FORGE:BUILDER:COMPLETE`. If absent, invoke `work-on:build` once more with the same args; if still absent, post `<!-- FORGE:GATE_FAILURE -->` ("builder completion marker missing after one re-invoke"), add `needs-human`, remove `workflow:building`, STOP. <!-- forge#1418 -->

---

## Phase 4: Review (push → PR → /review-pr → merge)

Post the Phase 4 heartbeat, run Lane Resolution including the lane validation, then:

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:review", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE}")
```

The review phase owns: ancestry and empty-branch guards, push, PR creation, `workflow:in-review`, the phase-trail preflight (and the single re-dispatch of any missing phase via `Skill`), `/review-pr --auto-merge` (CI gate and reviewed-head guard included), stale-review re-review, and the REVIEW checkpoint. It never closes the issue and never runs remediation: a red CI gate or an in-PR fix request comes back as `REVIEW_RESULT: status: NEXT` for Phase 4R.

| `REVIEW_RESULT` | Router action |
|---|---|
| `COMPLETE` (PR merged) | Record `PR_NUMBER` → Phase 5 with `--terminal-state merged` |
| `ALREADY_MERGED` | Same as COMPLETE |
| `NEXT`, `next: remediate` | Record `PR_NUMBER` and `remediation` (`ci-gate` or `inpr-fix`) → Phase 4R (review handoff to remediation) |
| `BLOCKED` | Terminal: the phase already added `needs-human` (or `workflow:awaiting-merge` for a deploy-gate hold) with the blocker. Do NOT merge, re-run phases, or add labels here. STOP. |

### Phase 4R: Remediation handoff from review

The review phase never invokes remediation itself: remediation re-reviews through `/review-pr`, which spawns domain reviewers, so it must run one level below this router (see the Depth Budget). The review phase has checked the bound; this router posts the bound marker **immediately before** invoking remediation, so a handoff interrupted before remediation starts (compaction, crash) is retried on resume instead of being counted as used. It runs at most once per PR per kind.

```bash
# {REMEDIATION_KIND} is the review result's `remediation` value: ci-gate -> CI_REMEDIATION, inpr-fix -> INPR_REMEDIATION.
BOUND_MARKER="CI_REMEDIATION"; [ "{REMEDIATION_KIND}" = "inpr-fix" ] && BOUND_MARKER="INPR_REMEDIATION"
BOUND_BODY="<!-- FORGE:${BOUND_MARKER}: pr={PR_NUMBER} -->
Review handed PR #{PR_NUMBER} to remediation ({REMEDIATION_KIND}); the router is dispatching it once."
gh issue comment {NUMBER} {GH_FLAG} --body "$BOUND_BODY" || { echo "github-unavailable: could not post FORGE:${BOUND_MARKER}; remediation not invoked"; exit 1; } # allowlist:check-command-side-effects
```

If the marker cannot be posted, do not invoke remediation (an unrecorded bound could repeat): treat it as a `github-unavailable:` blocker under the router-owned retry rule.

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:remediate", args="{PR_NUMBER} --issue {NUMBER} --base {PR_BASE} --repo {GH_REPO} --gh-flag {GH_FLAG}")
```

| `REMEDIATE_RESULT` | Router action |
|---|---|
| `re_gate_outcome: AUTO-LANDED` | Merged. Remediation's Phase M8 already ran `work-on:close`; if the issue is still open, run Phase 5 with `--terminal-state merged`. Then done. |
| `status: REREVIEW_REQUIRED` | Fallback only (should not occur at this depth): run the re-review from this router as in 0A.1, then Phase 5 on `REVIEW_RESULT: status: COMPLETE`. If the re-review cannot run or returns anything else, apply the terminal fallback defined in 0A.1 (comment with reason, add `needs-human`, remove `workflow:in-review`), then STOP; do not poll. |
| `status: BLOCKED`, blocker starts with `github-unavailable:` | Transient, not a decision (see Transient GitHub failures). Re-add `needs-human` with a short comment (remediation's Phase M0 only accepts `needs-human`-gated issues and its M1 clears the label for a FIXABLE run), wait 2 min (5 min before the second retry), then re-invoke `work-on:remediate` with the same args; do NOT re-post the bound marker. At most 2 retries; if the third attempt still returns `github-unavailable:`, fall through to the `status: BLOCKED` (any kind) row below. |
| `status: BLOCKED` (any kind) | Make sure `needs-human` is on the issue (add it with the blocker as a comment if absent: remediation can exit after its M1 cleared the label). STOP. |
| `status: ALREADY_DONE` (single-attempt guard: an earlier remediation already completed on this PR), `remediation: inpr-fix` | Same as any other `inpr-fix` outcome below: re-invoke Phase 4 once, which waives the in-PR gate. |
| `status: ALREADY_DONE`, `remediation: ci-gate` | Make sure `needs-human` is on the issue (add it, with a comment naming the PR and that remediation already ran, if absent). STOP. |
| any other outcome, `remediation: inpr-fix` | Re-invoke Phase 4 (`work-on:review`) once with the same args. Review finds its `INPR_REMEDIATION` bound used, waives the in-PR gate for the current head, files the remaining findings as issues and re-reviews. |
| any other outcome, `remediation: ci-gate` | Terminal: remediation left `needs-human` (or `workflow:awaiting-merge`) with its reason. STOP. |

Row order matters: the `github-unavailable:` row is evaluated before the generic `status: BLOCKED` (any kind) row, which only handles non-transient blockers and the exhausted retry budget (see Transient GitHub failures). <!-- Added: forge#3402 -->

---

## Phase 5: Close & trajectory

```
Skill(skill="{FORGE_SKILL_PREFIX}work-on:close", args="{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\" --pr {PR_NUMBER} --base {PR_BASE} --branch {BRANCH} --worktree {WORKTREE_PATH} --terminal-state {merged|investigation|decomposed|invalid}")
```
Omit `--pr/--branch/--worktree` when the value is unknown (PR-less terminals).

| `CLOSE_RESULT` | Router action |
|---|---|
| `COMPLETE` / `ALREADY_DONE` | Pipeline done. If `IS_BATCH` (Phase 0B), run the batch-member closure below. Print the phase's report/card verbatim and stop. |
| `PHASE_COMPLETE` | Multi-phase issue: this phase merged, more remain. The issue is open again at `workflow:investigating` → re-run Phase 0 and continue from the next phase. |
| `FAILED` | Invoke `work-on:close` once more with the same args (it is idempotent). If it fails again, post the blocker as a comment, add `needs-human`, STOP. |

**Batch-member closure** (only when `IS_BATCH` and the batch PR merged): for each member in `BATCH_MEMBERS`, re-read its live state and labels; leave open (and report as a split outcome) any member that is closed, `needs-human`, `blocked` or `operator-only`; otherwise close it with "Resolved as part of batch PR #{PR_NUMBER} (#{NUMBER})" and add `workflow:merged`.

---

## Remediation entry (`--remediate`)

Handled in Phase 0A.1: `/work-on <pr> --remediate [--issue N]` dispatches `Skill(skill="{FORGE_SKILL_PREFIX}work-on:remediate", ...)` (forked) and STOPS after its `REMEDIATE_RESULT`, except that `REREVIEW_REQUIRED` makes the router run `review-pr` itself first, with the terminal fallback if that cannot run (see 0A.1).

---

---

## Error Handling

- Worktree exists: reuse or clean up
- PR creation fails: check if branch pushed, if PR already exists
- Merge conflicts: report to user, do NOT auto-resolve
- gh CLI fails: check `gh auth status`
- Label missing: run `npx forgedock labels setup` (from the project directory, or pass `--repo owner/repo`) to idempotently bootstrap all ForgeDock-managed labels with canonical colors and descriptions. Alternatively: `gh label create "{name}" --color {hex} --description "Managed by ForgeDock." --force -R {GH_REPO}`
