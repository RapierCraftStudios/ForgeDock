---
module: lean
glob: "bin/lean/*"
authority: required
token_cost: 900
last_compacted: "2026-10-20"
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

1. **Host admission** — `admission.mjs` `checkAdmission` (free mem/tmp; load
   average only when `max_load_per_core` is configured, #4169);
   busy host → `deferred` / `host.busy`, before any lease or GitHub call.
   Heavy steps are gated separately by the host heavy-step semaphore (`heavy.mjs`).
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
   **Sparse worktree** (#4221, `worktree.mjs` `addLaneWorktree`): tracked blobs
   >= forge.yaml `env.sparse_max_kb` (default 1024; 0 = off) stay out of the
   checkout (non-cone patterns in the worktree's own `info/sparse-checkout`;
   lockfiles, manifests, toolchain pins, forge/git config always in). The
   #4162/#4118 steps above run first, unchanged; no such blob → today's plain
   `worktree add`; a failed sparse step → full checkout (`WORKTREE_SPARSE_FALLBACK`).
   `WORKTREE_SPARSE` logs the count/bytes; the builder prompt names the absent files.
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
   (`refactor-verify.sh`). TypeScript targets (#4212) use `symbol-index.mjs` and
   `symbol-move.mjs` (ts-morph from the target repo or `NODE_PATH`; a `--probe`
   before any edit refuses `no codemod tool for ts`) and leave a re-export barrel. Refusals → `needs-human` `split.*`, worktree reset,
   nothing pushed. No builder session: every fix path (precheck, CI, base-sync
   conflict) is `needs-human`; a clean base-sync re-verifies; no reviewer. After
   the merge the rest is filed as one chained `refactor:split` issue.
5. **Builder: plan → contract** — plan call writes `.forge-lean/`
   `investigation.md` + `contract.json`; `conformance.mjs` `validateContract`
   checks quotes against the issue and trusted comments; the engine freezes it
   (`FORGE:CONTRACT`, `contractHash`; the summary also records `issue S`, the
   hash of `scopeText`: title, body and trusted comments without HTML-comment
   blocks or `<!-- FORGE:` comments, #4265). `ISSUE_EDITED` fires only when that
   scope hash changes, so the engine's own FORGE:STATE/annotation writes are not
   edits. A rerun recovers the frozen contract only if its scope hash equals the
   current one (legacy comments without it: no trusted human comment after it
   and every `deliver` quote still in the issue); otherwise `CONTRACT_STALE`,
   decision "frozen contract H is stale", and it re-plans and freezes a new one.
   Conformance needs-human lines and the "Not conforming" decision append the
   quote of the requirement a failure names (`explainFailures`), and a failed
   validate names its command. Typed blocks (`classifyBlock`):
   `dependency` | `split` (≤ `MAX_SUBISSUES` sub-issues → `decomposed`) | `human`.
   A split sub-issue may declare `files` (the paths it will edit); `serializeShared`
   adds a `Depends on` edge from each later sub-issue to the nearest earlier one it
   shares a file with and does not already reach, so siblings editing the same hub
   (barrel, union type, shared fixture, index doc) merge one after another instead
   of conflicting; each added edge is a decision. No `files`: unchanged (#4385).
   A `split` closes the parent `not planned` once its `FORGE:DECOMPOSED` trail
   and `workflow:decomposed` label are written (label kept; the closing comment
   lists the sub-issues; either write failing leaves it open) (#4337). A
   decomposed dependency, open or closed, gates through its sub-issues in
   `openDependency` and `resolveBlock`; no usable trail keeps the parent as the
   dependency. A run on a closed decomposed tracker ends `decomposed` with its
   `subissues` (the batch re-points dependents; none listed skips them), and a
   trusted `FORGE:DECOMPOSED:REVOKED` reopens it (`reopenRevokedDecomposition`,
   also used by the engine's `--retry`).
6. **Implement** — same session; `result.json` with typed amendments
   (`applyAmendments` → `FORGE:AMENDMENT`). An `add-deliverable` on a path the
   contract already lists appends its why to that deliverable's `change`, so it
   can declare a package edge on an already-listed package.json (#4159).
   Builder and reviewer runs get `FORGE_DOCKER_LABELS` (`ledger.mjs`
   `dockerLabels`: `forgedock.owner/batch/lane/issue/expires`, values limited to
   `[A-Za-z0-9_.-]`), and the implement prompt tells the builder to put them on
   every docker run/volume/network/build, use `--rm` and tear down via trap
   (#4181); `scripts/ci-local/run.mjs` labels its own network and containers.
   #4374 builder self-review: `prompts.mjs` `REVIEW_RUBRIC` (yes/no questions: fixed, no regression, contract met,
   scope) is embedded verbatim in both `reviewerPrompt` (`<rubric>`) and `builderImplementPrompt`, whose last step
   before `result.json` answers each question against `git diff <base>...HEAD` with evidence and fixes any "no" in
   the same session; `result.json` gains `self_review: [{question, answer, evidence}]`. `selfreview.mjs`
   (`readSelfReview`, `compareSelfReview`) + `lean.mjs` wiring log `SELF_REVIEW` or `SELF_REVIEW_MISSING` after the
   implement session (fixed results only) and, once on the first reviewer judgement (`conforms|nonconforming`),
   `SELF_REVIEW_AGREED|SELF_REVIEW_DISAGREED`. Run log only: never a failure, no runner call, no phase.
6a. **Declared check commands** (#4240) — forge.yaml `learned.test_commands`
   (`engine-cli.mjs` `readPrecheckCommands`) run in the worktree after the build
   commit via `io.runCommand` (`bash -c`, `verify.precheck_timeout_seconds`,
   default 300; no Actions minutes). Failures go back to the builder
   (`precheckFailurePrompt`, up to `max_rounds`); no commit / rounds exhausted is
   an anomaly and the lane continues (CI stays the gate). `PRECHECK_COMMANDS` event.
   #4363 fresh fix sessions (`fixround.mjs` + `lean.mjs` `fixRound`): precheck, CI (verify and merge), docs,
   structure, enumerating and sequence rounds, and conformance/review FAILs whose failures all cite a `file:line`
   (`freshFix`/`citesFileLine`), run with `resume: null` on `fixModel` (forge.yaml `lean.fix_model`,
   `engine-cli.mjs` `readFixModel`; default the reviewer model) and `prompts.mjs` `fixSessionPrompt` (host rules,
   the site's task prompt, `git diff <base>...HEAD` via `boundDiff`, frozen contract, issue title + `issueSummary`;
   < 60K chars). The fresh session never adopts its session id; when it makes no commit, one resume of the build
   session follows in the same round. `PHASE_ATTEMPT_USAGE` gains `mode: fresh|resume` on fix rounds (run log only).
   Block/contract corrections, CI-unavailable and base-sync conflict resolution still resume; round gates unchanged.
   #4362: every `PHASE_ATTEMPT_USAGE` carries `trigger` (`fixround.mjs` `TRIGGERS`): plan call `plan`, implement
   `build`, untyped-block resume `block_correction`, contract correction `contract_correction`, `fixRound(kind, task,
   failures, trigger)` with `precheck`/`structure`/`docs`/`enumerating`/`sequence`/`conformance`/`review`, CI verify
   `ci_red`, merge-time CI `merge_ci`, CI-unavailable fallback `ci_unavailable`, base-sync conflict `recovery`,
   reviewer `review`, split grouping `plan`; a CLI idle/timeout retry is `timeout_restart` with `restart_of` (the
   replaced trigger); a context-ceiling restart (#4390, below) is `context_restart` with `restart_of`, and like
   `timeout_restart` of the build it counts as reaching the build, not rework.
   **Context ceiling** (#4390, forge.yaml `engine.context_ceiling_tokens`, default 120000, 0 = off; `readCoreLimits`
   → runCore `contextCeilingTokens`): every builder call except `plan`/`contract_correction`/`block_correction` passes
   `contextMax` through `makeLeanRunner` to `runCliBackendAsync`, which reads each stream-json assistant message's
   `usage` (context = input + cache read + cache creation) and kills the session at the ceiling with `CLI_CONTEXT`
   (`context`, `turns`, stream-aggregated `usage`, deduped by message id). `builder()` logs `CONTEXT_CEILING`, records
   the stopped attempt's usage/turns as a `PHASE_ATTEMPT_USAGE` (so killed tokens stay in telemetry), runs
   `checkpoint("context ceiling")` (commit + push, never loses work) and restarts a fresh session with the call's restart
   prompt + `prompts.mjs` `contextRestartPrompt`: `git diff --stat` and the hunks against the lane base (`boundDiff`,
   `RESTART_DIFF_MAX_BYTES` 40 KB) and the last `.forge-lean/self-check.json`; contract.json stays the authority on disk.
   Context restarts do not use the single idle/timeout retry; after 3 in one call the call runs uncapped (loop guard).
   **Turn budget** (#4392, `budget.mjs`, forge.yaml `engine.turn_budget_s|m|l`, defaults 25/60/100, 0 = off;
   `readCoreLimits` → runCore `turnBudgets`): at contract freeze (or a resumed frozen contract) `laneSize` sizes the lane
   from a `size:S|M|L` label, else the contract's distinct deliverable paths (S ≤ 2, M ≤ 5, else L). While `stage ===
   "implement"` every builder call (build plus its context/timeout restarts) passes `turnMax` = budget left;
   `runCliBackendAsync` kills the stream session at that many deduped assistant turns with `CLI_TURNS`. `builder()`
   records the attempt, logs `TURN_BUDGET_EXCEEDED`, checkpoints and runs `budgetWrapup`: one fresh session (trigger
   `budget_wrapup`, `restart_of` the stopped trigger, `wrapupGrant` = max(5, ceil(budget/5)) turns, prompt
   `turnBudgetWrapupPrompt` with diff and last self-check) that either finishes (the result flows on) or writes
   `status: budget-exceeded` + `digest`. A stop or overrun (`TURN_BUDGET_STOP`) ends needs-human `budget.exceeded` with
   `budgetDigest` (builder digest, else diff stat); it is in `RECOVERABLE_CODES`, so the batch reruns it once with
   `RECOVER_HOW` (continue from the checkpoint or a typed split-required block). Plan/corrections and fix rounds are not
   budgeted. The lane result and `RUN_TERMINAL` carry `turns: {size, budget, build, total, exceeded}`; orchestrate copies it
   to the row and the batch report adds `formatTurnSummary` (`turns by size: S n= p50 max/budget; … over budget: #N`).
   **Quiet output** (#4390): `HOST_RULES` tells the builder to run tests quiet, read failures as `tail -40` + failing test
   ids, read files by range and send output that may pass 8 KB to a `$TMPDIR` file. `precheck.mjs` `quietFailure`
   (last 40 lines within the char share, failing-test-id lines by pytest/TAP/jest/vitest/go/cargo markers, `full log:`
   path) formats each failure in `forgedock check`'s table and in the precheck fix prompt; the full output goes to
   `.forge-lean/logs/` (`CHECK_LOG_DIR`: `check-<V#|cmdN>.log`, `precheck-<round>-<i>.log`). Pitfall learning still
   reads the capped tail. A source-scan test in `lean.test.mjs` fails on a call site without a known literal. The lane
   result carries `firstPass` (`firstPassOf`: no `REWORK_TRIGGERS` attempt after the build; omitted when the lane never
   reached it) → orchestrate row `first_pass` → batch-report line `first-pass: P% (k/n lanes that reached the build)`
   (`formatFirstPassSummary`, after the precheck line). `forgedock stats` reads the same fields (`docs/STATS.md`).
   An optional `.forge/test-map.json` (#4272, `scripts/test-map.sh`; base ref via
   `testmap.mjs` `readTestMapAtRef`, then main checkout, never the lane worktree, #4297) adds the map entries whose
   globs match the changed files to that list (`selectCommands` + `mergeChecks`, #4315: learned first, deduped, so the
   map never removes a check; event gains `source: "test-map"|"test-map+learned"` when the map added a command).
   #4331 (`testmap.mjs` `scopeChecks`): a learned command the map covers (same `checkKey` as an entry's command) runs
   only when one of its globs matches a changed file; unmapped learned commands always run; `source` also marks a
   scoped-out command. A round runs through `precheck.mjs` `runChecks`: concurrent up to `verifyParallelism()`
   (`FORGE_HOST_PARALLELISM`, else cores / live lanes) N; #4344: each running command takes its own `heavyAcquire("precheck")`
   slot (`runChecks` `acquire`, awaited before its timeout is computed, so the slot wait counts against the budget) and
   the worker budget is shared, not multiplied: k concurrent commands each get `FORGE_HOST_PARALLELISM = max(1, floor(N / k))`
   (`FORGE_HOST_PARALLELISM=1` = serial, one worker), within a round budget of
   forge.yaml `lean.precheck.max_minutes` (`engine-cli.mjs` `readPrecheckBudget`, 1..120; else
   `verify.precheck_total_seconds`, default 600 s). Commands not started before the budget ends, or cut by it (rc 124
   with the remaining budget as timeout), are `deferred-to-ci` (event entries `{command, status}`, trajectory anomaly),
   never failures. `PRECHECK_COMMANDS` results carry `ms`; the event carries round `ms`, `parallelism` and the per-command `workers` share; the lane
   result `precheckMs`/`precheckDeferred` → orchestrate row `precheck_ms`/`precheck_deferred` → batch-report line
   `precheck: <m> total over <n> lanes[, <k> deferred to CI]` (`formatPrecheckSummary`).
   #4364: selection and budget are one function, `precheck.mjs` `planPrecheck`, shared with **`forgedock check`**
   (`engine-cli.mjs` `checkFromCli`), which the implement prompt tells the builder to run in-session until green (or
   report blocked) before writing result.json. The engine writes `.forge-lean/check-plan.json` (base, verify mode,
   learned commands, budget, timeouts; forge.yaml is gitignored, so not in the worktree) beside contract.json; the CLI
   runs the contract's validate commands (`ci` and not run in `verify.mode: ci`) and the planned pre-PR commands through
   `runChecks` + `runCheckCommand` in the builder's env (lane TMPDIR, toolchain, heavy shims gate heavy binaries: no
   `acquire`), prints a capped pass/fail table and writes `.forge-lean/self-check.json` with `worktreeFingerprint`
   (sha256 of path + blob sha of every path differing from the merge base, committed or not; `.forge-lean/` excluded).
   After the implement call a `fixed` result whose record is not green on the current tree logs `SELF_CHECK_MISSING`
   (`state: skipped|stale|red`); a failed `PRECHECK_COMMANDS` round carries `self_check` (`selfCheckState`). Both are
   records only: the engine's precheck, conformance and CI stay the gates.
6b. **Verify by CI** (#4167, forge.yaml `verify.mode` `ci|hybrid`; default `local`
   = unchanged) — `verify.mjs` `runCiVerify` before every review: push, dispatch
   `verify.workflow` (or wait on push checks), red → builder fix with log tails
   (`max_rounds`, then `ci.red`), slow → `ci-pending`, unavailable → local fallback;
   docs-only (`skip_paths`) skips. A verified head satisfies validate ids left to CI.
   **Validate commands vs a moving base**: `validateContract` rejects a validate
   command whose `git diff` compares against a remote `origin/<x>` tip rather than the
   merge base (`movingBaseDiff`), so the planner fixes it in the one contract
   correction. When a precheck `validate_failed` resumes the builder, the engine first
   fetches the lane and the resume prompt says to `git merge --no-edit origin/<lane>`
   (never rebase) if the failure is only the base moving on.
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
   Follow-up keys are cut to 240 chars and then trimmed, and `fileFollowups` maps
   the script's echoed (trimmed) keys back to the caller's keys via `followupMap`
   (#4388: a key ending on a space looped on `followup.unavailable`).
   Independent verifier (#4397, `verifier.mjs`, forge.yaml `review.verifier`,
   default `off`): after a conforming review, one fresh read-only call on a
   model other than the builder's tries to break the change; enforce turns its
   `file:line` findings into `conformance.regression` for the same fix round.
   Scope authority (#4350): the engine's scope gate (deliverables plus typed
   amendments) decides scope, not a builder-written allowlist. `precheck({frozen})`
   gets the pre-amendment contract; a failed validate that is a scope check
   (`isScopeCheck`: `git diff|log|show --name-only|--name-status|--stat|--numstat`,
   `git status --porcelain|--short`) whose only files outside `frozen` are
   covered by deliverables an `add-deliverable` amendment added, with no scope
   creep left, is returned in `superseded` (event `VALIDATE_SUPERSEDED`, a
   decision line), not `conformance.unimplemented`. Real creep still fails as
   `conformance.scope_creep`, and then the validate failure stands too. The plan
   prompt says scope is enforced by the engine. Option chosen over rejecting them at
   freeze because a frozen contract is reused on relaunch.
   Since #4353 such a validate never reaches a new frozen contract: at freeze
   (after each contract read, before `validateContract` and the preflight, so
   it never costs the one correction) `dropScopeValidates` removes every
   validate `isPureScopeCheck` matches (a scope check whose every segment is
   git diff|log|show|status|merge-base|rev-parse or a filter such as grep,
   sort, wc, test, awk, sed), with event `CONTRACT_SCOPE_VALIDATE_DROPPED` and a
   decision line. A mixed command (`node --test x && git diff --stat`) is kept.
   The hash and the posted contract cover the dropped contract; a contract
   frozen before the change and recovered on a rerun is not rewritten, so the
   `superseded` path stays for it.
   Hotspots (forge#4195): `io.hotspots` runs `scripts/hotspots.sh` once
   before the plan call on the issue's `namedPaths` (`hotspotPlanNote`: one
   line per file over `maintenance.hotspot.file_lines`, nothing when none;
   the implement prompt gets `hotspotBuildRule`) and again in `gate()` with
   `--base` on the changed files. `hotspotGrowth` fails precheck with
   `maintenance.hotspot_growth` (kind `hotspot_growth`, in
   `SHADOW_PRE_BLOCKS`, so it blocks in shadow too) for growth over
   `growth_lines` without `hotspot-exempt: <reason>` in a covering deliverable
   or add-deliverable why. A failed script or `enabled: false` turns it off;
   no runner calls are added.
   **Enumerating tests** (#4322, `enumerating.mjs`): before the plan call
   `io.enumeratingTests` lists tests that enumerate the exports or directory
   siblings of the issue's named paths (`enumeratingPlanNote` /
   `enumeratingBuildRule`, "" when none). After implement `io.enumeratingMissing`
   (new exports/files a sibling-listing test does not name, minus result.json
   `not_members` with a why) resumes the builder once; still missing is an anomaly.
8. **Push + PR → merge** — merge policy `required` (default) | `all` | `none`;
   base-sync merges the lane in on conflict (never rebase/force-push); merge
   at the reviewed head → `merged`, or `ci-pending` after the CI wait. Each CI
   wait poll re-reads mergeability (#4266): a PR that turned conflicting (its
   `pull_request` workflows never start) base-syncs at once and waits again,
   within the same base-sync limit (→ `base.conflict`); required checks that
   have not started after `CI_NOT_STARTED_GRACE_MS` on a MERGEABLE PR log one
   `CI_NOT_STARTED` event (not terminal). A failed
   required check (any verify mode, #4240) resumes the builder with the failed
   logs (`collectFailedLogs`, `ciFailurePrompt`), re-reviews and pushes the fix,
   and waits again; `ci.red` only after `max_rounds` (shared with `ciVerify`) or a
   round with no new commit. Rollups of another head count as pending. `CI_FIX_ROUND`.
   **e2e merge gate** (#4403, `e2e.mjs`, forge.yaml `verify.e2e*`): before `gh pr merge`,
   once per reviewed head, a lane whose diff touches `e2e_paths` or whose contract
   quotes `[type:e2e]` runs `runE2eGate` (label the PR and wait on `e2e_checks`, a
   `skipped` run = not run; or dispatch `e2e_workflow` via `runCiVerify`). The lane's
   own failures (`ownFailures`: spec path/basename in the log, empty log, or no spec
   changed) go through `mergeFixRound`; others are an anomaly (`e2e_blocking: all`
   blocks them). Timeout → `ci-pending`, unavailable → needs-human. `E2E_VERIFY`.
   `never`, or no `e2e_label`/`e2e_workflow` configured, keeps today's behaviour.
   **Sequence numbers** (#4322, `sequence.mjs`): before review and the first push,
   and after every base-sync merge (clean or not), lane-added `<NNN>_*` files whose
   number the fetched lane already uses → builder renumbers (`sequencePrompt`; a
   conflicted migration/journal gets `sequenceSyncNote`), then `verifyRenumber`
   (same blob, journal strictly ordered, no collision); still failing → `base.conflict`.
   Numbered documents (#4385, e.g. `docs/adr/0016-*.md`): a renamed file may differ
   only in its own number (`numberOnlyChange`, padded or not), and no tracked file
   may still name a renamed file's old stem (the series index, links).
   Only real series count (#4343): a leading date (`YYYY-MM-DD`, `YYYYMMDD`) is no
   number, and the directory must hold a series on the base — a `_journal.json` /
   `meta/_journal.json`, or ≥2 distinct numbers of the file's width filling at least
   half of their range (sparse issue-numbered docs are not a series).

## Host parallelism (#4182)

Every runner call gets `FORGE_HOST_PARALLELISM` in its env, next to the
per-run `TMPDIR`/`CLAUDE_CODE_TMPDIR`. The value is
`max(1, floor(cores / live lanes))`, computed by `admission.mjs`
`hostParallelism`. Live lanes come from `ledger.mjs` `countLiveLanes`, a
read-only scan of `~/.forge/ledger/*/*.json` that counts lane files with this
host, a live pid and an unexpired `expires`. That includes the lane itself,
which registers its run tmp before the first runner call. The scan is exposed
as `makeHostProbe().activeLanes()`.

- Since #4169 a heavy-step shim overrides the value per step with
  `max(1, floor(cores / live heavy holders))`, so lanes in LLM phases or
  waiting for a heavy slot no longer shrink a running step's workers.
- A positive-integer `FORGE_HOST_PARALLELISM` already set in the environment
  wins as an operator override (shims leave it alone too).
- When the probe fails, or there is no host probe, the variable is not set.
- `HOST_RULES` in `prompts.mjs` tells the builder to cap verification at the
  value: `turbo --concurrency`, `vitest`/`jest --maxWorkers`,
  `playwright --workers` and `node --test --test-concurrency`, with eslint
  going through turbo.
- ci-local passes the variable through `scrubbedEnv` and caps its slot count
  and job `maxParallel` at it (`lib.mjs` `capParallel`).

## Dependency cache (#4220)

`depcache.mjs` `prepare` (after the worktree and the toolchain step 2b exist) keys each lockfile (pnpm/npm/yarn
non-PnP, uv/poetry) by sha256 of lock + manifests + runtime + platform. Hit: hardlink the
read-only snapshot `~/.forge/depcache/<repoKey>/<eco>-<key>/` in (bin scripts copied, build
path rewritten), then a warm repair install. Miss: frozen install under the key lock, publish
via tmp + atomic rename. Never fails the run (`DEPS_PREPARED`); runner env gets the shared
stores; install/repair commands get the lane's toolchain env (#4347: a pm only the shim provides
resolves; no pin, no shim or a failed toolchain step means the host PATH); `forgedock gc --deps` reaps; `FORGE_DEPCACHE=0` opts out. See `decisions/4220-shared-dep-cache.md`.

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

Milestone drift (#4161, no LLM): a merged lane's result carries `structure`
(the merge-time STRUCTURE_DELTA record), `milestone` and `lane`.
`orchestrate.mjs` awaits `drift.onMerged` for merged `milestone/*` lanes
before their slot frees. A drift error is a `drift` row and never changes the
outcome. `drift.mjs` `makeDrift` (wired by `engine-cli.mjs`) folds the record,
keyed by PR, into a `<!-- FORGE:DRIFT {json} -->` block in the GitHub milestone
description (GET + PATCH; the text around it is kept). With forge.yaml
`orchestrate.drift` thresholds (`readDrift`: `pair_growth`, `package_lines`,
`file_lines`), it fetches the milestone and staging branches and runs
`scripts/milestone-drift.sh`. That script recomputes pair growth and new
edges (`structure-delta.sh`) and size growth (one `git diff --numstat`,
generated paths excluded) from the fork point. It then files one templated
issue per crossing in the milestone, deduplicated by a
`FORGE:DRIFT:<slug>:<kind>:<key>` marker. `block_dispatch: true` holds queued
issues on that lane whose Affected Files sit under a flagged package dir;
they end `held` (`drift: <dir> flagged`). The flags are in memory, so a
resumed batch holds nothing until the next merge. With no config, only the
summary is written. `/milestone drift <slug>` prints the script's text report.

## Other files

`checks.mjs` (change-scoped typecheck/lint/test commands and shared tsc/eslint caches, #4218),
`execution.mjs` (forge.yaml `execution`, sandbox-provider seam, `local`/`container` providers, #4253; `remote` provider, #4254),
`sandbox-remote.mjs` (remote sandbox provider + HTTP transport, #4254), `credentials.mjs` (env → OS keychain, #4254),
`prefilter.mjs` (cheap pre-run close of already-fixed issues, `FORGE:PREFILTER`; the CI-green close is skipped for flaky/intermittent issues, reopens after a pre-filter close and same-SHA fail+pass, #4305; post-deploy precondition gate parks `awaiting-promotion` follow-ups, #4389),
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
#4348: wherever npx launches the shims (an npm pin, or pnpm/yarn without corepack) `resolvePinnedBins` runs `npx -y -p <pkg>@<ver> -c 'command -v <bin>'`
once per lane and keeps the path only when `<.bin>/../<pkg>/package.json` has the exact pinned version; each shim
then execs that binary directly (no npx process per call), keeping the `npx -y -p` line as the fallback when
resolution fails or the cache is pruned (anomaly note names the unresolved bins). Heavy shims still wrap the toolchain shim.

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
- `add {id, issues}` (#4408, `--add <id> N...`, also `--resume <id> N...`) merges
  issues into the batch's cumulative `add` file, hosted or not. The client skips
  closed issues first; non-integers and issues already in the batch are skipped.
  The runner re-reads the file every pass (`getAdded`), adds new issues through
  `addIssues` after re-reading the pending issues' `Depends on`, and records one
  batch decision plus an `added` row. `attach` resumes a finished batch that has
  unrun adds instead of replaying its report.
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

## Entry 2026-10-20 — TypeScript mover for refactor:split (#4212)

`.ts/.tsx/.mts/.cts` targets go through `scripts/symbol-move.mjs` (ts-morph, same CLI/JSON/exit codes as
`symbol-move.py`) and `scripts/symbol-index.mjs`; the old file becomes a re-export barrel. ts-morph is resolved
from the target repo or `NODE_PATH` (no FD dependency); without it a `--probe` refuses `split.unsupported`
`no codemod tool for ts` before any edit. `refactor-verify.sh` now resolves erased TS types (interfaces, type
aliases) statically. Go/JS stay refused. ADR `decisions/4212-ts-symbol-move.md`.

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

## Entry 2026-10-20 — Phase-aware admission: heavy-step semaphore (#4169)

Steps have two classes (`heavy.mjs` `classifyStep`). **llm** covers the lane's
`claude` sessions and everything unknown; nothing gates it beyond the host lane cap
(#4191) and account holds (#4190). **heavy** covers pm install/test/run/exec/build,
npx, tsc, eslint, jest, vitest, playwright, pytest, mypy, pyright, tox, cargo/go
build/test, docker run/build/compose, gradle and mvn. A heavy step takes a slot of one
host semaphore, `schedDir()/heavy.json`, which uses the same lock, atomic-write and
dead-pid discipline as the lane registry. A grant needs all of:

- live holders < `max`, which defaults to max(1, cores − 1);
- first among waiters, ordered by priority and then FIFO;
- MemAvailable − Σ reservations of holders younger than 60 s ≥ `step_mem_mb`
  (2048) + `reserve_mb` (1024).

Swap never counts as free memory. With no holder, one step may run while
MemAvailable ≥ reserve. The semaphore fails open. A waiter gives up after
`max_wait_s` (1800) and runs ungated. Config is forge.yaml `engine.heavy_enabled|
heavy_max|heavy_step_mem_mb|heavy_reserve_mb` (`engine-cli.mjs` `readHeavy`), passed
as `o.heavy`, or env `FORGE_HEAVY_MAX|STEP_MEM_MB|RESERVE_MB`.

The steps are gated in two places:

- **Builder-run commands:** after the toolchain step, `lean.mjs` writes per-run
  PATH shims (`<runTmp>/heavy/bin`, `writeHeavyShims`). A shim calls
  `node heavy.mjs run --name <n> -- <real>`, which acquires a slot, runs the command
  with `FORGE_HEAVY_HELD=1` (nested calls pass through) and per-holder
  `FORGE_HOST_PARALLELISM`, then releases and propagates the exit code.
- **Engine-side steps:** `env.setup`, precheck commands and the split tests go
  through `io.heavy` (`effects.mjs` `makeHeavyIo`). The split grouper's LLM call
  hands its slot back while it runs.

Runner env adds `FORGE_LANE_PHASE` (plan, implement, fix, or the reviewer/grouper
role), `FORGE_LANE_ISSUE`, `FORGE_LANE_PRIORITY` and `FORGE_HEAVY_WAITS`.

Load average is off by default (`ADMISSION_DEFAULTS.max_load_per_core: null`), so
the governor pauses a builder only on the mem/tmp floors. Its pause time is
counted as a wait.

Metrics: the lane result carries `waits` ({phase: ms}) and `heavyQueueMax`, and
orchestrate rows keep both. The batch report adds `formatWaitSummary`: `waits by
phase: …; heavy queue: now N, max M`.

Cost: 0 LLM calls; one node process (~40 MB) per heavy step while it runs.
ADR `decisions/4169-heavy-step-semaphore.md`.

## Entry 2026-10-20 — Execution modes and the sandbox-provider seam (#4253)

forge.yaml `execution:` (`execution.mjs` `parseExecution`, read by `engine-cli.mjs`
`readExecution`): `mode` local (default) | remote | hybrid, `max_remote` (default 0),
`provider` (default `container` off local), `image`, `secrets` (comma-separated env
names). `placement` is `remote` only for `mode: remote` with `max_remote >= 1`;
`hybrid` is placed per lane by `placeLane` (#4256). Absent or local config builds lanes with
`batch.mjs` `detachedLanes` exactly as before.

A provider is `{name, idFor, start, status, fetchResult, teardown}` over a JSON
handle `{provider, id, issue}`. `local` wraps `launchLane`; the reference
`container` runs `docker run -d --rm --pull never` with the #4181 labels plus
`forgedock.sandbox=1`, the checkout's git common dir read-only at `/src` (cloned to
the container's own `/work`), `~/.forge/verify-cache` read-only at `/cache`, and the
batch `lanes/` dir at `/result`. The sandbox env is only `FORGEDOCK_BATCH_ID`,
`GH_REPO` (the target repo) and the allowlisted secret names, passed as `-e NAME`
so values never reach argv, the handle, the ledger or the batch state. The lane
inside still runs `run-issue`, so results, leases and annotations go through GitHub.

`providerLanes` registers ledger kind `sandbox` (lane file `sandbox-<n>`) before
`start` and releases it only when `teardown` returned true, on result, failure, no
result (engine-error row), thrown error and adopt. A dispatcher killed mid-lane
leaves the entry under its dead pid: `--resume` adopts from the persisted handle,
`forgedock gc --apply` (scope `sandboxes`) tears it down through the provider.
`countLiveLanes` skips sandbox-only lane files. `orchestrate.mjs` seam
`remote: {max, isRemote}` admits remote lanes against `max_remote` without a host
registry slot (batch K still applies). Rationale:
`devdocs/decisions/4253-execution-sandbox-provider.md`.

## Entry 2026-10-20 — Remote sandbox provider (#4254)

`sandbox-remote.mjs` `remoteProvider` implements the #4253 provider interface over a
transport (`launch/status/logs/result/usage/destroy`, addressed by ForgeDock's own id
`fdrsbx-<batch>-<issue>` so the pre-start ledger entry suffices for teardown).
`httpTransport` is the one shipped transport (JSON protocol in docs/CONFIG.md
`execution`). The launch spec carries the repo to clone, `cache_store`, the scoped
env (secret names resolved via `credentials.mjs` `resolveCredential`: env, then
keychain service `forgedock`) and the `run-issue` argv. Logs stream into the batch
lane log redacted; billable minutes go on `handle.minutes` and `providerLanes`
copies them to the lane result as `sandbox: {provider, id, minutes, cost_usd}` (#4255
reports them). `remote` is never a default provider; `remoteTransportFor` refuses a GitHub
Actions endpoint without `allow_actions: true`. `providerLanes` maps a throwing
`start` to `needs-human` `sandbox.start_failed` (or `deferred` `sandbox.capacity`
for a retryable error) instead of engine-error, and tears down after the result is
in on every path. `gc.mjs` `SANDBOX_TEARDOWN.remote` destroys stale remote
sandboxes through the checkout's forge.yaml transport (probe `sandboxTransport`
in tests). Contract suite: `sandbox-provider.contract.test.mjs` (container over a
fake docker, remote over a fake transport). Rationale:
`devdocs/decisions/4254-remote-sandbox-provider.md`.

## Entry 2026-10-20 — Sandbox cost and the execution budget (#4255)

Providers may implement `usage(handle, {startedAt, endedAt}) -> {minutes, cost_usd}`.
`providerLanes` stamps `startedAt` on the handle (persisted, so adopt measures from
the real start) and attaches `sandbox: {provider, id, minutes, cost_usd}` to every
result. Without a usage report it uses wall clock × `execution.cost_per_minute`.
`orchestrate` sums it per issue (state key `sandbox`, over attempts) onto the row and
calls `remote.onUsage`. `runBatch` records each attempt in the host-day store
(`openExecutionBudget`, `execution-budget.json` in the sched dir, keyed
`batch#sandbox#startedAt` so a repeat is a no-op) and emits FORGE:TELEMETRY
`sandbox_usage`. Before admitting a remote lane, `orchestrate` asks `remote.admit`
with settled + running usage. On refusal, `on_budget: stop` holds the rest
(`held`, "execution budget: ..."); `local` sends them through the host path
(`ctx.remote` false, composite lanes in `runBatch`). `formatTable` adds
`sbx-min`/`sbx-$` only when a row has `sandbox`; `formatSandboxSummary` prints the
totals and the budget. Rationale: `devdocs/decisions/4255-sandbox-cost-budget.md`.

## Entry 2026-10-20 — Hybrid placement (#4256)

`execution.mode: hybrid` places each lane with the pure `placeLane({exec,
verifyMode, labels, weight, headroom}) -> {where, reason}` (`execution.mjs`).
Rules, in order: a non-hybrid mode keeps `placement()`; `max_remote` 0 → local;
`verify.mode: ci` → local (validation is billed on CI already); docs-only labels →
local; heavy validation → remote; a host without headroom → remote; otherwise local.
`validationWeight` (declared check commands through heavy.mjs `classifyStep`,
multi-ecosystem toolchain markers, the `detectPins` package manager) is read once
per batch. `hostHeadroom` (admission memory floor + one heavy step, optional load
ceiling) is a fresh synchronous snapshot per decision.

`runBatch` wires hybrid like remote plus detached host lanes and passes
`remote.place` and `remote.fallbackLocal`. In `orchestrate`, a lane placed remote
with `max_remote` running, or refused by the budget, takes the host path instead
of waiting or stopping. Remote mode is unchanged. The final `{where, reason}` is
on the run record and the row, and in `ctx.placement`. The lane gets it as
`run-issue --placement/--placement-reason`, and `runCore` `o.placement` writes it
into FORGE:STATE (`placement: {where, reason, mode}`) and a trajectory decision.
Cost: 0 LLM calls. Rationale: `devdocs/decisions/4256-hybrid-placement.md`.

## Entry 2026-10-20 — Context pack: the issue's graph as plan context (#4275)

Before the plan call (not for refactor:split lanes or a recovered frozen contract)
`lean.mjs` `contextPackStep` asks `io.contextFacts` (`context.mjs`
`gatherContextFacts`, gh + git only) for four switchable sources: **graph**
(`**Parent**`, `Depends on`, body links, timeline cross-references, siblings from
the parent's `FORGE:DECOMPOSED`; full body only for parent/dependencies; outcome
from the linked body's `FORGE:STATE`), **attempts** (`FORGE:STATE` terminal reason,
trusted `FORGE:NEEDS_HUMAN|BASE_SYNC|FIX_CI`, `refs/forge/salvage/<N>/*`),
**ledger** (first-parent merges on the issue's named paths within
`context_pack_days`, kept only when a revert, reverted, or a decision / review
finding / title names a backticked symbol from the issue) and **facts**
(`.forge/repo-facts.json`, `.forge/test-map.json` paths when present).
`compileContextPack` is pure: ranked graph > attempts > ledger > facts, one line
per item with `#N`/comment id/SHA, whole items dropped past the byte cap
(default 6144). Cached in the run dir by issue + base head SHA + config.
Recorded as `CONTEXT_PACK` (mode, lane_type, sources, bytes, items, truncated,
hash) and a collapsed `FORGE:CONTEXT` comment (non-empty packs, once per hash).
All issue/comment text goes through `noComments` (HTML comments cut out by scanning,
`-->` or `--!>`, then every `<` starting `<!` becomes `‹`) and the rendered record is
passed through it again: no `<!` survives, so untrusted text can never open a comment
or place a FORGE marker in the bot's comment;
`RUN_TERMINAL` gains `context_pack` and `lane_type` (rerun | child | first).
Write-back: a terminal `FORGE:STATE` also carries `terminalCode` (the typed
outcome code) and `failureClasses` (conformance failure codes seen in the run),
which the next pack reads instead of re-deriving them from the reason.
`forge.yaml engine.context_pack`: `shadow` (default) records only, `on` appends
`contextPackNote` (hints, not proof; never quotable) to the plan prompt, `off` is
the old path with no extra calls. The pack never enters `issueText`, and neither does
the bot's `FORGE:CONTEXT` comment (#4297), so contract quotes stay issue-only. `forgedock stats --context-ab` reports first-pass yield,
builder turns, cache tokens and cost per lane type and mode; the default moves to
`on` only once that A/B shows a win.

## Entry 2026-10-20 — Resource hygiene: preflight and admission GC (#4183)

`forge.yaml` `hygiene:` (`container_ttl_hours` 6, `worktree_ttl_hours` 24,
`tmp_ttl_hours` 6, `delete_merged_branches` true, `max_host_load_ratio` 0.8,
`auto_gc` true) is read by `gc.readHygiene` and turned into TTLs by `hygieneTtls`.
`runBatch` runs `runOwnedGc` once in preflight, before any lane is admitted, and
tallies items and bytes. Only owned resources are reclaimed (ForgeDock label or
ledger); unowned stale ones are reported, never removed.

`admission.mjs` adds `nearCeiling({cfg, host, ratio})`: true when load per core,
free memory or free tmp is within `ratio` of a `checkAdmission` threshold (load only when `max_load_per_core` is set; it is off by default, #4169). A
failed or non-finite probe is never "near". `orchestrate` takes an optional
`beforeAdmit` hook, awaited at the start of each admission pass when a lane is
ready and a slot is free (not tripped, not held). Its errors are swallowed. In
`runBatch` the hook runs GC (phase `admission`) only when `nearCeiling` is true
and no GC ran in the last 5 minutes. `auto_gc: false` disables both phases; no hook
is passed.

The batch report ends with a `reclaimed:` line (`formatReclaimed`: items, size,
preflight/admissions split, or "off"), and `reclaimed` is on the report file and
the `runBatch` result. `forgedock doctor` check 13 (Resource hygiene) lists owned
leftovers with counts and sizes and warns on unowned stale ones; `doctor --fix`
applies the reaper. `commands/cleanup.md`, `work-on/close.md` and
`work-on/build/validate.md` call the same reaper. Cost: 0 LLM calls.

After `reclaimed:`, the batch report ends with the fail-soft alerts for the batch's
repo (#4354). `formatAlertLines` prints `ALERTS` and one line per alert, or nothing
when no alert fired. The lines come from `computeAlerts` (`bin/stats/aggregate.mjs`)
over `readLanes` of the batch's run-log dir. Each run in a log is one lane, and the
window is the last 50 lanes of the repo. The rules are: `DEPS_PREPARED` failed above
20% per ecosystem, `deferred-to-ci` above 30%, one `TOOLCHAIN_WARNING` on more than
50% of lanes, and an outcome code whose share doubled against the previous window.
Thresholds come from `stats.alerts.*`, and there are no alerts under 10 lanes.
`forgedock stats` prints the same alerts as `## ALERTS`. A failure while computing
them never fails the batch. Cost: 0 LLM calls, no network.

## Entry 2026-10-20 — Complete conformance reviews, blocking shadow gate (#4160)

`decide()` first runs `fillEngineRows` (`conformance.mjs`): engine-authorized scope rows, `unverified` preserve rows and `path:line` evidence normalized to repo paths (`normalizeEvidencePath`) are no longer "incomplete". `reviewerPrompt` embeds `reviewSkeleton` (a row per R/P/scope/coverage id). `checkCompleteness` returns `missing` ids; the retry in `reviewOnce` is `reviewerRepairPrompt` for those ids only (no diff), merged by `mergeReviewRows`. `changedFiles()` drops files equal to the base tip (base-sync merges).

In shadow, `gate()` now blocks on precheck/amend failures coded `conformance.unimplemented`/`regression` (`SHADOW_PRE_BLOCKS`), ends `review.incomplete`/`inconsistent` as needs-human, and files accepted deferrals with `track()`. `engine.review_incomplete: degraded` (`readReviewIncomplete`) merges instead with the `review-degraded` label and a tracked follow-up. Enforce unchanged. `scripts/calibration.mjs --shadow` prints the per-repo shadow mix and recommends `enforce` under the threshold. Rationale: `devdocs/decisions/4160-shadow-gate-complete-reviews.md`.

## Entry 2026-10-20 — forgedock/verify check run (#4270)

Opt-in `verify.check_run` (`verify.mjs` `parseVerify` → `checkRun`, default false).
`lean.mjs` keeps `verifyFacts` (last result of the declared checks, structure, docs and
`gate()` precheck) and `reportVerify()` posts one `forgedock/verify` check run per pushed
head (PR push, base-sync, merge fix round) via `effects.mjs` `createCheckRun`, payload from
pure `verify.mjs` `verifyReport`; `VERIFY` run-log event, Checks API failure → anomaly.
Own check excluded from `runCiVerify` commit checks and `wait-ci-green.sh --ignore-check`.

## Entry 2026-10-20 — Bug lanes freeze a red-green repro_test (#4271)

forge.yaml `lean.repro_test` (`engine-cli.mjs` `readReproTest`, `off|prefer`, default `prefer`) → `runCore` `reproTest`. On a `bug`/`type:bug` lane (`conformance.mjs` `isBugIssue`), the plan prompt gets `reproPlanNote`, and `validateContract(..., {repro: true})` requires `repro_test` `{path, id, command}` or `"none"` + `repro_test_reason` (one correction resume). `gate()` runs `io.redGreen` (`effects.mjs` → `scripts/acceptance-red-green.sh`, inside `heavyStep`) and passes `{base, head}` to `precheck({repro})`. Anything but `BASE=FAILED HEAD=RAN` is `reproFailures` kind `repro_red_green`, code `conformance.unimplemented`, so it blocks in shadow and gets the one in-session resume (#4149). `off`, non-bug lanes, resumed pre-#4271 contracts and refactor:split leave prompts, contract check and precheck unchanged. Cost: 0 LLM calls; one targeted test run on base and head per gate.

## Entry 2026-10-20 — Deterministic review trigger, shadow-first (#4273)

`review-trigger.mjs` `computeTrigger` returns `{would_skip, reasons}` from facts only: `risk_path` (built-in auth/payments/security/deletion/migration words, plus forge.yaml `review.risk_paths` globs), `package_edge`, `hotspot` (changed file `over`, not excluded), `gate.failed` (precheck failures, declared check commands still failing, CI fallback) and `gate.ambiguous` (hotspot facts unavailable, or the contract defers a requirement). `gate()` logs `REVIEW_TRIGGER {mode, would_skip, reasons, skipped}` after the precheck. Modes (`review.trigger`, `readReviewTrigger`): `shadow` (default) always reviews; `enforce` skips `reviewOnce` when untriggered and records why (trajectory, decision, FORGE:REVIEW); `off` computes and logs nothing. An error in the trigger runs the reviewer. Exit criterion for enforce: ≥30 shadow runs with `would_skip_flagged` 0 in `node bin/lean/review-trigger.mjs [--json]` (per repo, from the local run logs). Cost: 0 LLM calls; enforce saves one or two reviewer runs per untriggered lane.

## Entry 2026-10-20 — Test map + repo facts caches for the pre-PR step (#4272)

`scripts/test-map.sh` writes `.forge/test-map.json` (`file glob → command` from package.json scripts, pytest/ruff
config, go.mod, Makefile targets and CI workflow `run:` steps; fixtures `scripts/fixtures/test-map/{node,python,go}`).
`scripts/repo-facts.sh` writes `.forge/repo-facts.json` (toolchain pins via `toolchain.mjs` `detectPins`, slow suites,
workspace package edges + boundary configs, over-threshold hotspots via `hotspots.sh`). Both are optional, regenerable
caches looked up in the lane worktree, then the main checkout (`bin/lean/testmap.mjs`). The pre-PR step (6a) runs the
map's commands for the changed files when the map is valid and matches, else `learned.test_commands`; builder plan and
implement prompts cite the facts file by path (`prompts.mjs` `factsRule`, never its content). Deleting both files
restores today's commands, events and prompts byte-for-byte. Cost: 0 LLM calls; fewer pre-PR commands when the map
narrows them. Rationale: `devdocs/decisions/4199-incremental-not-restructure.md`.

## Entry 2026-10-20 — In-batch recovery of mechanical needs-human (#4267)

`outcome-codes.mjs` `classifyNeedsHuman(row)` sorts a lane row into `recoverable`
(needs-human `ci.red` / `base.conflict` / `builder.block_untyped`, `contract.invalid`
with `issueEdited`, `ci-pending` on a conflicting PR → `base.conflict`), `human`
(`builder.blocked`: credentials, spend, promotion, customer, product-decision) or
`terminal`. `orchestrate()` option `recovery: {maxAttempts}` (forge.yaml
`orchestration.recovery.max_attempts`, default 1, 0 = off; absent = old behaviour;
`orchestrateFromCli` leaves it off when `engine.path` is `full`, #4304, since recovery lanes run on the core path only)
requeues a recoverable row as a recovery lane (`ctx.recover = {code, attempt}`, state
keys `recoveries`/`recovering`) under the usual admission, so dependents stay queued.
A merged recovery row carries `recovered: <code>`; any other end is final with
`recovery` evidence. `runCore` `o.recover` (CLI `--recover <code> --recover-attempt n`)
removes `needs-human`, posts `FORGE:DECISION`, and adds a per-code note to the rerun
prompt (failed-check logs, base merge, untyped choice); no extra Actions trigger.
Runner decisions (recovery, engine-error relaunch, dependency requeue, sub-issues
added) go to `decide({issue, what, why, alternative})`, fire-and-forget; `runBatch`
posts them as `FORGE:DECISION` comments. `formatOutcomeLists` adds `recovered:`,
`unrecovered:` and one end-of-batch escalation list (human codes only) to the report.
`check-spec-markers.sh` registers `DECISION`. Cost: one rerun lane per recovered issue.

## Entry 2026-10-20 — 1.29.0 trust-boundary fixes (#4297)

Context pack: `context.mjs` `codeOf` keeps a `FORGE:STATE` `terminalCode`, `failureClasses` item or
`terminalReason` only when it matches `^[a-z][a-z0-9_.-]{0,63}$`. `linkLine` re-checks this, so cached facts are covered,
and cross-repo timeline references are skipped (the jq emits `repository_url` + number). `lean.mjs` `textOf` drops
`<!-- FORGE:` comments, so `FORGE:CONTEXT` is never quotable. The pre-PR test map comes from the base ref
(`readTestMapAtRef`), else the main checkout. `scripts/test-map.sh` ends a `run:` block at the `run` key's column.
Since #4300 it maps a workflow `run:` step only when the whole command is an allowlisted check (`<pm> test`, `<pm> run`
of a package.json check script, `make <check target>`, `go test|vet|build`, known test/lint/typecheck tools; one leading
`cd|pushd DIR &&` becomes the cwd); anything else is dropped, job/step names are ignored, and workflow entries never get
a bare `**` glob. `verifyReport` gates carry `ran`; zero ran → `neutral`, "no gates
ran". A recovery lane (`recoverUnlabelled`) re-adds `needs-human` with a recovery-evidence `FORGE:NEEDS_HUMAN` only on a final
`ci-pending` (`needsHuman()` has its own path); never on merged/invalid/decomposed/dependency-*/deferred/engine-error. The
batch runner (`orchestrate.mjs` settle, injected `relabelNeedsHuman`, wired in `engine-cli.mjs`) relabels once for a final
`engine-error`/`deferred` after a recovery pass (2026-10-20, SPEC-7/8, BUG-6 from #4291). Rationale: `devdocs/decisions/4297-pre-release-trust-boundaries.md`.

## Entry 2026-10-20 — 1.29.0 staging-review LOW follow-ups (#4298)

One comment-strip helper: `noComments` lives in `render.mjs` (re-exported by `context.mjs`) and `prefilter.mjs`
`namedPaths` uses it too, so no one-pass `<!--…-->` regex is left on hash or path input. `context.mjs` `REPO_FACT_FILES`
reuses `testmap.mjs` `REPO_FACTS_FILE`/`TEST_MAP_FILE`. Context-pack cache: the key also hashes the issue's scope-text hash
(`stamp.scope` = `contractHash(scopeText(...))`, not `updatedAt`, which the lane's own posts bump, #4304) and
prior-attempt count (`contextPackFor` `stamp`); the recovery row counts the pre-filter cost once (#4304); a gather with source `errors` is not cached; the write goes through
`<file>.<pid>.tmp` + `io.fs.rename`; the issue's other `context-<N>-*.json` files are pruned (`io.fs.list`/`rm`).
`lean.mjs` `RECOVER_HOW` is a module export; `recovery.test.mjs` keeps its keys equal to `RECOVERABLE_CODES`.
`orchestrate.mjs`: a settled recovery row sums the earlier attempts' `cost_usd` and `minutes` (persisted in the
`recovering` entry; older state without them sums 0); `OUTCOME_LINE_MAX`; `effects.mjs` `CHECK_RUN_TIMEOUT_MS`.
`engine-cli.mjs` `readContextPack` warns once on an invalid `context_pack` mode and keeps the other keys; `run-issue`
rejects `--recover` with `--path full`. `conformance.mjs` `movingBaseDiff` reads only the revisions before `--`;
`scopeText` cuts every HTML comment, human ones too (SEC-5, not scope). `scripts/wait-ci-green.sh` always ignores
`forgedock/verify`, so the legacy engine, `review-finalize.sh` and spec CI gates agree with the lean path.
`test-map.sh` separates globs with `\037`; it and `repo-facts.sh` list files with `-z` and `core.quotepath=off`, and
`grep -q` reads here-strings (no SIGPIPE false negative under pipefail). Cost: 0 LLM calls.
Rationale: `devdocs/decisions/4298-staging-low-followups.md`.

## Entry 2026-10-20 — Recovery relabel only on the final attempt (#4302)

`orchestrate.mjs` passes `ctx.recover = {code, attempt, final}` with `final = attempt >= recovery.maxAttempts`;
`engine-cli.mjs` carries it to a subprocess lane as `--recover-nonfinal` (absent = final, so a manual
`run-issue --recover` and `max_attempts: 1` are unchanged). `runCore` normalises `recover.final` (default true); a
non-final recovery lane posts no `FORGE:NEEDS_HUMAN` and adds no `needs-human`, on `ci-pending` and in `needsHuman()`
alike, so the label does not flap between attempts and a concurrent dependent does not read a transient label. Settle
relabels once via `relabelNeedsHuman` when a non-final attempt ends `needs-human`/`ci-pending` and no next attempt is
queued (human or terminal code, `ci-pending` on a non-conflicting PR). Cost: 0 LLM calls.

## Entry 2026-10-20 — 1.30.0 pre-release fixes (#4315)

- `prefilter.mjs`: a `FORGE:PREFILTER` marker comment is the pipeline's own when it is trusted or written by the
  engine's identity (`ownLogins`: the App slug plus the token's `gh api user` login, looked up only when an untrusted
  marker comment exists, once per `makePrefilter` batch). `gh issue view` reports the App as `rapiercraft-forgedock`
  with `CONTRIBUTOR`, so the `[bot]` heuristic never matched. The close now runs before the marker comment.
- `orchestrate.mjs`: a recovery still queued when the batch exits (breaker, execution budget, drift/maintenance hold, or a
  resume that does not relaunch a lost run) is relabelled once via `relabelNeedsHuman` with the full persisted lane
  reason (`recovering[n].detail`, never `firstLine`); the persisted `relabelled` list stops a repeat across resumes and is
  cleared when the lane launches. Its `held` row carries `recovery`. `engine-cli.mjs` caps that comment (`capComment`).
- `scripts/test-map.sh` allowlist: `cargo test|clippy|check`, gradle/maven with check tasks/goals only, `[bundle exec]
  rspec`, `python manage.py test`, `python -m unittest`, `tox`/`nox` (no publish/release/deploy/upload env), `deno|bun
  test`, `pnpm -r`, `npm --prefix DIR`, `test:*`-style script names, `bash|sh <path>.test.sh`, each with its globs.
  Cost: 0 LLM calls; one optional `gh api user` per batch.
- 2026-10-20 (#4314 review): `test-map.sh` accepts `test|lint|check|typecheck|type-check|tsc` bare, and sub-named scripts
  only with suffixes `unit|ci|node|types|type|ts|js|static|check` (`format` only when the command is a check form);
  anything containing `fix|watch|write|update|dev|serve|start|e2e|integration|deploy|release|publish|snapshot|-u` is
  rejected, for package.json scripts and `npm run|pnpm|yarn|bun run` workflow steps. `prefilter.mjs`: once the close
  succeeds the result is `closed:true` whatever the marker comment does; the comment is retried once, then a short
  marker-only comment is posted so the #4305 reopen guard still sees the close.

## Entry 2026-10-20 — 1.30.0 staging review LOW follow-ups (#4316)

- `scripts/test-map.sh`: `skip_cmd` is gone (the allowlist covers it). `check_cmd` also drops `$GITHUB_*`, any `<`/`>`
  (redirects, `<(...)`, `>(...)`), a `make` with a non-check target (`make test deploy`), and fixer forms (`--fix`,
  `--write`, `-w`; `black`/`ruff format` without `--check`, `gofmt` without `-l`/`-d`, `prettier` without a check flag).
- `render.mjs` `recoveryEvidence` is the one recovery-evidence text (lane `lean.mjs`, settle and batch-exit relabel in
  `orchestrate.mjs`); `full` keeps the whole persisted detail, `queued` adds the batch-stopped sentence.
- `prefilter.mjs`: the kept detail names the skip reason (`flaky|reopened|same-sha`); bare `sometimes` is no longer
  flaky wording (only `fails sometimes` / `sometimes fails`).
- `context.mjs` `linkStateStamp`: hash of `n:STATE` for the issues the body references (parent, Depends on, `#N`; max
  20, one REST call each, `n:?` when unreadable) joins the pack cache key as `stamp.links`; no links keeps the old key.
- `scripts/review-prepare.sh`: the code-index stderr tail shows the repo root as `<repo>`, strips control characters
  and caps lines at 200 chars. Cost: 0 LLM calls; up to 20 `gh api` reads per context-pack lane.

## Entry 2026-10-20 — Missing host tools are an environment error, not conformance (#4323)

`gate()` (`rerunFailedValidates`) reruns once each contract validate command the builder recorded with a non-zero exit, via `io.runCommand` (`runCheckCommand`, now with an optional `env`: the lane's `TMPDIR` + `toolchain.env`) inside `heavyStep("precheck")`, logged as `VALIDATE_RERUN`. `precheck({validateRuns, repoHas})` counts a passing rerun as passed and classifies the rest with `conformance.mjs` `missingTool`: `command not found` / rc 127, Python `No module named x`, Node `Cannot find module|package 'x'` (bare names only). A path, relative specifier or a name `repoTracks(git ls-files)` holds stays `validate_failed` (a module the change forgot is a code defect). A miss is kind `validate_env`, code `env.tool_missing`: kept out of `pre`/`SHADOW_PRE_BLOCKS`, never sent to a builder resume, skipped on a CI-verified head; with no other blocking failure the lane ends `needs-human` `env.tool_missing` naming the tool before any reviewer call (also on the base-sync and CI-fix re-reviews, `envNeedsHuman`). The code is in `RECOVERABLE_CODES`; `RECOVER_HOW` has the recovery lane run the check through the repo's own toolchain. Freeze-time preflight of validate commands: see the #4328 entry. Cost: 0 LLM calls; one rerun per failed validate command.

## Entry 2026-10-20 — Enumerating tests + sequence numbers at hand-off (#4322)

Two deterministic hand-off facts (git + fs, no LLM): `enumerating.mjs` finds tests that list every member of a group
(literal/key list of >= min(3, n) sibling names, or `Object.keys(<import>)`) → plan note, build rule, post-implement
`ENUMERATING_MISSING` resume (then anomaly). `sequence.mjs` finds lane-added numbered migrations colliding with the base
→ `SEQUENCE_COLLISION`, builder renumbers with the repo's own generator, engine verifies. #3969 union merge unchanged.
Cost: 0 LLM calls unless a fact fires (then one builder resume each). Implement prompt also says to run the formatter.

## Entry 2026-10-20 — Evidence paths keep route-group and bracket segments (#4327)

`conformance.mjs` `evidencePathLine` reads reviewer evidence token by token. It keeps `(group)`, `[slug]` and
`[...slug]` path segments verbatim and drops only brackets with no partner (prose `(src/a.js:3)`), backticks, quotes and a
markdown link label. The old regex treated `()[]` as delimiters, so `(console)/layout.tsx:12` became `/layout.tsx`. The
existence check is unchanged: a missing path is still `review.incomplete`. `reviewOnce` (`lean.mjs`) gives one extra
targeted re-ask (at most 3 reviewer runs) only when the repaired reply is incomplete solely by unresolved evidence paths
(`evidencePathOnly`); other incomplete replies keep 2 runs. Reviewer and repair prompts ask for backtick-quoted, verbatim
repo-relative `path:line`.

## Entry 2026-10-20 — Engine-run commands get the builder's lane env; no $TMPDIR inputs at freeze (#4325)

`runCore` `laneEnv()` builds one env for every command the engine runs itself: `io.deps.env()` stores, then the run
`TMPDIR`, `FORGE_HOST_PARALLELISM` and `toolchain.env` (engine keys win over the stores). `io.redGreen` (`effects.mjs`,
new `env` merged over `process.env`), the declared check commands (`io.runCommand`, previously no env),
`rerunFailedValidates` and env.setup all use it. Before this, red-green ran with the daemon env (no run TMPDIR), so a
repro command reading a builder-written `$TMPDIR` file reported `BASE=SKIPPED HEAD=FAILED`. `callRunner` builds its env
from `laneEnv()` plus its runner-only keys (`FORGE_DOCKER_LABELS`, `CLAUDE_CODE_TMPDIR`, heavy shims) and gives the same values as before.
`validateContract` adds one problem per `$TMPDIR/<name>` that a validate or `repro_test` command reads before creating it
(`conformance.mjs` `tmpdirInputs`: `>`/`>>`, `tee`, `touch|mkdir|mktemp`, last argument of `cp|mv|ln|install`, output-like
options and `X=` assignments count as creating). It goes through the existing contract-correction resume, because the run
TMPDIR is per run and a rerun never has the file. The plan prompt says so in one line. Cost: 0 LLM calls; one correction
resume only for a contract that would otherwise fail at precheck.

## Entry 2026-10-20 — Freeze-time preflight of validate commands (#4328)

At contract freeze, `preflightValidates` (`lean.mjs`) probes the host for what each `validate[].command` needs, from
`preflight.mjs` `preflightProbes` (pure): a quote-aware split on `&&`/`||`/`|`/`;`, each segment's bare executable
(`command -v`), the modules a bare `python`/`python3`/`pythonX.Y` imports via `-c`/`-m` (`importlib.util.find_spec` with
that interpreter) and the bare packages `node -e`/`-p` code imports (`node_modules/<pkg>` walked up from the worktree).
Paths, `$VAR` words, names `repoTracks(git ls-files)` holds and names a deliverable's `change` text names are not probed;
a wrapper (`uv run`, `npx`, ...) probes only the wrapper (the #4393 run probe covers what is behind it); at most 20 probes. Probes run through the separate
`io.probeCommand` hook (`runCheckCommand`) with `laneEnv()` (#4325); no hook, no change. A miss (`preflightProblems`) joins the
validateContract problems in the existing single `contractCorrectionPrompt` resume. After it the misses are re-probed and
logged as `VALIDATE_PREFLIGHT` {misses, corrected}; any left are an anomaly only, never a block: the post-build #4323
rerun still ends `env.tool_missing`. Skipped when the frozen contract is recovered from the issue. Cost: 0 LLM calls when
the host has the tools; otherwise the one correction resume, instead of a whole implement session lost to `env.tool_missing`.

## Entry 2026-10-23 — Freeze-time execution preflight of validate commands (#4393)

The #4328 probes read the command text, so a wrapped interpreter (`uv run --no-project python -m shared.x`) and a
transitive import (`shared` imports `httpx`) pass them, and the command first runs after the build (AlterLab#36619:
`env.tool_missing` after a green implementation, then a recovery lane). `preflightValidates` (`lean.mjs`) now also:
(1) flags `$NAME`/`${NAME}` references that are unset or empty in `process.env` + `laneEnv()` and that the command does
not assign (`preflight.mjs` `unsetEnvVars`; single quotes, escapes, `${X:-d}` defaults and bash's own variables are
skipped), kind `env-var`; (2) runs each validate command without a static or env miss once on the base worktree through
the separate `io.preflightRun` hook (`runCheckCommand`) inside `heavyStep("precheck")`, 30 s each within a 120 s total
(`runPreflight`). `runProbeMiss` classifies the output: rc 0, a timeout (124) or a test failure is `runs` (RED on base is
expected); conformance.mjs `missingTool` (missing command / Python module / Node package) or a missing path (bash exec
rc 127, python `can't open file`, pytest `file or directory not found`, node `Could not find`) is `unrunnable`. Names
the repo tracks or a deliverable's change names, and paths that are tracked, deliverables, the repro test or test-shaped
(`knownToContract`), are not misses. `git status --porcelain --untracked-files=all` before and after the runs: only
paths the runs newly created (`git clean`) or modified (`git checkout --`) are reverted, an anomaly records them; a path
dirty before is never touched. Commands the budget leaves are not run (anomaly), not misses. All misses share the one
`contractCorrectionPrompt` resume before the implement builder, are re-checked after it, and are logged on
`VALIDATE_PREFLIGHT` (`found`, `misses` with `source` probe|env|run); misses left stay advisory (the post-build #4323
rerun is still the gate). No hook, no run. Cost: 0 LLM calls, at most 120 s at freeze; one correction resume only when a
command cannot run, instead of an implement attempt plus a recovery lane.

## Entry 2026-10-20 — The repro harness links workspace deps on base; an unrunnable head is an environment error (#4334)

`io.redGreen` gets the lane env through `laneEnv()` (#4325), so a pinned `pnpm vitest …` runs on head.
`scripts/acceptance-red-green.sh` links every head `node_modules` next to a tracked `package.json` (workspace packages
too) and a root `.venv` into the base worktree when the base has none, so a workspace test resolves its deps on base.
`conformance.mjs` `reproFailures` maps `HEAD=UNRUNNABLE`, or no harness result, to `env.repro_unrunnable` (kind
`repro_env`, recoverable in `RECOVERABLE_CODES`, with a `RECOVER_HOW` prompt). `gate()` routes it with `env.tool_missing`
to the environment state: no builder resume, no reviewer. Other non-proofs stay `conformance.unimplemented`. A
`BASE=SKIPPED` detail now says the base was not run because head did not pass; head's new test files were already
overlaid (#3630). Cost: 0 LLM calls; saves the wasted resume.

## Entry 2026-10-21 — Builder self-review against the shared reviewer rubric (#4374)

One rubric constant (`prompts.mjs` `REVIEW_RUBRIC`) is shared verbatim by `reviewerPrompt` and the implement prompt,
so they cannot drift. The builder self-reviews its diff against it inside the build session and records
`result.json` `self_review`; the engine logs `SELF_REVIEW_MISSING` for a fixed result without it and
`SELF_REVIEW_AGREED`/`SELF_REVIEW_DISAGREED` against the first reviewer judgement, so first-pass self-checks can be
compared with the reviewer. Cost: 0 extra LLM calls (~230 prompt tokens on the implement prompt, ~120 on the reviewer).


## Entry 2026-10-21 — Learned per-repo pitfalls in the context pack (#4375)

`pitfalls.mjs` keeps an append-only JSONL per repo at `~/.forge/pitfalls/<owner>__<repo>.jsonl` (`FORGE_PITFALLS_DIR`),
real I/O through `io.pitfalls` {read, append} (`effects.mjs`). Rows: `{t:"lane", run}`, appended once per lane by
`contextPackStep` even when the pack is off (the aging clock), and `{t:"pitfall", run, sig, trigger, globs, lesson}`.
`fixRound` takes the gate's failure text. For a `REWORK_TRIGGERS` round it keeps a pending pitfall: `sig` = trigger + a
sha256/12 of the first error-like line with paths, quoted literals, hex and numbers normalised (rule codes kept), and
`lesson` = that line (≤160 chars). It's recorded only when the same gate passes again (`gatePassed`: precheck, structure,
docs, enumerating, sequence, CI pass or a merge for `ci_red`/`merge_ci`, conformance, base-sync re-review), with
`dir/*.ext` globs of `git diff --name-only <before>..HEAD`. The run log gets `PITFALL_RECORDED` {trigger, sig}.
`foldPitfalls` dedups by signature (count = lanes it recurred in), and an entry not seen in the last
`engine.context_pack_pitfall_lanes` lanes (default 50) ages out. `selectPitfalls` keeps up to 5: glob matches on the issue's
`namedPaths` first (`match: files`), then repo-wide (`match: repo`), each by count, then recency. `context.mjs` source
`pitfalls` (after `attempts`) compiles them inside the byte budget. Their signatures join the cache stamp. The pack result's
`pitfalls` [{sig, match}] goes on `CONTEXT_PACK` (run log only, not the telemetry emit), and `RUN_TERMINAL` carries
`pitfalls_matched`. `renderContextRecord` drops the pitfalls section (`publicPackText`) and shows only the count, so no
pitfall text is posted. `forgedock stats` (local logs) prints the first-pass rate with and without matching pitfalls.
Cost: 0 LLM calls; one local read and up to a few appends per lane; ≤ ~1 KB of pack bytes when mode is `on`.

## Entry 2026-10-23 — Risk-path enforce, partial investigation close, per-batch shadow line (#4398)

`gate()` (`lean.mjs`) checks the changed files against forge.yaml `review.risk_paths` globs (`review-trigger.mjs` `riskPathHits`;
declared globs only, never the built-in risk words). A hit makes a shadow lane enforce for the rest of the run (sticky:
precheck, review, resume, base-sync re-review, no degraded merge), logs `CONFORMANCE_RISK_ENFORCED {paths}` once plus a
decision line, and `RUN_TERMINAL.conformance_mode` reports `enforce`. `closePlan(contract, {title, review})`: an
`investigate(`/`investigate:` issue (`isInvestigation`) with a defer/post-deploy requirement, or a deliver requirement
whose review row is not `implemented`, is `partial`. The untracked ones are filed with `track()` before the PR, the issue
closes `not planned` with a FORGE:TRACKED "Closed as partial" note, and the Close row and lane result say partial.
The lane result carries `conformance {mode, would, risk}`. Orchestrate's row copies it, and the batch report prints
`formatShadowSummary`: shadow lanes, would-block share, false-block share (a would-block on an incomplete, inconsistent
or unparseable review) and risk-enforced lanes. Rationale: `devdocs/decisions/4398-risk-path-enforce.md`. Cost: 0 LLM
calls; a risk-enforced lane may spend the one builder resume that shadow would have skipped.

## Entry 2026-10-23 — Independent adversarial verifier (#4397)

The conformance reviewer reads `<builder_result>` and shares `REVIEW_RUBRIC` with the builder's self-review (#4374), so it is a
self-audit. `verifier.mjs` adds one independent call. `gate()` runs `runVerifier()` only when the precheck and `reviewOnce`
conform (not on a `review.trigger` skip) and at most once per head SHA (`verifiedHeads`; a fix round that made no commit
reuses the verdict). Inputs (`verifierPrompt`): issue, trusted comments, effective contract, changed files, `boundDiff` diff and
`callersOf` (the repo's `git grep -n -w -I -F` over `changedSymbols(diff)`: names from hunk headers and +/- definition lines,
JS/TS/Python/Ruby/Go/Rust/Java-style; ≤12 symbols, ≤8 hits each, ≤40 lines, definitions and `.forge-lean/` excluded). Never
the builder's result, notes or session (`resume: null`, `readOnly`). `VERIFIER_SYSTEM` is adversarial: boundary inputs, the
issue's non-regression baselines, the listed callers, a repro test that cannot fail; JSON `findings[{file,line,input,expected,
actual,why}]`. `parseVerifierFindings` keeps ≤10 findings at a tracked file and positive line; anything else is dropped.
Model: `review.verifier_model` (else `engine.lean_verifier_model`, `engine-cli.mjs` `readVerifier`), default
`claude-sonnet-5-5`; `pickVerifierModel` swaps to the first of opus/sonnet/haiku that is not the builder's configured or
reported model (`sameModel`: ids, `[1m]` suffix, bare aliases). Size bound (`verifierBudget`): `maxMs` 3–15 min and
`maxTurns` 10–40 by diff KB (the lean runner now forwards `maxTurns` when the CLI supports it); empty diff → no call; no
repair re-ask. Modes: `off` (no call, no event), `shadow` (FORGE:REVIEW gets an advisory "Independent verifier" section, never
blocks), `enforce` (`findingsToFailures` → `conformance.regression`, kind `verifier`, detail `path:line …`, so `fixRound`
runs a fresh session; the one-resume budget is unchanged). A verifier error is an anomaly, never a failure (a session-limit
defer still propagates). Run log: `PHASE_ATTEMPT_USAGE` phase `verify` trigger `verifier`; `VERIFIER {mode, head, model,
swapped, findings, cost_usd, implement_cost_usd, ratio, skipped?, error?}`. `node bin/lean/verifier.mjs [--json] [--dir]`
reports per repo runs, findings, errors and the verifier/implement cost ratio (median, max, runs over 0.10). Exit criterion
for enforce: a seeded-defect replay in shadow where it catches what the reviewer misses, plus ≥30 shadow runs with ratio ≤
0.10. Cost: 0 LLM calls when off (default); one read-only call per reviewed head when on. ADR
`decisions/4397-independent-verifier.md`.

## Entry 2026-10-23 — Post-deploy precondition gate in the pre-filter (#4389)

`prefilter.mjs` `postDeployGate`: an open issue whose body carries `<!-- FORGE:DEFERRED_FROM: #P -->` and whose checklist
items are all `` `R#: …` — post-deploy: `` lines (`postDeployOnly`; the format of `file-deferred-followups.sh` /
`followupItems`) is checked before any lane. The parent's merge SHAs come from `gh pr list --state merged --search "#P"`
(`mergeCommit`, PRs that `claimsFix` #P), else the `merged at <sha>` of a trusted `FORGE:TRAJECTORY` on #P. Each is tested
with `git merge-base --is-ancestor <sha> origin/<default>` (exit 1 = not there). Any SHA not on the default branch parks the
issue: `{parked: true, kind: "awaiting-promotion"}`, label `awaiting-promotion` (created on demand), one
`FORGE:PRECONDITION` comment when the label was new, no lane. With every SHA on default, forge.yaml
`post_deploy.precondition_cmd` (`sh -c <cmd> precondition <issue>`, `FORGE_ISSUE`, 60 s) exit 1 parks
`awaiting-precondition`. Everything unresolvable (no SHA, git exit ≠ 0/1, unknown default branch, hook exit ≠ 0/1)
fails open to today's path. The gate runs before the `needs-human` early return, so escalated promotion follow-ups are
parked too (the label stays). A `ready` issue loses `awaiting-promotion`. The default branch (`branches.default`, else
GitHub's) is resolved and fetched once, lazily, by `lazyDefaultBranch` (orchestrate and triage). `orchestrate.mjs` settles
a parked result as outcome `awaiting-promotion|awaiting-precondition` with $0 and no `runOne` (not SATISFIED: dependents
skip). `formatOutcomeLists` prints one `awaiting promotion: #A #B (fixes on <lane>, not on <default>)` line instead of
escalations. Re-evaluation is the next batch or triage run. Cost: 0 LLM calls; per gated issue 1-2 gh reads and one git call.
