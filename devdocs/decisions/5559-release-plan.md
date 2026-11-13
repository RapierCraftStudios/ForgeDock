---
status: fresh
anchor: bin/lean/release-plan.mjs
created: 2026-11-13
---

# ADR: `release plan` (deterministic dry-run planner)

## Context

The managed release needs a reviewable plan an approval can bind to (#5559, epic #5549, I2).

## Decision

- `buildPlan` is pure: issues + policy + live sha in, waves/exclusions/`plan_hash` out; input order never matters.
- Exclusion keys are evaluated in this order: `epic`, `plan.skip_labels` (batch defaults, `parked:*`, `hold`), `design_gate`, `ready_no`, `unclassified` (after the optional `investigate` seam), `lane_force_exclude`, `dependency_cycle`, `dependency_open`, then `p0` (surfaced as "call p0") and `max_issues` after wave formation. PRs and `release-plan` tracking issues are never candidates.
- `plan_hash = sha256(stableJson({snapshot[number, updated_at, body_sha], policy_sha, live_sha, lane_forces?}))`. Any change yields a new hash; honoured `lane --force` entries are hashed too.
- Approval is a `<!-- FORGE:DECISION plan <hash> -->` comment on a `release-plan` issue from an actor in `trust.actors`; an old hash reads `stale`, untrusted authors are ignored (none trusted = nobody).
- `lane --force` entries (actor, `until` or 24h after `at`) are honoured only when unexpired and trusted.
- Persistence: `plan` is read-only (`gh issue list`, `gh repo view`, the live-release command). Only with `release.managed` is the record written, via the ledger writer.

## Consequences

`explain #N` reports the plan outcome when given a plan. The AlterLab snapshot review (R17) is an owner check.

- `recordOf` drops `<!-- ... -->` spans by index scan (an unterminated one drops the rest), not a regex sanitizer, before reading the CLASSIFY JSON (CodeQL, release #5676).
