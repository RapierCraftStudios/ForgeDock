---
issue: 4775
status: fresh
anchor: bin/lean/schedd.mjs
created: 2026-10-30
---

# ADR: schedd stays observable under load and never races its systemd unit

## Context

On a loaded host the daemon stopped admitting work and answering its socket, and a client that auto-spawned a daemon during `systemctl --user restart` left an unsupervised daemon plus a unit restart loop (`already running`, exit 0, `Restart=always`).

## Decision

- `connectDaemon` consults the unit (`systemctl --user is-active forgedock-schedd`): active, activating or reloading is waited for, never spawned over; an installed but stopped unit is started; only without a unit does the client spawn. `spawnDaemon: null` callers never start anything.
- Under systemd (`INVOCATION_ID`), a daemon that finds a live lock owner stands by and retries when the owner dies, instead of exiting 0.
- `request()` takes an optional `timeoutMs`; `schedd status` and the control ops use 15 s and report "not responding" (non-zero exit). Submit/attach streams stay unbounded.
- `status` lists per batch `lastProgressAgeSec` (newest mtime of `state.json`/`log.jsonl`) and `pendingAdds`, including an unhosted daemon batch with un-admitted adds.
- A request waiting for a batch to start (add/requeue/attach, start-up resume) is bounded by `FORGEDOCK_SCHEDD_ADMIT_MS` (default 120 s); the start itself is not duplicated. An event-loop stall over 5 s is logged.
