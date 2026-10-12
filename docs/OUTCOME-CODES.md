# Engine outcome codes

Version: 1 (`OUTCOME_CODES_VERSION` in `bin/engine/outcome-codes.mjs`, the single source of truth).

Every `PHASE_FAILED`, blocked `PHASE_COMMIT` (a handoff or block) and `RUN_TERMINAL` run-log event carries a
`code` from this closed enum, so stall causes can be counted and grouped without reading prose. The code is
derived in code from structured evidence only (`REVIEW_RESULT` fields, FORGE markers and sentinels,
`**Re-gate outcome**`, `err.code`), never from the free-text `detail`/`reason`, which stays alongside for humans.
`terminate()` also records the code in the issue's `FORGE:STATE` block (`outcomeCode`), so it survives a rebuild
or resume and is recoverable from GitHub alone. Adding a code is additive; renaming or removing one bumps the
version.

An absent or unknown code is recorded as `unclassified`, with the raw reason kept (`PHASE_FAILED.reason`,
`RUN_TERMINAL.detail`), so gaps show up in a report instead of being hidden.

| Code | Meaning | Emitted by | Source evidence |
|------|---------|------------|-----------------|
| `review.changes_requested` | Review asked for an in-PR fix and handed off to remediate | review | `REVIEW_RESULT` `status: NEXT`, `next: remediate` |
| `review.escalated` | Review escalated the PR to a human or remediation | review | PR/issue carries `needs-human` or `workflow:remediating` |
| `review.rereview_skipped` | Re-review was skipped | reserved | No structured evidence source yet |
| `review.blocking_issue` | Review left the PR open at an unchanged head with a filed blocking ISSUE and handed off to remediate | review | Trusted `FORGE:NOTE_DISPOSITION` on the PR with `findings_filed` > 0 and `reviewed_sha` equal to the live head |
| `review.pr_open` | Review ended with the PR open and unmerged and no handoff signal | review | Live PR open, no `REVIEW_RESULT` remediate handoff, no `needs-human`/`workflow:remediating` label, no blocking disposition |
| `build.acceptance_failed` | Newest acceptance gate marker is blocked | build | `FORGE:ACCEPTANCE_GATE:FAILED`/`:BLOCKED` or `FORGE:BUILD_BLOCKED` (`:DEGRADED` is a pass-class marker, not blocked) |
| `build.acceptance_malformed` | Acceptance spec was malformed | reserved | Indistinguishable from `build.acceptance_failed` by sentinel alone |
| `build.size_over_gate` | Retired (forge#3862): the old size gate routed a finished build to decompose; never emitted now, kept so historic runs still parse | reserved | A finished build is never routed to decompose |
| `build.cohesive` | Retired (forge#3862): the old size gate judged an oversized diff cohesive | reserved | No size gate remains |
| `remediate.no_marker` | Remediation ended without its completion marker | remediate | No trusted `FORGE:REMEDIATION:COMPLETE` |
| `remediate.deferred_live_run` | Remediation deferred to a live earlier run | remediate, engine | Trusted `FORGE:REMEDIATION_DEFERRED` record |
| `remediate.re_escalated` | Remediation re-escalated to a human | remediate | `**Re-gate outcome**: RE-ESCALATED` |
| `remediate.unfixable` | Remediation judged the findings unfixable | remediate | `**Re-gate outcome**: UNFIXABLE` |
| `ci.red` | CI failed | reserved | `REVIEW_RESULT` carries no CI field yet |
| `ci.timeout` | CI timed out | reserved | `REVIEW_RESULT` carries no CI field yet |
| `base.conflict` | Base-branch conflict blocked the PR | reserved | `REVIEW_RESULT` carries no conflict field yet |
| `rate_limited` | Session or usage limit outlasted the pause budget | engine | `err.usageLimit` / `err.resetAtEpochMs` |
| `engine.error` | Engine or tool failure (missing key/SDK, CLI crash, max turns, unresolved args, runner threw every attempt) | engine | `err.code` |
| `infra.disk_quota` | Disk full or quota exhausted (EDQUOT/ENOSPC, errno -28/-122); retryable infra failure, never `needs-human` | engine | Runner error text |
| `lease.held` | Another live agent holds the issue lease | engine | Foreign live lease on acquire |
| `dependency.open` | A trusted `**Depends on**: #N` dependency is still open, so the run was refused before any state write | engine | Trusted issue body `**Depends on**` line + the dependency issue's open state |
| `dependency.unreadable` | The issue body or a declared dependency could not be read, so the run was refused (fail closed) | engine | Failed or unparsable `gh api` read |
| `invalid` | Issue is invalid or in a divergent closed state | investigate, engine | `INVESTIGATION:INVALID` marker, or live snapshot |
| `decomposed` | Issue was decomposed into sub-issues | investigate, decompose | `FORGE:DECOMPOSED` or the decomposition assessment |
| `completed` | Non-failure terminal (merged, phase-complete, investigation) | engine | Terminal reason |
| `awaiting_merge` | Clean result held for a merge decision | remediate | Terminal reason `awaiting-merge` |
| `unclassified` | Fallback for an absent or unknown code | engine | The raw reason is kept alongside |

## Known limits

- `build.acceptance_failed` covers malformed specs too until the gate sentinel distinguishes them.
- `ci.red`, `ci.timeout` and `base.conflict` stay reserved until `REVIEW_RESULT` carries structured fields for
  them; the engine will not infer them from prose. Such outcomes are `unclassified` today.
- `needs-human` has many causes; a pause on a pre-existing `needs-human` label is `unclassified`.
- The `FORGE:TELEMETRY` comment write is owned by #3834. The engine forwards coded deferrals through the
  existing `emitTelemetry` hook and exposes the code on the run log and `FORGE:STATE`.
