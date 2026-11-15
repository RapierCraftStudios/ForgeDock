forge-stamp: issue=5690 contract=-
**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: P2 (feature gap, no data loss)
**Task Type**: feature
### What Was Claimed
No CI failure impact classifier exists; `classifyFailure` only distinguishes `infra` vs unknown, so agents cannot tell deterministic setup failures from flakes. Asks for `bin/lean/ci-classify.mjs`, ingest-time classification, and a `fail_fast` policy decision. Dependency #5688 is CLOSED (merged 8baaab14).
### What We Found
- `bin/lean/ci-classify.mjs` does not exist (`ls bin/lean`).
- `bin/lean/release-flakes.mjs:19` `INFRA_SIGNATURES` and `:43` `signatureHash(check,test,signature)` are already exported; `:139` `readFlakes(lctx)` is async and exported. `:39` `classifyFailure` is infra-only. So item 4 needs no export change.
- `bin/pool/ci-events.mjs:8` has `step_failed`/`test_failed` types. `validateEvent` (`:28-63`) passes through an optional `class` (`:47`), `step`, `lines`, `test`.
- `ingest` (`:150`) is synchronous and stamps `seq`/`received_at`. Classification would go there for events lacking `class`.
- `devdocs/modules/pool.md:15-21` documents ci-events, and `devdocs/modules/lean.md:3336` documents ci-preflight. Both need an entry.
### Root Cause
Missing feature. No deterministic classifier or fail-fast decision exists between event ingest and the lane consumer.
### Affected Files
- `bin/lean/ci-classify.mjs` (new): `classifyCiFailure`, `failFastDecision`.
- `bin/pool/ci-events.mjs`: classify on ingest when `class` is absent.
- `bin/lean/ci-classify.test.mjs` (new): corpus of at least 40 excerpts.
- `devdocs/modules/pool.md` (and `lean.md`): entry.
- `bin/lean/release-flakes.mjs`: no change expected.
### Sibling Sweep
`ci-preflight.mjs` emits `step_failed` events without a `class`, so it benefits automatically. No other classifier of the same kind exists. Pool importing from lean is a layering point to check (the pool must not take a hard dependency on lean ledger I/O).
### History
`classifyFailure` came from #5568 (release flakes). The event bus came from #5688 (8baaab14, e272c1fe, d2e55dc5).
### Recommendation
Implement the classifier as a pure function: ordered regex tables with precedence setup > stale > infra > flaky-suspect (ledger hit via `signatureHash`) > code. Flake override applies only to a would-be `code` result, so a flake hit must not turn a setup failure into `flaky-suspect`. Keep it conservative so code failures are never classed as setup, which is the 100% precision requirement. `failFastDecision(event, policy)` returns `{action:"cancel"|"continue", reason}`, and `cancel` only for downstream classes when `policy.fail_fast==="deterministic"`. `createCiEvents` takes an optional injected `classify` and `flakes` getter, so ingest stays sync and the pool does not read the ledger itself. Stored `class` is only set for failure events with none.
### Related Issues
Parent #5687; dependency #5688 (closed); #5568 (release-flakes).
### Test plan
Feature, but covers the ACs: unit tests in `ci-classify.test.mjs` for corpus accuracy at least 90% overall and 100% setup precision with a printed table, `failFastDecision` matrix, flake-ledger override, and an ingest test in `ci-events.test.mjs`. Run `release-flakes.test.mjs` unchanged.
