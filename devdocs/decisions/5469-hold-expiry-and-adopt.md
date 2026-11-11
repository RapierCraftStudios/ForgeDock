---
status: fresh
anchor: bin/lean/batch.mjs
created: 2026-11-11
---

# ADR: holds carry an owner and an expiry; hand-built PRs are adopted

## Context

`orchestrate --hold` (#4592) was a bare list of issue numbers. When a batch ran out of other work it ended with the held issues pending, `schedd status` printed "not hosted but has N pending" for every such batch, and a hand-built PR for a held issue was never reviewed, base-synced or merged (#5469).

## Choice

- The `hold` file stays a sorted integer list (legacy readers and `--resume N` unchanged). A sidecar `hold-info` file records `{owner, since, expiresAt, reason, ownerPid, ownerHost}` per issue (`batch.mjs` `holdIssues`, `readHoldInfo`, `expireHolds`).
- `--hold <id> N... --for 4h --reason "..."` sets the expiry. The runner calls `expireHolds` on every pass; an expired hold is released and the issue is admitted. A dead owner session (pid gone on this host) also emits a `hold-alert` row.
- A batch that ends with held issues names `(owner, since)` in each held row. `batch-health` flags holds older than 4 hours (`stale-hold`) and the first-hour report lists them.
- `schedd status` collapses unhosted batches idle over 7 days into one `orphaned` line; `orchestrate --gc-orphans` cancels them (`schedd.mjs` `findUnhosted`).
- `orchestrate --adopt <issue>` runs the single-issue lane with `adopt: true`: it finds the open PR to the lane base that references the issue from a branch the pipeline did not use, takes its head branch as the lane branch, skips plan and build, and goes on to review, base-sync and merge. issue-watch launches it automatically for an open closing PR from a foreign branch (single mode only).

## Rejected

- Changing the `hold` file format: it would break existing readers and holds written by an older ForgeDock mid-batch.
- A new pipeline for adoption: the lane already resumes an existing PR and has a no-builder path (`refactor:split`).
