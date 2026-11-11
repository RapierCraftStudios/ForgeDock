---
status: fresh
anchor: bin/lean/testsandbox.mjs
created: 2026-11-11
---

# ADR: test sandboxes come from the validate `env`, not the lane execution provider

## Context

Lanes only tested what the host had, so a root cause needing Postgres, Redis or a service was mocked, skipped or deferred to prod (#5450). The test plan (#5445) that will declare `env` is not merged yet.

## Choice

- A frozen validate entry carries an optional `env` list of `verify.sandboxes` names. #5445 can fill the same field later, so nothing is reworked.
- `testsandbox.mjs` is a small provider over `docker` with injected I/O (a fake in tests). Containers register in the lane ledger as kind `container` (`ledger.mjs`), so the existing teardown loop and gc reclaim them; no new GC.
- An unknown name or missing Docker is a typed `needs-human` outcome (`env.tool_missing` for no Docker), never a skip (#5447).
- Per-lane isolation is by unique container names, ephemeral loopback ports and ownership labels; a per-lane docker network is not created (the ledger has no network kind), and nothing points at a project DB because the URL is always a fresh container.
- Image presence is checked once per lane batch process; Docker's own layer cache covers the rest.

## Rejected

- Reusing `execution.mjs` providers: they run whole lanes (clone and `run-issue`), not service containers beside a lane.
- Waiting for #5445: the field is optional and forward compatible.
