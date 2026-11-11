---
status: fresh
anchor: bin/lean/preflight.mjs
created: 2026-11-11
---

# ADR: a declared test that cannot run blocks the merge

## Context

AlterLab #40538 merged with a validate that could not run (pytest missing) and #40566 logged a failed install with no consequence. A CI-verified head also covered a missing-tool validate although CI may not run that test.

## Decision

Reuse `env.tool_missing` (kinds `validate_env`, `dep_install`) instead of a new outcome code: it is already in `ENV_CODES`, the recoverable and engine-owned lists. CI no longer covers `validate_env`. One provisioning pass and a fresh `gate()` run before the lane ends needs-human. The helpers live in `preflight.mjs` because tests enumerate the `bin/lean` files and the `conformance.mjs` exports. `test_plan.env` is deferred to #5445.

## Rejected

A new outcome code (edits every code list); a new `bin/lean` file (breaks the sibling-file lists); blocking every failed install (unrelated packages are only logged).
