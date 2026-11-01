---
issue: 4771
status: fresh
anchor: scripts/review-delta.sh
created: 2026-10-30
---

# ADR: a complete roster panel is a delta checkpoint without a Phase 7 artefact

## Context

`review-delta.sh` accepted a SHA as a checkpoint only with a post-panel-guard proof (synthesized body or `# PR Review Summary`). A fix commit pushed after all reviewers posted but before Phase 7 left no proof, so the next run resolved to FULL (`FULL_ROUNDS=0`) and re-reviewed the whole diff.

## Choice

A SHA is also proven when a trusted `FORGE:REVIEW_TIER` comment posted before its first agent body lists a non-empty `Roster: a b c.` and every listed domain has a trusted, complete-shape agent body at that SHA. The tier comment is a GitHub comment (the register), trust still comes from `trusted-comments.sh`. The SHA counts in `FULL_ROUNDS` and `last`. A degraded marker after the first agent body, or the `review-degraded` label, still forces FULL; `Roster: none (...)` is no proof.

## Rejected

- The launched-agents file: written only by review-pr-staging and scratchpad-local.
- Requiring the verdict: a mid-review fix commit would forfeit delta mode.
