---
issue: 4572
status: fresh
anchor: scripts/review-staging-pre.sh
created: 2026-10-25
---

# ADR: staging gate and bundle retry transient gh reads

## Context

On a 146-PR bundle the gate made ~146 search-API reads (30 req/min) plus one label read per PR. Each run failed closed on a different random transient read error and posted `FORGE:GATE_FAILURE`. `bundle_pr_kind` failing transiently kept an issue number as a PR (fail open), and the gate then failed permanently on it.

## Choice

- `gh_retry [--search] CMD...` in `scripts/review-staging-pre.sh` (block `gh-retry`) retries up to `FORGE_GH_RETRY_ATTEMPTS` (default 6) with exponential backoff from `FORGE_GH_RETRY_SLEEP` (default 2s, capped at 16s per wait). `--search` triples the base for the search API.
- Used for the label read, the finding read (`fetch_findings`, which also fails on non-array output) and both identical `bundle_pr_kind` blocks.
- After the last attempt nothing changes: a persistent gate read failure still yields `READ_FAILURES`, `GATE_FAILURE` and `BLOCK DEPLOY` (never waived by an override), and `bundle_pr_kind` still fails open.

## Rejected

- Retrying only in the engine by re-running the review: a bundle of this size hits a transient error on nearly every run. This supersedes the "no retry in the gate" rejection in 4470.
