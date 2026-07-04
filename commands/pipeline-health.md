---
description: Self-analysis — measures pipeline performance, correlates with prompt changes, proposes improvements
argument-hint: [project repo slug or "all"]
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

```
Read: $FORGE_HOME/commands/pipeline-health/config.md           # ALWAYS READ FIRST
Read: $FORGE_HOME/commands/pipeline-health/phase-1-context.md
Read: $FORGE_HOME/commands/pipeline-health/phase-2-metrics.md
Read: $FORGE_HOME/commands/pipeline-health/phase-3-analyze.md
Read: $FORGE_HOME/commands/pipeline-health/phase-4-proposals.md
Read: $FORGE_HOME/commands/pipeline-health/phase-5-report.md
Read: $FORGE_HOME/commands/pipeline-health/phase-6-summary.md
```

The command reads only the phase file(s) relevant to the current step rather than loading
the full 2500-line monolith upfront.
