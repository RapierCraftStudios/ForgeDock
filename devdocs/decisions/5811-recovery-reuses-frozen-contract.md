---
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-11-21
---

# ADR: a recovery reuses the frozen contract of the same issue scope and base

## Context

A rerun read the frozen `FORGE:CONTRACT` back only when it resumed a branch (`resumed`: an open PR, a remote branch or `LOCAL_BRANCH_REUSED`). A lane that ends after `CONTRACT_FROZEN` but before its first commit (for example `env.tool_missing` from the test-plan env probe) leaves no branch, so its recovery ran the full pre-contract plan session again on the top tier: about 8 minutes and $2 to rebuild a contract that was still valid, and the restart then hit the context ceiling.

## Decision

- The contract read runs on `resumed || recover`. `reuseStale()` in `lean.mjs` decides whether it is usable.
- The contract comment summary now records the lane base too: `(sha256 H, issue S, base B)`. `parseContractComment` returns `base`, or null for older comments.
- A contract is stale when its recorded base differs from the lane or its issue scope hash differs (#4265). Without a branch, a contract must record both scope and base to be reused. Legacy contracts re-plan as before.
- On reuse the lane logs `CONTRACT_REUSED` and goes straight to `BUILDER_ROUTE`. The builder gets the existing rerun prompt: the resume digest, the recovery note and `git diff origin/<lane>...HEAD`.

## Consequences

- An edited issue or a changed base keeps the old behaviour: `CONTRACT_STALE`, then a new plan and freeze.
- Contracts frozen before this change still need a branch to be reused. Only contracts frozen after it benefit when there is no branch.
- The base is the lane name, not a commit: base commits move with every merge, and the scope hash already covers issue edits.
