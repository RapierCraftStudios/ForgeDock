---
description: Orchestrate parallel work on multiple issues or an entire milestone — spawns sub-agents that each run the full /work-on pipeline
argument-hint: "[milestone <slug> | #1 #2 #3 | next <N> | fast-lane | priority:P0]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Multi-Issue Parallel Orchestrator

**Input**: $ARGUMENTS

This file is the slim dispatcher. Detailed phase content lives in `commands/orchestrate/`.

## Execution Order

Read and execute phases in sequence. Each phase file is self-contained.

| Step | File | Description |
|------|------|-------------|
| 0 | `orchestrate/config.md` | Hard rules, config resolution, multi-repo support — READ FIRST |
| 1 | `orchestrate/phase-1-resolve.md` | Resolve the issue set from input |
| 2 | `orchestrate/phase-2-triage.md` | Investigation-first triage, Wave 0 |
| 2.5 | `orchestrate/phase-2.5-synthesis.md` | Investigation synthesis and deconfliction |
| 3 | `orchestrate/phase-3-dependency.md` | Dependency analysis, DAG construction, execution plan |
| 4 | `orchestrate/phase-4-execution.md` | Streaming DAG execution, agent dispatch, stall detection |
| 5 | `orchestrate/phase-5-cleanup.md` | Post-batch cleanup sweep and agent audit |
| 6 | `orchestrate/phase-6-report.md` | Consolidated report and pipeline summary |
| — | `orchestrate/safety.md` | Safety rules and examples (reference) |

## Quick Reference

```
Read: $FORGE_HOME/commands/orchestrate/config.md       # ALWAYS READ FIRST
Read: $FORGE_HOME/commands/orchestrate/phase-1-resolve.md
Read: $FORGE_HOME/commands/orchestrate/phase-2-triage.md
Read: $FORGE_HOME/commands/orchestrate/phase-2.5-synthesis.md
Read: $FORGE_HOME/commands/orchestrate/phase-3-dependency.md
Read: $FORGE_HOME/commands/orchestrate/phase-4-execution.md
Read: $FORGE_HOME/commands/orchestrate/phase-5-cleanup.md
Read: $FORGE_HOME/commands/orchestrate/phase-6-report.md
```

The orchestrator reads only the phase file(s) relevant to the current step rather than
loading the full 2300-line monolith upfront.
