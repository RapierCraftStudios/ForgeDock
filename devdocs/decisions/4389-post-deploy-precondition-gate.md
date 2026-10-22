---
issue: 4389
status: fresh
anchor: bin/lean/prefilter.mjs
created: 2026-10-23
---

# ADR: deterministic post-deploy precondition gate in the pre-filter

## Context

Deferred follow-ups whose items are all post-deploy checks got a full lean lane even when the parent's fix had not reached
the default branch. In AlterLab batch b20261022-183421-1103229, 26 of 32 needs-human lanes ended with "fix on staging, not
on main" (~$0.30 and 2 min each), and each one was a separate escalation for a single decision (promote).

## Choice

- The gate lives in `prefilterIssue` (`bin/lean/prefilter.mjs`), shared by orchestrate and `forgedock triage`. It makes
  no model call: `git merge-base --is-ancestor <parent merge SHA> origin/<default>`.
- Eligible: `FORGE:DEFERRED_FROM: #P` and every checklist item's disposition is `post-deploy`. A mixed follow-up (any
  `defer:` code item) is untouched.
- It runs before the `needs-human` early return, so follow-ups an earlier lane already escalated for promotion are
  parked too. It never removes `needs-human`.
- The parked state is a plain `awaiting-promotion` label plus one `FORGE:PRECONDITION` comment, and an
  `awaiting-promotion` row and report line. Re-evaluation needs no stored state: the next run checks again.
- Fail-open on anything uncertain (no SHA, git exit other than 0/1, unknown default branch, hook error or timeout).
- `post_deploy.precondition_cmd` covers non-git readiness (rollout state). Exit 1 means "not ready"; any other non-zero
  exit is treated as a broken hook and fails open.

## Rejected

- Letting the LLM lane find it (today): ~$0.30 per issue and an escalation each.
- A FORGE:STATE field: invisible in the issue list. A label is filterable and needs no lease.
- A `workflow:*` label via `transition-label.sh`: those are lane-managed states and would fight the lane's transitions.
- Closing the issue: the follow-up's checks still need doing after promotion.
- `post_deploy.min_age` now: it needs when the SHA reached the default branch and a window parsed from free text. Deferred.
