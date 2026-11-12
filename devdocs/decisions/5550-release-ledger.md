---
status: fresh
anchor: bin/lean/release-ledger.mjs
created: 2026-11-12
---

# ADR: the release record lives on per-release ledger branches

## Context

The release record was the host-local `~/.forge/releases/<id>/state.json`: another host could not resume it and a host death lost it (#5550, epic #5549 Phase 0).

## Decision

- One orphan branch `forge-ledger/<release-id>` per release (`state.json`, a single writer) and one control branch `forge-ledger/_active` (`active.json`, `controls.jsonl`). The names avoid a ref clash with a plain `forge/ledger`.
- Commits go through the Git Data API (tree, commit, ref). The ref update is never forced, so a non-fast-forward (HTTP 422) is a lost race: compare-and-swap with no lock. `_active` has many writers, so updates are key-scoped read-modify-write with up to 5 retries.
- The heartbeat is an edit of the `FORGE:LEASE` comment on the tracking issue (its `updated_at`), not a commit. Takeover bumps the epoch; a fenced holder's heartbeat is refused.
- A head commit is trusted only when GitHub-verified, authored by an allowlisted actor id and by the driver credential (I12). A lane credential cannot write (`assertDriver`). Every written value is redacted (I21).
- `release.managed` is off by default: no ledger call and no extra GitHub write. Local `state.json` stays as a cache; when managed, resume reads the ledger first (Q10, R9).

## Q4 (org rulesets)

Not answerable from a lane: it needs an org admin to confirm that rulesets allow driver-only pushes to `forge-ledger/*` and non-forced ref updates. Probe: as the driver credential, create and delete a scratch `forge-ledger/_probe` ref via `createLedger`'s ref call. Fallback if refused: a private satellite ledger repo, with the same module pointed at that repo (another permission surface). Tracked as a deferred owner action.

## Not in this change

Lease acquisition inside `runRelease`, the tracking issue, `intake pause` and `release control` verbs, watcher reads of GitHub truth.
