---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Shared Agent Policies

This file contains the canonical, default-tier agent policy lines that most
single-purpose commands carry verbatim. It is read once per command spec
instead of being restated inline.

**Normative for**: `check-protocol-restatements.sh` treats the two lines
below as the single source; any other `commands/**/*.md` file that restates
them verbatim (outside its own file-specific variant — see the cross-file
variance note below) is flagged as a restatement.

Commands with a genuinely different policy (a different model, a different
effort tier, or extra dispatcher-specific caveats — e.g. `orchestrate/config.md`'s
`haiku`/`effort: low` dispatcher tier, or `work-on.md`'s per-sub-phase tiering
note) are NOT restatements — they carry intentionally different content and
are exempt.

## Agent model policy (default tier)

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

## Plan mode ban

**NEVER use plan mode (EnterPlanMode).**

## Usage

A command spec that uses both lines verbatim replaces them with:

> Agent policy: see `commands/shared/agent-policies.md` (default-tier model resolution + plan-mode ban) if not already in context.

A command spec that uses only the plan-mode ban (its model policy differs)
keeps its own model-policy line and replaces only the plan-mode line with:

> Plan mode: see `commands/shared/agent-policies.md` § Plan mode ban if not already in context.
