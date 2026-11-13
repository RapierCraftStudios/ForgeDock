---
status: fresh
anchor: bin/lean/release-regate.mjs
created: 2026-11-13
---

# ADR: gate-only fix lane (`release control regate`)

## Context

A gate fix needed a new merge cycle because the smoke ran the previous release's script (#5584, epic #5549 N5, rule R4).

## Decision

- `classifyGateOnly` (`release-regate.mjs`) is gate-only when every changed path matches `gates.paths` (defaults in `release-gates.mjs`). Migration, image and app paths flip to the normal lane; a workflow file qualifies only if every changed hunk lies in a step named in `gates.workflow_steps`.
- The `regate` verb of `release-control.mjs` refuses closed: no recorded live record/rollback target, a run-set freeze with migration evidence, a non-gate-only diff, or a ref already re-evaluated.
- It then audits to `controls.jsonl` (gate-script sha, ref, sha, actor; `regates` in `_active`) and sends one `fenced()` dispatch of the verify workflow at the fix ref for the same release sha, with `forge_epoch`. It never sets `override_freeze` (I26) and never touches the live record (I28).
- `gate_fix_ref` is the hotfix input that lets a hotfix-branch gate fix replace the default-branch preflight copy; it is recorded in the ledger. `release.mjs` stamps `gate_sha` on gate telemetry.

## Consequences

Nothing runs unless the verb is called. Code that ships in images still goes through CI, review and merge.
