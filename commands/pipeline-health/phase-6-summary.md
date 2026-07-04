<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Phase 6: Summary

## Phase 6: Summary

Print to the user:

```
Forge Pipeline Health — [REPO]
Score: [SCORE]/100 ([CATEGORY]) $SCORE_TREND

Pre-merge quality:
  Build pass rate:          [X]% (target 95%)
  Findings per PR:          [X]  (target < 0.5)
  False positive rate:      [X]% (target < 10%)
  Manual fix-up rate:       [X]% (target < 15%)
  Self-correction rate:     [X]% (target < 15%)

Post-deploy quality:
  Post-deploy failure rate: [X]% (target < 5%) — [N] audit findings
  Review escape rate:       [X]% (target < 2%) — [N] REVIEW_FALSE_NEG
  Mean time to detect:      [X] days (target < 7 days)
  Top failure points:       [FP1] ([N]), [FP2] ([N]), [FP3] ([N])

Pipeline health signals:
  Issue quality score:      [X]/100 (target > 80)
    Invalidation rate:      [X]% (target < 15%)
    ISSUE_SPEC findings:    [X]  (target 0)
    Re-investigations:      [X]  (target 0)
    Structure compliance:   [X]% (target > 80%)
  Investigation accuracy:   [X]% (target > 85%) — [N] issues with trajectory data
    CONFIRMED: [N] | PARTIAL: [N] | INVALID: [N]
  Anomalies flagged:        [N] issues
  Task type distribution:   Bug Fix: [N], Feature: [N], Refactor: [N], Maintenance: [N]
  Orchestration efficiency: [X]/100 (target > 70) — [N] sessions, [M] agents
    Avg idle%:              [X]% (target < 30%)
    Avg resume cycles:      [X] (target < 1)
    Clean agent rate:       [X]% (target > 60%)
    Top stall boundary:     [boundary] ([N] occurrences)
  Original work ratio:      [X]% (target > 70%)
  Milestone merge rate:     [X]% (target 80%)

Top defect categories: [CAT1] ([N]), [CAT2] ([N]), [CAT3] ([N])

Proposed improvements: [N] issues created in $FORGE_REPO
Health report: [ISSUE_URL]
```
