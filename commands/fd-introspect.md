---
description: Introspect lean-lane quality telemetry — trend test-adequacy and test-quality fields per window
argument-hint: "[window days, default 7]"
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /fd-introspect — Lean Lane Test-Quality Trends

**Input**: $ARGUMENTS (default window: 7 days)

Trends the per-lane test-quality telemetry the lean engine writes on `RUN_TERMINAL` (#5449): `tests_declared`, `tests_ran`, `repro_quality`, `mutation_killed`, `regression_suite_ran`, `post_deploy_check_ids`. The batch report's `test adequacy:` line gives the adequate/weak/missing share per batch.

```bash
forgedock stats --conformance-outcomes
```

Per window report: `tests_ran / tests_declared`, the share of lanes with `repro_quality = red_green`, `mutation_killed` per lane, lanes that ran their regression suite, and issues reopened within 14 days split by test-adequacy class (adequate / weak / missing / n/a), which shows whether the gate pays off. A field absent on a lane means the input did not exist for it; do not count it as a failure. The same trend section runs in `/pipeline-health` (phase 2A2).
