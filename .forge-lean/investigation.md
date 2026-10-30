**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (missing feature; operators hand-group releases today)
**Task Type**: feature

### What Was Claimed
`issue-watch` needs `mode: release`: pool eligible issues, fire on a threshold (min_issues, weighted score, max age, immediate class), classify the pool into themes deterministically (LLM only for unclassified, counted), pick a theme plus its `Depends on` closure under `max_release_issues`, post `FORGE:RELEASE_PLAN`, tag the set (milestone or label), run it as one batch, open a deploy PR (never merged by the watch), roll the remainder over with age kept, and support `--dry-run`.

### What We Found
- bin/lean/issuewatch.mjs:21 `WATCH_KEYS` has no `threshold`, `immediate`, `max_release_issues`, `theme_map`; unknown keys throw (:57).
- bin/lean/issuewatch.mjs:67 `mode` only accepts `per-issue|batch`.
- bin/lean/issuewatch.mjs:35-50 `parseWatches` reads only `key: scalar` / flat `[a, b]` lists at depth 4+; no flow maps (`threshold: {…}`), no nested `theme_map:` block.
- bin/lean/issuewatch.mjs:184-243 `tick` claims immediately up to `max_inflight`; no pool, thresholds or themes. Batch plumbing (`io.batch.start/add/reported`, :228-232, :204) and `claimIssue` (:161) are reusable.
- bin/lean/issuewatch.mjs:129 `dagOrder` parses `Depends on #N`; no closure computation exists.
- bin/lean/issuewatch.mjs:120 `laneFor` already refuses default-branch lanes; bin/lean/issuewatch.mjs:294 CLI has no `--dry-run`.
- bin/lean/decision-engine.mjs:20,47 `loadPolicy` reads NORTHSTAR.md (policyText); no priority/tie-break extractor exists. Decision-engine `settle` is a different (escalation) flow.
- No `FORGE:RELEASE_PLAN` anywhere in bin/ (grep). Existing PR creation lives in bin/lean/lean.mjs / milestonesync.mjs, not in issuewatch.
- docs/ISSUE-WATCH.md and docs/CONFIG.md:627 document only #4765 keys.
- The earlier FORGE:INVESTIGATION comment on the issue (Windows argv/stdin, runner.mjs) is about a different issue; ignore it. The stale `.forge-lean/result.json` (#4778) was removed.

### Root Cause
Feature absent: the watch is claim-immediately only, with no pooling or release decision layer.

### Affected Files
- bin/lean/issuewatch-release.mjs (NEW): pure pool/threshold/theme/closure/plan logic + `releaseTick`.
- bin/lean/issuewatch.mjs (hotspot, 320 lines: wiring only): keys, validation, nested-config parse, `mode: release` dispatch, `--dry-run`.
- bin/lean/issuewatch-release.test.mjs (NEW), bin/lean/issuewatch.test.mjs (parse/validate additions).
- bin/forgedock.mjs:3362 usage line; docs/ISSUE-WATCH.md; docs/CONFIG.md.

### Sibling Sweep
`grep -rn "issuewatch" bin` : only forgedock.mjs:4211 dispatch and docs. Priority weights (P0..P3) have no existing helper; labels may be `P0` or `priority:P0` (accept both). Milestone-title slug via `milestoneSlug` (lane.mjs) for `release/<theme>-<date>`.

### History
issuewatch.mjs introduced by 2245e525e (#4765), renamed export in 15796c8dc. Decision engine #4766 landed. No prior release-mode attempt.

### Recommendation
Keep issuewatch.mjs small: add `bin/lean/issuewatch-release.mjs` with pure functions (`score`, `triggers`, `classifyTheme`, `closure`, `pickRelease`, `releasePlanComment`) and `releaseTick` that reuses `claimIssue`, `dagOrder`, `laneFor` and the `io.batch` seam. Extend `parseWatches` for one more nesting level and flow maps. LLM fallback via injected `io.classify` (count stored in state). Theme tie-break/priority from NORTHSTAR text: deterministic parse of an optional `Release priorities:` ordered list in NORTHSTAR.md (via loadPolicy), else score then name. Tag via `gh api` milestone create (milestone targets) or label create+edit (staging). Deploy PR via `gh pr create --base <default> --head <lane>`, once (state.deployPr), never `pr merge`. Dry run is a pure print with no gh writes.

### Related Issues
#4765 (watches, merged), #4766 (decision engine, merged), #4768 (production watcher, downstream).
