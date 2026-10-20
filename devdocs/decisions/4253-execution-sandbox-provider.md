---
issue: 4253
status: fresh
anchor: bin/lean/execution.mjs
created: 2026-10-20
---

# ADR: lane execution behind a sandbox-provider seam, remote lanes outside the host cap

## Context

Every `forgedock orchestrate` lane was a detached local `run-issue` child (`batch.mjs` `launchLane`/`waitLane`), tracked by pid and counted against the host lane cap (#4191). One host bounds the lane count (#4170). A remote target needs a seam where launch, liveness, result fetch and teardown are not hard-wired to a local pid.

## Decision

- forge.yaml `execution: {mode, max_remote, provider, image, secrets}`, parsed like `verify`; default `local` keeps the detached-lane code path untouched.
- A provider interface `start/status/fetchResult/teardown` over a JSON handle that the batch state persists, so a resumed dispatcher adopts a sandbox without a pid. `providerLanes` owns the ledger discipline (#4179): register kind `sandbox` before `start`, release only after a successful `teardown`, teardown in `finally` on every path.
- Reference provider `container`: a local `docker run --rm --pull never` with its own clone of the checkout and a read-only shared cache mount, so the seam is tested end to end without cloud spend.
- Remote lanes are admitted per batch against `max_remote` and take no host registry slot; the batch K still applies.
- Secrets reach a sandbox only by name from `execution.secrets`, plus `GH_REPO` and `FORGEDOCK_BATCH_ID`; values are passed through the docker CLI's env (`-e NAME`), never argv.
- `forgedock gc` reaps stale `sandbox` ledger entries through the named provider; an unknown provider is reported, never reclaimed.

## Rejected

- Reusing the `container` ledger kind: the lane-internal teardown and gc would treat the sandbox like a builder test container, and a non-container provider (#4254) would have no kind.
- Remote slots in the host registry: the host cap bounds host load, which a remote lane does not add.
- Forwarding the dispatcher's env into the sandbox: it carries every credential of the host, not just the target repo's.
- The cloud adapter, sandbox cost and hybrid placement in this change: filed as #4254, #4255 and #4256.
