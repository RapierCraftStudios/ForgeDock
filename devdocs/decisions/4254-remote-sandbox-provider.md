---
issue: 4254
status: fresh
anchor: bin/lean/sandbox-remote.mjs
created: 2026-10-20
---

# ADR: generic remote sandbox provider over a small HTTP protocol

## Context

#4253 added the sandbox-provider seam with a local reference `container` provider. Lanes must also run on a cloud runner pool or a remote agent session (#4170) without tying ForgeDock to one vendor or one operator's setup, and ForgeDock's own repos must not spend pre-review GitHub Actions minutes. A sandbox that failed to start ended `engine-error`, which orchestrate relaunches and counts toward its breaker.

## Decision

- One `remote` provider (`sandbox-remote.mjs`) over a transport interface (`launch/status/logs/result/usage/destroy`). The shipped transport is a small JSON-over-HTTP protocol (docs/CONFIG.md); any pool or session gateway can front it. The sandbox is addressed by ForgeDock's id, so the ledger entry written before launch is enough to tear it down (#4253 discipline unchanged).
- Credentials (the API token and the repo's allowlisted secrets) come from the env, else the OS keychain (`credentials.mjs`). The token goes only into the `Authorization` header; secret values only into the launch spec env; streamed logs are redacted.
- `remote` is never a default provider, and an Actions endpoint is refused unless `allow_actions: true`.
- A start failure is typed: `needs-human` `sandbox.start_failed` (final, no relaunch, no breaker), or `deferred` `sandbox.capacity` when the transport reports no capacity (429/503).
- Billable minutes ride on the handle and the lane result; reporting and the budget cap are #4255.

## Rejected

- Vendor SDK adapters in core: ties ForgeDock to one provider's account and setup.
- An Actions-dispatch provider as a default: spends pre-review Actions minutes implicitly.
- Keeping start failures as engine-error: the relaunch repeats a deterministic failure and trips the breaker for an infrastructure fault.
- Sending the transport credential inside the launch spec: the sandbox only needs the repo's scoped secrets.
