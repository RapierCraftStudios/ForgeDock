---
issue: 4471
status: fresh
anchor: scripts/review-prepare.sh
created: 2026-10-23
---

# ADR: `--delta-from` credits only a complete, non-degraded earlier pass

## Context

`review-prepare.sh --delta-from <sha>` (#4360, `forgedock review-staging --delta`) credited the earlier pass when one trusted `FORGE:REVIEW-AGENT` comment named `<sha>`. A degraded pass, where one agent posted and the integrity guard then posted `review-panel-integrity` and labelled the PR `review-degraded`, could be credited, so the delta pass could end in `FORGE:GATE_PASS`. `scripts/review-delta.sh` already has the rules a checkpoint must meet. #4360 bypassed it because it does not recognise the staging summary.

## Choice

The `--delta-from` branch ports the resolver's checkpoint rules and fails closed (BLOCKED) unless all of these hold:
- a trusted agent body for `<sha>` has a findings block;
- a trusted post-panel-guard proof names `<sha>`. The proof is the staging summary (`<!-- FORGE:GATE_PASS|GATE_FAILURE -->` + `## Staging Review:` + **Head** `<sha>`, posted only after the `review-staging-post.sh delivery` guard), a synthesized findings block, or a `# PR Review Summary` whose **Agents** count equals the distinct domains;
- no trusted `review-panel-integrity` / `REVIEW_DEGRADED` / `REVIEW_BLOCKED` marker was posted after the first agent body for `<sha>`;
- the PR has no `review-degraded` label (read from the Phase 1A `gh pr view`);
- the delta does not touch the resolver's review spec/config list. The list is copied from `scripts/review-delta.sh`, and a drift test in `review-prepare.test.sh` keeps the two equal.

## Rejected

- Calling `review-delta.sh` with a fixed checkpoint. It answers FULL for every staging PR (no staging-summary proof), and #4360 rejected changing the shared trust proof.
- Widening to FULL instead of blocking. An explicit delta would silently become a full-panel spend; the branch's rule is that every check blocks, and only an empty delta widens.
