---
issue: 4180
status: fresh
anchor: bin/gc.mjs
created: 2026-10-20
---

# ADR: `forgedock gc` reclaims only what ForgeDock provably owns, dry-run by default

## Context

Lanes leave containers, volumes, worktrees, branches, scratch dirs and processes behind (#4156). Since #4179, a lane that dies keeps its ledger (`~/.forge/ledger/<batch>/<lane>.json`). Until now nothing read those ledgers, and `gc` only pruned `~/.forge/tmp/runs`.

## Decision

`bin/gc.mjs` plans first and applies only when `--apply` is given. A resource is owned only through one of these:

- **A stale ledger:** the owner pid is dead on this host, or the ledger has expired on another host. A live owner on this host is never stale, even after `expires` has passed, because a long CI wait only refreshes `expires` on register.
- **The `forgedock.owner=1` docker label:** reclaimed once `forgedock.expires` has passed, or once the container or volume is older than `--older-than`.
- **Lane naming:**
  - `lean-*` and `agent-*` dirs under `<repo>/.claude/worktrees`.
  - `feat/issue-<n>-lean` branches whose issue is closed or does not exist, older than the TTL.
- **ForgeDock's own scratch:**
  - Run dirs with the `.forge-run-owner` marker (same rule as `makeRunTmp().prune`, #4104).
  - Runner scratch `~/.forge/tmp/<repoKey>/<issue>` older than the TTL with no live process inside.

The following are always reported and never touched:

- uncommitted or unpushed work, and dirs that git cannot inspect but that are not empty;
- live processes inside a dir;
- `main`, `master`, `staging`, `milestone/*` and the forge.yaml branches;
- branches that are the head of an open PR, or any branch when open PRs cannot be listed;
- unlabelled containers and volumes;
- unrecognised entries in `~/.forge/tmp`;
- pids that are not re-parented to PID 1.

If a probe fails, the item is reported. A probe failure never leads to a reclaim.

## Rejected

- **`docker system prune` / `docker volume prune`:** these delete the user's own unlabelled resources.
- **Deleting by age alone:** age does not prove ownership, and it would discard unpushed work.
- **Reaping `/tmp/claude-<uid>`:** that dir belongs to the operator. ForgeDock-spawned Claude scratch already lives in the run tmp (`CLAUDE_CODE_TMPDIR=runTmp`).
