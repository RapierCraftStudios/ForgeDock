**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (missing feature: without a governor the prod-watch loop can storm the tracker)
**Task Type**: feature

### What Was Claimed
Add `bin/lean/prodwatch-governor.mjs` with `admit(clusters, {governor, state, openProdIssues, now})` returning `{file:[], summary:null|{title, body}}`, enforcing `max_issues_per_hour`, `max_open_prod_issues`, `max_cost_usd_per_round`, filing ONE summary issue on overflow, incidents before defects, and documenting the mapping to signal-planner's `max_issues_per_run`/`max_cost_usd`.

### What We Found
- `bin/lean/prodwatch-governor.mjs` does not exist (`ls bin/lean | grep prodwatch` lists only sources and triage files).
- Cluster shape to consume is produced at `bin/lean/prodwatch-triage.mjs:49-64` (`fingerprint, signals, count, first_seen, last_seen, severity, owner, duplicateOf`); `validateCluster` (:103) adds `class` (incident|defect|...), `fileable`, `reason`; `signalRef(fp)` at :35.
- signal-planner Phase 0 (`commands/signal-planner.md:18-19, 66-99`) defines `governor.max_issues_per_run` (default 10) and `governor.max_cost_usd` (default 5.00) as hard per-run caps.
- The enclosing comments on #4835 carry an unrelated investigation (relay answer 413, `bin/lean/relay.mjs`); it does not apply to this issue and is ignored.
- Dep #4834 is merged (HEAD 5d9dd72ab).

### Root Cause
Feature not yet built; triage output is unbounded, so a storm of fileable clusters would each become an issue.

### Affected Files
- bin/lean/prodwatch-governor.mjs (new)
- bin/lean/prodwatch-governor.test.mjs (new)
- devdocs/modules/lean.md (module dossier entry, freshness check)
- docs/ (or the lean.md entry) for the key mapping to signal-planner
- Enumerating tests (literal sibling lists in bin/lean) that must still pass; a new file there is a non-member as with prodwatch-triage (#4834 chore 28d2de202): bin/engine/telemetry-seam.test.mjs, bin/lean/batch.test.mjs, checks.test.mjs, conformance.e2e.test.mjs, conformance.test.mjs, context.test.mjs, drift.test.mjs, execution.e2e.test.mjs, execution.test.mjs, fixround.test.mjs. None needs editing unless one scans the directory; run them to confirm.

### Sibling Sweep
Other prod-watch modules (prodwatch-sources, prodwatch-triage) are pure with injected io; the governor follows the same style. Siblings #4837 (metrics, drop to shadow) and #4838 (runner) will consume `admit`; keep return shape exact.

### History
Triage landed in 47fdba653 / 26d39c77d (#4834); issue-watch caps pattern in issuewatch.mjs (#4765).

### Recommendation
One lane, one pure module + test + dossier/doc update. `admit`: drop non-fileable/duplicate clusters; order incident first, then defect, others after (stable by severity then count); walk in order with remaining = min(hourly budget = max_issues_per_hour − filings in state within 60 min of now, max_open_prod_issues − openProdIssues.length, cost budget = floor(max_cost_usd_per_round / per-cluster cost)); admitted go to `file`; the rest go into ONE summary `{title, body}` listing deferred clusters (fingerprint, class, severity, count) with the SIGNAL_REF marker only for... none (summary must not embed fingerprints so deferred clusters stay re-admittable). Summary suppressed if an identical open summary exists (state.summary_open) to avoid a storm of summaries. Overflow with budget 0 still yields one summary.

### Related Issues
#4768 (parent, closed), #4833, #4834 (deps, merged), #4837, #4838 (consumers, open), #1347 (repo-agnostic core).
