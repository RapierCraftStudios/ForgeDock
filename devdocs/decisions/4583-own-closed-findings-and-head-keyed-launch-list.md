---
issue: 4583
status: fresh
anchor: devdocs/modules/lean.md
created: 2026-10-25
---

# ADR — Only a PR's own closed findings resolve; the launched list proves a panel only for its head

## Context

The v1.34.0 staging review (#4582) found that #4569's DELTA `skip-resolved` matched any closed `review-finding` issue
within ±5 lines, repo-wide (`CLOSED_JSON`, last 100), so a new CONFIRMED HIGH next to an unrelated old fix was neither
filed nor counted. #4573's `--delta-from` completeness proof read `<PR>_launched_review_agents`, which the next dispatch at
another head rewrites, so it could vouch for a panel it never described. `normalizeAmendment` (#4574) looked slips up on a
plain object, so `kind: "constructor"` matched `Object.prototype`.

## Decision

- file-prepare marks a DELTA closed match `skip-resolved` only when that issue is this PR's own: its title ends `PR #N)` or
  its body has a `**Source**: PR #N` line. Any other closed same-location issue keeps the P1-regression path (filed, blocks).
- `review-staging` writes `<PR>_launched_review_agents.head` (the dispatch head) when it truncates the list;
  `review-prepare.sh --delta-from X` uses the list as proof only when that file names X. A missing sidecar is no proof.
- `normalizeAmendment` uses `Object.hasOwn` for the slip table.

## Alternatives

Filtering `CLOSED_JSON` itself to this PR would also drop the cross-PR regression signal on FULL runs, which #4569 kept on purpose.
