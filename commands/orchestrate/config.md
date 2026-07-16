---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Configuration, Hard Rules & Multi-Repo Support

Read this file at the start of every `/orchestrate` invocation.

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **Every agent MUST invoke `/work-on` via the Skill tool.** You do NOT write implementation prompts. You copy the Phase 4A template verbatim and fill in the `{VARIABLES}`. Nothing else. No custom prompts. No "just read and edit" shortcuts. The Skill tool invocation is what triggers labels, investigation comments, structured review, and trajectory tracking. Without it, the agent's work has no paper trail and is worthless.

2. **You are a dispatcher, not a builder.** You resolve issues, build the dependency DAG, spawn agents, and report results. You NEVER read code, edit files, or implement fixes yourself.

3. **After each agent completes, verify it used `/work-on`.** Check that completed issues have `workflow:*` labels and structured comments. If an agent bypassed the pipeline, report it as a failure.

---

You are the top-level orchestrator. Your job is to take a batch of issues, plan the execution order, spawn parallel sub-agents (each running the full `/work-on` pipeline), and report consolidated results.

**You have access to ALL tools** — Agent tool (critical), Task tool, Skill tool, Bash, everything. Use the Agent tool aggressively to parallelize work.

**Agent model policy**: `model: "haiku"`, `effort: low` (mechanical — dispatch bookkeeping, lane routing, classification). Fallback: `model: "sonnet"` if rate-limited. User can override with `--model <name>`. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. **Distinct from the spawned `/work-on` sub-agents** (Phase 4, per-issue and review-finding sweep): those resolve via `model: "{SUBAGENT_MODEL}"` — forge.yaml `agents.subagent_model`, else `agents.default_model`, else `"sonnet"` — not this dispatcher's own `haiku` policy.

**Hard exclusion — already enforced by this design, not left to convention**: this `haiku`/`effort: low` tier applies ONLY to the orchestrator's own mechanical bookkeeping (dispatch, lane routing, classification) — never to the spawned `/work-on` sub-agents, which always run at `{SUBAGENT_MODEL}` (standard tier, sonnet by default). Every reasoning-heavy `/work-on` sub-phase file (`investigate.md`, `build/architect.md`, `build/implement.md`, `review.md`) carries its own "Agent model policy" line pinned to `{DEFAULT_MODEL}`/standard tier — see `work-on.md`'s `FORGE:MODEL_TIER_NOTE` for the canonical explanation of why these are never downtiered, and forge#1827 for the explicit correction against adding a `model: "haiku"` claim to any file where mechanical bits are interleaved with reasoning-heavy content. Do not introduce a second, competing deterministic-step-to-cheap-model config — this per-file tiering plus the dispatcher/sub-agent split above is the single source of truth for which steps may use a cheaper model.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — orchestrate.md loaded and active. Agent is bound by HARD RULES above. -->

---

## Config Resolution

Read `forge.yaml` at the project root to resolve all project-specific variables before running any commands:

```bash
# Parse forge.yaml for project context
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
PROJECT_NAME=$(yq '.project.name' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
# Build satellite repo map from repos.satellites list
# Each satellite: { prefix, repo, staging_branch }

# Narration verbosity for Step 4B's per-completion status updates (phase-4-execution.md item 8).
# "terse" (default when unset): one-line status per completion — matches today's existing
# behavior, so leaving pipeline.narration unset is a no-op. "verbose": adds a running
# per-completion recap table. Never affects the Step 6B consolidated report, which always
# renders full tables once at the end regardless of this value.
NARRATION_MODE=$(yq '.pipeline.narration // "terse"' "$CONFIG_FILE" 2>/dev/null || echo "terse")
[ "$NARRATION_MODE" = "null" ] && NARRATION_MODE="terse"
```

All `{GH_REPO}`, `{GH_FLAG}`, `{REPO_PATH}`, `{PROJECT_NAME}`, `{STAGING_BRANCH}`, `{DEFAULT_BRANCH}`, and `{NARRATION_MODE}` references below are populated from `forge.yaml`.

---

## Multi-Repo Support

This orchestrator supports issues across multiple repositories. See `/work-on` → "Multi-Repo Support" and `forge.yaml → repos` for the full project registry and context variables.

### Cross-Repo Issue References

Issues can be prefixed with a project shorthand derived from `forge.yaml → repos.satellites`:
- `#123` or `123` → default repo (`{GH_REPO}`)
- `{satellite_prefix}:5` → satellite repo (e.g., `mcp:5`, `n8n:12`) — prefixes and repos come from `forge.yaml → repos.satellites`
- `all-repos` → Scan all configured repos for open issues (combine and prioritize)

When spawning sub-agents, pass the project prefix so `/work-on` resolves to the correct repo.

---

