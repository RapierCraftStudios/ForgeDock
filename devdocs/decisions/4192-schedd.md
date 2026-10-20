---
issue: 4192
status: fresh
anchor: bin/lean/schedd.mjs
created: 2026-10-20
---

# ADR: one schedd daemon hosts every orchestrate batch

## Context

Each `forgedock orchestrate` was its own dispatcher process for the life of its batch, at about 80 MB each (#4166 baseline: 27 runner and engine processes, 2.2 GB in total). The batch state (`~/.forge/batches/<id>/`), the host registry (#4191) and the account holds (#4190) were already host files. Only the process was per batch.

## Decision

- `bin/lean/schedd.mjs`: one daemon per host, made single instance by a pid lock plus a unix socket in `~/.forge/sched/`. It runs each batch's `orchestrate()` through `engine-cli.mjs` `runBatch` (the former `orchestrateFromCli` body, now parameterized by `cwd`, `env` and an output sink).
- `orchestrate` becomes a client: it submits, streams rows and returns the same result. Ctrl-C only detaches. `--resume` attaches (replay `log.jsonl` then go live, replay `report.json` when done, resume when orphaned or held). `--set-parallel` goes through the daemon.
- Auto-spawned by the first client and exits when idle (10 min), so a host that stops orchestrating has no resident process. A systemd-user unit is optional (`ExecStart=forgedock schedd`).
- Restart: the daemon resumes every daemon batch without a report. Live lanes re-attach through the existing `adopt`, and a tripped breaker stays tripped (only an operator `--resume` resets it).
- Env: lanes need the submitting shell's account. Only an allowlist (paths, `FORGEDOCK_*`, `CLAUDE_*`, `ANTHROPIC_*`, `GH_*`, `GITHUB_*`) is kept in `plan.json`, so a restarted daemon relaunches on the same account.

## Rejected

- Running the lane engines in the daemon too: this would collapse the `run-issue` processes as well, but a lane crash would take every batch down, and lanes must outlive the scheduler (non-negotiable 5).
- A TCP port: a unix socket under the user's home is private to the user and needs no port allocation.
- A mandatory systemd unit: not portable (macOS, containers). Auto-spawn works everywhere.
- Persisting the full env: it would store unrelated secrets on disk. The allowlist covers account selection.
