---
status: fresh
anchor: bin/lean/admit.mjs
created: 2026-11-28
---

# Decision: 1.72 release-review P1s in the admit probe and docker-dns repair (#6231 #6232 #6233 #6234)

**What**
- #6231: one exported `NON_STOPPABLE_CODES` / `isNonStoppable` / `stampable` in `bin/lean/admit.mjs` is the only non-stoppable list. The stamp writer, the fingerprint stop reader and lean.mjs's repeat counter all use it. It covers engine.*, sandbox.*, lane.*, infra.*, backend.*, net.*, gh.*, env.setup_failed and the other env/deferred codes, so a rerun after the operator fixes the cause is admitted.
- #6232: the base.red check matches the failing check's name as a whole token. An issue is the fix (admitted) when its text, frozen contract or deliverables name a file from the failing output (or one in the same directory), or it is labelled `base-red`, or it carries a trusted FORGE:BASE_RED comment.
- #6233: the claude login probe runs with the lane's env. Only the documented logged-out signal (exit 1 with "Not logged in" or `loggedIn: false`) is `backend.auth`; any other non-zero exit, timeout or missing binary is unknown, the probe fails open and an anomaly records the warning.
- #6234: the docker DNS repair holds admission on the agent across the idle check and the restart, and restarts dockerd only with no sandbox and no running container at all on the daemon (co-tenants included). daemon.json is written only at that moment and restored if the restart fails.

**Why**: the 1.72 one-pass review found each of these could strand a healthy lane (a stamp on a transient park, a substring check name, a false login failure) or kill other tenants' containers (a restart after a racy idle check).

**Alternative**: a daemon-wide resolver pin on every DNS failure (rejected: it restarts the shared dockerd and pins public resolvers permanently). Lane containers already get a per-container `--dns` (agent `netArgs`), so only dockerd's own pulls need the daemon fix, and that waits for a fully idle daemon.
