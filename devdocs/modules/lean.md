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
   **Toolchain + env.setup** (#4163, `toolchain.mjs`): the repo's pins
   (`packageManager`, `.nvmrc`/`.node-version`/`.tool-versions`/`engines.node`,
   forge.yaml `env.toolchain`) become a shim dir first on every runner PATH;
   an unsatisfied node pin is a trajectory anomaly; `env.setup` runs once
   before the builder, failure → `needs-human` / `env.setup_failed`.
4a. **`refactor:split` lane** (#4211, `refactor.mjs`) — an issue labelled
   `refactor:split` (labels come from the issue read `runCore` already makes)
   skips steps 5–7: `runSplitStep` indexes the target (`symbol-index.py`), makes
   ONE tool-less grouping call over the compact index (`noTools`, empty cwd; none
   for a chained `FORGE:SPLIT-PLAN`), moves ≤ `splitMaxLines` (4000) whole modules
   (`symbol-move.py`, `--extend` on chain steps), commits and proves it
   (`refactor-verify.sh`). Refusals → `needs-human` `split.*`, worktree reset,
   nothing pushed. No builder session: every fix path (precheck, CI, base-sync
   conflict) is `needs-human`; a clean base-sync re-verifies; no reviewer. After
   the merge the rest is filed as one chained `refactor:split` issue.
5. **Builder: plan → contract** — plan call writes `.forge-lean/`
   `investigation.md` + `contract.json`; `conformance.mjs` `validateContract`
   checks quotes against the issue and trusted comments; the engine freezes it
   (`FORGE:CONTRACT`, `contractHash`). Typed blocks (`classifyBlock`):
   `dependency` | `split` (≤ `MAX_SUBISSUES` sub-issues → `decomposed`) | `human`.
6. **Implement** — same session; `result.json` with typed amendments
   (`applyAmendments` → `FORGE:AMENDMENT`). An `add-deliverable` on a path the
   contract already lists appends its why to that deliverable's `change`, so it
   can declare a package edge on an already-listed package.json (#4159).
   Builder and reviewer runs get `FORGE_DOCKER_LABELS` (`ledger.mjs`
   `dockerLabels`: `forgedock.owner/batch/lane/issue/expires`, values limited to
   `[A-Za-z0-9_.-]`), and the implement prompt tells the builder to put them on
   every docker run/volume/network/build, use `--rm` and tear down via trap
   (#4181); `scripts/ci-local/run.mjs` labels its own network and containers.
6a. **Declared check commands** (#4240) — forge.yaml `learned.test_commands`
   (`engine-cli.mjs` `readPrecheckCommands`) run in the worktree after the build
   commit via `io.runCommand` (`bash -c`, `verify.precheck_timeout_seconds`,
   default 300; no Actions minutes). Failures resume the builder in-session
   (`precheckFailurePrompt`, up to `max_rounds`); no commit / rounds exhausted is
   an anomaly and the lane continues (CI stays the gate). `PRECHECK_COMMANDS` event.
6b. **Verify by CI** (#4167, forge.yaml `verify.mode` `ci|hybrid`; default `local`
   = unchanged) — `verify.mjs` `runCiVerify` before every review: push, dispatch
   `verify.workflow` (or wait on push checks), red → builder fix with log tails
   (`max_rounds`, then `ci.red`), slow → `ci-pending`, unavailable → local fallback;
   docs-only (`skip_paths`) skips. A verified head satisfies validate ids left to CI.
   **Docs freshness**: when the target repo has `scripts/check-devdocs-freshness.sh`,
   the engine runs it on `base...HEAD` after implement (`io.docsFreshness`, empty
   `PR_BODY`). Exit 1 resumes the builder once with the script's output (`docsPrompt`);
   still failing is `needs-human` / `docs.stale`, before any PR or reviewer run. No
   script, or exit 2+, never blocks.
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
   at the reviewed head → `merged`, or `ci-pending` after the CI wait. A failed
   required check (any verify mode, #4240) resumes the builder with the failed
   logs (`collectFailedLogs`, `ciFailurePrompt`), re-reviews and pushes the fix,
   and waits again; `ci.red` only after `max_rounds` (shared with `ciVerify`) or a
   round with no new commit. Rollups of another head count as pending. `CI_FIX_ROUND`.

## Host parallelism (#4182)

Every runner call gets `FORGE_HOST_PARALLELISM` in its env, next to the
per-run `TMPDIR`/`CLAUDE_CODE_TMPDIR`. The value is
`max(1, floor(cores / live lanes))`, computed by `admission.mjs`
`hostParallelism`. Live lanes come from `ledger.mjs` `countLiveLanes`, a
read-only scan of `~/.forge/ledger/*/*.json` that counts lane files with this
host, a live pid and an unexpired `expires`. That includes the lane itself,
which registers its run tmp before the first runner call. The scan is exposed
as `makeHostProbe().activeLanes()`.

- A positive-integer `FORGE_HOST_PARALLELISM` already set in the environment
  wins as an operator override.
- When the probe fails, or there is no host probe, the variable is not set.
- `HOST_RULES` in `prompts.mjs` tells the builder to cap verification at the
  value: `turbo --concurrency`, `vitest`/`jest --maxWorkers`,
  `playwright --workers` and `node --test --test-concurrency`, with eslint
  going through turbo.
- ci-local passes the variable through `scrubbedEnv` and caps its slot count
  and job `maxParallel` at it (`lib.mjs` `capParallel`).

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

`checks.mjs` (change-scoped typecheck/lint/test commands and shared tsc/eslint caches, #4218),
`prefilter.mjs` (cheap pre-run close of already-fixed issues, `FORGE:PREFILTER`),
`prompts.mjs` (builder/reviewer/grouping prompts, `.forge-lean/` file names),
`refactor.mjs` (`refactor:split` step, #4211),
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

## Entry 2026-10-20 — Host-aware verification concurrency (#4182)

Added `FORGE_HOST_PARALLELISM`: it is derived from the ledger lane count,
injected into the runner env, named in the builder host rules, and used to cap
ci-local slots and job parallelism.

## Entry 2026-10-19 — Lane toolchain pins + env.setup (#4163)

`toolchain.mjs` `prepareToolchain` (zero LLM) runs right after the worktree is
added: pinned pm → `corepack <pm>@<ver>` (else `npx -y`) shims in
`<run tmp>/toolchain/bin`, merged into `callRunner`'s env so the builder, its
validate commands and git hooks resolve the pin. No pins → no env/prompt change.
`env.setup` failure is an environment error (`env.setup_failed`), not a build failure.

## Entry 2026-10-20 — Structure delta and decision provenance telemetry (#4165)

The implement-time `STRUCTURE_DELTA` stays in the run log and keeps gating
undeclared package edges. Its telemetry write moved to the merged path:
`lean.mjs` `recordStructure` re-runs `structure-delta.sh` (now with
`import_pairs[].files`), takes `top_growth` from one `git diff --numstat` and
writes one `STRUCTURE_DELTA` (`phase: merge`, pr, milestone, deps/edges/growth,
contract `decisions[]` sources). The trajectory shows it as a **Structure** table.
`RUN_TERMINAL` gains pr, milestone, `conformance_mode` and `shadow_would`.
Contracts may carry `decisions: [{id, choice, justification, source: doc|lint|precedent|spec}]`,
which `validateContract` checks only when present. `forgedock stats --edge FROM:TO` /
`--milestone M` (`bin/stats/query.mjs`) answer audit queries from these records.
Rationale: `devdocs/decisions/4165-structure-delta-telemetry.md`.

## Entry 2026-10-20 — Account-scoped usage-limit holds (#4190)

`limits.mjs` keeps a host-level store (`~/.forge/limits.json`, atomic writes) of
`rate_limited` holds keyed by `backendIdentity({backend, env})`. A lane's
`rate_limited` result carries `backendId`; `orchestrate.mjs` admission consults the
hold for the identity the next lane would use, so batches on the same account share
one hold and a lane on another account is admitted. Legacy per-batch `holdUntil` in
`state.json` is ignored on `--resume`. CLI: `forgedock limits show|clear [<id>|--all]`
(`engine-cli.mjs` `limitsFromCli`).

## Entry 2026-10-20 — Host lane registry: global cap and cross-batch priority (#4191)

`sched.mjs` keeps one host registry (`~/.forge/sched/registry.json`, or
`FORGEDOCK_SCHED_DIR`; read-modify-write under `registry.lock`, a dead owner's lock
is taken over). `orchestrate.mjs` (seam `sched: {registry, batch, repo, cap}` +
`priorityOf`, persisted as `priorities`) starts a lane only when the batch is under
its K **and** `tryAcquire` grants a slot: live slots < cap and the key ranks within
the free slots of the queue ordered by (priority, FIFO seq). Priority comes from
`priority:P<n>` / `P<n>` labels (unlabelled P2), read in the body call. Cap: registry
(`forgedock sched cap N|--clear`, `engine-cli.mjs` `schedFromCli`) > forge.yaml
`orchestration.global_parallel` > none. Running lanes are never revoked. A dead
dispatcher's queued entries are dropped; its slots too unless the detached lane
(`lanePid`) still runs; `--resume` adopts them. Unreadable registry or lock timeout:
admit without the cap (one `sched` row). Rationale:
`devdocs/decisions/4191-host-lane-registry.md`.

## Entry 2026-10-20 — schedd: one host scheduler process for every batch (#4192)

`bin/lean/schedd.mjs` is the host daemon (`forgedock schedd`). It is single
instance through `schedd.lock` (daemon pid, O_EXCL, a dead owner's lock taken over)
plus the unix socket `schedd.sock` in `schedDir()`. It hosts `orchestrate()` for
every batch through the injected `engine-cli.mjs` `runBatch`, so the registry slot
`pid` of every lane is the daemon's.

`forgedock orchestrate` is now a client (`orchestrateClient`). It checks the
arguments, resolves the repo, auto-spawns the daemon (output to
`<sched>/schedd.log`) and talks to it in NDJSON:
- `submit {argv, cwd, env}` streams `row`/`line` messages, then `done`.
- `attach {id}` replays `log.jsonl` and then streams live. A finished batch
  replays `report.json`. A batch nobody hosts, or one with `held` rows, is resumed
  in the daemon (breaker reset, as an operator resume).
- `set-parallel {id, k}` sets K live. With no daemon running, the client writes
  the `parallel` file itself.
- `status` reports the daemon pid and hosted batches.

A client exit never stops a batch.

On start the daemon resumes every `plan.daemon` batch without `report.json` and
keeps a tripped breaker tripped. Live lanes are re-adopted through `adopt`. It
exits after `FORGEDOCK_SCHEDD_IDLE_MS` (default 10 min) with no batch and no client.

Lanes run with the client's env. The plan keeps the allowlist
`PATH|HOME|USER|SHELL|LANG|LC_ALL|TMPDIR|FORGEDOCK_*|CLAUDE_*|ANTHROPIC_*|GH_*|GITHUB_*`
(`batchEnv`). `mergeEnv` drops the daemon's own allowlisted keys, so an account
selector never leaks between batches.

`--foreground`, `FORGEDOCK_SCHEDD=0` or injected test deps run the batch
in-process as before.

systemd-user unit:
`[Service] ExecStart=/usr/bin/env forgedock schedd` with `Restart=on-failure`.
Rationale: `devdocs/decisions/4192-schedd.md`.

## Entry 2026-10-20 — Change-scoped checks and shared caches (#4218)

`bin/lean/checks.mjs` (CLI + library) discovers the repo's typecheck/lint/test
commands (turbo task > workspace package scripts > root script; Python `pytest` /
`ruff check` via `uv run` / `poetry run`), scopes each with ci-local's
`scopeCommand` against the lane's changed files, and prints them. `HOST_RULES`
(`prompts.mjs`, `CHECKS_CLI`) tells the builder to run these instead of the full
scripts. `scoping.mjs` gained a `tsc` selector (`scopeTsc`, `tsProjectOf`): the
nearest owning `tsconfig.json` of the changed and referencing files →
`tsc -p <project>`, `tsc -b` across several composite/referenced projects, full
for the root project, several non-composite projects or any `globalWiden`
trigger (lockfile, tsconfig, CI config). Caches: the shared entry
`~/.forge/verify-cache/<sha256(git common dir)>/<merge-base sha>/` is copied into
the worktree's `node_modules/.cache/forge-verify/` (hydrate); tsc gets
`--incremental --tsBuildInfoFile` and eslint `--cache --cache-strategy content
--cache-location` there; `--publish` creates the entry only when absent
(tmp dir + rename, first writer wins, never modified).

## Entry 2026-10-20 — Local-mode CI fix rounds + declared pre-PR checks (#4240)

`verify.mode: local` (the default) ended `ci.red` on the first failed required check
at merge. `lean.mjs` `mergeFixRound` now gives the merge wait the same fix rounds as
`ciVerify` (shared `ciRounds` budget; fixed head re-reviewed before merge), and the
build is followed by the repo's declared check commands (`learned.test_commands`;
`scripts/ci-local.sh` only when the repo lists it, no hardcoded paths). Seams:
`effects.mjs` `checkStates` (+`url`, `head`), `runCommand`. Cost: green path +0 LLM
calls; each red round is one builder resume (+ one reviewer run at merge), replacing a
`needs-human` and a manual `/fix-ci` + relaunch. `merge_wait: all` is unchanged.

## Entry 2026-10-20 — refactor:split lane (#4211)

`refactor:split` issues no longer go through the builder. `lean.mjs` routes them by label to
`refactor.mjs` `runSplitStep`: deterministic index, move and proof around one `noTools` grouping
call (`effects.mjs` `noToolFlags`, `prompts.mjs` `groupingPrompt`), then the usual PR/merge.
Chains: `slicePlan` + `symbol-move.py --extend` + a `FORGE:SPLIT-PLAN` follow-up issue. Codes
`split.unsupported|plan_invalid|verify_failed`. Cost: one index-sized call, 0 reviewer runs per
split, instead of a builder session plus a reviewer. ADR `decisions/4211-refactor-split-lane.md`.

## Entry 2026-10-20 — Cross-repo fairness weights in the host registry (#4193)

`sched.mjs` `grantOrder(s)` replaces the static (priority, seq) sort for both
`tryAcquire`'s rank check and `list().queue`. Priority still comes first, so a P0
from any repo is granted next. Within a priority, the next entry comes from the repo
(entry `repo`, else `batch`, else key) with the smallest (live slots of that repo
across all priorities + entries already ordered ahead) / weight. Ties go to the
heavier repo, then FIFO; inside a repo the order is FIFO. A single-repo queue orders
exactly as before. Weights live in the registry (`weights: {"owner/repo": N}`,
missing = 1), set with `forgedock sched weight <owner/repo> N|--clear`
(`engine-cli.mjs` `schedFromCli`) and printed by `sched show`. Running lanes are
never revoked, so a newly set weight converges as lanes end. Rationale:
`devdocs/decisions/4193-sched-fair-weights.md`.
