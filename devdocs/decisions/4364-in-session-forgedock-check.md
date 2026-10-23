---
issue: 4364
status: fresh
anchor: bin/lean/precheck.mjs
created: 2026-10-21
---

# ADR: the builder runs the engine's validate and pre-PR checks in-session (`forgedock check`)

## Context

Rework rounds were 39% of builder spend over 200 lane runs: pre-PR check failures, CI red after the PR and CI fix rounds, each a resumed session at $4.5–7.5. The engine ran its pre-PR checks and validate reruns only after the builder finished, and nothing recorded whether the builder had checked its final tree.

## Decision

- **One selection rule.** `precheck.mjs` `planPrecheck` (test-map scoping over `learned.test_commands`, round budget, per-command timeout) is called by the engine's pre-PR round and by `forgedock check`, so both run the same commands by construction. A real-git e2e test runs both on one worktree and compares commands and verdicts.
- **Plan hand-off file.** The engine writes `.forge-lean/check-plan.json` beside `contract.json`. forge.yaml is gitignored and read from the operator checkout, so the worktree cannot be trusted to have it.
- **Content fingerprint, not HEAD.** `self-check.json` stores a hash of every path differing from the merge base (path + blob sha, committed or not). A builder that checks and then commits is still green; any edit after the check makes it stale.
- **A record, not a gate.** `SELF_CHECK_MISSING` and `PRECHECK_COMMANDS.self_check` are run-log fields. The engine's precheck, conformance and CI are unchanged and authoritative.
- **No engine heavy slot from the CLI.** The builder's PATH already has the heavy shims, which gate each heavy binary; taking a slot per command as well would double-gate.

## Rejected

- Read forge.yaml from the worktree: gitignored, so absent in a lane.
- Compare HEAD shas: every commit after a green check would read stale.
- Fail or resume the lane on a missing self-check: it would add a builder turn, the cost this issue removes.
- Extend `checks.mjs`: it discovers the repo's own scripts, which is a different command set from the engine's.

## Cost

0 LLM calls added; one prompt rule (~80 tokens). The builder's check turns replace resumed sessions when they catch a failure first.
