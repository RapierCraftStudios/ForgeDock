---
issue: 4626
status: fresh
anchor: bin/lean/postdeploy-check.mjs
created: 2026-10-26
---

# ADR: named default-branch checks for post-deploy requirements

## Context

A post-deploy requirement became a follow-up issue that went to a builder lane, which could not run a deploy-time
measurement and escalated to a human (#4415, #4421, #4438, #4488, #4495, #4498). The #4399 probe runs commands, but it
reads them from issue text, which bot-filed follow-ups quote from untrusted PRs (#4468).

## Choice

- A post-deploy requirement carries `check`, an id. The command lives in `.forge/post-deploy-checks.json`
  (`{"<id>": {"run", "pass", "timeout"}}`), read with `git show origin/<default>:<file>`: reviewed default-branch code.
- `validateContract` and the `post-deploy` amendment need a well-formed id. `precheck` rejects an id that is in neither the lane
  base's checks file nor this PR's (`checkIds`, resolved in `lean.mjs`). `followupItems` writes `post-deploy: [check:<id>] why`.
- The pre-filter gate (#4389) is the one "ready" signal. When ready, `measureFollowup` runs each item's check with the probe
  runner (minimal env, timeout, masked output), no model call. All pass: a `FORGE:PROBE` record and the follow-up closes. A fail:
  the record, and the parent reopens with the output; a recorded fail for the same fix is not re-run (`check-failed`, parked).
- An item with no check id, or an id the default branch does not define, parks `awaiting-measurement` (label, one
  `FORGE:PRECONDITION` comment, report line). It never gets a lane and `needs-human` is never removed. A missing id is a pure
  fact, so it parks before any git call.
- Migration: the six open follow-ups have no ids, so the next `forgedock triage` labels them `awaiting-measurement`.

## Rejected

- `forge.yaml` `post_deploy.checks.<id>`: `parseForgeYaml` reads two levels, and the issue allows a checks file.
- Reusing `declaredProbe`: it reads issue text.
- The working tree's checks file: a PR could add a check it then runs; only the default branch's runs.
