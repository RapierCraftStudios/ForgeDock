---
description: review-pr fragment — Phase 7A purpose regression gate (milestone PRs) (read by /review-pr when its trigger holds; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

### 7A: Purpose Regression Gate (Milestone PRs Only)

**Skip if**: `IS_MILESTONE_TO_STAGING` is false (i.e., HEAD branch does NOT start with `milestone/`). This gate fires ONLY for milestone→staging PRs.

**Why this exists**: For milestone PRs, a CONFIRMED finding can be a functional regression even if it doesn't cause a runtime crash. A stealth milestone shipping a detectable signal is the stealth equivalent of a crash — the milestone's entire purpose is negated. The orchestrator's default heuristic (crash or data corruption = blocking) is insufficient here. This gate adds an explicit purpose-aware blocking criterion.

**Step 1 — Extract milestone purpose:**
```bash
# PR title and milestone name were fetched in Phase 1A
# Examples: "Stealth Engine Overhaul", "Session Intelligence", "Billing Reconciliation"
# Derive the capability domain from the milestone/PR title:
#   "stealth" → detection avoidance, fingerprint consistency, proxy signal coherence
#   "performance" → latency, throughput, resource utilization
#   "billing" → charge accuracy, credit calculation, subscription state
#   "auth" → session validity, token correctness, permission enforcement
#   "session" → session state consistency, persistence, expiry
```

**Step 2 — Evaluate each finding for purpose regression:**

For each finding that is CONFIRMED or LIKELY at MEDIUM+ severity (already created as a GitHub issue in Phase 6), apply the purpose regression test:

> **The test**: "If someone described this milestone's goal in one sentence (e.g., 'Improve stealth to avoid bot detection'), would this finding represent the opposite of that goal?"
>
> - A **stealth milestone** + a CONFIRMED finding about a detectable signal/fingerprint mismatch → **PURPOSE REGRESSION** → BLOCKING
> - A **performance milestone** + a CONFIRMED finding about increased latency or higher resource usage → **PURPOSE REGRESSION** → BLOCKING
> - A **billing milestone** + a CONFIRMED finding about incorrect charge calculation or credit leak → **PURPOSE REGRESSION** → BLOCKING
> - A **stealth milestone** + a CONFIRMED finding about a formatting inconsistency or a missing log line → **NOT a purpose regression** → advisory only (still gets a GitHub issue, but does not block)

**Step 3 — Set verdict flag:**
```bash
HAS_PURPOSE_REGRESSION=false

# For each CONFIRMED/LIKELY finding at MEDIUM+ severity:
# Read the finding's title/description from the GitHub issue created in Phase 6.
# Apply the purpose regression test above.
# If the finding contradicts the milestone's stated capability improvement:
HAS_PURPOSE_REGRESSION=true
PURPOSE_REGRESSION_FINDINGS+=("Finding ID: ..., Reason: ...")
```

**Step 4 — Log result:**

If `HAS_PURPOSE_REGRESSION=true`:
```
PURPOSE REGRESSION GATE: BLOCKED
Reason: [finding] contradicts milestone goal "[milestone name]"
Verdict escalated to CHANGES REQUESTED.
```

If no purpose regression found:
```
PURPOSE REGRESSION GATE: PASSED
No findings contradict the milestone's stated purpose.
Verdict determined by standard blocking criteria.
```
