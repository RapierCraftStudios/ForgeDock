---
module: lean
glob: "bin/lean/*"
authority: required
token_cost: 900
last_compacted: "2026-10-19"
---

# Module Dossier: bin/lean/ (core work-on engine)

Rolling per-module knowledge log. Each entry is 3–5 lines with a citation.
Hard cap: 150 lines. A behaviour change under `bin/lean/` updates this file,
`NORTHSTAR.md` § Runtime map or a new `devdocs/decisions/*.md` in the same PR
(`scripts/check-devdocs-freshness.sh`, CI job `devdocs-freshness`).

## Summary

`bin/lean/` is the canonical runtime: `forgedock run-issue` defaults to the
core path (`bin/engine-cli.mjs` `enginePath ?? "core"`, imports
`lean/lean.mjs` `runCore`); `--path full` is the legacy multi-phase pipeline.
`forgedock orchestrate` drives many lanes through `lean/orchestrate.mjs`.
ONE builder session does the work, ONE read-only reviewer judges it, and
GitHub is the register (labels, comments, PR, merge). All effects are injected
through `io` (`lean/effects.mjs` `makeLeanIo`) so `runCore` is unit-testable.

## Flow (`lean.mjs` `runCore`)

1. **Host admission** — `admission.mjs` `checkAdmission` (free mem/tmp, load);
   busy host → `deferred` / `host.busy`, before any lease or GitHub call.
2. **Lane** — `lane.mjs` `resolveLane`: milestone → `branches.feature_pattern`
   (`milestone/{slug}`), else `branches.staging`; never the default branch;
   fail closed with `lane.*` codes → `lane-refused`.
3. **Dependencies, then lease** — open `Depends-on` → `dependency-open`
   (orchestrate requeues behind it); then the FORGE:STATE lease.
4. **Claim + worktree** — `workflow:investigating`, `FORGE:STARTED` comment;
   resumes an open PR / remote branch. Before an existing `lean-<N>` worktree is
   removed (#4162): processes whose cwd is inside it (an orphaned runner from a
   dead run, found via `/proc`) get SIGTERM, then SIGKILL after 5 s
   (`WORKTREE_PROCS_STOPPED`); uncommitted work (tracked, untracked, `.forge-lean/`)
   is saved to `refs/forge/salvage/<N>/<ms>` (`WORKTREE_SALVAGED`) and the
   implement prompt names the ref. This covers runs that died hard (no
   teardown); a run that exits normally checkpoints its work in teardown (#4179).
5. **Builder: plan → contract** — plan call writes `.forge-lean/`
   `investigation.md` + `contract.json`; `conformance.mjs` `validateContract`
   checks quotes against the issue and trusted comments; the engine freezes it
   (`FORGE:CONTRACT`, `contractHash`). Typed blocks (`classifyBlock`):
   `dependency` | `split` (≤ `MAX_SUBISSUES` sub-issues → `decomposed`) | `human`.
6. **Implement** — same session; `result.json` with typed amendments
   (`applyAmendments` → `FORGE:AMENDMENT`). An `add-deliverable` on a path the
   contract already lists appends its why to that deliverable's `change`, so it
   can declare a package edge on an already-listed package.json (#4159).
6b. **Verify by CI** (#4167, forge.yaml `verify.mode` `ci|hybrid`; default `local`
   = unchanged) — `verify.mjs` `runCiVerify` before every review: push, dispatch
   `verify.workflow` (or wait on push checks), red → builder fix with log tails
   (`max_rounds`, then `ci.red`), slow → `ci-pending`, unavailable → local fallback;
   docs-only (`skip_paths`) skips. A verified head satisfies validate ids left to CI.
7. **Conformance** — `precheck` (deterministic: changed files vs deliverables,
   validate results, requirement statuses; each failure has a `kind`),
   structured review (`parseReview`), `decide` computes the verdict. The
   reviewer prompt carries a `reviewSkeleton` (#4160): every requirement and
   preserve id, scope rows only for files the contract does not authorize,
   coverage seeded with the contract's verbatim quotes, all statuses empty.
   Completeness needs scope rows only for those unauthorized files; bare
   evidence names resolve to the one changed file they name
   (`resolveEvidencePath`). An incomplete reply gets one retry that lists the
   exact problems plus the previous reply. Mode `engine.conformance`: `shadow`
   (default; unimplemented/regression from the review block, and so do a
   precheck `validate_failed` or `requirement_unimplemented`, before any
   reviewer run) or `enforce`. Defer/post-deploy requirements become tracked
   follow-ups (`followupItems`, `pendingTracking`).
8. **Push + PR → merge** — merge policy `required` (default) | `all` | `none`;
   base-sync merges the lane in on conflict (never rebase/force-push); merge
   at the reviewed head → `merged`, or `ci-pending` after the CI wait.

## FORGE:STATE lease

Stored in the issue body by `io.projector.writeState`:
`{v, run: "core_<issue>", issue, lane, committed, phase, branch, pr,
terminalReason, terminal, lease: {by, until, host, pid}}`. TTL 25 min, renewed
every 2 min; a live foreign lease → `deferred` / `lease-held`; a dead holder
(same host, pid gone) is taken over (`LEASE_TAKEOVER` event). Released on
finish with `terminal`/`terminalReason`.

## Outcomes

Terminal reasons: `merged`, `ci-pending`, `deferred`, `decomposed`, `invalid`,
`needs-human`, `dependency-open`, `dependency-unreadable`,
`dependency-blocked`, `lane-refused`, `engine-error`. Typed codes come from
`bin/engine/outcome-codes.mjs` `OUTCOME_CODES` (e.g. `host.busy`,
`lease.held`, `dependency.open`, `lane.*`, `conformance.*`, `gh.unavailable`).
`orchestrate.mjs` treats `deferred` as a scheduling fact (requeue with
retry-at, `MAX_REQUEUES`, `DEFAULT_MAX_DEFERRALS`), relaunches one
`engine-error`, and persists batches (`batch.mjs`) so a restart resumes.

Maintenance budget (#4197, off unless forge.yaml `maintenance.enabled: true`,
read by `engine-cli.mjs` `readMaintenance`): the CLI pulls open
maintenance-labelled issues into the batch and classifies each from its labels;
`orchestrate.mjs` `pickNext` admits P0/P1 features > maintenance while
`maint + 1 <= floor(share * (started + 1))` > P2+ features > maintenance when
idle (`when_idle`). The store gains `classes` and `dispatch: {started, maint}`
only with the budget; maintenance it never admits ends `held` (`maintenance
share`). `scripts/maintenance-scan.sh` is the deterministic producer
(hotspots, package cycles via `structure-delta.sh`, dead-code tools, oversized
docs), deduplicated by a `FORGE:MAINT:<kind>:<key>` marker.

## Other files

`prefilter.mjs` (cheap pre-run close of already-fixed issues, `FORGE:PREFILTER`),
`prompts.mjs` (builder/reviewer prompts, `.forge-lean/` file names),
`render.mjs` (comment/PR rendering, size caps), `retry.mjs` (transient
push/gh/merge retry patterns).

## Entries

## Entry 2026-10-19 — Dossier created (#4185)

Initial dossier written with NORTHSTAR.md and the devdocs freshness gate.

## Entry 2026-10-19 — Verify-by-CI (#4167)

Opt-in `verify:` section (`engine-cli.mjs` `readVerify` → `verify.mjs` `parseVerify`).
`lean.mjs` `ciVerify` runs before each conformance gate and after a base-sync push;
`precheck({ciVerified})` accepts `ci:true` validate ids at the verified head. Seams:
`effects.mjs` `dispatchWorkflow`/`workflowRuns`/`commitChecks`/`failedLogs`. Rationale:
`devdocs/decisions/4167-verify-by-ci.md`.
