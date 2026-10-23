---
issue: 4399
status: fresh
anchor: bin/lean/probe.mjs
created: 2026-10-23
---

# ADR: outcome-based acceptance — a declared probe runs after promotion and reopens on failure

## Context

A lean lane closes its issue when the PR merges into the lane branch (`bin/lean/lean.mjs`), and promotion to the default branch is a human-merged release PR the engine never observes. AlterLab#35907 closed green after fixing one path; the same billed false success reproduced on the next deploy (AlterLab#36619). Nothing checked the production outcome.

## Choice

- An issue declares a probe in a fenced `forge-probe` block (`run:`, `pass: exit 0 | /regex/`, `timeout:`). Only human declarers' declarations run (`isProbeDeclarer`, #4468: a trusted association or `FORGE_TRAIL_TRUSTED_LOGINS` login, never a Bot/App, the engine included) and only from a top-level fence (a block nested in another fence or indented as code is quoted content); fail closed, because the command runs on the operator host.
- The fix commit comes from the trusted FORGE:TRAJECTORY `merged at <sha>` (the reviewed head; the lane merges with `--merge`, so it reaches the default branch exactly when the merge commit does), else the latest merged closing PR's merge commit. Promotion = `git merge-base --is-ancestor <fix> origin/<default>`.
- The probe runs as `sh -c` with a minimal env plus forge.yaml `acceptance_probe.env` (the designated test identity), masked in the output. The result is a `FORGE:PROBE` comment, idempotent per fix commit; a fail reopens the issue first.
- Triggers: a sweep at the start of every `forgedock orchestrate` batch (one search, deterministic, `--no-probes`) and `forgedock probe [issue...]`.
- The pre-filter treats a latest FORGE:PROBE fail as `probe-failed` and never re-closes the issue as already-fixed: the merged PR that "fixed" it is exactly the signal that would.

## Rejected

- A GitHub Action on push to the default branch: costs Actions minutes, and the Action has no host test identity.
- An LLM verification lane after promotion: the outcome is a fact a command can decide (NORTHSTAR: deterministic first).
- Running probes when the lane merges to staging: the production outcome does not exist yet.
- Reusing the FORGE trail predicate (`isTrustedActor`) for declarations (#4468): it trusts every Bot so engine markers count, and bot-filed issues quote untrusted PR content, so a quoted block became host command execution.
- Parsing arbitrary prose acceptance criteria: not deterministic; the issue author states the command.
