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
| `review.ci_pending_timeout` | CI was still pending at the merge gate after the engine's bounded wait (`engine.ci_pending_max_minutes`) ran out | engine | Review ended `REVIEW_RESULT` `status: BLOCKED` with a blocker containing `checks still pending` (or remediate held at its M7 re-gate on `CI pending`), and `scripts/wait-ci-green.sh` still reported pending when the budget expired |
| `build.acceptance_failed` | Newest acceptance gate marker is blocked | build | `FORGE:ACCEPTANCE_GATE:FAILED`/`:BLOCKED` or `FORGE:BUILD_BLOCKED` (`:DEGRADED` is a pass-class marker, not blocked) |
| `build.acceptance_malformed` | Acceptance spec was malformed | reserved | Indistinguishable from `build.acceptance_failed` by sentinel alone |
| `build.size_over_gate` | Retired (forge#3862): the old size gate routed a finished build to decompose; never emitted now, kept so historic runs still parse | reserved | A finished build is never routed to decompose |
| `build.cohesive` | Retired (forge#3862): the old size gate judged an oversized diff cohesive | reserved | No size gate remains |
| `remediate.no_marker` | Remediation ended without its completion marker | remediate | No trusted `FORGE:REMEDIATION:COMPLETE` |
| `remediate.deferred_live_run` | Remediation deferred to a live earlier run | remediate, engine | Trusted `FORGE:REMEDIATION_DEFERRED` record |
| `remediate.re_escalated` | Remediation re-escalated to a human | remediate | `**Re-gate outcome**: RE-ESCALATED` |
| `remediate.unfixable` | Remediation judged the findings unfixable | remediate | `**Re-gate outcome**: UNFIXABLE` |
| `remediate.inpr_requested` | Re-gate approved but requested one further in-PR fix round; the run continues, never `needs-human` | remediate | `**Re-gate outcome**: INPR-FIX-REQUESTED` |
| `ci.red` | CI failed | reserved | `REVIEW_RESULT` carries no CI field yet |
| `ci.timeout` | CI timed out | reserved | `REVIEW_RESULT` carries no CI field yet |
| `base.conflict` | Base-branch conflict blocked the PR | reserved | `REVIEW_RESULT` carries no conflict field yet |
| `path.switch_conflict` | The full path was started on an issue that has an open core-path PR (`feat/issue-<n>-lean`); refused to avoid a second implementation. Rerun on the default path (base-sync) or close that PR first | engine | `bin/engine.mjs` admission |
| `merge.transient` | `gh pr merge` kept failing with a transient error (`Base branch was modified`, GraphQL or 5xx) after the retry budget; the run is `deferred` and a rerun resumes at the merge | lean | `bin/lean/lean.mjs` |
| `push.transient` | `git push` kept failing with a transient error (`remote unpack failed`, `index-pack failed`, `RPC failed`, 5xx, reset, timeout) after 4 attempts; `deferred`, rerun resumes | lean | `bin/lean/lean.mjs` |
| `cli.idle` | The builder CLI showed no stream activity for `engine.cli_idle_minutes` and was killed; uncommitted work was checkpointed to the lane branch; `deferred` after one automatic retry | lean | `bin/runner.mjs` |
| `host.busy` | Core run deferred at admission: free memory, free tmp space or load per core outside `engine.admission` limits; no lease taken, nothing posted | lean | `bin/lean/admission.mjs` |
| `rate_limited` | Session or usage limit outlasted the pause budget | engine | `err.usageLimit` / `err.resetAtEpochMs` |
| `engine.error` | Engine or tool failure (missing key/SDK, CLI crash, max turns, unresolved args, runner threw every attempt) | engine | `err.code` |
| `infra.disk_quota` | Disk full or quota exhausted (EDQUOT/ENOSPC, errno -28/-122); retryable infra failure, never `needs-human` | engine | Runner error text |
| `infra.cli_spawn_transient` | CLI spawn failed transiently before the child ran (ETIMEDOUT, EAGAIN, ENOMEM, EMFILE); retried with backoff on a separate bounded counter that does not consume a phase attempt | engine | `err.code` `CLI_SPAWN_TRANSIENT` |
| `cli.timeout` | CLI child ran and was killed at the wall-clock limit; a normal attempt (consumes one of `maxAttempts`), usage recorded when the CLI emitted any | engine | `err.code` `CLI_TIMEOUT` |
| `cli.spawn_failed` | The CLI could not be started for a reason that repeats on every rerun (`E2BIG` argv too large, `ENOENT`/`EACCES`/`ENOEXEC` binary missing or not executable, `ENAMETOOLONG`). Core work-on ends `needs-human` with this code instead of `engine-error`, so `forgedock orchestrate` does not spend its relaunch on it | lean, engine | `err.code` `CLI_SPAWN_FAILED` (E2BIG) or `err.spawnDeterministic` (other errnos keep their `err.code`); `err.spawnErrno` holds the errno |
| `lease.held` | Another live agent holds the issue lease | engine | Foreign live lease on acquire |
| `dependency.open` | A dependency is still open: a trusted `**Depends on**: #N` line refused the run before any state write, or the core builder reported `block.kind: "dependency"` naming an issue that is open. Carries `dependencies`; never `needs-human`. `forgedock orchestrate` adds the edge and requeues the issue behind it, without skipping dependents | engine, lean | Trusted `**Depends on**` line, or `result.json` `block.issues`, + the dependency issue's live open state |
| `dependency.unreadable` | The issue body or a declared dependency could not be read, so the run was refused (fail closed) | engine, lean | Failed or unparsable `gh api` / `gh issue view` read |
| `dependency.blocked` | Core work-on: the builder's dependency is open and itself labelled `needs-human`. Terminal reason `dependency-blocked` (blocked by #X); this issue is not labelled `needs-human` | lean | `result.json` `block.kind: "dependency"` + the dependency's `needs-human` label |
| `lane.mismatch` | Core work-on: `--lane` differs from the lane worked out from the issue (milestone → `branches.feature_pattern`, else `branches.staging`); refused before any lease, comment or worktree. `--lane-override` forces it and is recorded in the trajectory. A resumed PR whose base is not the lane is refused the same way before merge | lean | Issue milestone + forge.yaml `branches`, or the open PR's `baseRefName` |
| `lane.default_branch` | Core work-on: the requested or resolved lane is the default (production) branch (forge.yaml `branches.default` or the GitHub default branch); never a lane, refused at every entry point and before PR create and merge | lean, cli | forge.yaml `branches.default`, `gh repo view` `defaultBranchRef` |
| `lane.branch_missing` | Core work-on: the lane branch (e.g. `milestone/<slug>`) does not exist on origin; fail closed | lean | `git ls-remote --heads origin` |
| `lane.unresolved` | Core work-on: the lane could not be worked out (milestone or default branch unreadable, empty milestone slug, bad `feature_pattern`); fail closed | lean | Failed `gh` read or config |
| `invalid` | Issue is invalid or in a divergent closed state | investigate, engine | `INVESTIGATION:INVALID` marker, or live snapshot |
| `decomposed` | Issue was decomposed into sub-issues. In core work-on, the builder reported `block.kind: "split-required"`; the engine files the sub-issues (`**Parent**` and `**Depends on**` lines) and returns them as `subissues` for `forgedock orchestrate` to run | investigate, decompose, lean | `FORGE:DECOMPOSED` or the decomposition assessment; `result.json` `block.subissues` |
| `builder.blocked` | Core work-on: the builder reported an external action agents cannot take, or a product decision too critical for agents: `block.kind: "human"` with `why` one of `credentials`, `spend`, `promotion`, `customer`, `product-decision`. An upstream issue, a needed split, or prod data that monitoring access can read never count | lean | `result.json` status `blocked` + typed `block` |
| `builder.block_untyped` | Core work-on: the builder stayed `blocked` without a valid typed reason (missing `block`, a non-human `why` such as prod data, or a dependency that is not open) after one corrective resume | lean | `result.json` status `blocked`, twice |
| `builder.no_evidence` | Core work-on: the builder reported invalid/already-fixed without file:line evidence, so the issue was not closed | lean | `result.json` with empty `evidence` |
| `builder.no_commit` | Core work-on: the builder made no commit for a fix | lean | No changed files after the builder session |
| `review.failed` | Core work-on: the fix/regression review failed twice (or could not resume the builder) | lean | Reviewer verdict FAIL |
| `review.no_verdict` | Core work-on: the reviewer returned no parseable verdict twice | lean | Unparsable reviewer output |
| `contract.invalid` | Core work-on: the builder's contract.json stayed invalid after one correction (missing requirement rows, a quote not verbatim from the issue, a defer without a why, no validate commands) | lean | `validateContract` problems after the correction resume |
| `review.incomplete` | Core work-on: the conformance review twice returned no complete rows (a generic PASS, a missing requirement/scope/preserve row, evidence in a file that does not exist); nothing merged | lean | `checkCompleteness` problems on both reviewer runs |
| `review.inconsistent` | Core work-on: the reviewer said NONCONFORMING without any failing row; treated as not conforming | lean | Verdict/row mismatch after the builder resume |
| `conformance.omission` | Core work-on: an issue requirement is missing from or narrowed by the frozen contract, after one builder resume | lean | Review `issue_coverage` row not `covered` |
| `conformance.unimplemented` | Core work-on: a contracted requirement is partial, missing or unvalidated, or a validate command failed, after one builder resume | lean | Precheck (result.json, validation) or review requirement row |
| `conformance.scope_creep` | Core work-on: a changed file is not authorized by a deliverable or typed amendment, after one builder resume | lean | Precheck changed files or review `scope` row `none` |
| `conformance.untracked_deferral` | Core work-on: a requirement was deferred without a typed amendment or a tracking issue, after one builder resume | lean | Precheck or review requirement row `deferred` on a `deliver` requirement |
| `conformance.preserve_violated` | Core work-on: a preserve constraint is violated or unverified, after one builder resume | lean | Review `preserve` row not `intact` |
| `conformance.regression` | Core work-on: the reviewer named a concrete regression, after one builder resume | lean | Review `regressions` row |
| `followup.unavailable` | Core work-on: filing or verifying the tracking issue for a deferral failed; the run is deferred with nothing merged, never needs-human | lean | `file-deferred-followups.sh` exit 3/4 or an unreadable tracking issue |
| `merge.head_mismatch` | Core work-on: CI passed for a head other than the reviewed head; merge refused | lean | Gate head differs from the reviewed head |
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
