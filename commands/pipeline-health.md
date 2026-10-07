---
description: Self-analysis — measures pipeline performance, correlates with prompt changes, proposes improvements
argument-hint: "[project repo slug or \"all\"]"
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Forge Self-Analysis

**Input**: $ARGUMENTS

You are the Forge pipeline's self-awareness layer. Your job is to measure how well the pipeline is performing,
correlate performance with recent prompt changes, identify weak spots, and propose concrete improvements.

This file is the slim dispatcher. Detailed phase content lives in `commands/pipeline-health/`.

## Execution Order

Read and execute phases in sequence. Each phase file is self-contained.

| Step | File | Description |
|------|------|-------------|
| 0 | `pipeline-health/config.md` | Configuration — READ FIRST |
| 1 | `pipeline-health/phase-1-context.md` | Identify context (target project, analysis window, prior report) |
| 2 | `pipeline-health/phase-2-metrics.md` | Collect pipeline metrics (review findings, build rates, transcript analytics) |
| 3 | `pipeline-health/phase-3-analyze.md` | Analyze & correlate (defect breakdown, prompt change impact, health score) |
| 4 | `pipeline-health/phase-4-proposals.md` | Generate improvement proposals |
| 5 | `pipeline-health/phase-5-report.md` | Report & track (post health report, create improvement issues) |
| 6 | `pipeline-health/phase-6-summary.md` | Summary |

## Quick Reference

**Spec root (MANDATORY)**: read every file below from `${CLAUDE_PLUGIN_ROOT}` — the install root of the ForgeDock plugin that is running this command (Claude Code fills it in when it loads the spec). Only if that path does not start with `/` (not a Claude Code plugin session: install.sh, Codex, OpenCode) use `$FORGE_HOME` instead. Never read sub-files from `$FORGE_HOME` when the plugin root resolved: an exported `FORGE_HOME` can point at a different, older ForgeDock checkout, and mixing roots runs stale phase specs.

```
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/config.md           # ALWAYS READ FIRST
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/phase-1-context.md
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/phase-2-metrics.md
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/phase-3-analyze.md
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/phase-4-proposals.md
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/phase-5-report.md
Read: ${CLAUDE_PLUGIN_ROOT}/commands/pipeline-health/phase-6-summary.md
```

The command reads only the phase file(s) relevant to the current step rather than loading
the full 2500-line monolith upfront.
