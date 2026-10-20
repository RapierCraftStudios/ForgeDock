---
issue: 4160
status: fresh
anchor: bin/lean/conformance.mjs
created: 2026-10-20
---

# ADR: the engine fills reviewer bookkeeping; shadow mode no longer merges unusable reviews

## Context

Across 60 merged lean issues on one private monorepo, 69% of shadow verdicts were `review.incomplete`, 75% of runs needed a second full reviewer call, and the gate could never move to `enforce`. Most incompletes were bookkeeping, not defects: a missing preserve row, a basename as evidence (`route.ts:12`), a base-sync merge file without a scope row. Three shadow-only paths also merged real failures: a precheck `conformance.unimplemented` never blocked, `review.incomplete`/`review.inconsistent` after the retry became `conforms`, and accepted deferrals were never filed.

## Decision

- The engine fills what it can compute (`fillEngineRows` in `conformance.mjs`, called first in `decide()`): a scope row per changed file from the contract's own authorization (`none` when unauthorized, still scope creep), a preserve row per id as `unverified` (still `preserve_violated`), and `implemented` evidence rewritten to `repo/path:line` (`normalizeEvidencePath`: a basename or suffix resolves to the one changed or repo file; an ambiguous name is left unchanged). The evidence regex finds `path:line` anywhere in the text.
- `reviewerPrompt` embeds a row skeleton for every R/P/scope/coverage id (`reviewSkeleton`).
- `checkCompleteness` returns `missing` ids. A retry is a targeted re-ask (`reviewerRepairPrompt`): only the missing ids, the exact problems and the previous rows, no diff. Its rows merge into the first reply (`mergeReviewRows`). An unparseable reply still gets the full prompt again.
- `changedFiles()` in `lean.mjs` keeps only files that still differ from the base tip, so base-sync merge files drop out of the scope check.
- Shadow mode blocks on every precheck or amendment failure coded `conformance.unimplemented` or `conformance.regression` (`SHADOW_PRE_BLOCKS = SHADOW_BLOCKS`), with the same one builder resume then needs-human. Scope creep stays recorded-only. The would-verdict still carries the full failure list.
- A review that is still `review.incomplete`/`review.inconsistent` after the re-ask ends needs-human in shadow as in enforce. `forge.yaml engine.review_incomplete: degraded` (shadow only; `readReviewIncomplete`) merges instead with the `review-degraded` PR label and a tracked follow-up, shown in the shadow FORGE:REVIEW comment.
- Shadow files accepted deferrals with `track()` like enforce (the `unfiled` list is gone from `renderShadowReview`).
- `scripts/calibration.mjs --shadow` reads FORGE:REVIEW shadow verdicts per repo and prints the mix. It recommends `enforce` only with at least `--min-runs` (20) shadow reviews and a would-block-on-incomplete share under `--threshold` (0.10).

## Consequences

- No new LLM calls; the repair call is smaller than a full re-review. Enforce behaviour is unchanged.
- Shadow can now stop merges it used to allow (unimplemented precheck, unusable review). `degraded` is the explicit opt-out.
- The fill rules trade strictness for fewer false incompletes: an unrecorded preserve row counts as `unverified`, and a file the contract authorizes needs no reviewer row.
