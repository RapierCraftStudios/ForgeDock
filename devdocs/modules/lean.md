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
   #5421: free disk is the third GC trigger. `diskLow` (`admission.mjs`) compares `host.freeMb` of the worktree root and `~/.forge`
   (`host.hygienePaths`) with forge.yaml `hygiene.min_free_gb` (default 5, 0 = off); `nearCeiling({minFreeGb})` counts it, so the
   orchestrate `beforeAdmit` runs owned GC. `guardHeavyDisk` (`effects.mjs`) wraps `io.heavy`: below the threshold it runs GC once and,
   if still low, refuses the heavy step with `DISK_LOW` (`heavyAcquire` rethrows only that code). `hygiene.schedule` installs a
   systemd user timer or cron entry (`gc-schedule.mjs`, by `doctor --fix` / `init`) running `gc --apply`. Lanes get
   `COMPOSE_PROJECT_NAME=forgedock-lane-<issue>`; gc owns compose volumes/containers of that project.
   Heavy steps are gated separately by the host heavy-step semaphore (`heavy.mjs`); #4777: that covers pytest,
   promtool check/test, `poetry|uv|pipenv|pdm|hatch run <heavy>` / install / sync / build, pip install, ruff/black/
   flake8/pylint, make/cmake/ninja and `python -m pytest|mypy|tox|unittest` (python shim).
   #5148: `isPassThroughWrapper` also detects a wrapper that looks up a `$0`-derived name (`${0##*/}`, `basename "$0"`), so
   `writeHeavyShims` bakes the real binary past it and the preflight flags it; `guardChain` counts `FORGE_HEAVY_DEPTH` and
   stops at `SHIM_DEPTH_MAX` (32) with `env.shim_loop` (exit 126), whatever the wrapper shape.
   Local lane cap (#4777): `admission.mjs` `localLaneCap` = max(1, min(floor(cores / `lane_cpu_reservation`, default 1),
   floor((MemAvailable − `min_free_mem_mb`) / `lane_mem_mb`, default 2048))), forge.yaml `engine.lane_cpu_reservation|
   lane_mem_mb`. `engine-cli.mjs` `liveLaneCap` passes it (min `global_parallel`) as `sched.cap` function, which
   `orchestrate.mjs` evaluates at every registry admission: over-cap lanes queue, running lanes are never revoked.
2. **Lane** — `lane.mjs` `resolveLane`: milestone → `branches.feature_pattern`
   (`milestone/{slug}`), else `branches.staging`; never the default branch;
   fail closed with `lane.*` codes → `lane-refused`.
   An open PR on another non-default base is `needs-human`, except when the resolved lane
   is shipped (merged into staging by a merge commit, `isShippedLane`; an unused lane at the staging tip is not) and the PR base is live: the run follows it (#4593).
3. **Dependencies, then lease** — open `Depends-on` → `dependency-open`
   (orchestrate requeues behind it); then the FORGE:STATE lease. An open dependency
   whose PR (closing or referencing it) is merged into this lane, by merge-commit
   ancestry on `origin/<lane>`, is satisfied (a stale `needs-human` on it does not
   block either); the FORGE:DEPENDENCY comment names the PR and merge commit (#4686).
   A merge only to another lane still blocks. A merged lane run also records
   `mergedTo: {lane, pr, sha}` on its terminal FORGE:STATE (#4711); a dependency whose
   trusted body carries it for this lane is satisfied when that PR reads MERGED with
   that merge commit and the commit is an ancestor of `origin/<lane>` (`phases.mjs`
   `mergedToByState`), checked before the PR-list search.
4. **Claim + worktree** — `workflow:investigating`, `FORGE:STARTED` comment;
   resumes an open PR / remote branch. Before an existing `lean-<N>` worktree is
   removed (#4162): processes whose cwd is inside it (an orphaned runner from a
   dead run, found via `/proc`) get SIGTERM, then SIGKILL after 5 s
   (`WORKTREE_PROCS_STOPPED`); uncommitted work (tracked, untracked, `.forge-lean/`)
   is saved to `refs/forge/salvage/<N>/<ms>` (`WORKTREE_SALVAGED`) and the
   implement prompt names the ref. This covers runs that died hard (no
   teardown); a run that exits normally checkpoints its work in teardown (#4179).
   #4786: a PR-less remote/local lane branch whose diff vs the base is only tool state (`.forge-lean/`, `isToolState`)
   holds no work: it is not resumed (no stale contract). The worktree is still built from the branch (pushes stay
   fast-forward), the scratch is removed in a normal commit, and `SCRATCH_BRANCH_DROPPED` is emitted. Any real change
   or an open PR resumes as before; `changedFiles()` ignores tool-state paths.
   #4880: `.forge-lean/` is untracked and in `.gitignore`; after `worktree add` a lane that is not resuming real work
   clears it (`clearLaneScratch`, `LANE_SCRATCH_CLEARED`), so it never reads or posts another lane's scratch.
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
   Dependency prep (`depcache.mjs`) also installs JS lockfiles one level down
   (`web/`, `frontend/`, `client/`, `ui/`, `services|packages|apps/<n>/`) in their own dir (#5423). A remote lane
   whose preflight finds a missing tool provisions once (prepare + `pip install pytest`) and re-probes before
   ending `env.tool_missing`; a first lane ending an engine-owned env code (`ENV_ENGINE_OWNED_CODES`) posts its
   comment but does not label `needs-human`, and the first `env.tool_missing` recovery of a remote run retries
   remotely (a repeat goes to the host).
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
   checks quotes against the issue and trusted comments (markdown, `...` elision and
   punctuation-only differences are tolerated; a quote still missing snaps to the one
   issue line or sentence holding at least 90% of its tokens, `snapQuotes`, original kept
   as `requoted`, #5244); the engine freezes it
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
   `dependency` | `split` (≤ `MAX_SUBISSUES` sub-issues → `decomposed`) | `human` | `design-invalidated` (#5342: `replan.mjs` `fileAmendment` files or joins one spike-amendment issue per epic, adds a `**Depends on**` edge to each affected open sibling and the lane, posts `FORGE:REPLAN`, finishes `dependency-open`; `forgedock replan apply --amendment N --repo o/r` then applies the per-child `forge-replan-dispositions` block (unchanged / re-scoped / dropped), releases the hold and rewrites the epic checklist, failing closed on a missing disposition).
   A `split` is admitted only by `decompose.mjs` `splitGate` (#4396): every
   sub-issue's `paths`/`files` disjoint from the others', or the block's `size` over
   `SPLIT_MIN_FILES` (25) / `SPLIT_MIN_LINES` (1500); otherwise it is `untyped`
   and the one corrective resume asks for one lane with an ordered checklist.
   The rationale goes on `FORGE:DECOMPOSED`, the decision line and the result's
   `decomposition`.
   A split sub-issue may declare `files` (the paths it will edit); `serializeShared`
   adds a `Depends on` edge from each later sub-issue to the nearest earlier one it
   shares a file with and does not already reach, so siblings editing the same hub
   (barrel, union type, shared fixture, index doc) merge one after another instead
   of conflicting; each added edge is a decision. No `files`: unchanged (#4385).
   The gate runs first; `serializeShared` orders only an admitted split.
   A `split` closes the parent `completed` (#5152: scope moved, not dropped) once its `FORGE:DECOMPOSED` trail
   and `workflow:decomposed` label are written (label kept; the closing comment
   lists the sub-issues; either write failing leaves it open) (#4337). A
   decomposed dependency, open or closed, gates through its sub-issues in
   `openDependency` and `resolveBlock`; no usable trail keeps the parent as the
   dependency. A run on a closed decomposed tracker ends `decomposed` with its
   `subissues` (the batch re-points dependents; none listed skips them), and a
   trusted `FORGE:DECOMPOSED:REVOKED` reopens it (`reopenRevokedDecomposition`,
   also used by the engine's `--retry`).
6. **Implement** — same session; `result.json` with typed amendments
   (`applyAmendments` → `FORGE:AMENDMENT`; #4574: `type`→`kind`, `amend-requirement`/`limitation`→`defer`, an `R#` `id`→`requirement`; a rejected amendment's problem names the valid kinds or missing field and keeps 400 chars, and the one correction round shows 900). An `add-deliverable` on a path the
   #5036: `applyAmendments` also normalises builder slips: `scope-narrowing`/`scope-reduction`/`defer-*`/`deferred-*` naming a requirement → `defer`; `verification-substitution` → `substitute-validate` (same checks); `out-of-band-verification` → `out-of-band` (sets `verify: out_of_band` and `evidence` on a deliver requirement); `scope-note`, `scope`, `scope-clarification`, `interpretation`, `environment`, `validation-unavailable` are informational (listed in `applied`, never a problem). A `decision` anchor may match any lane-added file (`addedPaths`); an unlisted one becomes an amended deliverable. Other unknown kinds are still rejected naming the valid kinds.
   #5020: environment defects of frozen commands are recoverable. forge.yaml `validate.recipes` (block map `{regex: replacement}`) rewrite validate and `repro_test` commands at freeze (`applyValidateRecipes`, wired by `readEnvConfig` → `validateRecipes`; the rewrite is recorded as a decision). Freeze preflight probes/runs `repro_test.command` too (`contractCommands`); Poetry's `Command not found: X` (an uninstalled env) is `env.tool_missing` via `missingTool`, and a repro head that fails on a missing tool is `env.repro_unrunnable` (`reproEnvMiss`), not `repro_red_green`. A post-deploy requirement (or amendment) with no check id becomes `defer` with bucket `owner:orchestrator` (`deferChecklessPostDeploy`); a named but unregistered check still fails `check_unknown`. A substitute-validate is re-checked with `substituteShellProblem` (fails closed when `bash -n` cannot run) when applied and in `precheck`; the `FORGE:AMENDMENT` post is retried by `ghw` and a still-failing post is an anomaly, never an engine-error.
   #4987: an `unrelated-ci-failure` amendment (builder note that a red check is outside the diff) is an informational no-op in `applyAmendments` (no problem, no contract change, listed in `applied`); it is not a valid kind, and `ciFailurePrompt` tells the builder to put such a check in `implementation.md` instead.
   #4594: `amend-requirement` with `text` + `why` keeps the requirement `deliver` and sets `amendment`; the reviewer judges it against that text, and a failing row reads `amendment not accepted` so the one builder resume is the correction turn (without `text` it is still the `defer` slip).
   #5365: `applyAmendments` renumbers an `add-requirement` whose id is already taken to the next free `R<n>` (recorded in `applied` as `R2 -> R5`, never a problem). `authorizationOf` returns `coupled` for a file in the `COUPLED_PATHS` map (`docs/OUTCOME-CODES.md` when `bin/engine/outcome-codes.mjs` is a deliverable; a parity test reads both), so it is not `scope_creep` in `precheck` or `decide`. `decide` turns a `defer`/`post-deploy` row the review marks `implemented` into `converted[]` instead of `unjustified_deferral`; `lean.mjs` applies `convertDelivered` so the requirement is judged as `deliver` (original kept in `amended_from`). A deferral the reviewer does not find implemented still fails (#5207).
   SEC-31/SPEC-33 (#4996): an `amend-requirement` that flips a `defer`/`post-deploy` requirement to `deliver` records the original quote, disposition, why, bucket, check and tracked in `amended_from` (the reviewer prompt compares it with `amendment.text`); when the original has a check id or a filed tracking issue the amendment is rejected unless its why or text names that check or issue.
   contract already lists appends its why to that deliverable's `change`, so it
   can declare a package edge on an already-listed package.json (#4159).
   #4899: the `FORGE:AMENDMENT` comment also carries a hidden `FORGE:AMENDMENT-STATE` JSON block (raw amendments bound to the frozen contract hash); a recovery or resume lane on the same frozen contract reads it back (`readFrozenContract`) and re-applies it, so an accepted `supersedes` (or any other amendment) survives a `ci.red` recovery.
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
   #5079: `verify.precheck_block: true` makes that exhausted / no-commit case `needsHuman` `ci.red` (recoverable) instead. forge.yaml `verification.coupled_files` (`readEnvConfig` → `coupledFiles`; `coupled.mjs`) is a block map `{when glob: required glob[, glob]}` (`added:` prefix = newly added files only); a miss is a `coupled_file_missing` `conformance.unimplemented` failure passed to `precheck()` as `coupledFailures`. Path-scoped suites are `.forge/test-map.json` entries.
   Timeout (rc 124, #4589/#4620): retried once longer if the round budget has room; a spent budget defers the
   command to CI. #5332: a command still at rc 124 after that is host load, never a failing check
   (`precheck.mjs` `splitPrecheckResults`/`timedOutDetail`): no builder resume, never `ci.red`, `PRECHECK_COMMANDS`
   `self_check` is `timed_out` (not green). Without `verify.precheck_block` it is a `deferred-to-ci` anomaly naming
   command and limit; with it (or a failing guard) the lane ends `env.validate_timeout` (recoverable) with that detail.
   A validate rerun that still times out (#4906) is infrastructure: `precheck()` counts it covered when CI verified the
   head, else `env.validate_timeout` (environment state, recoverable, no builder resume; teardown pushes the commits),
   never `conformance.unimplemented`.
   Environment failures (#5371): `missingTool` also recognises exit-1 signatures of the executor (Docker daemon/socket, a
   bind-mount source absent, Playwright browser missing, npm `ENOTFOUND`/`EAI_AGAIN`), so `substituteVerdict` is not `runs`
   and the failure is `env.tool_missing`. Validate/repro failure details carry `outputTail()` (last 40 lines, secret-looking
   values redacted). A remote-placed lane whose only failure is `validate_failed` ends `env.validate_placement`
   (recoverable, mechanical); `orchestrate.mjs` `placeOf` recovers it, and any mechanical code whose failed run was remote,
   locally. The local lane reruns the frozen command: a pass merges, a fail stays `conformance.unimplemented`.
   Lane head report (#4958): the exit checkpoint (`checkpoint`/`rescuePush`/`reportLaneHead` in `lean.mjs`) records
   `{branch, sha, pushedTo}` whenever the lane has commits ahead of base. When the normal push fails before git push
   (sign-off rewrite) or the push is rejected or exhausted, HEAD is pushed as is to the lane branch (not after a rejection), else to `forge-salvage/<issue>-<sha>`. The line goes into the terminal trajectory (or a `FORGE:LANE_BRANCH`
   comment for deferred/engine-error), `RUN_TERMINAL` (`lane_branch`, `lane_sha`) and the returned result (`laneHead`);
   an unpushed head is stated as lost-on-teardown. A rerun or `--requeue` resumes from the pushed branch (existing `ls-remote` resume) or from `forge-salvage/<issue>-*` (`RESUME_FROM_SALVAGE`). `pickSalvage` (`salvage-resume.mjs`, #5063) picks the newest salvage ref by commit time (the sha suffix is not chronological); when the lane branch exists on origin or a PR is open, only a ref strictly ahead of `origin/<branch>` (descending from it) is resumed, behind or diverged refs are ignored.
   Checkpoint reconcile (#5202, `checkpoint-reconcile.mjs` `reconcileCheckpoints`): `gitPush` (non-`--delete`, after the tool-state untrack, before the sign-off) and `ciVerify` (before it reads the head) fetch `origin/<branch>`; when it is not an ancestor of HEAD and every remote-only commit is a `wip(forge): checkpoint` whose sha is in this worktree's reflog (`refs/heads/<branch>` or `HEAD`), it is merged in with `merge -s ours` (`CHECKPOINT_RECONCILED`): the lane's tree wins, the checkpoint stays in history, the push stays a plain fast-forward (never force). Other remote-only commits are left alone (`CHECKPOINT_RECONCILE_SKIPPED`). A non-ff rejection no other lane owns (#4920 `otherLaneOwner`) ends `engine-error` `engine.push_diverged` (recoverable), never `needs-human`; permission/protected-branch rejections stay `needs-human`. Observed cause: a context-restart session amended the pushed checkpoint (AlterLab #39689), so `contextRestartPrompt` and `CONTINUE_NOTE` tell the builder the checkpoint is pushed and existing commits are not to be amended, squashed, reset or rebased.
   #4363 fresh fix sessions (`fixround.mjs` + `lean.mjs` `fixRound`): precheck, CI (verify and merge), docs,
   structure, enumerating and sequence rounds, and conformance/review FAILs whose failures all cite a `file:line`
   (`freshFix`/`citesFileLine`), run with `resume: null` on `fixModel` (forge.yaml `lean.fix_model`,
   `engine-cli.mjs` `readFixModel`; default the reviewer model) and `prompts.mjs` `fixSessionPrompt` (host rules,
   the site's task prompt, `git diff <base>...HEAD` via `boundDiff`, frozen contract, issue title + `issueSummary`;
   < 60K chars). The fresh session never adopts its session id; when it makes no commit, one resume of the build
   session follows in the same round. `PHASE_ATTEMPT_USAGE` gains `mode: fresh|resume` on fix rounds (run log only).
   Block/contract corrections, CI-unavailable and base-sync conflict resolution still resume; round gates unchanged.
   #5348 narrow fixes: the enumerating and duplicate-export gates first apply the change the detector names with no model
   (`mechfix.mjs` `applyEnumerating` writes the missing entry into the test's string list, `renameDuplicates` renames an
   export only its declaring file mentions to `<App><Name>`; the detector's `others`, which declare the name themselves, do not
   block the rename and are left untouched, any other mentioning file does), commit it (`MECHANICAL_FIX` event) and re-run the detector.
   #5405: `applyEnumerating` collects each test's applied rows per test and adds them to `applied` only after that test's write
   succeeds; a failed write moves only that test's rows to `remaining`, so earlier tests' written fixes stay applied and committed.
   What is left goes to one narrow session per stage: the enumerating round also carries the pending duplicate-export and
   English-copy findings (`mergeNarrowTasks`; their gates re-check). The session runs profile `narrow` (no lane text,
   CLAUDE.md off, `prompts.mjs` `narrowFixPrompt`: contract excerpt, failure output and named files, `NARROW_PROMPT_MAX`
   chars, under `NARROW_BASELINE_TOKENS`); `PHASE_ATTEMPT_USAGE.lane_profile` is `narrow` and `stats --efficiency`
   prints baseline tokens per profile.
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
   #5346 (`ceiling.mjs`, pure): `engine.context_ceiling_by_size` ("S=..,M=..,L=..", `readCoreLimits` → `contextCeilingBySize`) sets
   the ceiling per lane size at contract freeze (no entry: the global one; defaults unchanged until an A/B sets them). Before
   the build, `predictRestart` estimates the start (prompt bytes + the contract's existing deliverable files, 4 bytes/token):
   at ≥60% of the ceiling the build prompt drops the explore rule and gets `NARROW_NOTE` (`CONTEXT_PREDICT` event); named
   files alone over the ceiling make a restart certain, so that build runs without the ceiling. The runner never stops
   mid-edit: a crossing with an Edit/Write/MultiEdit/NotebookEdit `tool_use` unanswered waits for its `tool_result` (hard stop
   at 1.25x). The restart prompt adds `<established>` (files read, files edited, last tool, from `handoffFacts`), and
   `toolStats` carries `first_edit_turn` so `context_restart` attempts show turns-to-first-edit.
   **Turn budget** (#4392, `budget.mjs`, forge.yaml `engine.turn_budget_s|m|l`, defaults 25/60/100, 0 = off;
   `readCoreLimits` → runCore `turnBudgets`): at contract freeze (or a resumed frozen contract) `laneSize` sizes the lane
   from a `size:S|M|L` label, else the contract's distinct deliverable paths (S ≤ 2, M ≤ 5, else L); an L lane gets +10 turns per distinct deliverable path above 5 (cap +2x the L base) and a `budget.exceeded` recovery of L another +ceil(base/2) (`scaledExtra`, #4587). While `stage ===
   "implement"` every builder call (build plus its context/timeout restarts) passes `turnMax` = budget left;
   `runCliBackendAsync` kills the stream session at that many deduped assistant turns with `CLI_TURNS`. `builder()`
   records the attempt, logs `TURN_BUDGET_EXCEEDED`, checkpoints and runs `budgetWrapup`: one fresh session (trigger
   `budget_wrapup`, `restart_of` the stopped trigger, `wrapupGrant` = max(5, ceil(budget/5)) turns, prompt
   `turnBudgetWrapupPrompt` with diff and last self-check) that either finishes (the result flows on) or writes
   `status: budget-exceeded` + `digest`. A stop or overrun (`TURN_BUDGET_STOP`) ends the non-human reason
   `budget-exceeded` (code `budget.exceeded`, #4505: no `needs-human` label, no FORGE:NEEDS_HUMAN comment; the result
   carries `branch` and `budgetDigest`, builder digest else diff stat). `classifyNeedsHuman` calls it recoverable, so the
   batch reruns it once from the checkpoint branch with `RECOVER_HOW` (continue, or a typed split-required block: the
   decompose path) at `recoverySize` = `nextSize` (S→M→L, L stays L); dependents stay queued. needs-human only when that
   final `budget.exceeded` recovery overruns again (the lane labels it), or no recovery runs (orchestrate relabels once
   and parks dependents). Plan/corrections and fix rounds are not
   budgeted. The lane result and `RUN_TERMINAL` carry `turns: {size, budget, build, total, exceeded}`; orchestrate copies it
   to the row and the batch report adds `formatTurnSummary` (`turns by size: S n= p50 max/budget; … over budget: #N`).
   Owner step + remainder (#4730): a `human` block may carry `remainder:[{title,body}]`; `endBlocked` files each as its own
   issue (`Parent: #N`, marker `FORGE:REMAINDER of=#N key=<hash>` makes a rerun reuse it, no needs-human) and only the owner
   step keeps needs-human. An issue whose entire content equals an already-registered owner ask (strict normalized match,
   `onlyAsk`) is closed not-planned and linked to the existing ask; any extra content only links.
   **Lane profile** (#4395, `lean.mjs` section 2a + `callRunner`): every LLM session runs with
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (profile `memory-off`). With forge.yaml `engine.lane_instructions`
   (`engine-cli.mjs` `readLaneInstructions` → runCore `laneInstructions`) naming a repo-relative file in the lane
   worktree (no `..`, non-empty, ≤ `LANE_INSTRUCTIONS_MAX_BYTES` 16 KB), profile `lane` also sets
   `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and appends the file text to the system prompt of fresh tool-using sessions
   (builder, reviewer, verifier; not resumes, not the noTools grouper). A bad file is a trajectory anomaly and falls back
   to `memory-off`. `FORGEDOCK_FULL_SESSION=1` is profile `full`: nothing changes. No `--setting-sources`/`--bare`, so
   user-scope hooks keep running; `laneEnv()` (validate/precheck/setup commands) never gets the switches. Measurement:
   `runCliBackendAsync` returns `baselineTokens` (first stream assistant message's input + cache read + cache creation);
   `makeLeanRunner` keeps it for fresh sessions only, and `PHASE_ATTEMPT_USAGE` / telemetry `phase_attempt` carry
   `baseline_tokens` and `lane_profile`. Decision: `devdocs/decisions/4395-lane-profile.md`.
   Before/after (#4436): `forgedock stats --lane-profile` (`query.mjs` `laneProfileReport` / `renderLaneProfiles`) reads
   every RUN_START slice (`readLocalRuns(dir, {allSlices: true})`), groups finished runs by `lane_profile` with baseline
   sessions/median/mean per phase and the conformance rate per profile (the `--tiers` rule); `--issues` pins the issue set.
   **One turn, many calls** (#5347): #4410's clause was buried in the quiet-output paragraph and the p50 stayed ~1.03, so
   `HOST_RULES` now ends with its own `BATCH_RULE`; the plan prompt ends with a "Build reads:" list and the implement prompt
   gets `buildOpeningNote` (contract deliverable paths plus the base test map's commands for them) so the build opens with
   one batch. Plan/implement caps rose to 2150/1700 tokens.
   **Batched reads** (#4410): `HOST_RULES` also tells the builder to issue independent read-only calls (reads, greps,
   git log/blame, gh) in the same turn or one shell call, and to read each file's ranges once and keep notes. The
   wording replaced older text, so the plan/implement token caps are unchanged. Calls/turn p50 > 1.5 is no longer a
   target (#4580): p50 stayed 1.00, and whether calls are independent is a judgment no script can enforce; it stays an
   informational metric and success is judged on turns/merge and implement wall (`decisions/4580-reread-guard-and-batching-target.md`). Measurement: `runCliBackendAsync`'s stream
   parser returns `toolUses` ([{msg, name, path, cmd}], deduped by tool_use id, cap 5000; also on `CLI_TURNS` /
   `CLI_CONTEXT` errors). `bin/lean/toolstats.mjs` `toolStats` turns them into `{calls, turns, per_turn, rereads, top}`:
   a turn is an assistant message with a tool use, and a re-read path is one read 3 or more times by Read or by a Bash
   `cat` / `sed -n` / `head` / `tail` operand (grep is not counted). `makeLeanRunner` returns it as `tools`, and
   `PHASE_ATTEMPT_USAGE` carries `tools` when present. This is a local run-log field only: the telemetry seam does not
   map it.
   **Owned subagent model** (#4843, #4849): every lean session (builder, reviewer, verifier, grouper, prefilter) gets one
   `--settings` from `leanSettingsFlags`, passed in `extraArgs` so `FORGEDOCK_FULL_SESSION=1` keeps it. Its `env` sets
   `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=0`, so a ForgeDock-defined agent's own `model` (the Haiku explorer) beats an operator
   settings.json force. A child env var can't undo that, because settings env wins over it. `CLAUDE_CODE_SUBAGENT_MODEL` is
   set only from forge.yaml `agents.subagent_model` (`readSubagentModel`, the `makeLeanIo` default); unset leaves the
   operator's own default alone.
   **Attribution pin** (#5118): the same `--settings` always carries `includeCoAuthoredBy: false` and
   `attribution: {commit: "", pr: ""}`, so Claude Code's default `Co-Authored-By: Claude` trailer is off in every lane, even
   a remote sandbox whose config dir has no operator settings. When `makeLeanRunner` is `sandboxed` (default `IS_SANDBOX=1`
   or `CS_SANDBOX_ID`, see `inSandbox`) it also registers `bin/hooks/pre-tool-use.mjs` (`PRE_TOOL_USE_HOOK`) as a PreToolUse
   hook on `Bash`, so its attribution rule blocks a trailer commit; kept under `FORGEDOCK_FULL_SESSION=1` and for read-only
   and no-tool roles. Local lanes don't register it (operator user settings already carry it). Post-deploy check
   `remote-lane-no-claude-attribution` (`.forge/post-deploy-checks.json`) scans staging for the trailer.
   **Re-read nudge** (#4456): the builder session (`builderOnce`, full and light lane) runs with `rereadNudge: true`, and
   `makeLeanRunner` merges `rereadHooks()` into that same `--settings`, registering `bin/hooks/reread-nudge.mjs` as a PostToolUse
   hook on `Read|Bash` (reviewer, verifier and grouper sessions are unchanged). The hook counts reads per path with
   toolstats `readPaths` (resolved against the session cwd) in `<tmpdir>/forgedock-reread/<session_id>.json`, and on
   exactly the `REREAD_MIN` (3rd) read returns an `additionalContext` reminder to use notes or the excerpt already in
   context. Advisory and fail-open: always exit 0, no output on error. #4580: the same script is also a PreToolUse hook
   on `Read` (`guardFor`): a full-file Read (no offset/limit) of a path read twice already, with an unchanged mtime
   (`<session_id>.mtime.json`; a changed mtime resets the count), is denied with a reason pointing at notes or a line
   range. Ranged reads and Bash never deny. Its effect is read off `forgedock stats
   --efficiency` `rereads_per_merge`.
   **Quiet output** (#4390): `HOST_RULES` tells the builder to run tests quiet, read failures as `tail -40` + failing test
   ids, read files by range and send output that may pass 8 KB to a `$TMPDIR` file. `precheck.mjs` `quietFailure`
   (last 40 lines within the char share, failing-test-id lines by pytest/TAP/jest/vitest/go/cargo markers, `full log:`
   path) formats each failure in `forgedock check`'s table and in the precheck fix prompt; the full output goes to
   `.forge-lean/logs/` (`CHECK_LOG_DIR`: `check-<V#|cmdN>.log`, `precheck-<round>-<i>.log`). Pitfall learning still
   reads the capped tail. A source-scan test in `lean.test.mjs` fails on a call site without a known literal. The lane
   result carries `firstPass` (`firstPassOf`: no `REWORK_TRIGGERS` attempt after the build; omitted when the lane never
   reached it) → orchestrate row `first_pass` → batch-report line `first-pass: P% (k/n lanes that reached the build)`
   (`formatFirstPassSummary`, after the precheck line). `forgedock stats` reads the same fields (`docs/STATS.md`).
   #4407: the CLI's `total_cost_usd` is a running total over a resumed session, so `PHASE_ATTEMPT_USAGE` also carries
   `cost_usd_delta` (this attempt) and `cost_usd_session` (the session total; `cost_usd` stays the raw value), from
   `fixround.mjs` `sessionCostDelta` keyed on the call's `resume` id. The lane `cost_usd` (orchestrate rows, batch
   summary, trajectory `cost $`) and `forgedock stats` sum the deltas; old logs fall back to `cost_usd`.
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
   `verify.precheck_total_seconds`, default 600 s). #4585: `verify.invariants` (block list) are appended to every round unscoped (never dropped by the test map; `planPrecheck`), written to `check-plan.json`, and prompt-side `invariantsPlanNote`/`invariantsBuildRule` give the builder the registry checklist. Commands not started before the budget ends, or cut by it (rc 124
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
   docs-only (`skip_paths`) skips. A verified head satisfies validate ids left to CI;
   the trajectory decisions name them (`precheck` `ciCovered`, `VALIDATE_CI_VERIFIED`), and the
   base-sync re-review retry CI-verifies its fix round's head before reviewing (#4527).
   Push-check mode gates on `ciGate` (`verify.checks` > required checks under
   `merge_wait: required` > all) at the latest attempt per name (`latestPerName`, check-run
   id); the failed jobs are rerun once per head (`rerunFailedOnce`,
   `CI_FLAKE_RERUN`) BEFORE a fix round is counted, in `ciVerify` and at merge time
   (`mergeFixRound`); only a failure that repeats on the same head spends a round (#4387,
   #4586). `verify.flaky` ids (`splitFlaky`: exact job name only, never log text, #4614; string, flow or block list) are reported
   (`CI_FLAKY_REPORTED`), never block or reach the builder; a required check still blocks.
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
   structured review (`parseReview`), `decide` computes the verdict. `tmpdirInputs`
   (#4325) flags `$TMPDIR` reads a validate command never created; #5230: the dir
   argument of `uv venv`, `virtualenv`, `python[3] -m venv`, `git worktree add`
   (first) and `git clone` (last) counts as created. The
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
   Per-kind modes (`engine.conformance_kinds`, flat `"code=mode, ..."`,
   `readConformanceKinds`): `blockingFailures` splits failures into blocking and
   recorded-only; a listed code follows its own `enforce|shadow` in either lane
   mode, others follow the lane (shadow: the `SHADOW_BLOCKS` allowlist). A
   risk-path hit overrides them to enforce. `recording()` in `lean.mjs` keeps the
   shadow note and `CONFORMANCE_SHADOW` event for a lane with kinds set.
   `unverifiedRequirements` names deliver requirements without an executed
   passing evidence validate (report only). `scripts/conformance-calibrate.mjs`
   scores `docs/eval/conformance-labels-v1.json` (+ `--replay`) per kind; enforce a
   kind only at ~0 false blocks.
   Mutation check (#4913, `engine.conformance_mutation: report`, default off):
   `runMutationCheck` (`conformance.mjs`) reverts the diff's non-test files to the
   merge base (`git apply -R`), reruns each evidence validate command and restores
   from HEAD in a `finally` (commits are never touched). A green rerun is
   `conformance.mutation_survived`, shadow unless `conformance_kinds` enforces it;
   a dirty tree, failed revert, timeout or missing runner skips, never fails.
   `conformance-calibrate.mjs --events <run-log>` (#4929) reports the survived-mutation
   share (from `REQUIREMENT_MUTATION_SURVIVED` events) and the false-survived rate
   (labelled `conformance.mutation_survived` cases) for promotion.
   Host routing (#5186): a `[bucket:host]` item whose text is post-promotion (`POSTPROM_ERE`) and has no external need
   or `before|pre-promotion` guard goes to the `post-deploy` rollup (deduped on normalized text across parents), not
   `follow-up (host)` (`host_route` in `file-deferred-followups.sh`, routed through `hostRoute` in `conformance.mjs`, the single source, #5197).
   Bare `billing` is no longer an external need (reading billing rows is read-only; writes still match).
   Follow-up keys are cut to 240 chars and then trimmed, and `fileFollowups` maps
   the script's echoed (trimmed) keys back to the caller's keys via `followupMap`
   (#4388: a key ending on a space looped on `followup.unavailable`).
   `followupMap` applies every identity rule of the script to both sides: trim,
   strip backticks, and collapse repeated leading `R<n>: R<m>:` prefixes to the
   first (#5141: a quote starting with its own id, `R6: R6: …`, looped on
   `followup.unavailable`). An item that still has no match takes the one echoed row
   whose identity starts with `<id>:`, and never an ambiguous one. `track()` retries
   the whole file-and-verify step in-lane up to 3 times, waiting 5 s and then 15 s
   (`io.sleep`; the script is idempotent), and logs each retry in the decisions.
   A requirement verified open in an earlier attempt keeps its `tracked` issue and
   is neither re-verified nor counted again in `followupsFiled`.
   A malformed TSV (`DEFERRED_TSV=INVALID`) is not retried and still defers with
   `followup.unavailable`. When the 3 attempts fail for any other reason, the run
   does not defer: it keeps the merge-capable work and goes on to review, PR and
   merge. The unfiled requirements (id, quote, why, `FORGE:DEFERRED_FROM: #<n>`)
   go into `pendingFollowups`, which is kept in FORGE:STATE and the lane result.
   The close step files them again after the merge (the marker keeps this
   idempotent). Anything still unfiled is posted as `FORGE:FOLLOWUP_PENDING` on
   the issue, and the issue is left open, not closed (#5156). Nothing re-files
   a pending item automatically, so the open issue is the durable record.
   While it stays open, FORGE:TRACKED says "Left open: follow-up pending"
   (never "Closed as …"), and the trajectory Close row says
   `left open (follow-up pending)` (#5159).
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
   Verified out of band (#4404): a deliver requirement may carry
   `verify: "in_lane"|"out_of_band"` (`VERIFY_MODES`); out_of_band needs
   `evidence` = the job or workflow that measures it (`validateContract`). At
   freeze, right after `dropScopeValidates`, `tagOutOfBand` tags every deliver
   requirement without a `verify` whose quote names Lighthouse, web vitals,
   field perf/profile, a throttled profile, a nightly or report-only suite, or
   LCP/INP/TTI/FCP/TTFB (event `CONTRACT_OUT_OF_BAND_TAGGED`, decision line); an
   explicit `verify` (in_lane opts out) is kept, and an `add-requirement`
   amendment is tagged the same way. Such a requirement is judged by its
   instrumentation (budget test or bench committed, job configured), not its
   measured result: the skeleton row carries `verify`, `job` and
   `instrumented: null`; completeness needs a boolean `instrumented` (true needs
   path:line evidence); `decide` passes it on `instrumented: true` whatever the
   status and fails `conformance.unimplemented` otherwise; `precheck` accepts
   the builder's `instrumented: true` or `implemented`. `computeTrigger` adds a
   `gate.ambiguous` reason so the reviewer always runs, and `renderPrBody` lists
   them under "Verified out of band" with the job name. Not a disposition: no
   follow-up issue is filed.
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
   Generated files (forge#4519): `hotspots.sh` marks a row `generated` (and
   so `excluded`) for `linguist-generated`, a `maintenance.generated_paths`
   glob or an `@generated` / `DO NOT EDIT` header in the first 5 lines, and
   `hotspotGrowth` never counts it. `generated_paths` (bot-owned) is also in
   the output head, so `amend()` passes it to `applyAmendments`, which refuses
   an add-deliverable on a matching path; `hotspotPlanNote`/`hotspotBuildRule`
   then name those globs in the prompts.
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
   **DCO sign-off** (#4651, `signoff.mjs`): `gitPush` (and `ciVerify` before it reads the head)
   first runs `ensureSignedOff`: commits reachable from HEAD but not from `origin/<branch>` nor
   `origin/<lane>` that are authored/committed `*@localhost` or lack a `Signed-off-by` naming their
   author are rewritten (`git filter-branch` over that range only) with the lane identity
   (`GIT_AUTHOR_*`, else `git config`) and a sign-off; pushed commits are never in the range. No usable
   identity ends `ci.dco`. A failed rewrite (#4997) ends `engine-error` `engine.dco_rewrite` (recoverable): tracked/staged changes are parked first with `git stash create` pinned on `refs/forgedock/dco-stash` (never the shared stash stack), `reset --hard`, then re-applied after `filter-branch`; if the apply conflicts the ref stays and the error names the sha. Before `gh pr merge`, a failed check named DCO on the The parked paths are reported as `dirty` on the `DCO_SIGNOFF_REWRITE` event and in a failed-rewrite error (#4905). A failed rewrite (not `noIdentity`) makes `gitPush` rescue-push HEAD as-is to `forge-salvage/<issue>-<sha10>` (never the lane branch, #5047: the sign-off range excludes `origin/<branch>`, so unsigned commits published there could never be rewritten) before reporting (`DCO_RESCUE_PUSH` / `DCO_RESCUE_PUSH_FAILED` events); the exit rescue skips the lane branch for `engine.dco_rewrite`. A recovery lane resumed from that salvage branch drops its `refs/remotes/origin/<branch>` tracking ref after the worktree is built (`dropSalvageTracking`), so the commits are rewritten; real pushed history keeps its exclusion. A failed needs-human comment or label call in `needsHuman` is recorded as a `NEEDS_HUMAN_LABEL_FAILED` event and a trajectory anomaly instead of being swallowed (#4905). Before `gh pr merge`, a failed check named DCO on the
   current head (read from `checkStates`, required or not, any `merge_wait`) ends needs-human `ci.dco`
   (not recoverable: a new commit cannot fix history). `DCO_SIGNOFF_REWRITE` event.
   **e2e merge gate** (#4403, `e2e.mjs`, forge.yaml `verify.e2e*`): before `gh pr merge`,
   once per reviewed head, a lane whose diff touches `e2e_paths` or whose contract
   quotes `[type:e2e]` runs `runE2eGate` (label the PR and wait on `e2e_checks`, a
   `skipped` run = not run; or dispatch `e2e_workflow` via `runCiVerify`). The lane's
   own failures (`ownFailures`: spec path/basename in the log, empty log, or no spec
   changed) go through `mergeFixRound`; others are an anomaly (`e2e_blocking: all`
   blocks them). Timeout → `ci-pending`, unavailable → needs-human. `E2E_VERIFY`.
   `never`, or no `e2e_label`/`e2e_workflow` configured, keeps today's behaviour.
   **Hand-named migrations** (#4591, `generatorProblems`): at hand-off, a lane-added `.sql`
   in a drizzle-style dir (`meta/_journal.json`) without a lane-added journal entry and
   `meta/<prefix>_snapshot.json` was not made by the generator; one builder round
   (`migrationGeneratorPrompt`, stage `sequence`: regenerate, `--custom` for hand SQL), else an
   anomaly. `builderImplementPrompt` also says never to name migrations by hand.
   **Journal `when` order** (#4661, `journalOrderProblems`, same gate): a journal entry the lane adds
   whose `when` is not above the base journal's max (parallel milestone branches interleave stamps;
   newest-only migrators such as drizzle `migrate()` skip it on a persistent DB, CI migrates a fresh one)
   is reported with the hand-named problems; the one builder round re-stamps it, else an anomaly.
   Repos get `templates/github-actions/migration-journal-guard.test.mjs` (strictly increasing `when`, none
   older than the base max). An optional repo-side upgrade test (migrate a DB to the base head, apply the
   branch, assert every new migration was recorded) is not engine-run.
   **Sequence numbers** (#4322, `sequence.mjs`): before review and the first push,
   and after every base-sync merge (clean or not), lane-added `<NNN>_*` files whose
   number the fetched lane already uses → builder renumbers (`sequencePrompt`; a
   conflicted migration/journal gets `sequenceSyncNote`), then `verifyRenumber`
   (same blob, journal strictly ordered, no collision); still failing → `base.conflict`.
   Numbered documents (#4385, e.g. `docs/adr/0016-*.md`): a renamed file may differ
   only in its own number (`numberOnlyChange`, padded or not), and no tracked file
   may still name a renamed file's old stem (the series index, links).
   #4386: the engine renumbers first (`renumberLane`: `git mv` to max(base)+1…, a Markdown
   file's own heading number, references to the old stem repo-wide, the base journal plus the
   lane's entries with consecutive `idx`, a data-only snapshot cloned from the base tip with a
   new `id`/`prevId`, else `lean.sequence.regenerate`; `SEQUENCE_RENUMBERED`), and only an
   `unsupported` result goes to the builder (`SEQUENCE_RENUMBER_FALLBACK`, reason in the
   trajectory). `verifyRenumber` also accepts a file equal after mapping each move's old stem
   and its own heading number. #4732: that one substitution (`renumberText`) also covers a
   moved SQL's first line and every lane SQL naming the old stem (its `_rollback` pointer and
   a lane-added `<stem>_rollback.*` in another dir, which moves to the same number), written
   by the engine and compared by `verifyRenumber`; the number floor also counts open PRs on the
   lane (`sequenceOpenNumbers`, gh), and a non-sequence conflict base-syncs first (sequence files
   take the base side, the builder resolves the rest, `SEQUENCE_SYNC_FIRST`), then the engine
   renumbers. A base-sync whose conflicts are all sequence files
   (`resolveSequenceConflicts`: base side, journal union, index union) needs no builder, and
   an engine-only delta needs no re-review. A numbered file counts as a sequence file there
   only when renumberLane can restore the lane's side (#4465): an add/add conflict (no
   merge-base stage) in a directory holding a series on the merged base (`MERGE_HEAD`). A
   both-edited `0016-x.md` or `src/404-page.tsx` is `unsupported`: builder, tests, re-review. The base-sync bound counts syncs against one base
   head (`sameBaseSyncs`); a sync overtaken by a new base head does not count. Merge-gate late
   binding: a lane with numbered files takes the host sequence lease (`seqlease.mjs`, a
   one-slot `heavy.mjs` semaphore per (repo, lane, dir) under `schedDir()/seq-lease`,
   fail-open after the CI wait budget), re-checks against the fetched lane, and a taken number
   base-syncs + renumbers (`SEQUENCE_LATE_BIND`) and waits for CI again; released at merge
   or finish.
   #4526: the renumber picks its numbers under a short host pick lock per (repo, base, dir)
   (`seqlease.mjs` `reserve`, its own registry `schedDir()/seq-pick/<key>/`, never the merge-gate
   lease) above every other live lane's reservation in `reserved.json`; a reservation lasts until
   `unreserve` at finish, its holder's death (pid) or 24h, and a lock or file error keeps the
   #5235: build-start reservation (`seqreserve.mjs` `reserveForBuild`): before the implement call one number per numbered series dir (and one version per `lean.sequence.versioned` class, `seqversioned.mjs`) the frozen deliverables touch is reserved through the same `reserve`, above the base and open PRs, and named to the builder (`sequenceBuildRule`, kept on restarts). A renumber after a base-sync reruns the frozen validates (`revalidate`; one fix round, then an anomaly). Versioned-dir collisions are renumbered by `renumberVersioned` (`git mv` plus companion rewrite).
   base-derived numbers (fail-open). `verifyRenumber` also accepts a file whose first line only
   swaps its own stem/number (`headerOnlyChange`, e.g. `-- Migration 0067_x`). A data-only move
   after a schema-changing one in the same dir goes through the generator (its predecessor is not
   the base tip), and a move the regular generator writes no snapshot for (hand-written SQL) is
   rerun as `<regenerate> --custom` with its and later lane SQL withheld; the generator's empty
   migration is dropped and the lane's SQL and planned journal restored byte-identical.
   Only real series count (#4343): a leading date (`YYYY-MM-DD`, `YYYYMMDD`) is no
   number, and the directory must hold a series on the base — a `_journal.json` /
   `meta/_journal.json`, or ≥2 distinct numbers of the file's width filling at least
   half of their range (sparse issue-numbered docs are not a series).

   Runner CLI usage errors (#4761): `validateContract` rejects vitest `-q`/`--quiet`; a failed validate rerun whose output is a usage error (`cliUsageError`: vitest `Unknown option`, jest `Unrecognized CLI Parameter`) is first rerun once with `normalizeRunnerCommand` (`-q` → `--reporter=dot`), and if still rejected fails `contract.invalid_command` (an `ENV_CODES` state, no builder resume; recoverable and mechanical).

   Project-dir paths (#5234): `poetry -C D run pytest D/x.py` / `uv run --project D pytest D/x.py` name repo-root paths that do not exist from `D` (pytest exit 4). `freezeRewrites` rewrites the single-segment, all-`D/`-prefixed case to `cd D && poetry run pytest x.py` (`rewriteProjectDirCommand`, logged in decisions); `validateContract` rejects any other (`projectDirPathMiss`). `UNRUNNABLE_RE` also matches pytest's `ERROR: file or directory not found`, and `unrunnableValidate(run, command)` treats pytest exit 4 or 5 of a pytest command as unrunnable whatever the output, so such a rerun is `contract.invalid_command` (not `conformance.unimplemented`) and a substitute-validate for it is judged ok.

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
path rewritten), then a warm repair install. A link or repair that fails (non-EXDEV) removes the
linked trees and installs fresh after the key lock is released, without publishing: status `materialize-fallback`, or
`failed` when that install fails too (#4522). Reasons lead with pnpm's `ERR_PNPM_*` line, which pnpm prints on stdout. Miss: frozen install under the key lock, publish
via tmp + atomic rename. Never fails the run (`DEPS_PREPARED`); runner env gets the shared
stores; install/repair commands get the lane's toolchain env (#4347: a pm only the shim provides
resolves; no pin, no shim or a failed toolchain step means the host PATH); `forgedock gc --deps` reaps; `FORGE_DEPCACHE=0` opts out. See `decisions/4220-shared-dep-cache.md`.

`depcache.mjs` `linkOrCopy` (#4909) copies a file when the hardlink fails with EXDEV, so a cache on another filesystem is still a `hit`. `capwait.mjs` holds a lane refused for capacity (`sandbox.capacity`) until the pool reports `free > 0` and banks the wait as `waits.queue`.

Warm sandboxes (#4912, default off): `execution.warm_sandboxes` N adds `warm: N` to the remote launch spec, and `sandbox-remote.mjs` tries `transport.claim` (`POST /sandboxes/claim`) before `launch`, falling back cold on none, error or a transport without `claim`. The pool agent side is `bin/pool/warm.mjs` (wired in `agent.mjs`; router `claim` forwards): N prepared sandboxes per repo, a claim file in `/claim` hands over the lane, `pool/image/warm-refresh.sh` fetches the lane's ref incrementally. See `decisions/4912-warm-sandbox-pool.md`.

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
#5161: an `engine-error` whose detail is a transport/gateway failure
(`isTransientEngineError`, `TRANSPORT_TEXT`: curl `returned error: 5xx`,
`HTTP/1.1 5xx`, `Bad Gateway`, `Service Unavailable`, `overloaded`, resets)
is requeued with backoff (`transientRetryDelayMs`: 30s, 2m, 8m, cap 15m) up
to forge.yaml `orchestration.transient_retries` (default 4) times, persisted
as `transientRetries`, with one `decided` row per retry; dependents stay
pending. These retries never use the single relaunch, which is kept for
non-transient errors. Once spent, the row ends `engine-error`. The breaker
still counts every one of them (#4685).

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

Milestone integration (#4667, no LLM; `integration.mjs`, off without forge.yaml
`ci.workflow`): dispatches the workflow on each active `milestone/*` branch
every `interval_hours` or `every_merges` lane merges (`onMerged` counts, the
run is started in the background and settled after the batch; `forgedock
integration run` is the cron entry). State is a `FORGE:INTEGRATION` block in
the milestone description (lastRun, lastGreen, redStreak, mergedPrs, issue). A
red run files or updates ONE `integration-red` issue (marker
`FORGE:INTEGRATION:<slug>`: failing specs, merge range); green closes it.
`block_admission_after` makes `holds` refuse new lanes of the milestone
(`integHeld` in `orchestrate.mjs`) until a green run.

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

`apishape.mjs` (public-API-shape change detector for the light lane, #4449; see its entry below),
`checks.mjs` (change-scoped typecheck/lint/test commands and shared tsc/eslint caches, #4218),
`postmerge.mjs` (base-sync post-merge commands and same-app duplicate exports, #4406),
`execution.mjs` (forge.yaml `execution`, sandbox-provider seam, `local`/`container` providers, #4253; `remote` provider, #4254),
`sandbox-remote.mjs` (remote sandbox provider + HTTP transport, #4254), `credentials.mjs` (env → OS keychain, #4254),
`prefilter.mjs` (cheap pre-run close of already-fixed issues, `FORGE:PREFILTER`; the CI-green close is skipped for flaky/intermittent issues, reopens after a pre-filter close and same-SHA fail+pass, #4305; an issue whose latest pipeline `FORGE:PROBE` is a fail is never closed as already-fixed, reason `probe-failed`, #4399; post-deploy precondition gate parks `awaiting-promotion` follow-ups, #4389; opt-in `post_deploy.min_age` soak window parks `awaiting-min-age`, #4425),
`probe.mjs` (outcome-based acceptance, #4399; see "Acceptance probes" below),
`postdeploy-monitor.mjs` (windowed post-deploy checks, #4627: `sweepDue` re-runs open `post-deploy-monitoring` follow-ups on cadence or a new release, files a regression issue on pass-then-fail (idempotent: an existing `FORGE:REGRESSION` issue for the follow-up and fix commit is reused, #4653); run by `forgedock probe --due` and the schedd timer; ADR `devdocs/decisions/4627-post-deploy-monitoring.md`),
`prompts.mjs` (builder/reviewer/grouping prompts, `.forge-lean/` file names),
`refactor.mjs` (`refactor:split` step, #4211),
`light.mjs` (light-lane eligibility and upgrade triggers, forge.yaml `lean.light`, #4448; see its entry below),
`lightlane.mjs` (light-lane execution: one builder session, derived contract, upgrade to the full lane, #4450; see its entry below),
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
- `set-execution {id, maxRemote?, mode?}` (#5138, `--set-max-remote <id> N`,
  `--set-placement <id> remote|hybrid|local`) changes `max_remote` and the placement
  mode live. It merges into the batch's `execution` file (`{maxRemote?, mode?,
  provider?}`); with no daemon running, the client writes the file itself. The runner
  puts live getters on its `remote` object (`bin/lean/live-execution.mjs`
  `liveRemote`): `max`, `fallbackLocal` (true in hybrid) and `place` re-read the file
  on every admission, and orchestrate reads `remoteMax()` per grant. Running lanes are
  never stopped: a lower `max_remote` only holds new remote admissions (polled, so a
  raise admits them, even with nothing running); hybrid runs them on the host instead,
  and placement `local` runs every new lane on the host. A batch that built a
  remote provider records `provider: true` at start (`false` when a resume builds
  none); `remote`/`hybrid` are refused without it, because the provider, ledger and
  execution budget are built once at start. Switching a remote batch to hybrid
  computes the validation weight on first use (light until it resolves). The override
  is per batch, survives `--resume`, and logs one `execution: live placement ...` line
  per change.
- `add {id, issues}` (#4408, `--add <id> N...`, also `--resume <id> N...`) merges
  issues into the batch's cumulative `add` file, hosted or not. The client skips
  closed issues first; non-integers and issues already in the batch are skipped.
  The runner re-reads the file every pass (`getAdded`), adds new issues through
  `addIssues` after re-reading the pending issues' `Depends on`, and records one
  batch decision plus an `added` row. `attach` resumes a finished batch that has
  unrun adds instead of replaying its report.
- `cancel {id}` (#4376, `--cancel <id>`) writes the batch's `cancel` file. Only that
  batch stops: no more admissions, SIGTERM to its running local lanes, the rest `held`.
  With no daemon, the client writes the file itself.
- `status` reports the daemon pid and hosted batches.

A client exit never stops a batch.

On start the daemon resumes every `plan.daemon` batch without `report.json` and
keeps a tripped breaker tripped. Live lanes are re-adopted through `adopt`. It
exits after `FORGEDOCK_SCHEDD_IDLE_MS` (default 10 min) with no batch and no client.

Lanes run with the client's env. The plan keeps the allowlist
`PATH|HOME|USER|SHELL|LANG|LC_ALL|TMPDIR|FORGEDOCK_*|CLAUDE_*|ANTHROPIC_*|GH_*|GITHUB_*`
(`batchEnv`). `mergeEnv` drops the daemon's own allowlisted keys, so an account
selector never leaks between batches.
A secret-named key is pinned only when named (`env_passthrough`, `token_env`). A non-empty pin wins over the daemon's value. An empty one never
overrides it (#5131), and the daemon fills keys the plan lacks (release review #5142 REG-1, #5143).

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
  Re-entry guard (#4680): a pass-through wrapper that re-resolves the name back to the
  shim is cut off by `FORGE_HEAVY_CHAIN` (`name:cmd|...`). A repeat of a real binary
  (`npm run` inside an npm script, #4735) is legitimate nesting: it passes through
  unchanged and unrecorded, so depth is not capped. A repeated wrapper resolves the next
  PATH match past `FORGE_HEAVY_SHIM_DIR` and the chain dirs; none, or more than 4 entries,
  exits 126 with `env.shim_loop` naming the dirs. `writeHeavyShims` also skips wrapper
  targets at write time (next match, else skipped with a warning).
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
A transport failure while polling or adopting (refused/reset, `fetch failed`, timeout, 502/503/504, `isTransportError`) is retried with backoff for `execution.unreachable_window_min` (default 5); past it the lane ends `deferred` `sandbox.unreachable` (not breaker-counted) and the sandbox is kept, then adopted by the next attempt or `--resume` (#4672). `countLiveLanes` skips sandbox-only lane files. `orchestrate.mjs` seam
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
keychain service `forgedock`) and the `run-issue` argv. The env also carries the dispatching host's git identity (`GIT_AUTHOR_*`/`GIT_COMMITTER_*` from `git config user.name/email`, `hostGitIdentity`; a lane env identity wins) so sandbox commits have the same author as local lanes; without it the lane image fell back to `forgedock@localhost`, which fails DCO (forge#4561). Logs stream into the batch
lane log redacted; billable minutes go on `handle.minutes` and `providerLanes`
copies them to the lane result as `sandbox: {provider, id, minutes, cost_usd}` (#4255
reports them). `remote` is never a default provider; `remoteTransportFor` refuses a GitHub
Actions endpoint without `allow_actions: true`. The bearer is resolved per request (#5144): `httpTransport`'s `token` may be a function, `remoteTransportFor` passes a getter over `poolCredential`, and `providerByName` always names the token (`FORGEDOCK_POOL_TOKEN`/`FORGEDOCK_REMOTE_TOKEN`) and re-reads the router's token file per call, so a token fixed or rotated mid-batch is the next request's bearer (and is redacted). #5159: the synchronous keychain lookup of `token_env` (`secret-tool`/`security`, 10s timeout) is memoised per provider or transport by `credentials.mjs` `memoKeychain` for 60s, misses included, so a `token_env` missing from the env (when the bearer comes from the token_file or router fallback) no longer spawns the keychain on every request. The env and the token files are still read on every request. `providerByName` takes `opts.keychain` and `remoteTransportFor` takes `keychain` as test seams. `providerLanes` maps a throwing
`start` to `needs-human` `sandbox.start_failed` for a 4xx config error (not 401/403/429) or a non-HTTP throw (or `deferred` `sandbox.capacity`
for a retryable error, which `deferPolicy` requeues uncapped like `host.busy`, forge#4528; `deferred` `sandbox.transient` for any other 5xx,
retried after Retry-After or 60s and capped by `max_deferrals`, forge#5095) instead of engine-error. A sandbox that exits without a result while its
log tail shows a usage limit ends `deferred` `rate_limited` with the reset time, not engine-error (#5095). It tears down after the result is
in on every path. An optional `provider.capacity()` (`GET /status -> {free}`) caps `grant()` remote admissions so lanes queue instead of 503ing (forge#4540). `gc.mjs` `SANDBOX_TEARDOWN.remote` destroys stale remote
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

Monorepos (#4523): `validationWeight` also scans heavy markers and package.json
scripts one and two directory levels below the root (injectable `list`, default
`readdir`; skips dot-dirs, `node_modules`, `vendor`, `dist`, `build`, `target`,
`venv`, `__pycache__`; capped at 200 dirs). Root signals keep their order.
`execution.heavy: true|false` (`parseExecution`) is a placement-only override in
`placeLane`: `true` → remote (`execution.heavy: true`) after rules 1-3; `false`
ignores the detected weight but the headroom rule still applies. It adds no
pre-PR commands and does not touch admission.

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

Subject history (#5085): **attempts** also carries `subject` rows after the
issue's own runs. `subjectTerms` takes codes (dotted/underscored, UPPER_SNAKE,
HTTP 403/5xx), backticked symbols, then up to 3 distinctive title words
(3-letter acronyms like TLS count). #5110: codes and words made only of generic
status/label tokens (`blocked.generic`, `broad-base`) are dropped and never
searched, so they cannot displace the subject words; words run as overlapping
pairs and always join the git grep.
`subjectHistory` (shared with `scripts/prior-attempts.mjs`, the `/issue`
`## Prior Attempts` table) runs at most `MAX_SUBJECT_QUERIES`=3 closed
`search/issues` queries plus one repo-wide `git log --grep` (no pathspec), drops
self and graph/body links, ranks by matched terms then number, and keeps
`MAX_SUBJECT_ITEMS`=8. A failed query is a `facts.errors` entry (`attempts:
subject ...`). Subject rows never count as runs (`priorAttempts`/`laneType`).
`facts.recall` / pack `recall` says whether `bin/recall.mjs` (repo or ForgeDock
install) and `~/.forge/index/knowledge.jsonl` exist; when absent, `FORGE:CONTEXT`
adds `Recall index: absent (<reason>); subject history comes from live search.`
and `CONTEXT_PACK` records `recall: absent|present`. The status stays out of the
pack text and hash.
`ab` (#4444) runs the experiment: `contextArm` (context.mjs) hashes `repo#issue`
(sha256, first byte parity) to a stable `on` or `shadow` arm, so reruns stay in
their arm. The lane uses the arm as its effective mode, logs it as `context_pack` /
`CONTEXT_PACK.mode` (never `ab`) and tags `context_ab: true` on both events. The
default stays `shadow`. `--context-ab` also reports, per cell, merged n, builder turns
and cache-read per merge and the rework rate (remediated, after an earlier merge,
or a rerun lane). `recovery` pairs each rerun's implement attempt (builder calls
other than the plan call) with the first/child run of the same issue (its own log's
earlier slice, else the earliest such run) as mean turn and output-token ratios.

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
20% per ecosystem, `materialize-fallback` above the same 20% as a separate alert (#4522), `deferred-to-ci` above 30%, one `TOOLCHAIN_WARNING` on more than
50% of lanes, and an outcome code whose share doubled against the previous window.
Thresholds come from `stats.alerts.*`, and there are no alerts under 10 lanes.
`forgedock stats` prints the same alerts as `## ALERTS`. A failure while computing
them never fails the batch. Cost: 0 LLM calls, no network.

After the turns-by-size line, the batch report prints the efficiency section (#4402)
from `bin/stats/efficiency.mjs` `batchEfficiency` over the in-memory rows, the
batch's `log.jsonl` settle times and the run-log dir. It covers merged count,
$/merge (implement and review), turns/merge and context/turn, each split by size
and by model. It also covers retries/merge by cause (env, engine, code, review,
unknown, counting lane reruns), no-action lanes (parked post-deploy follow-ups and
`Builder is blocked (promotion)`), issue quality vs. cost, and the acceptance pass
rate 7 days after promotion. A merged issue's cost includes its earlier run slices
(cost to merge). `gh` is called only for merged issues' bodies, labels and
`FORGE:PROBE` comments. A gh failure turns quality and acceptance into `n/a`, and
any error prints `efficiency: n/a (...)` without failing the batch.
The last line (#4410) is `tools: calls/turn p50 X, re-reads (>=3x same path)/merge Y`. For each merged lane with
`PHASE_ATTEMPT_USAGE.tools`, it takes the implement calls / implement tool turns and prints the median across lanes,
plus re-read paths per such lane (`tool_calls_per_turn_p50`, `rereads_per_merge`, per-issue
`implement_tool_calls_per_turn` / `implement_rereads`). Logs without tool data give `n/a`. #5347: with 3 or more
sampled lanes (`tool_calls_per_turn_n`) and p50 below `CALLS_PER_TURN_ALERT` (1.5) an `ALERT:` line follows.
`forgedock stats --efficiency` prints the same lines per batch and over trailing
windows (`docs/STATS.md`). Cost: 0 LLM calls.

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
with `issueEdited` or `quoteMismatch` (#4789: every contract problem was an unmatched quote), `ci-pending` on a conflicting PR → `base.conflict`), `human`
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
`engine-error`/`deferred` after a recovery pass (2026-10-20, SPEC-7/8, BUG-6 from #4291).
#4656: a final needs-human row on a mechanical terminal code (or a recoverable one whose recovery is spent) is parked, not escalated: `relabelNeedsHuman({parked:{code,pr}})` swaps `needs-human` for `parked:<code>` + `remediation-queue` (the `/work-on:remediate` queue); `needs-human:external` is reserved for human waits (`classifyNeedsHuman(row,{parked:true})`, `classifyLegacyNeedsHuman` defaults to external). `gatewatch.mjs` `detectGateDeadlock` runs each pass (hold list plus the `getGates` seam) and emits a `GATE_DEADLOCK` row once per (gate, issue). Rationale: `devdocs/decisions/4297-pre-release-trust-boundaries.md`.

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
- `scripts/review-prepare.sh` (#4571): the final context `jq` takes PR-scaled values (slices, file lists, findings, domain
  and index text) through `--slurpfile`/`--rawfile` on files under `$TMP_DIR`, never argv, so a 1,000+ file PR no longer
  dies on the 128 KiB per-argument limit. Output schema unchanged; 0 LLM calls.
- `scripts/review-prepare.sh` + `bin/review-context.mjs` (#4666): `node bin/review-context.mjs check` compares forge.yaml
  `review.tech_stack`/`review.context` with the manifests and the decision log (`review.decision_log`, else the first of
  `docs/decisions.md`, `DECISIONS.md`, `docs/decision-log.md`, `devdocs/project/decisions.md`). Each stale reason becomes a
  `REVIEW_CONTEXT_STALE:` line in `phase2.findings`; `config.context_generated_at/context_stale/context_advisory` are
  additive. Advisory once more than `review.context_max_merged_prs` (default 50) PRs merged since
  `review.context_generated_at` (one guarded `gh pr list`; failure = unknown). `forgedock init --refresh-context` shows a
  diff and writes only on approval. Never blocks a review; 0 LLM calls.

## Entry 2026-10-20 — Missing host tools are an environment error, not conformance (#4323)

`gate()` (`rerunFailedValidatesRaw`) reruns once each contract validate command the builder recorded with a non-zero exit, via `io.runCommand` (`runCheckCommand`, now with an optional `env`: the lane's `TMPDIR` + `toolchain.env`) inside `heavyStep("precheck")`, logged as `VALIDATE_RERUN`. `precheck({validateRuns, repoHas})` counts a passing rerun as passed and classifies the rest with `conformance.mjs` `missingTool`: `command not found` / rc 127, Python `No module named x`, Node `Cannot find module|package 'x'` (bare names only). A path, relative specifier or a name `repoTracks(git ls-files)` holds stays `validate_failed` (a module the change forgot is a code defect). A miss is kind `validate_env`, code `env.tool_missing`: kept out of `pre`/`SHADOW_PRE_BLOCKS`, never sent to a builder resume, skipped on a CI-verified head; with no other blocking failure the lane ends `needs-human` `env.tool_missing` naming the tool before any reviewer call (also on the base-sync and CI-fix re-reviews, `envNeedsHuman`). The code is in `RECOVERABLE_CODES`; `RECOVER_HOW` has the recovery lane run the check through the repo's own toolchain. Freeze-time preflight of validate commands: see the #4328 entry. Cost: 0 LLM calls; one rerun per failed validate command.

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

**#5164 (review-row misquotes):** `fillEngineRows` now also repairs `issue_coverage` quotes. A quote that fails `inIssue`
but `matchCriterion` (`conformance.mjs`) maps to exactly one criterion line (`criterionLines`: the issue's list/checklist
items) is replaced by that exact line, the original kept as `requoted` in the posted review. Matching is loose: `norm()`
plus `#N` digits ignored, trailing punctuation and a plural `s` dropped; a prefix covering ≥80% of one line, else ≥80% of
the quote's words in exactly one line (ties and paraphrases match nothing and stay `review.incomplete`, with the nearest
criterion line in the problem). `reaskable` (evidence-path misses or coverage misquotes only) replaces `evidencePathOnly`
as the third-run condition in `reviewOnce`, so a misquote never spends the second strike reserved for real gaps; the
repair prompt carries the criterion lines verbatim (`<issue_criteria>`) whenever `issue_coverage` is missing.

## Entry 2026-10-20 — Engine-run commands get the builder's lane env; no $TMPDIR inputs at freeze (#4325)

`runCore` `laneEnv()` builds one env for every command the engine runs itself: `io.deps.env()` stores, then the run
`TMPDIR`, `FORGE_HOST_PARALLELISM` and `toolchain.env` (engine keys win over the stores). `io.redGreen` (`effects.mjs`,
new `env` merged over `process.env`), the declared check commands (`io.runCommand`, previously no env),
`rerunFailedValidatesRaw` and env.setup all use it. Before this, red-green ran with the daemon env (no run TMPDIR), so a
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

## Entry 2026-10-23 — Idle watchdog counts heavy steps and heavy-queue waits as activity (#4405)

A builder waiting silently on a queued or running heavy step (lint, test, type check) was idle-killed at
`cli_idle_minutes`. `runCliBackendAsync` (`bin/runner.mjs`) now takes an injected `busy(children)`, `busyMs` and
`onIdleExtend`. Once the idle threshold is reached it asks `busy` (at most every min(5 s, idleMs)). While the answer is
busy, the kill waits until idleMs + busyMs of silence. `lean.mjs` `sessionBusy` answers busy when a descendant is a
heavy step (`heavy.mjs` `isHeavyProcess`: the shim marker `heavy.mjs run`, `classifyStep` on argv0 or on the script
after an interpreter, `node --test`, `python -m pytest|mypy|tox|unittest`), or when `io.heavy.lane(pids)` finds a queued
or running heavy entry whose pid is one of the session's descendants. It matches by pid, not issue, because the registry
is host-wide and shared across repos. `lane()` is read-only and lock-free. Pollers (`sleep`, `until grep`) and MCP
servers do not count, so a silent session with no work child is still killed at idleMs. The window is
`engine.cli_busy_minutes` (default 45 = heavy `max_wait_s` plus the idle default), so a stuck child is still killed. Run
log: `CLI_IDLE_EXTENDED` {children, heavyQueue} once per silent stretch; `CLI_IDLE_KILL` adds `heavyQueue` and `extended`.
The busy check gets whole command lines (`listDescendants` `maxCmd`; the kill record keeps 200 chars), and because `ps` is
synchronous, a first "not busy" answer kills only on the next tick, after output written meanwhile has been read.
Cost: 0 LLM calls; one `ps` and one registry read per check, only while idle.

## Entry 2026-10-23 — Risk-path enforce, partial investigation close, per-batch shadow line (#4398)

`gate()` (`lean.mjs`) checks the changed files against forge.yaml `review.risk_paths` globs (`review-trigger.mjs` `riskPathHits`;
declared globs only, never the built-in risk words). A hit makes a shadow lane enforce for the rest of the run (sticky:
precheck, review, resume, base-sync re-review, no degraded merge), logs `CONFORMANCE_RISK_ENFORCED {paths}` once plus a
decision line, and `RUN_TERMINAL.conformance_mode` reports `enforce`. `closePlan(contract, {title, review})`: an
`investigate(`/`investigate:` issue (`isInvestigation`) with a defer/post-deploy requirement, or a deliver requirement
whose review row is not `implemented`, is `partial`. The untracked ones are filed with `track()` before the PR, the issue
closes `completed` (#5152; was `not planned`) with a FORGE:TRACKED "Closed as partial" note naming the follow-ups, and the Close row and lane result say partial.
The lane result carries `conformance {mode, would, risk}`. Orchestrate's row copies it, and the batch report prints
`formatShadowSummary`: shadow lanes, would-block share, false-block share (a would-block on an incomplete, inconsistent
or unparseable review) and risk-enforced lanes. Rationale: `devdocs/decisions/4398-risk-path-enforce.md`. Cost: 0 LLM
calls; a risk-enforced lane may spend the one builder resume that shadow would have skipped.

## Entry 2026-10-23 — Lint scoped to changed packages; configured typescript.lint (#4381)

`checks.mjs` printed `turbo run lint --filter=...[base]` (changed packages plus
every dependent), so a change to an upstream package linted the whole repo.
`scoping.mjs` `scopeMono` now scopes a turbo run whose tasks are all lint tasks
(`lint`, `lint:*`, `*:lint`) to `--filter=[base]` (selector `turbo-changed`);
typecheck/test/build keep `...[base]`. `checks.mjs` `configuredLint` reads
`verification.commands.typescript.lint` from the trusted forge.yaml
(`lib.mjs` `trustedForgeYaml`, extracted from `plan.mjs` `loadConfig`, forge#4040)
and prints it (`configured: true`) in place of the discovered JS lint; Python
checks are never replaced. `HOST_RULES` forbids dependency-closure lints (the
configured lint wins because the builder runs what `checks.mjs` prints; filler
words were trimmed to keep the implement prompt within its 1500-token budget). Legacy `validate.md` runs `typescript.lint` like
`typescript.typecheck`.

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

## Entry 2026-10-23 — Structured FORGE:FACTS for later lanes on the same files (#4401)

`facts.mjs` (pure) defines the record. The implement prompt asks the builder for an optional result.json `facts` key:
`decisions`, `rejected` [{approach, why}], `hotspots` [{at: file:line, why}] and `conventions`. `normaliseFacts` adds
`baselines` (result.json `validation` rows with a command and an integer exit) and `files` (the lane's changed files,
`.forge-lean/` left out). Those files are the path index. Decisions fall back to the frozen contract's `decisions[].choice`.
Each list is capped at 5 entries (files at 20). Text is one-lined, comments are stripped, and text is capped at 160 chars.
A rejected approach or hot spot without a why is dropped, and so is a hot spot with `..`. `finishOnce` runs `postLaneFacts`
before teardown, while result.json still exists. It posts one `<!-- FORGE:FACTS -->` issue comment for every outcome,
failed lanes included. The comment has a count line and the JSON in a fence, with `<` and backticks escaped. Nothing is
posted for an empty record or one already on the issue. A failure never changes the lane's outcome. Like every
`<!-- FORGE:` comment, the record is never quotable contract text (`textOf`, `scopeText`).
`context.mjs`: the ledger and facts sources share one file-path walk (`git log --first-parent <base> -- namedPaths`) and
one trusted-comment read per PR (PR + linked issue). The walk runs when either source is on. The `facts` source collects
up to `MAX_FACT_LANES` (6) records with `parseFactsComment`, which applies the same caps again, from trusted comments
only. It reads this issue's own records first (earlier attempts, newest first). It then reads records on merged PRs and
their linked issues whose `files` overlap the issue's named paths. The pack lists them by kind across lanes: rejected,
hot spots, decisions, conventions, baselines. Each line carries its provenance (`#33, PR #101`). The repo-fact pointers
follow, all under `facts` (section "Facts from earlier lanes and repo facts"). Cost: 0 LLM calls, about 60 prompt
tokens, one comment per lane, and no extra GitHub read per PR.

## Entry 2026-10-23 — Resume digest and populated context-pack sources (#4400)

Resumed and recovery lanes used to re-orient from scratch. `textOf` keeps every `<!-- FORGE:` comment out of the quotable
issue text (#4297), so the last run's own records never reached the builder. `resume.mjs` (pure) adds
`buildResumeDigest`, a bounded digest (`RESUME_DIGEST_BYTES`, 2048 bytes) built from structured records only. It holds
the RUN_START `FORGE:STATE` end reason, `terminalCode` and `failureClasses`, kept only when they are outcome codes. The
lease write keeps them, so they are read before this run ends. It adds the first line of the newest trusted
`FORGE:NEEDS_HUMAN`/`FORGE:FIX_CI` and the newest trusted `FORGE:FACTS` baselines (validate command + exit, mapped to the
contract's `V` ids). It lists the frozen contract's `deliver` requirements and the branch's changed files, and ends with
"start from this state: do not re-derive it". Whole lines drop from the end to fit the cap, so the end reason and
validate results survive longest. Text is one-lined, comments are stripped and `<` is escaped. `runCore` builds the
digest once when the lane is resumed, salvaged or a recovery pass, unless `engine.context_pack` is `off`. It is the
lane's own state, not the shadow-gated hint pack. The digest is appended to the plan rerun prompt, to the implement
prompt on the frozen-contract path (after the recovery note) and to the context-restart prompt. It never goes into
`issueText`. A `RESUME_DIGEST {bytes, files, validates, reason}` event and a trajectory decision record it, so recovery
implement attempts can be compared with first runs.

Why the pack's `facts` source was 0 in all 10 AlterLab lanes on 2026-10-22: (a) there was no `FORGE:FACTS` source before
#4401; (b) the repo-fact pointers (`.forge/repo-facts.json`, `.forge/test-map.json`) were only looked up in the lane
worktree, and these untracked caches never exist there. `gatherContextFacts` now takes `checkout` (the main checkout) as
the fallback, like `factsPath([wt, cwd])` for the builder; the cache key is unchanged. `ledger`, and facts from merged
PRs, still depend on the issue body naming file paths (`namedPaths`). `attempts` is 0 on a first run by design.
The `on` vs `shadow` A/B (turns, cache-read and rework per merge, via `forgedock stats --context-ab`) runs after deploy.
Cost: 0 LLM calls; one `git diff --name-only` on a resumed lane; at most ~500 prompt tokens.

## Entry 2026-10-23 — Post-merge typecheck at base-sync and duplicate exports (#4406)
Sibling lanes can add the same name (an export, a registry key) and git merges both cleanly: duplicate object keys
(TS1117), or a name-keyed probe map that tests only one of two same-named actions. `baseSync` now checks the merged tree
before the push whenever the merge moved the head: `postMergeGate` runs `postMergeCommands` (`postmerge.mjs`:
forge.yaml `verify.post_merge`, else the non-skip typecheck rows of `checks.mjs` `scopedChecks` via `io.postMergeChecks`;
none in `ci` mode unless configured) through `io.runCommand`. A failure resumes the builder (`fixRound("post_merge")`, trigger `post_merge`,
`postMergeFailurePrompt`) up to `verify.max_rounds`; still failing is an anomaly (CI stays the gate). Run log:
`POST_MERGE_CHECKS` {trigger, round, results}. `duplicateGate` (`io.duplicateExports` → `postmerge.mjs`
`duplicateExports`) runs at hand-off and after each base-sync merge: lane-added declared exports that another non-test
module under the same manifest root declares (re-exports, default exports and names 3+ modules declare are ignored) get one
"rename or reuse" round (trigger `duplicate`, `duplicateExportsPrompt`, both paths), then an anomaly; `verify.duplicate_exports: false` turns
it off. Run log: `DUPLICATE_EXPORTS`. A post-merge or duplicate fix round triggers the base-sync re-review; a clean merge
that passes both is still not re-reviewed. Cost: 0 LLM calls when clean; one typecheck per base-sync in local/hybrid mode.

## Acceptance probes (#4399)

`probe.mjs` checks a production outcome after promotion, deterministically (0 LLM calls, no lane). An issue declares a
probe in a fenced ```` ```forge-probe ```` block: `run: <shell command>` (required), `pass: exit 0` (default) or
`pass: /regex/flags` on stdout, `timeout: <s>` (default forge.yaml `acceptance_probe.timeout_s` or 120, capped at 900).
CRLF/CR line endings (GitHub web UI bodies) are normalised to LF before the block is matched (#4466). The
latest declarer comment's block wins, else the body's when its author is a declarer (`isProbeDeclarer`, #4468): a human
whose association is in `FORGE_TRAIL_TRUSTED_ASSOCIATIONS` (default OWNER,MEMBER,COLLABORATOR) or whose login is in
`FORGE_TRAIL_TRUSTED_LOGINS`, never a Bot/App or `[bot]` login, the engine included (the issues it files quote untrusted PR
content; the shared `isTrustedActor` still trusts Bots for markers). Only a top-level fence counts (CommonMark: backtick or
tilde, closed by the same character at least as long): a block nested in another fence or indented as code is quoted
content. FORGE marker comments never declare one, and an untrusted declaration is reported `untrusted` and never run. The fix
commit is the latest trusted FORGE:TRAJECTORY `merged at <sha>`, else the merge commit of the latest merged PR whose
title/body closes the issue (none: `unresolved`). Promotion is `git merge-base --is-ancestor <fix> origin/<default>`
(`branches.default`, else GitHub's); not yet: `awaiting-promotion`, nothing runs (`onDefault` is exported for #4389).
The probe runs as `sh -c` in the checkout, in its own process group (timeout kills it = fail), with only PATH, HOME, LANG,
TMPDIR plus the names in `acceptance_probe.env` (the repo's designated test identity); those values are masked as `***` in
the output. The result is a `FORGE:PROBE` comment (JSON line `{fix, default_sha, result, exit, ms}` + the last 4000 chars
of output); a fail first reopens the issue. A trusted FORGE:PROBE for the same fix is never re-run (`already-recorded`).
Triggers: `forgedock probe [issue...] [--dry-run] [--limit N]` (no issues = closed within `acceptance_probe.sweep_days`,
default 30, matching `forge-probe in:body,comments`, capped at 50) and a sweep at the start of every `forgedock orchestrate`
batch (`--no-probes`; `acceptance_probe.enabled: false` turns the sweep off), printed as one `probes: ...` line; a sweep
error is one line and never fails the batch. Cost: one search per batch plus 2-3 gh calls per probing issue.

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

## Entry 2026-10-23 — post_deploy.min_age soak window (#4425)

Opt-in forge.yaml `post_deploy.min_age` (`parseMinAge`: `30m`/`24h`/`7d`/`2w`, a bare number is minutes, `0` allowed; read by
`readPostDeployMinAge` in `engine-cli.mjs` for orchestrate and triage). Unset: the gate is exactly #4389 (no extra git
call). Set: once every parent SHA is on the default branch, and before `precondition_cmd`, `postDeployGate` requires
`max over items (item window ?? min_age)` since the fix landed. An item's window is the largest explicit duration in its
post-deploy `why` (`itemWindowsMs`, strict number+unit regex h/d/w, no model). `landedAt` takes the landing time from git:
`rev-list --ancestry-path <sha>..origin/<default>` (descendants) intersected with `log --first-parent` of the same range.
The oldest mainline descendant is the merge that brought the SHA in (its `%ct`). The SHA's own `%ct` is used when it is on
the mainline itself or is the tip. `--first-parent --ancestry-path` together returns nothing for a second-parent merge, so
the two walks stay separate. The latest landing over the SHAs counts. Too young: `{parked: true, kind: "awaiting-min-age",
eligibleAt}`, the same `awaiting-promotion` label and `FORGE:PRECONDITION` comment, and one `awaiting min age: #A (fix on
<default>, soak window not elapsed)` report line. An unknown landing time fails open (`unresolved`). `now` (or `io.now`)
is injectable for tests.

## Entry 2026-10-23 — CI-verify gate, flake rerun, parked dependencies (#4387)

`verify.mjs`: `parseVerify` `checks`; `ciGate` (verify.checks, else `io.requiredChecks(lane)` under `merge_wait:
required`, else null = all); `latestPerName` (highest check-run id; no ids → worst state); `runCiVerify` `gate` (missing
gate names waited on for the grace period, none reported → all checks) and `rerunOf` (`rerunTarget`: older attempts count
pending; workflow mode waits for the run's next `attempt`). `lean.mjs` `ciVerify`: a no-commit fix round calls
`rerunFailedOnce` (`effects.mjs` `rerunFailedJobs`, `gh run rerun --failed`), logs `CI_FLAKE_RERUN`, continues on green,
else `ci.red`; merge-time rounds unchanged. `orchestrate.mjs`: `issueLabels` seam (engine-cli `labelNames`, fail-open):
a `dependency-open` naming a `needs-human` dependency (batch result or out-of-set label) ends `skipped (dependency #N
needs-human)` without pulling it in.

## Entry 2026-10-23 — Builder model routing by contract class (#4394)

Implement is about 96% of lane spend and review about 4%, so the build is where a cheaper model pays. `routing.mjs` (pure)
classes a lane from the frozen contract's deliverable paths: `risk` (`riskClassOf` built-in words, or a `review.risk_paths`
glob through `riskPathHits`), `docs-config-test` (every path `classifyPath` → test/docs/config; lockfiles are code), `small`
(≤2 non-test paths) or `large` (more, or none). `runCore` computes the route once, after the contract is frozen or recovered
on a rerun and before the build call; refactor:split lanes compute none. `docs-config-test` and `small` take the mid tier
(forge.yaml `lean.builder_mid_model`, else `engine.lean_builder_mid_model`, default `claude-sonnet-5-5`); `risk` and
`large` take the top model (`builderModel`, null meaning the CLI default). `laneModel()` is the default model of every
builder call, so the plan and contract-correction calls (made before the route exists) stay on `builderModel`.
`fixRound` → `escalateOn(trigger)`: on the mid tier, the first `ESCALATE_TRIGGERS` round (`precheck`, `ci_red`,
`merge_ci`) sets `escalated`. That round and every later builder call run on the top model, and fresh fix sessions pass
`model: null`, so `fixModel ?? reviewerModel` does not override it. Non-escalated lanes keep today's fresh-fix model. No round
is added. `pickVerifierModel` also gets the routed mid model as a reported builder model, so the verifier never runs on it.
`lean.builder_routing: off` (`readBuilderRouting` in `engine-cli.mjs`) keeps every call on `builderModel` and still records
the class (tier `top`). Run log: `BUILDER_ROUTE {mode, class, tier, model, risk}` and `BUILDER_ESCALATED {from, to,
trigger}`. `RUN_TERMINAL` and the telemetry `run_terminal` payload gain `builder_tier`, `builder_class`, `builder_model`
(id or `default`) and `builder_escalated` (0|1 in telemetry). The lane result gains `builderRoute`. Stats: `summariseLog`
adds `builderRoute`, `conformanceRound`, `shadowWould`, `reachedReview` and `reworkedMerges` (earlier merged slices of the
same issue log). `forgedock stats --tiers` (`builderTierReport` / `renderTiers`) groups finished routed runs by `mid`,
`mid->top` and `top` × class: n, merge rate, conformance rate (of reviewed lanes: no conformance/review fix round, no shadow
would-block), post-merge-rework rate (a later run of a merged issue, or remediated), first-pass yield and mean cost. The
2-week no-regression check is a post-deploy gate on the default. Cost: 0 LLM calls; mid-tier implement on routed lanes.
ADR `decisions/4394-builder-model-routing.md`.

## Entry 2026-10-23 — Decomposition gate and $/parent report line (#4396)

`classifyBlock` (`lean.mjs`) passes a `split-required` block through `decompose.mjs` `splitGate`. The split is admitted
when every sub-issue declares `paths` (or the #4385 `files`) and no path of one equals or sits under another's (independent), or when the
block's `size` estimate exceeds 25 files or 1500 lines (oversize). Otherwise it is an `untyped` block: the existing
single corrective resume tells the builder to keep one lane, an ordered checklist with a validate per item, and a
second unjustified split ends `builder.block_untyped`. An admitted split writes `rationaleLine` into `FORGE:DECOMPOSED`
and its decision line, and the lane result carries `decomposition {independent, oversize, overlaps, missing, size}`.
Orchestrate's row keeps `subissues` and `decomposition`. The batch report prints `formatDecompositionSummary`: $/parent
for decomposed parents (their row plus their sub-lanes, recursively; sub-issues not in the batch are counted as
outside) against merged single-lane parents. Rationale: `devdocs/decisions/4396-decomposition-gate.md`. Cost: 0 LLM
calls; an unjustified split spends the one block-correction resume instead of N sub-lanes.

## Entry 2026-10-23 — Explorer subagent for builder discovery (#4391)

`explore.mjs` defines an `explorer` custom subagent (read-only; tools Read, Grep, Glob, Bash; model `lean.explore_model`,
default `haiku`) whose prompt returns one digest of at most 60 lines: Files (path:start-end), Call sites, Tests to extend
(with the command that runs them), Conventions to match, Open questions. forge.yaml `lean.explore: on` (`engine-cli.mjs`
`readExplore`, runCore `o.explore`) passes it on every builder call as `--agents <json>` (`effects.mjs` `makeLeanRunner`
`agents`; reviewer and grouper never get it) and appends a rule to the plan and implement prompts: discover through the
explorer, keep the digest, open a file only to edit it or to verify a digest claim. Off (default) leaves argv and prompts
byte-identical. `RUN_TERMINAL` carries `explore: on|off`; the A/B compares plan/build `PHASE_ATTEMPT_USAGE` turns and
`cache_read_input_tokens`, merge rate and conformance verdicts by that tag over the same issues. Cost: 0 engine LLM calls;
~120 prompt tokens per builder prompt when on; explorer calls are billed inside the builder call's `cost_usd`.
`forgedock stats --explore-ab` (#4418, `bin/stats/query.mjs` `exploreAb`) is that reader: every RUN_START slice of the
local run logs (`local-source.mjs` `readLocalLaneRuns`, so an on and an off run of one issue both count), per size bucket
(`RUN_TERMINAL.turns.size` S/M/L, else unsized) and mode: mean plan+build turns and cache-read, merge rate and conformance
rate (as `--tiers`), plus a paired section of issues with a finished run in both modes. Untagged (pre-#4391) runs are
counted and left out, never read as `off`. The A/B result itself stays a post-deploy check.

## Entry 2026-10-23 — Per-batch cancel (#4376)

`forgedock orchestrate --cancel <id>` stops one batch without stopping the shared schedd. The client sends the schedd
`cancel` op, or, with no daemon, writes `batch.mjs` `requestCancel` (the batch `cancel` file, `{at, reason}`) itself. A
finished batch (its `report.json` written, not hosted) is left alone; an unknown id fails `no batch`. `orchestrate.mjs`
reads the file through `getCancelled` every pass, and also every `pollMs` while lanes run or the batch waits on a delay.
On the first pass that sees it, the runner:
- admits nothing more, including beforeAdmit GC and recovery relaunches;
- logs one `cancelled` row and a batch decision, and withdraws its registry offers;
- calls `stopLane` once per running local lane. engine-cli wires `stopLane` to `killLedgerPid(pid, resultFile)`: SIGTERM
  to the lane's process group, so its #4179 teardown checkpoints and reports `deferred run.interrupted`.

A lane settling `deferred` or `engine-error` under a cancel is requeued with no deferral and no usage-limit hold. A lane
the runner launched in the same instant ends `deferred` without starting. Remote lanes (sandboxes) are not stopped by default: they run to their result (see Entry 2026-10-26). Once nothing runs, the loop ends; every unfinished issue is
`held` with detail `cancelled by operator` (also the reason for the #4315 queued-recovery relabel) and `report.json` is
written. `state.json` keeps `cancelled`, but the file stays the authority: an operator `--resume` clears it (`clearCancel`
next to the breaker reset) and continues the held issues; a daemon restart (`keepBreaker`) keeps it. Cost: 0 LLM calls;
one small file read per pass. ADR `decisions/4376-orchestrate-cancel.md`.

## Entry 2026-10-23 — A held batch polls the usage-limit store (#4446)

While the account's usage-limit hold is active, `orchestrate.mjs` caps its wake at `pollMs` (5 s default) and the idle
sleep (pending issues, no running lane) honours that cap. Each pass re-reads `limits.json` through `heldUntil()`, so
`forgedock limits clear <id>` from any process admits the held batch on its next poll, not at the recorded reset. A
live K (`getParallel`, `--set-parallel`) also wakes an idle held batch. Before this, only the #4376 cancel seam bounded
that sleep. A hold still present keeps the batch waiting, and the first admission lands exactly at the reset
(`wake = min(holdUntil - t, pollMs)`). Per-issue `notBefore` delays are not externally clearable and are capped only
by the existing seams. No socket notification: the host file is the authority for daemon-hosted and foreground
dispatchers alike. Cost: 0 LLM calls; one small file read per poll while held.

## Entry 2026-10-23 — Longest-first admission inside a priority level (#4409)

Batch admission used to take ready issues in queue order (FIFO) inside a priority level, and `addIssues` added a decomposed
lane's sub-issues at the back of the queue. A batch's makespan is set by its longest chain, so long lanes and
decomposition children started last and became the long pole (AlterLab batch 2026-10-22: a 48 min sub-issue started
1h18m in, batch 2h46m). `orchestrate.mjs` now ranks `ready` with one `rank()` in all three admission paths (registry
offer, `pickNext` budget, plain):
1. priority (unchanged; the host registry `sched.mjs` keeps its cross-batch FIFO, only the in-batch offer order changes);
2. the head band: decomposed sub-issues (`addIssues(subs, {head: true, parent})` puts them at the front of the queue;
   persisted `heads`), and, with an estimator, issues queued longer than `starveMs` (default `DEFAULT_STARVE_MS`, 30 min;
   persisted `enqueued`), oldest first;
3. the estimate plus the estimates of unfinished in-batch dependents (critical path), descending;
4. queue order.

The estimate comes from the optional `estimate(issue, {body})` hook (null keeps today's order apart from the head rule).
engine-cli wires `estimateLaneMinutes`: a post-deploy-only body is `POST_DEPLOY_EST_MIN` (2), otherwise the `size:` label
(`budget.mjs` `laneSize`; unsized = M) picks the repo's median wall minutes of merged runs of that size from the local
run logs (`laneHistory`; `summariseLog` now carries `size` from `RUN_TERMINAL turns.size`; at least 3 samples), else
`EST_DEFAULT_MIN` S 10 / M 25 / L 50. A sub-issue gets the parent's estimate ÷ N, floored at M. Estimates are persisted
as `estimates` (only with the hook); a failing hook is the M default. A settled row carries `est_minutes`;
`formatEstimateSummary` adds the batch-report line `estimates: N lanes, est X min vs actual Y min; median |error| Z min;
worst #n …`. Cost: 0 LLM calls; one local run-log read per batch. Tests: `bin/lean/sched.test.mjs` "longest-first
admission (#4409)", including a virtual-clock replay of the 2026-10-22 batch shape.

## Entry 2026-10-23 — schedd shutdown stops the batch loops before the lock (#4454)

SIGTERM/SIGINT of `forgedock schedd` used to release `schedd.lock` and the socket without stopping the hosted
`orchestrate()` loops or exiting. Their timers kept a lock-less process dispatching while the next auto-spawned daemon
resumed the same batches. Now `startDaemon` gives every in-flight `runBatch` (hosted, or still resuming) an
AbortController and passes its `signal` through `runBatch` to `orchestrate`. `close()` refuses new submits, aborts every
run, waits for them to settle (bounded by `stopMs`, default `STOP_MS` 10 s; on timeout it logs and goes on), and only
then removes the lock (if still ours) and the socket. `exitOnSignals(d)` (used by `scheddFromCli`) awaits `close()` and
exits 128+signo, the #4318 dispatcher convention.

When `signal` aborts, `orchestrate` admits nothing more, wakes every sleep (`nap` races the abort and cancels the timer)
and lane race, and leaves without awaiting, stopping or settling running lanes. Lanes are detached and keep running. It
does not relabel queued recoveries. It saves the state once, with `running` records and pending, then ignores later
saves and settles, and throws `code: "batch.stopped"`. `runBatch` therefore writes no `report.json`, and the next daemon's
`resumeOnStart` resumes the batch and adopts the lanes. This differs from #4376 cancel, which SIGTERMs lanes and ends the
batch with a report. Callers without `signal` are unchanged. Cost: 0 LLM calls.

## Entry 2026-10-23 — Run logs and lane ledgers keyed by repo (#4432)

Issue numbers are per repo, but `~/.forge/runs` and `~/.forge/ledger` are per host. The run log is now
`<owner>__<repo>__<N>.jsonl` (`engine/runlog.mjs` `runLogPath`, the `owner__repo` scheme of `pitfalls.mjs`);
`appendEvent`/`readLog`/`rewriteLog` take an optional `{ repo }` and keep the legacy `<N>.jsonl` without one (the
interactive hook logs under `<cwd>/.forgedock/run-logs`, already per checkout). Both paths pass the repo: runCore its
`repo`, the full path `resolveRepo()` before its first read. Read fallback for one release: a repo with no file yet reads
the legacy file's RUN_START slices of that repo. `migrateRunLogs(dir)` runs at `run-issue` and `orchestrate` start: it
claims each legacy `<N>.jsonl` by an atomic rename, moves repo slices into the repo files (before any events already
there, seq renumbered), keeps repo-less slices in `<N>.jsonl`, never throws. `lastLocalRun`, `readLocalRuns`/`readLanes`
and `efficiency` read the new names. The adhoc lane ledger was `adhoc/lean-<N>.json` for every repo, so one lane's
teardown could act on another repo's resources: `makeLedger({ repo })` now writes `<batch>/<owner>__<repo>__<lane>.json`
(the `lane` field and gc are unchanged; old files age out by TTL). The context-pack cache name and prune prefix carry the
repo too. Audit: leases (FORGE:STATE on the repo's issue), worktrees (under the checkout), depcache (`<repoKey>/`), the
sequence lease and sched keys were already repo-scoped. Cost: 0 LLM calls; one dir scan per run-issue/orchestrate start.

## Entry 2026-10-23 — Public API-shape detector (#4449)

`apishape.mjs` adds a deterministic check for API drift such as the more-itertools `ichunked` generator→function
change from #4442. `detectApiShape({ cwd, base, head })` and the CLI `node bin/lean/apishape.mjs <base>...<head>`
work the same way. For every file in `git diff -M <base>...<head>`, they index the base and head blobs with
`scripts/symbol-index.py --shape` (stdlib `ast`) or `scripts/symbol-index.mjs --shape` (the repo's own `typescript`,
else ts-morph's). The opt-in `--shape` flag adds `async`, `generator` and a normalized `sig` to functions, methods and
function-valued consts. The sig covers parameter kinds, names and annotation text, and marks defaults with `=` without
their values. Default indexer output is unchanged.

Public symbols are compared by name:
- `signature`, `sync-async` or `generator-function` when the shape changes;
- `renamed` when a vanished public symbol pairs with a new one of the same kind and shape in the same file;
- `removed` otherwise, including public→private.

Additions never report. Code with no indexer (go, rust, …) or a blob the indexer refuses (parse error, no parser) is
`unknown`; docs, config, data, test files and `.d.ts` are skipped. Output is
`{status: none|changed|unknown, changes[], unknown[]}`, and exit 2 means a usage error or a bad ref. The detector is
not wired into a lane yet: #4448 takes it as one upgrade-trigger input and #4450 runs it. The JS/TS tests need
`APISHAPE_TS_NODE_MODULES`, and CI requires them with `APISHAPE_REQUIRE_TS=1` on the ts-morph install. Cost: 0 LLM
calls, two indexer runs per changed source file. ADR `decisions/4449-apishape-detector.md`.

## Entry 2026-10-23 — App comments in gh issue view shape are trusted (#4467)

`gh issue view --json comments` reports the ForgeDock App as a bare `rapiercraft-forgedock` with `CONTRIBUTOR` and no
type or `[bot]` suffix, so the gh-shape trust filters in `resume.mjs`, `context.mjs` and `lean.mjs` `trustedOf` dropped the
engine's own FORGE:NEEDS_HUMAN/FIX_CI/FACTS records: the resume digest lost the end reason and validate baselines and
`priorAttempts` read a first attempt. The pre-filter's #4315 rule is now the one shared predicate,
`prefilter.mjs` `isTrustedIssueComment`: what `isTrustedComment` trusts, or a login whose bare form (lowercased, `app/`
and `[bot]` stripped) is `APP_SLUG`. Other CONTRIBUTOR logins stay untrusted; a differently named App still needs
`FORGE_TRAIL_TRUSTED_LOGINS`. REST readers (`readFrozenContract`, context `readComments`, probe) are unchanged. Cost: 0.

## Entry 2026-10-23 — Light-lane eligibility and upgrade triggers (#4448)

`light.mjs` (pure: no I/O, no model call) is the gatekeeper of the light lane (#4442: one builder session plus the
deterministic gates). It reuses `riskClassOf`/`riskPathHits` (review-trigger.mjs), `classifyPath` (routing.mjs),
`laneSize` (budget.mjs), `isInvestigation` (conformance.mjs) and `postDeployOnly` (prefilter.mjs).
`lightEligibility({title, body, labels, predictedFiles, riskPaths, cfg})` returns `{mode, verdict, eligible, light,
reasons:[{code, detail}]}`, reasons sorted by code then detail. Hard reasons make the verdict `ineligible`:
- `files`: more than `max_files` predicted non-test files (tests never count: the light lane writes a failing test first);
- `size`: a `size:M` or `size:L` label;
- `risk_path`: a predicted file with a built-in risk word or matching a `review.risk_paths` glob (same rule as builder routing);
- `investigate`: an `investigate(` / `investigate:` title;
- `post_deploy`: a `post-deploy` or `awaiting-promotion` label, or a body whose checklist items are all post-deploy checks;
- `decision`: a `decision`, `needs-decision`, `product-decision`, `rfc` or `adr` label (optionally `type:`-prefixed), or a
  `decision(`, `rfc(` or `adr(` (or `:`) title.

With no hard reason, soft reasons make it `ambiguous`, for the caller's cheap classifier (this module never calls one):
`no_repro` (the body, HTML comments stripped, has no code fence and no steps to reproduce / repro / expected or actual
behaviour, result or output line) and `files_unknown` (no predicted non-test file). Otherwise it is `eligible`.
Modes: `off` returns verdict `off` with `eligible: false` and no reasons (never eligible); `shadow` (default) computes the
verdict and reasons, `light` stays false so the lane shape does not change; `on` sets `light` for an eligible issue.
`upgradeTriggers({diff, repro, testFailures, riskPaths, apiShape, cfg})` returns `{upgrade, reasons}`: `diff_lines`
(added+deleted of non-test numstat rows above `max_lines`, binary `-` counts 0), `diff_files` (more than `max_files`
non-test files), `repro_not_red` (repro base word is not `FAILED`, or no repro result), `tests_failed_twice` (two or more
failed targeted-test runs), `risk_path` (any diff path, tests included) and `api_shape` (each entry of the #4449 detector's
output, strings or `{symbol, kind}`). Config: forge.yaml `lean.light: {mode: off|shadow|on, max_lines: 40, max_files: 2}`.
The one-level forge.yaml parser flattens the nested block to `lean.mode|max_lines|max_files`; flat
`lean.light_mode|light_max_lines|light_max_files` also work and win. An unknown mode is `shadow`, and a limit that is not a
positive integer keeps its default. `readLight(cwd)` in `engine-cli.mjs` reads it. Nothing calls the module yet: the lane
wiring (light session, derived contract, upgrade to the full lane) is #4450, so every lane runs as before. Cost: 0 LLM calls.

## Entry 2026-10-23 — Light-lane execution (#4450)

`runCore` now calls `lightEligibility` on every lane, before the plan call. It logs `LIGHT_ELIGIBILITY {mode, verdict,
light, reasons}`, and adds one trajectory decision unless the mode is off, so shadow (the default) reports without changing
the lane. `engine-cli.mjs` passes `light: readLight(cwd)` at both `runCore` call sites. The predicted files are the
paths the body names (`namedPaths`), and the risk paths are `review.risk_paths`.
A lane runs light only in mode `on`, with verdict `eligible` (an `ambiguous` verdict stays full; no classifier call), and
only as a fresh lane: never resumed, salvaged, recovery, refactor:split or with a recovered frozen contract.
`lightlane.mjs` `runLightStep` (every effect injected; lean.mjs only wires it):
1. One builder session (`lightBuildPrompt`, trigger `build`, implement turn budget): failing regression test first, then
   the fix, then the targeted tests, commit; result.json carries `requirement` (one verbatim issue sentence),
   `repro_test` and `tests[].command`. A builder that finds the issue invalid, blocked or too big writes
   `status: "upgrade"`.
2. `checkpoint("light build")` commits uncommitted work. No commit is `no_commit`, and a status other than `fixed` is
   `not_fixed`.
3. `deriveLightContract` (pure) builds the record from the diff and the test:
   - R1 quotes the builder's sentence when it is verbatim in the issue, else the title;
   - one deliverable per changed non-test file;
   - validate is the repro command plus each targeted test command;
   - `repro_test` is the builder's, else `"none"` with a reason.
   The same `validateContract` judges it; an invalid one is `contract_invalid`.
4. Gates:
   - the engine runs the validate commands (`io.runCommand`, `heavyStep("precheck")`). A failure resumes the builder
     session once (trigger `precheck`), then reruns them, so two failed runs are `tests_failed_twice`;
   - the red/green repro (`reproOf`, `io.redGreen`);
   - `git diff --numstat base...HEAD` (`parseNumstat`);
   - `io.apiShape` (`effects.mjs` → `apishape.mjs` `detectApiShape`). A status `unknown`, a missing hook or an error
     is an `api_shape` reason.
   All of these feed `upgradeTriggers`; any exception is `light_error`.
No trigger: the derived contract is frozen and posted as FORGE:CONTRACT exactly like a planned one
(`CONTRACT_FROZEN {derived: "light"}`, `LIGHT_DONE`). The plan and implement calls are skipped, and every later gate runs
unchanged: declared checks (lint/format), structure, docs, enumerating, the conformance precheck (which reruns the
repro) and the review.
Upgrade: `LIGHT_UPGRADE {reasons}` is logged, the light result.json is blanked, and the same run continues into the plan →
freeze → implement path. The plan prompt gets `PLAN_RERUN_NOTE` (the branch holds commits), the `buildResumeDigest`
text with the light diff's files, and `upgradeNote(reasons)`. The branch is never reset, so committed work is kept.
Cost: a light lane with no trigger makes one builder call plus the review, with no plan session. An upgrade costs the
light session on top of the full lane. ADR `decisions/4442-light-lane.md`.

## Entry 2026-10-23 — Light-lane fixed overhead stripped (#4451)

`lean.mjs` decides light eligibility before the plan-context steps. A fresh, eligible lane in mode `on` (`lightTry`)
skips `hotspotsOf` (plan facts) and `contextPackStep` (no CONTEXT_PACK, no FORGE:CONTEXT). On `LIGHT_UPGRADE`, both run
before the plan call, so the full lane keeps them. When the light lane finishes without an upgrade, the run-wide `light`
flag also skips the implement-time structure delta, the gate's `hotspotsOf` (null hotspots), and the `structureOf` call
in the merge-time record. The STRUCTURE_DELTA merge record is still written from the local numstat. Light diffs are
capped by `light.mjs` (default 40 lines / 2 files), so neither the hotspot-growth gate nor an undeclared package edge
can reach them unnoticed (a risk path upgrades).
Light targeted tests run through `lightlane.mjs` `runLightTests` → `precheck.mjs` `runChecks`. They run concurrently up
to `verifyParallelism()`, with one heavy slot per running command and a per-command FORGE_HOST_PARALLELISM share. There
is no round budget, so a timeout stays a failure. `runLightStep` runs `reproOf`, `numstat` and `apiShape` concurrently.
Wall vs model time: `attempt()` sums each session's `duration_ms` into `model_ms`. The lane result and RUN_TERMINAL
carry `wall_ms` and `model_ms` (RUN_TERMINAL also has `light`), and the orchestrate batch row copies both. A warm
worktree pool reused across issues is deferred; deps are already warm via the shared cache (#4220). Cost: 0 LLM calls.

## Entry 2026-10-23 — FORGE:LITE receipt and the light/full split in the batch report (#4452)

After `LIGHT_DONE`, and again after `LIGHT_UPGRADE`, `runCore` posts a `FORGE:LITE` comment. The body comes from
`lightlane.mjs` `renderLiteReceipt({lr, eligibility, costUsd, contractHash})` (pure) and contains:
- the outcome: light or upgraded
- the diff stat (all files and non-test lines)
- the red/green repro, base → head
- the gates: the targeted test commands and their result, the API-shape result, and whether the contract was derived
- the cost, which is `usage.cost_usd`: the sum of the #4407 `cost_usd_delta`s, never a running session total
- the eligibility verdict, mode and reasons
- the upgrade reasons, when the lane upgraded

Posting is best effort and never changes the lane outcome. Shadow and full lanes post nothing. `runLightStep` now also
returns the receipt inputs: `diff`, `apiShape`, `testCommands` and `testRuns`. Its existing fields are unchanged.
`LIGHT_DONE` and `LIGHT_UPGRADE` now carry `cost_usd`.

In `bin/stats/efficiency.mjs`, `issueSlices` tags each slice with a `shape`: `light` (LIGHT_DONE), `upgraded`
(LIGHT_UPGRADE) or `full`. `efficiencyMetrics.lanes` counts every in-scope slice of every row, whatever its outcome, by
shape with its delta cost, plus `upgrade_rate` = upgraded ÷ (light + upgraded). `per_issue[].shape` is the last slice's
shape. `formatEfficiencyLines` appends a `lanes:` line, so the batch report and `forgedock stats --efficiency` print it.
Cost: no LLM calls; one extra issue comment per light lane.

## Entry 2026-10-23 — One lane per issue across batches; dispatch-time already-done check (#4481)

Two hosted batches that both include issue N (a resumed batch and a new one) no longer run two lanes for N.
- Per-issue lock in the host registry (`sched.mjs`): an entry with `exclusive: true` (set by `runBatch` through
  `sched.exclusive`; not stored) is refused by `tryAcquire` while a live slot of another batch holds the same non-null
  `repo` and `issue`: `{ok:false, conflict:<batch>}`, and the key leaves the queue so it holds no grant rank.
  `holder(entry)` answers the same for a lane placed remote. Without `exclusive` (or with no repo), nothing changes.
- `orchestrate.mjs` `grant()` returns `"busy"` on a conflict: the issue is retried after `pollMs`, one `deferred` row
  per other batch names it (`#N has a live lane in batch <id>`), no deferral count or breaker, and admission continues
  with the next ready issue.
- `dispatchCheck(n)` (injected; `engine-cli.mjs` `makeDispatchCheck`, gh only) runs before every lane start, requeues
  included, unlike the once-per-issue pre-filter: a merged `feat/issue-N-lean` PR ends the row `merged` (with the PR), a
  closed issue without one ends `invalid`, both with `skipped at dispatch: …` and no lane, so dependents still run.
  Fail-open: an error or an unreadable answer runs the lane.
- `--cancel <id>` (#4376) is unchanged; a test pins that a schedd restart resumes no batch cancelled through the daemon.

## Entry 2026-10-23 — Resume settles lanes that ended while no dispatcher ran (#4504)

- `orchestrate.mjs` resume starts every `adopt(n, rec, {onLive})` at once and races it against `onLive`. An adopt that
  resolves first with a result is settled (row in `results`, out of `running`, slot freed) before the scheduling loop; one
  that resolves with null or throws is requeued. A live lane (`onLive` fired) keeps `adoptSlot` and is awaited in the
  background, so it no longer holds up the others.
- Seams: `detachedLanes.adopt` (`batch.mjs`) calls `onLive` only for a live pid with no result file; `providerLanes.adopt`
  (`execution.mjs`) calls it for a still-running sandbox; the hybrid wrapper in `engine-cli.mjs` forwards `ctx`. A seam that
  never calls `onLive` is awaited as before. Return values for direct callers are unchanged.

## Entry 2026-10-23 — schedd logs every exit; clients re-attach after a daemon death (#4503)

A daemon vanished without a line in `schedd.log`, and its client exited, so the batch stalled until some other client
spawned a daemon. Now every exit writes a reason line. `exitOnSignals(d, {on, exit, log})` handles SIGTERM, SIGINT and
SIGHUP (128+signo) and `uncaughtException`/`unhandledRejection` (exit 1, stack on the next line): it logs
`schedd: exiting (<reason>)` before `close()`, and the process `exit` logs `schedd: exited (code N)`. The idle path keeps
`schedd: idle, exiting`. Every `lockCheckMs` (default `LOCK_CHECK_MS` 5 s) `startDaemon` checks that `schedd.lock` still
holds its pid and `schedd.sock` exists. If not, it logs `schedd: lost lock (owner …)` or `lost socket …, exiting` and
stops like `close()`, so its batches stay resumable (no report). On a lost lock it neither closes the server (libuv would
unlink the successor's socket path) nor removes the socket. Taking over a dead owner's lock logs
`schedd: took over the lock of dead pid N (it exited without a clean shutdown)`, so a SIGKILL or OOM kill leaves a trace.
An `attach` that arrives while a start-up resume of that batch is not yet hosted waits for it instead of hosting a second
copy.

The client (`orchestrateClient`): when the stream drops after the batch id is known, it prints
`schedd connection lost; reconnecting to batch <id>`, reconnects through `connectDaemon` (spawning a daemon unless
`spawnDaemon: null`) and sends `attach`, without reprinting replayed rows. It keeps retrying for `deps.reconnectMs`
(default 60 s) per loss and allows at most 10 losses, then throws the old `--resume <id>` hint.

Tests: `schedd.test.mjs` pins `FORGEDOCK_SCHED_DIR` to a tmp dir in the test process, so the env that clients submit for
their lanes never resolves `~/.forge/sched`. Stub lanes record their pid, exit once the work dir is gone or after 120 s,
and are SIGKILLed by `h.cleanup()` and by a process `exit` hook. Cost: 0 LLM calls.

#4518: an external kill of the builder CLI (`CLI_BACKEND_FAILED` with signal SIGTERM/SIGKILL or status 143/137, classified by
`bin/lean/hostkill.mjs`; `runCliBackendAsync` attaches `status` and `signal`) is handled like a timeout in `builder()`: checkpoint,
one fresh restart, then `deferred` with `cli.host_killed`, so it never reaches the batch breaker. The CLI ceiling already excludes
governor-paused time (`pausedTotal`, `bin/runner.mjs`). Cost: 0 LLM calls.

## Entry 2026-10-24 — Feat: parked-PR base sync (#4525)

`bin/lean/basesync.mjs` (`syncParked`, `unionResolve`) merges the moved base into the open PR of a `needs-human` row from `orchestrate()` (new `syncParked` seam, `syncEveryMs`). Clean or pure two-sided list-addition merges (files in `orchestration.base_sync.union_globs`; never sequence/`_journal.json`) are pushed plainly; other conflicts are aborted and their paths posted once per base sha. Opt out: `orchestration.base_sync.enabled: false`. The in-lane `baseSync()` in lean.mjs is untouched.
Cite: #4525.

## Entry 2026-10-24 — Light-lane review fixes (#4502)

A kept light lane now runs the same structure delta and hotspot precheck as the full lane (the undeclared package edge gets the one builder resume).
`runLightStep` rethrows typed builder errors (`isTypedBuilderError`: `laneCode`, `deferCode`, `CLI_*`, `spawnDeterministic`, usage limit), so the lane's own catch ends them (budget-exceeded, deferred, needs-human) with no second builder session; only internal errors stay `light_error`.
The derived contract's deliverables are the issue-named files (`predictedFiles`); a changed non-test file outside them upgrades with `scope_creep`. The light prompt no longer asks for `forgedock check` (no contract exists yet). `runLightTests` forwards `timeoutMs` (`precheckTimeoutSeconds`) to `io.runCommand`. `RUN_TERMINAL.light` is summarised as `contextPack.light` and `contextPackAb` skips light runs.

## Entry 2026-10-24 — Host-only capabilities in placement (#4542)

`placeLane` takes `needs` (host-only capabilities: `sops`, `prod_monitor`, `ops_credentials`, or names declared in `execution.host_capabilities`) and `relays` (what the provider relays: a remote/pool provider relays the capabilities of `execution.relay_commands`, #4778; otherwise none). A lane needing something not relayed is placed `local` with reason `host capability: <names>` in both `remote` and `hybrid` modes; lanes with no needs are unchanged. `detectNeeds(text, exec)` is zero-LLM: built-in text signals plus declared names and `host_capability_patterns` (`name:regex`, flat key). `engine-cli` fills a per-issue `needsOf` map in `readBody`, and `remote.place` now exists in remote mode too.
If a remote lane still blocks on credentials and its summary names only a declared host capability (`hostCapabilityBlock`), `endBlocked` in lean.mjs ends it `env.capability_remote` (recoverable, `RECOVER_HOW`); `orchestrate` `placeOf` relaunches it local once. A mixed or unknown need stays `builder.blocked`. `BLOCK_RULES` tells a remote builder to name the missing capability.
Cite: #4542.

## Entry 2026-10-24 — Feat: requeue a terminal issue in a running batch (#4550)

`forgedock orchestrate --requeue <id> N... [--reason]` appends `{issue, reason, by, at}` to the batch's `requeue` file (`batch.requeue`, `readRequeued`, `unrunRequeues` in batch.mjs). It refuses issues not in the batch or not terminal; the CLI also refuses closed and `needs-human`-labelled issues before writing.
`orchestrate()` takes a `getRequeued` seam: each pass `drainRequeues` applies each entry once (keys in state `requeueApplied`), moves the issue and the `skipped` dependents behind it back to pending (prior rows kept in state `requeued`, DAG edges kept), posts a runner `FORGE:DECISION`, and the report row is the latest outcome with a `requeued: #N (reason)` line. The lane starts through the normal K/lease path.
schedd `op:"requeue"` mirrors `add` and reopens a finished batch (clears its report, hosts it). `--add` is unchanged.
Cite: #4550.

## Entry 2026-10-24 — `pool` execution provider (#4546)

`execution.provider: pool` (`execution.mjs` `providerByName`) is `remoteProvider` (`name: "pool"`) with the endpoint and token defaulted from the local router config (`poolRouterConfig`: `COMPUTESHARE_CONFIG` or `~/.config/computeshare/router.json`, token from `forgedock_token_file` or the sibling `forgedock.token`); an explicit `endpoint`/`token_env` wins, and no router config plus no endpoint is `execution.provider.misconfigured`. The token is only sent as the Authorization header and kept in the redaction set.
#5131: `pool`, `remote`, `remoteTransportFor` (so `gc`) and `preflight.pool_auth` share one resolver, `poolCredential(exec, { env, router, keychain })` -> `{token, source}`: `token_env` from the env then the keychain; then `execution.token_file` (trimmed, `~/` expands; any endpoint); then the router's `forgedock_token_file`, always for `pool` and for `remote` only when its endpoint is unset or equals the local router's (scheme, host and port compared; path and trailing slash ignored). The local pool token is never sent to another endpoint. `source` names the env var, `token_file` or `forgedock_token_file`, never the value. A file-read token is registered under `FORGEDOCK_POOL_TOKEN` (`pool`) or `FORGEDOCK_REMOTE_TOKEN` (`remote`) so `remoteProvider` redacts it. `providerByName`/`remoteTransportFor` take an optional `fetchFn` (test seam, forwarded to `httpTransport`; `runBatch` `deps.sandboxFetch`).
The dispatcher reads `<cwd>/forge.yaml` (absent is fine) and passes it as `settings.forgeYaml`; `remoteProvider` adds `env.CS_FORGE_YAML_B64` to the launch spec, so the router's `repos` map is optional (it still takes precedence). Placement is unchanged.

## Entry 2026-10-24 — Opt-in local fallback when no pool agent is online (#4547)

`execution.fallback_local: true` (`parseExecution` -> `fallbackLocal`) lets `orchestrate()` grant run a remote-placed lane on the host (`fallback to local: no pool agent online`) while `remote.capacity()` reports `online === 0`; `engine-cli.mjs` samples `online` next to `free` and wires the detached local lanes. Unknown liveness (null, failing `/status`) never triggers it, so the first grant before the first sample still goes remote; default off keeps the uncapped `sandbox.capacity` deferral.
`httpTransport.capacity()` returns `{free?, online?, total?}` (null when none is valid); the pool router's `GET /status` answers `{online, total, agents:[{name, ok, paused}]}` (online = reachable and not paused) and deliberately has no `free`, so the #4540 cap stays off for the pool.

## Entry 2026-10-24 — Per-agent remote lane minutes (#4549)

The router's `GET /sandboxes/:id/usage` forward adds `agent` (the placing agent) to the agent's `{minutes}` body; the field is optional for third-party runners. `httpTransport.usage` returns `{minutes, agent?}`, `remoteProvider` keeps `h.agent`, and `providerLanes` `withUsage` copies it to `sandbox.agent` (omitted when unknown). `orchestrate` accumulates `sandbox.by_agent {name: minutes}` per issue across attempts onto the row, and `formatSandboxSummary` appends `; by agent: a X min, b Y min` only when it exists; the table and non-pool output are unchanged. `forgedock stats --pool` (`bin/stats/pool.mjs`) aggregates `by_agent` from local batch `report.json` rows (latest row per issue); see `docs/STATS.md`.

## Entry 2026-10-25 — In-run base-merge resolution of sibling-lane conflicts (#4588)

`conflictres.mjs` `resolveBaseConflicts` (seam `io.conflictResolve`, config `readBaseMerge` = forge.yaml `lean.base_merge_{union_globs,json_globs,generated_globs,generated_command}`) runs in `lean.mjs` `baseSync` before `sequenceResolve`: union of pure line additions (`basesync.mjs` `unionResolve`), a 3-way JSON key union, and base-side-then-regenerate for generated files. It resolves only files it can fully settle, never sequence files; leftovers go to `sequenceResolve`, then the builder.
When it settles every conflict, `baseSync` commits the merge and counts it as deterministic (`detResolved`: no builder, no re-review). No config means today's flow. Migrations stay on `sequence.mjs` (#4386, #4526).

## Entry 2026-10-25 — Tool state never rides a lane branch (#4590)

`toolstate.mjs` holds the deny-list (`.forge-lean/`, `.eslintcache`, `*.tsbuildinfo`, and `next-env.d.ts` when the repo's `.gitignore` ignores it). `gitPush` (`lean.mjs`) first runs `untrackToolState`: files the branch ADDED against the merge base are `git rm --cached` and committed (`TOOLSTATE_UNTRACKED`); files the base tracks are never touched. `checkpoint` unstages deny-listed paths after `add -A`. Salvage still force-adds `.forge-lean` to its private ref. `forgedock init` appends the missing deny-list lines to `.gitignore`.

## Entry 2026-10-25 — Skipped dependents re-admitted when the blocker merges mid-batch (#4595)

`orchestrate()` `watchBlockers` re-checks the blocker (`dependency #B ...` in a `skipped` row's detail) through the injected `dispatchCheck` at most every `WATCH_EVERY_MS` (60 s) while lanes run, and once before the batch would end; fail-open.
A merged or closed blocker is recorded as `merged`/`invalid` (in-batch rows only) and its skipped dependents, transitively, go back to `pending` with one FORGE:DECISION. Skip resolution now runs to a fixpoint, so a chain's tail is skipped on its blocker instead of as `dependency cycle`.

## Entry 2026-10-25 — English copies in locale catalogs (#4596)

Lanes added new keys to non-English catalogs as English copies; the repo's `i18n:check` caught them only on CI. `i18n.mjs` `englishCopies` (via `io.englishCopies`) lists, for each changed non-en JSON catalog whose `en` counterpart exists (locale segment, directory or file stem, replaced by `en`), the added keys whose string value equals the en value (values without three letters once placeholders are removed are ignored). `i18nGate` in `lean.mjs` runs at hand-off and after each base-sync merge, like `duplicateGate`: one `fixRound("i18n")` with `i18nCopiesPrompt`, a leftover is an anomaly; run log `I18N_ENGLISH_COPIES`. The implement prompt also tells the builder to translate every new key and to insert status entries as a minimal diff. The `verify.invariants` idea is not implemented; a repo lists its `i18n:check` in `precheck.commands`. The implement-prompt budget test allows 1550 tokens for the added i18n rule.

## Entry 2026-10-25 — A check timeout is infrastructure (#4589)

A command killed by its own timeout (rc 124, `timeoutMs >= perCommandMs`) is retried once by `precheck.mjs` `runWithTimeoutRetry` with `retryTimeoutMs({perMs, load1, cores})` = `perMs * max(2, ceil(load1 / cores))`, at most 3600 s and never below `perMs` (load from `os.loadavg()`, injectable as `runChecks` `load`). The retry is capped by the remaining round budget; a budget-cut timeout, or a retry the budget cuts short, is still deferred to CI. A repeated timeout keeps rc 124 and appends `infra timeout: host load, not a code failure`. Other rcs are never retried; the `runChecks` result shape is unchanged. `lean.mjs` uses the same helper in the post-merge gate and `rerunFailedValidatesRaw`. `prompts.mjs` `BLOCK_RULES` tells the builder a timeout is host load, never a block or `human` product decision: run the narrowest targeted command and say the full one could not finish.

## Entry 2026-10-26 — Versioned outbound lifecycle events (#4630)

`lean.mjs` now also forwards `RUN_START`, `CONTRACT_FROZEN` (both sites) and `PR_OPENED` through `emit()` (they were run-log only); `telemetry-seam.mjs` ignores them. `engine-cli.mjs` composes `makeEventEmitter` (`bin/engine/events.mjs`, forge.yaml `events:`) after the telemetry seam, and passes `onResult` to `sweepProbes` (`probe.mjs`, called for every non-dry-run row) so a probe pass or fail emits `probe.passed` / `probe.failed`. Envelope, types and signature: `docs/EVENTS.md`; pinned by `bin/engine/events.test.mjs`. `regression.detected` (monitor fail row with a regression issue, via `probeEventSink`) and `experiment.verdict` (`stats --experiment --emit-event`, met or missed only) are emitted (#4632); `release.promoted` is emitted by the probe sweep for each recorded probe pass/fail (`probeSweepEvents`; `probeIssue` rows carry `defaultBranch`; once per fix, probe-declaring issues only).

## Entry 2026-10-26 — Live A/B experiment arms (#4629)

forge.yaml `experiment:` (id, arms, ratio, metrics, targets, min_n; parsed by `bin/experiment.mjs`) makes `lean.mjs` assign each issue an arm once per run (`assignArm`: sha1 of id and issue over the ratio, so resumes keep the arm) and tag `experiment` and `arm` on every `PHASE_ATTEMPT_USAGE` and on `RUN_TERMINAL` (`expTag`). No declaration means no tags. `forgedock stats --experiment <id>` (`bin/stats/experiment.mjs`) reports arms against targets, null below min n. `bench-lightlane.mjs aggregate` and `eval-gate-scorecard.mjs` add a `record` key in the shared `forge.bench.v1` shape (`benchRecord`); their other output is unchanged.

## Entry 2026-10-26 — ciVerify untracks tool state before sampling HEAD (#4621)

`lean.mjs` `ciVerify` calls `untrackToolState` before `rev-parse HEAD`. `gitPush` runs it first too, so in verify.mode ci/hybrid the untrack commit used to move HEAD after `head` was read: `commitChecks(head)` and `sameSha(run.headSha, head)` targeted an unpushed sha, CI timed out as `unavailable` and `ciFellBack` skipped CI for the lane. Now `head` is the tip `gitPush` publishes; `untrackToolState` is idempotent, so the push adds no second commit, and `verify.mjs` `runCiVerify` is unchanged. Pinned by the `untrack commit before CI verify` test.

## Entry 2026-10-26 — `--cancel --stop-remote` stops sandbox lanes at their checkpoint (#4612)

`forgedock orchestrate --cancel <id> --stop-remote` also asks remote lanes to stop. The flag travels in the batch `cancel`
file as `stopRemote: true` (through the schedd `cancel` op or `requestCancel`); the file stays the authority. With it,
`orchestrate.mjs` `stop` no longer skips `rec.remote` lanes (still once per lane), and engine-cli routes remote records to
`providerLanes.stopLane` -> `remoteProvider.stop(handle)` -> `transport.stop(id)`. The pool contract is an optional
`POST /sandboxes/:id/stop`: the pool SIGTERMs the lane so its #4179 teardown checkpoints and it reports `deferred
run.interrupted`; 2xx = sent, 404/405 = unsupported or gone (false). Stop never falls back to `DELETE`: destroying a
sandbox is not a checkpoint and would lose work; teardown still destroys only after the result. Without the flag, or on a
pool with no stop endpoint, behaviour is as before (remote lanes run to their result). Cost: 0 LLM calls.

## Entry 2026-10-27 — Bot token refresh and gh.auth (#4662)

`scripts/systemd/forgedock-bot-token-refresh.{service,timer}` run `scripts/refresh-bot-token.sh` every 45 min (`Persistent=true`); the script writes `~/.forge/bot-token.json` (`FORGE_HOME_DIR` overrides the dir), which `bin/bot-token-status.mjs` turns into the doctor Check 12 lifetime report (fails under 10 min left or over 50 min since refresh; no stamp stays a warning). In `bin/lean/retry.mjs`, `refreshAuthOnce` wraps `ghc` and the lane-resolution gh calls: on HTTP 401 (`GH_AUTH_RE`) it runs the refresh script once per run (`io.refreshAuth` or `FORGE_REFRESH_TOKEN_SCRIPT`), retries once, then throws with `deferCode: "gh.auth"`. The lane ends `deferred` (`retryInSeconds` 120) and the batch requeues it like `gh.unavailable`. `scripts/wait-ci-green.sh` retries a 401 a bounded number of times and then fails with an auth message; 403 still fails fast.

## Entry 2026-10-27 — external prerequisites are preview/deploy gates (#4660)

`scripts/readiness.mjs` (pure module + CLI) reads `needs-human:external` issues, parses `gates:` (`preview|staging-deploy|prod-deploy|feature-flag:<name>`) and `owner:` from the body, and reports per gate the open prerequisites (owner, age) and open code milestones; malformed gates are ignored. `--digest` orders unblocked human actions by `Depends on #N` (topological, cycle-safe). `deployable(target)` is false while the mapped gate (preview, staging, prod) has open prerequisites; a `feature-flag` gate stays red but never blocks merge. `bootstrap-validate.mjs` treats `needs-human:external` as needs-human and rejects a missing/invalid `gates:` with `missing-gates`; `bootstrap-create.mjs` applies the label. Merge and lane code unchanged. Cost: 0 LLM calls.

## Entry 2026-10-27 — Deferred follow-ups: one issue per class, milestone, TSV validation (#4664)

`scripts/file-deferred-followups.sh` groups items by class (`engineering|post-deploy|external|ops`; TSV column 4, else the
why's `post-deploy:|external:|ops:` prefix, else engineering; `followupItems` sets it from the requirement's optional `class`)
and files one follow-up per class per parent: label `followup:<class>`, a `FORGE:DEFERRED_CLASS` marker next to the unchanged
`FORGE:DEFERRED_FROM` marker (absent = engineering, so older issues and claims still match), a `class=` suffix on the claim
marker, and the parent's milestone (`FORGE_FOLLOWUP_MILESTONE` from `lean.mjs`, else read from the parent). A closed milestone
resolves to the next open one by due date, else forge.yaml `followups.default_milestone` (`readFollowupsDefaultMilestone`,
`o.followupsDefaultMilestone`). TSV column 1 is a path or `-`; the engine sends `-` and puts the requirement text in column 5
(the item's identity in the checklist and the stdout rows). Requirement text or an `R<n>:` prefix in column 1 exits 2
(`DEFERRED_TSV=INVALID`) before any gh call. Lookups for all classes run before anything is filed.

#4994: a parent that is itself an open follow-up (`FORGE:DEFERRED_FROM` in its body) is the issue the lane closes, so its deferred items go to a NEW follow-up carrying `**Parent**: #<parent>`, never into the parent's own body. #4984: `amend-requirement` with text on a `defer`/`post-deploy` requirement makes it `deliver` (bucket, why, check, tracked cleared) so nothing is filed; `followupMap` matches keys with backticks stripped, as the script echoes them.
## Entry 2026-10-27 — settle scope freeze and deploy-last warning (#4665)

`scripts/settle-scope.mjs` (pure module, no I/O) freezes the milestone's issue set when settle begins (`freezeScope`). `classifyNew` sorts later issues: a child of a frozen decomposed issue is a `decomposition-child` and stays in the milestone; a `FORGE:DEFERRED_FROM` issue is a `deferred-followup` routed to the next milestone or backlog (`file-deferred-followups.sh` already files without a milestone); anything else is `review-finding` or `other` (growth only). `convergence` measures the frozen set plus decomposition children (transitively); `formatStopReport` states the growth and per-source issue numbers. `commands/orchestrate.md` §3b specifies it; no settle loop exists in the repo. `bootstrap-validate.mjs` adds a `warnings` array (`ok` and exit code 0 unchanged) with `deploy-last`: warned once when deploy-class issues (deploy workflow, staging environment) sit only in the last of >= 3 milestones; `formatWarnings` is exported and main() prints `warning:` lines to stderr. `commands/bootstrap.md` asks for dependency-layer milestones and a deployable slice in milestone 1 or 2. Cost: 0 LLM calls.

## Entry 2026-10-27 — Anchored decisions with supersession (#4695)

`bin/lean/decisions.mjs` (pure apart from the index file) holds the decision record `{id, choice, why, anchors, symbols?, supersedes?, status, superseded_by?, issue}`. It is posted as `<!-- FORGE:DECISION {json} -->` (JSON on the marker line; the older prose FORGE:DECISION comments have none and are ignored), and indexed at `~/.forge/decisions/<repo>.json` (`FORGEDOCK_DECISIONS_DIR` overrides). At contract freeze (`lean.mjs`) `withDecisionRows` appends `{id:"H<n>", what, source:"decision", decision}` preserve rows for active decisions whose anchor covers a deliverable path: most specific anchor, then newest issue, at most 5 (`HISTORY_ROWS_MAX`, shared with guards #4694); one index read, nothing when none match, so the contract is unchanged. The reviewer marks them like any preserve row; a violation fails conformance (`conformance.preserve_violated`). The amendment `{kind:"decision", decision:{choice, anchors, symbols?, supersedes?}, why}` (`applyAmendments`) needs every anchor to match a base file (one `git ls-tree` only when such an amendment exists); with `supersedes` it drops that row and `recordDecisions` posts the new record plus the old one marked `superseded` (`superseded_by`) on its own issue; the latest record per id wins. `forgedock decisions list [--stale] [--refresh]` (`decisionsFromCli`) lists active decisions; `--stale` lists those with an anchor missing on the base; `--refresh` rebuilds the index from GitHub.

## Entry 2026-10-27 — Decision records persist after the merge (#4737)

`amend()` in `lean.mjs` no longer calls `recordDecisions` at gate time; it keeps the latest `a.decisions` and the lane records them (FORGE:DECISION, supersession of the old record, local index) right after `label("merged")`, beside the guard supersession. A rejected, needs-human or abandoned lane therefore leaves the decision index and the old decision untouched. A failed post is an anomaly, never a lane failure. Cost: 0 LLM calls.

## Entry 2026-10-27 — Default lane scope caps and env.lane_limit (#4690)

Every local lane's builder CLI now runs in a `systemd-run --user --scope --unit=forgedock-lane-*` scope by default (`effects.mjs` `wrapLaneLimits`): `TasksMax` 1024 (`engine.lane_limits.tasks_max`, `0`/`off` disables) and a `MemoryMax` of `(MemTotal - reserve) / K` (`engine-cli.mjs` `defaultLaneMemory`; K reaches lanes as `FORGEDOCK_LANE_PARALLEL`). forge.yaml `memory_max`/`cpu_quota` still win. `runner.mjs` samples the scope's `pids.events` (`max`) and `memory.events` (`oom_kill`) while the child runs and throws `CLI_LANE_LIMIT`; `lean.mjs` checkpoints and ends `needs-human` `env.lane_limit` (never engine-error, so the breaker ignores it; `hostkill.mjs` no longer reads it as a host kill). Without scopes, orchestrate logs one "lanes are uncapped" line.

## Entry 2026-10-27 — Engine-authored history preserve rows (#4694)

At contract freeze (full and light lanes) `lean.mjs` calls `withHistoryRows` (`guards.mjs`), which reads the local guards index (`readIndex`, no GitHub call) and appends `{id:"H<n>", what:"<why> (#X, PR #Y)", source:"guard"}` rows to `preserve` before `contractHash`. `historyPreserve` is pure and deterministic: skips the lane's own issue; score 3 = a guarded hunk file is a deliverable, 2 = a guarding test file is, 1 = either sits under a deliverable's directory; ties go to the newest issue (issue number, not merge time); capped at 5; earlier H guard rows are dropped first. No index or no match returns the same contract object, so hashes of unguarded lanes are unchanged. `guardAfterMerge` merges a freshly posted guard into an existing local index. The trajectory's Decision sources line lists the H rows (`recordStructure`); the split-lane contract gets none. Decision-sourced rows wait for #4695. Cost: 0 LLM calls, one file read.

## Compounding metrics (#4696)

`forgedock stats --compounding` (`bin/stats/compounding.mjs`) measures reintroduction (guarded fix reopened, or blamed by a later
guarded fix within 90 days), reopen-after-close, guard activity and decision churn by rolling window, release and lane-age bucket.
It reads FORGE:GUARD comments (`bin/lean/guards.mjs` `collectGuards`, read only), `reopened` issue events, git, and these
FORGE:TELEMETRY gate events, which #4693/#4695 must emit under exactly these names: `guard_run`, `guard_broken`,
`supersedes_accepted`, `decision_superseded`, `decision_violation` (an unrecorded kind prints n/a). Stats-time only: no lane-path
cost, no LLM. Usage and definitions: `docs/STATS.md`.

## Entry 2026-10-27 — Batch env pin keeps provider selectors and names what it drops (#4734)

`schedd.mjs` `ENV_KEEP` now also keeps the non-secret provider/endpoint/model selectors `CLAUDE_CODE_USE_*`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`. Secrets (`SECRET_ENV`) still never reach `plan.json`. New
`droppedEnv(env, kept)` returns the names (never values) of `CLAUDE_*`/`ANTHROPIC_*`/`GH_*`/`GITHUB_*`/`FORGEDOCK_*` keys not pinned, minus
session-scoped ones; `engine-cli.mjs` submit logs one line with them and a pointer to `orchestration.env_passthrough`. Release note: a
per-shell `GH_TOKEN`/`FORGEDOCK_POOL_TOKEN` is still not pinned, so lanes use the daemon's copy unless named in `env_passthrough`.

## Entry 2026-10-27 — Pinned batch env is allowlisted and PATH-sanitised (#4691)

`schedd.mjs` `batchEnv` no longer pins the launching session's whole env into `plan.json`. It keeps `PATH`, `HOME`, `USER`, `SHELL`,
`LANG`/`LC_*`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `FORGEDOCK_*`, `GH_*`/`GITHUB_*`, plus names from forge.yaml `orchestration.env_passthrough`
and `execution.token_env` (comma-separated, read by `engine-cli.mjs` `readPinnedEnvConfig`). Session-scoped `CLAUDE_CODE_*`, `CLAUDE_PID`,
`ANTHROPIC_*` and secret-looking names (`SECRET_ENV`) are dropped unless named; secrets resolve at lane start. `sanitizePath` drops
non-existent dirs, per-session temp `arg0`/`claude*` dirs under a temp root, and `orchestration.path_exclude` globs. `redactEnv` masks secrets.
`forgedock orchestrate --show-env <id>` prints the pinned env redacted; `--set-env <id> KEY=VAL` / `--unset-env <id> KEY` edit `plan.json`
(`envBatch`), and `runBatch`'s `laneSpawn` re-reads `plan.env` for each newly launched lane (running lanes keep theirs). Pre-#4192 batches
with no `plan.env` still use the daemon env. Config: `docs/CONFIG.md`.

## Guard gate (#4693)

`bin/lean/guardgate.mjs`, called from `gate()` in `bin/lean/lean.mjs` beside the validate rerun. Deterministic, no LLM call.
It loads the guards (#4692) from the local index (`~/.forge/guards/<repo>.json`, rebuilt from FORGE:GUARD comments when absent or
older than 6 h). A guard is selected when the lane's diff changes lines whose `git blame` at the merge base names the guard's
merge commit (or a later commit; line drift tolerance 10), or when the lane edits or deletes one of its test files. A lane touching
no guarded file does no git work. Each selected test file is exported from the merge base to a sibling path
`<name>__guardbase.<ext>` (so relative imports resolve against the lane's tree), run with the contract's own validate command with
that path substituted (else `node --test` / `python -m pytest -q`), then removed. At most `FORGE_HOST_PARALLELISM` (default 2) run at
once under one 120 s cap; a timeout, missing base copy or unknown runner is a trajectory note, never a block.

Baseline compare (#4968): a test that fails on the lane tree is rerun at its own path in one lazily made detached worktree of the merge base
(`os.tmpdir()/guardbase-*`, `node_modules` symlinked, removed in `finally`; passing guards add no git or run) under the remaining cap.
Failing test names (`failingNames`: TAP/node:test `not ok`, spec `✖`, pytest `FAILED`) are compared per name, so only names that pass on base block. A base that
fails the same tests (or names none) records `guard #N <test>: fails on base`; a base that cannot run records `baseline unavailable (...)`; both are skips, not blocks.

A failing base test is `conformance.guard_broken` (guard issue, its why, test, the new failing test names, output tail), a precheck failure: enforce resumes the
builder once; shadow records it in `CONFORMANCE_SHADOW` `would` (it is not in `SHADOW_PRE_BLOCKS`), which is the would-block count.
The only override is `{"kind":"supersedes","guard":"#X","why":"..."}` in result.json amendments (`applyAmendments` records
`contract.supersedes`; the reviewer sees it on the effective contract). After the lane merges with the amendment, the engine
comments on #X and logs `supersedes_accepted`. Events: `guard_run` (with `wall_ms`), `guard_broken`, `supersedes_accepted`.
`normalizeAmendment` maps the near-synonyms `supersede-guard`, `supersede` and `supersedes-guard` to `supersedes` (#4916), and the `applyAmendments` rows pre-pass expands a `supersedes` amendment carrying `guards: [...]` into one `{guard, why}` row per id (same `why`; a single `guard` is kept too). Each row still hits the `GUARD_ID_RE` check and the reviewer still judges it; other unknown kinds keep the valid-kinds error.
#4856: `normalizeAmendment` compares kinds case-insensitively with `_` as `-` (`Scope_Deferral`), and `AMEND_SLIPS` also maps `deferred`, `deferral` and `scope-deferral` to `defer`. Only recognised kinds are rewritten, so `scope-note` and any other unlisted kind keep their spelling in the unknown-kind error (it lists `AMEND_KINDS`).

## Entry 2026-10-27 — AlterLab engine gaps (#4685)
- A remote lane's `credentials` block naming a missing tool/module (`missingToolBlock`, lean.mjs) ends `env.tool_missing` (recoverable), not `builder.blocked`.
- `scripts/hotspots.sh` always excludes lockfiles (basename match at any depth) on top of `exclude_globs`.
- `scripts/hotspots.sh` reads its config from `--config`, then `$FORGE_CONFIG`, then `./forge.yaml` (#5163); the lane passes the main checkout's `forge.yaml` because it is usually gitignored and absent from the worktree. Output `config_source: null` means defaults were used and the lane records a `hotspot_config_missing` anomaly.
- Pool provider: a `token_env` credential that resolves empty falls back to `execution.token_file`, then the router token file (#5131: `remote` too, but only on an endpoint match); HTTP 401/403 at sandbox start defers `sandbox.auth` (300s), never needs-human.
- Breaker: `orchestrate --clear-breaker <id>` clears it; a breaker tripped only by transport errors (`tripped.transport`) auto-closes after 5 min and is cleared on a daemon-restart resume. Submit-time env replay was already delivered by #4691.

## Entry 2026-10-27 — Validate results across a merge-time CI fix round (#4708)

`mergeFixRound` reviewed the fix head before it was CI-verified, and the fix session could rewrite `result.json` without the
earlier `validation` rows, so the review failed `conformance.unimplemented: ... has no recorded result` on a green lane. Now the
rows recorded before the round are carried forward (marked `carried: true`, written back to `result.json` because `gate()` re-reads
it), the fix head goes through `ciVerify("merge")` under remote verify before `doReview` (as the base-sync retry, #4527), and a
validate id still unrecorded is `engine.validate_result_lost`, not a conformance failure.

## Entry 2026-10-27 — Due-date gate, parked sweep and owner asks for post-deploy follow-ups (#4689)

A post-deploy item may carry `due:YYYY-MM-DD`: `postDeployGate` (`prefilter.mjs`) parks it `awaiting-due` (labels
`awaiting-due` and `due:<date>`, UTC midnight, after the promotion check and before `min_age`). A `decision:` item
(`postDeployOnly` accepts it) parks `owner-ask` with one `FORGE:OWNER_ASK` comment and no lane. `parked-sweep.mjs`
(`sweepParked`) runs from the schedd timer next to `sweepDue` and from `forgedock probe --due`: it re-runs the gate with
`prefilterIssue({gateOnly})` (no model call, no already-fixed path) for the `awaiting-promotion|awaiting-due|
awaiting-measurement` issues, so a promoted parent or a passed date releases the wait labels within one pass.
`measureFollowup` ticks the post-deploy items on a pass, files one `followup:engineering` issue per failing check and posts
the typed owner ask for an item with no runnable check. The batch report adds `due date:` and `owner ask:` lines.

## Entry 2026-10-27 — Post-deploy fail reopens the parent before it records (#4652)

`measureFollowup` (`postdeploy-check.mjs`) used to post the `FORGE:PROBE` fail record and then reopen the parent; a failed reopen
was swallowed and every later pass returned `recorded-fail`, so the parent stayed closed. Now the parent is reopened first; if that
throws, no record is posted and the next pass re-runs the checks and retries. The early `monitoring` return on an existing windowed
pass record also re-applies the idempotent `post-deploy-monitoring` label, so a label that failed on the first pass is retried
(`sweepDue` selects by it).

## Entry 2026-10-27 — Dependency-skipped issues wait and re-queue in the same batch (#4687)

A dependency skip (`dependency #X ended <outcome>`) keeps outcome `skipped` but carries a display-only `waiting` flag while
`dispatchCheck` can still re-admit it (cleared when the batch ends, so the report ends `skipped` only if X never resolved). The
table and console show `waiting on #X`. The #4595 blocker re-check re-admits the dependent when X merges or closes; each skip,
re-admit and requeue row carries `trigger:<issue>` in the `decide` log. `makeDispatchCheck` returns `final: true` for an issue
closed as NOT_PLANNED without `workflow:merged` / a fully closed decomposition (#5152): `watchBlockers` stops re-checking it and its dependents stay `skipped`. `batch.addIssues` now re-queues an
in-batch issue whose result is `skipped` through the `--requeue` file (returned as `requeued`); merged/needs-human/other rows still
report `already in batch`. The schedd `add` op reopens a finished, unhosted batch like `requeue`; without a daemon `addToBatch`
clears the report so the next `--resume` reruns it. Cost: 0 LLM calls; one extra `dispatchCheck` per blocker per watch interval.

Guard gate added wall time (#4705, R12): `guardGate` runs beside `rerunFailedValidatesRaw` in one `Promise.all`, so the gate's raw `wall_ms` overstates the lane delay. `lean.mjs` times both; `added_wall_ms = max(0, total - validate rerun time)` rides on the `guard_run` event (0 when the gate errors or skips), and the sum over gate passes that selected a guard is carried as `guard_added_ms` on `RUN_TERMINAL` (omitted when 0; `telemetry-seam.mjs` passes it through on `run_terminal` beside `wall_ms`). Telemetry only, no verdict change. The enforce rule (median added wall < 5% of lane wall) is judged post-deploy from shadow telemetry.

## Entry 2026-10-27 — Joined amendment refs split; missing host module is env.repro_unrunnable (#4655)
`applyAmendments` expands a `requirement` like `R2/R3`, `R2, R3`, `R2 and R3` or `R2–R3` (range, capped at 50) into one row per id with the same kind/why/text/check before lookup; an unknown id in the list is still a problem for the correction round. `scope-note` is not a kind: the amendment prompt says so and asks for one id per row. In `scripts/acceptance-red-green.sh`, a head run that failed only on a missing host module or command (`No module named X` with X not tracked by the repo, `foo: command not found`) is `UNRUNNABLE`, so `reproFailures` yields `env.repro_unrunnable` instead of `conformance.unimplemented`; a real failing test stays `FAILED`.

## Entry 2026-10-27 — [type:e2e] requirements need a real e2e validate (#4726)
`decide()` in `conformance.mjs` fails an `implemented` `deliver` row whose requirement quote carries `[type:e2e]` with `conformance.e2e_unverified` unless its `validated_by` V-ref resolves to a contract validate command that is a real e2e check (`isE2eCommand`: an entry of `verify.e2e_checks`, an `e2e_paths` spec file, or playwright/cypress/e2e/live-stack/wdio). `lean.mjs` passes `ctx.e2e` (`{checks, isSpec}` from the parsed verify config); `decide()` without it still works and falls back to the keyword test. Other tags, `not-applicable` and out-of-band rows are untouched. The plan/implement prompts and `REVIEW_RUBRIC` carry one line saying so (post-deploy with a follow-up otherwise). `commands/work-on/investigate.md` step 7.5 also fires for wrong/non-existent route, URL or link findings: grep the file and template siblings for every constructed URL and check each against the route table. #5339: `[type:manual]` is judged like `[type:e2e]`; a validate that names a test file carrying fake markers (`e2e.mjs` `fakedPaths`: mocks, fakes, stubs) is not real unless it is in `verify.e2e_checks`; a `defer`red e2e/manual row also fails. These failures carry `kind: e2e_row`, enforced by default (`DEFAULT_ENFORCED_KINDS`; an `engine.conformance_kinds` entry for the code still overrides). A `post-deploy` e2e/manual row is *transferred*: `closePlan` returns `partial` with `transferred`, the lane posts a `FORGE:TRANSFERRED` comment on the milestone's epic (`acceptance.mjs` `transferToEpic`), and `acceptance gate --stage close` blocks until a post-deploy journey named `#<issue> <req>` passes; `liveDeferralBlocks` also counts it. `RUN_TERMINAL` carries `verified` (merged with nothing transferred/unverified); `forgedock stats` shows merged vs verified per repo and milestone.

## Entry 2026-10-27 — Deferred rows are bucketed; post-deploy items roll up per lane (#4724)
Every defer/post-deploy contract row needs one `bucket` (`post-deploy|verify-now|date:YYYY-MM-DD|owner:<action>|new-issue`, `BUCKETS`/`bucketProblems` in `conformance.mjs`); an amendment without one defaults to `post-deploy`. `followupClass` routes owner -> external, new-issue -> engineering, the rest -> post-deploy; `followupItems` tags the why with `[bucket:<kind>]` and, for dates, `due:`/`from:` (contract-time anchor). `scripts/file-deferred-followups.sh` appends post-deploy items to ONE rollup per release lane (`FORGE:POSTDEPLOY_ROLLUP`, `FORGE_RELEASE_LANE`) under `### #<root parent>`, dedups normalized text across parents, resolves DEFERRED_FROM chains to the root, never puts owner items in it, and reports per-bucket counts in DEFERRED_TELEMETRY. `postDeployGate` reads every `DEFERRED_FROM` parent (`deferredFromAll`) and re-anchors `due:` by (landed - `from:`). Single-parent follow-ups behave as before. #5207: engineering and `new-issue` rows are not deferrable: `inLaneDeferral` (`conformance.mjs`) makes `decide()` emit `conformance.unjustified_deferral` whatever `deferral_ok` says (one failure per row), `pendingTracking` never files them, and `SHADOW_BLOCKS` (`lean.mjs`) includes the code so the one builder resume delivers them in shadow mode too. `bucketProblems` still accepts `new-issue` so frozen contracts parse.

## Entry 2026-10-27 — needs-human premises, owner-ask registry, per-class recovery budget (#4725)
- **Class budget**: `recoveryClassOf` (`bin/engine/outcome-codes.mjs`) puts `base.conflict`, `env.tool_missing`, `env.repro_unrunnable`, `env.capability_remote` (and a conflicting `ci-pending`) in `mechanical`; everything else is `conformance`. `orchestrate` counts recovery lanes per `${issue}:${class}` (`recoveryClasses` in batch state); mechanical rows get `recovery.mechanicalMaxAttempts` (`orchestration.recovery.mechanical_max_attempts`, default 2, never below `max_attempts`; `max_attempts: 0` still turns recovery off). A mechanical row with an open PR is requeued as a recovery lane, not parked, while its class budget remains.
- **Premises**: `bin/lean/needs-human-premise.mjs`. A blocker names its external fact as a `Premise: issue-closed:N | date-after:ISO | pkg-version:name@ver` line. `needsHuman()` (lean.mjs) re-evaluates it before labelling (holds → no label, `deferred`) and writes a `FORGE:PREMISE` annotation; `sweepPremises` runs from `scheddDue` and clears `needs-human` when the predicate holds. Unknown answers never clear.
- **Closed edges**: the batch parking path asks `dispatchCheck` and ignores a blocker that is closed; the lane lists closed `Depends on` edges in the needs-human comment (`closedEdgeNote`).
- **Owner asks**: `registerAsk` keys the normalized ask (`FORGE:ASK key=`) on GitHub; an identical ask links to the existing entry. Closing issues whose only content is an ask, and splitting mixed owner/agent issues, are deferred (follow-up).

- **Trust (release #4820 SEC-1/BUG-1)**: `sweepPremises` reads only the newest trusted `FORGE:NEEDS_HUMAN` comment (`isTrustedIssueComment`) and evaluates a premise only when that comment carries it. An untrusted `FORGE:PREMISE` never clears the label, and a newer block without a premise supersedes an older one. `registerAsk` matches only trusted `FORGE:ASK` entries.

## Entry 2026-10-27 — Mechanical park creates its `parked:<code>` label and only counts a real relabel (#4736)
`makeRelabelNeedsHuman` (`engine-cli.mjs`) best-effort runs `gh label create parked:<code> --force` before the park edit, since per-code labels are not in `labels.json` (same lazy-create as `prefilter.mjs`); without it the whole edit failed and returned `"failed"`. `orchestrate()` now sets `row.parkedQueued` only when the park relabel returns neither `false`, `"failed"` nor `"skipped"`, so a failed relabel stays in "unrecovered" instead of printing as remediation-queued.

## Entry 2026-10-27 — Deferred follow-ups: column 1 accepts legal path characters (#4739)

`scripts/file-deferred-followups.sh` no longer whitelists column-1 characters (it rejected `app/(marketing)/page.tsx`, `src/a=b.ts`, `src/#x.ts`, `src/foo:bar.ts`, and one bad row aborted the batch). It now rejects only `R<n>:` prefixes, control characters, and whitespace values with neither a `/` nor a file extension (prose such as `add a saved mapping`); `docs/My Notes.md` passes. Rejection stays exit 2 / `DEFERRED_TSV=INVALID` with nothing filed. Row format, exit codes and gh calls are unchanged.

## Entry 2026-10-27 — FORGE:GUARD marker escapes every `>` (#4741)

`renderGuard` (`guards.mjs`) now writes every `<` and `>` in the embedded JSON as `<` / `>` instead of special-casing `-->`, so no HTML comment terminator variant (`-->`, `--!>`) can end the marker early and make `parseGuard` return null. The only `>` in the output is the closing `-->`. Previously posted guards still parse (the old escapes are valid JSON). Same pattern as `drift.mjs`, `lifecycle.mjs`, `integration.mjs`; also clears CodeQL `js/bad-tag-filter`.

## Entry 2026-10-27 — Batch state files are private (#4751)

`batch.mjs` `writeAtomic(file, data, {private})` creates the file 0600 and its directory 0700 (an existing dir is chmodded). `openBatch` writes every batch-dir file this way (`plan.json`, `state.json`, `parallel`, `add`, `hold`, `requeue`, `cancel`, `report.json`), since `plan.json` can hold pinned secrets (`env_passthrough`, `token_env`). `log.jsonl` and `lanes/<n>.log` are created 0600, the `lanes/` dir 0700. Other `writeAtomic` callers (`sched`, `limits`, `train`, `execution`) keep default modes. Existing files keep their old mode until rewritten. `package.json` no longer excludes `scripts/refresh-bot-token.sh`, so the `retry.mjs` 401 refresh path exists in an npm install.

## Entry 2026-10-27 — Trusted authors only for FORGE:GUARD (#4750)

`guardIssue` and `collectGuards` (`guards.mjs`) now keep a FORGE:GUARD comment only when `isTrustedIssueComment` (`prefilter.mjs`, same helper as FORGE:DECISION) accepts its `authorAssociation`; an untrusted comment is ignored, so it cannot be the idempotency `existing` guard, enter the guards index, or select a guard for the gate (`guardgate.mjs`, `stats --compounding` read through `collectGuards`). The `gh` queries are unchanged (the comments JSON already carries `authorAssociation`). Cost: 0 LLM calls.

#4755: a post-deploy rollup (body carries `FORGE:POSTDEPLOY_ROLLUP`, no windowed check) is verified per item by `measureFollowup` -> `measureItems` (`postdeploy-check.mjs`): the unticked items with a default-branch check run, passing ones are ticked (`tickItems(body, ids)`, evidence = the FORGE:PROBE record), one issue is filed per failing check (no parent reopen), items without a check get one owner ask and never block the rest, and the rollup closes only when every item is ticked. Deploy-green stays the #4389 gate (parent SHAs on the default branch, optional `post_deploy.precondition_cmd`); there is no new lane or trigger.

## Entry 2026-10-30 — Host-capability needs from decisions and the frozen contract (#4785)

Placement needs (`needsOf` in engine-cli `readBody`) now come from `placementText({body, comments})` (`execution.mjs`): the issue body, every `<!-- FORGE:DECISION` comment and the validate commands of the last parseable FORGE:CONTRACT comment, fetched in the same single `gh issue view` call. A rerun of an issue whose frozen contract runs `promtool` (declared in `execution.host_capabilities`), or whose decision says `ssh ovh-monitor obs-psql`, is placed local. On a first remote run, `runCore` checks the frozen contract right after the freeze: when `contractHostNeeds` finds a declared capability in a validate command and the lane is remote and not a recovery, it ends `env.capability_remote` before any implementation turn, and the host resumes it with the frozen contract. `orchestrate` `placeOf` now also relaunches `env.tool_missing` recoveries local (reason `host capability: recovering env.tool_missing`), so a sandbox that lacked the tool is not chosen again.
Cite: #4785.

## Entry 2026-10-30 — `verify.guard_command` for the guard gate (#4792)

`commandFor` (`guardgate.mjs`) first consults the repo's `verify.guard_command` map (extension, lowercase with leading dot, to a command template) before the contract's validate commands and the `node --test` / `python -m pytest -q` fallbacks, so a repo whose tests need a managed environment (uv, poetry, venv) is not parked `conformance.guard_broken` by the system Python. `{path}` is replaced by the repo-relative `<name>__guardbase.<ext>` path, or the path is appended when the template has none; the command runs from the worktree root. `parseVerify` (`verify.mjs`) normalises the map into `guardCommand` (omitted when empty, invalid entries dropped); `readVerify` fills it via `readYamlMap` in `engine-cli.mjs` because `parseForgeYaml` is one-level; `guardGate` in `lean.mjs` passes `vcfg.guardCommand` to `runGuards`. Unconfigured extensions behave as before. Documented in `docs/CONFIG.md`.
Cite: #4792.

`sandbox.unreachable` is uncapped like `host.busy`/`sandbox.capacity` (#4788): `deferPolicy` requeues it after its retry-in, never against `maxDeferrals`. `httpTransport.capacity()` derives `online`/`total` from `GET /agents` (`ok && !paused`) when `/status` carries no valid `online`; a failing `/agents` leaves liveness unknown (null). `grant()` tracks the first sample with `online === 0`; past `remote.poolOfflineMin` (default `POOL_OFFLINE_ALERT_MIN` 10) it emits one `pool-offline` batch update (status-line `STALLED: no compute pool agent online ...`), reset when `online > 0`. Report only: the host fallback stays the `execution.fallback_local` opt-in.

## Entry 2026-10-30 — Fix: usage-limit deferrals never capped; `deferred` requeuable (#4784)

`deferPolicy` (`orchestrate.mjs`) handles `rate_limited` before the `maxDeferrals` check: it returns `{delayMs, hold:true}` (reset time or `RATE_LIMIT_FALLBACK_S`) and the deferral counter is not incremented for a hold, so a usage limit waits for the reset instead of ending `deferred: gave up after N deferrals`. Other codes still cap; `host.busy`/`sandbox.capacity` stay uncapped with `host:true`. `REQUEUABLE` (`batch.mjs`) also accepts `deferred`, so `--requeue` and `drainRequeues` take a row that already gave up.
Cite: #4784.

## Entry 2026-10-30 — Host-capability needs ignore quoted evidence in the issue body (#4776)

`placementText` (`execution.mjs`) no longer feeds the raw issue body to `detectNeeds`. A private `proseOf` first removes HTML comments (FORGE:STATE included, so a lane no longer re-pins itself from its recorded placement reason), fenced code blocks, evidence-like sections (headings Evidence, Logs, Data, Observations, Measurements, Queries, Samples, Findings, up to the next heading of the same or higher level), blockquote lines and inline code spans. Plain prose that states a need still counts. `FORGE:DECISION` comments stay unstripped, and the last frozen contract's validate commands and `repro_test.command` are read; `contractHostNeeds` checks `repro_test` too (id `repro_test`). The builder's block summary (`hostCapabilityBlock`) is unchanged: a remote lane that truly needs a host capability still ends `env.capability_remote` and is recovered locally once. Fixture: `bin/tests/fixtures/alterlab-capability-bodies.json` (sanitised AlterLab #37290–#37317). Cost: 0 LLM calls.
Cite: #4776.

## Entry 2026-10-30 — schedd: heartbeat, watchdog, unit priority (#4780)

`bin/lean/schedd-health.mjs` owns schedd liveness. The daemon's event loop writes `heartbeat.json` (`{pid, ts}`, atomic) in
`schedDir()` every 5 s and removes it on a clean close; `status` replies carry `lastTick`. `forgedock sched show` and
`forgedock schedd status` print "last tick N s ago". A wedged daemon is alive, so `Restart=always` never fires:
`forgedock schedd watchdog [--stall-sec N]` (default 60 s; run every 30 s by the `forgedock-schedd-watchdog.timer` that
`pool/install/install-schedd.sh` installs) sends SIGTERM, then SIGKILL, to a live daemon whose heartbeat is stale, and the unit
restarts it (a new daemon resumes hosted batches). Priority: `unit_priority` in `pool/install/unit-hardening.sh` gives the
schedd unit `CPUWeight=500` (system units also `Nice=-5`; a user manager cannot set a negative Nice), and the daemon reniced
itself best-effort at start. Not done: async state saves. `gh` calls were already async and the atomic fsync saves
(`writeAtomic`) are the durability guarantee, so the heartbeat and watchdog bound a stall instead.

### Issue-level readiness in the scheduler (#4773)

`bin/lean/orchestrate.mjs`: `trusted(n)` gates `Blocked by`/`Depends on` edges to a trusted body author (`declared`); `getBlocked()` (the `orchestration.blocked_label` issues, default `blocked`) keeps an issue admitted but not ready in `isReady`, with `blocked`/`unblocked` rows and a poll while only blocked issues wait. `engine-cli.mjs` wires both and `addToBatch` reports the edges it created (see modules/orchestrate.md).

## Entry 2026-10-30 — Quote check normalizes unicode and markup (#4789)

`conformance.mjs` `norm` now folds curly quotes, dashes, ellipsis, zero-width
characters, markdown links, `~`, `#` and backslash escapes on both sides of the
verbatim check, so retyped quotes match. A miss appends `nearestSpan` (the issue line
sharing most words) to the problem, which the correction prompt shows. A contract still
invalid with only quote problems ends `contract.invalid` with `quoteMismatch`, which
`classifyNeedsHuman` treats as recoverable (relaunch with a fresh plan).

## Entry 2026-10-30 — Activation rows, rollout owner asks, dormancy report (#4769)

`activation.mjs`: `readRollouts` (forge.yaml `rollouts.files`), `detectNewOffKeys` (new off/false/0 keys in the PR diff of those files, wired in `lean.mjs` `newOffKeysOf` into `precheck`'s `newOffKeys`), `activationFailures` (`activation_missing`, `mode_unreachable` for shadow/cohort/treated ACs) and `dormancyReport` (injected read-only `flagState`, keep-off decisions silence). `postdeploy-check.mjs` `measureItems`: a check printing `BLOCKED: <flag> = off` posts one `FORGE:ROLLOUT_ASK` per flag (re-posted only when the evidence hash changes) and parks `awaiting-measurement` instead of filing a failure.
Cite: #4769.

## Entry 2026-10-30 — Batch plan.json never holds secrets (#4787)

`batch.mjs` `writePlan` drops secret-named `plan.env` keys (`SECRET_ENV`, now defined in `batch.mjs`, imported by `schedd.mjs` (not re-exported), also matching a bare `*_KEY`) and records only their names in `plan.envSecrets`; state files stay 0600. On `--resume` the lanes re-read the value from the daemon/client environment (`mergeEnv`) or the keychain (`execution.token_env`). #5131: a fresh daemon-hosted batch behaves the same: `batchEnv` never pins an empty value (passthrough keys included), and `mergeEnv` keeps the daemon's non-empty value of a secret-named key over the client's in-memory pin; a non-empty pin only fills a secret the daemon lacks (client-spawned daemon). Non-secret pinned keys still win. `batch.scrubPlan()` rewrites a pre-fix plan.json (secrets removed, chmod 0600); it runs on every `--resume` and for each batch at schedd start. `--set-env` refuses secret-named keys.
Cite: #4787.

## Entry 2026-10-30 — Transient lane-resolution failures retry; `lane-refused` is requeueable (#4791)

`resolveLane` marks a failed `gh`/`git` command (milestone read, default-branch read, `git ls-remote`) `lane.unresolved` with `transient: true` (additive; no new outcome code). Genuine refusals (`lane.branch_missing`, `lane.default_branch`, `lane.mismatch`, bad slug/pattern) stay terminal `lane-refused`. In `orchestrate` `start()`, a transient refused lane is re-resolved: still transient → `deferred` / `lane.unresolved`, requeued with backoff `DEFER_BACKOFF_S` doubling to `DEFER_BACKOFF_MAX_S` from a separate `laneRetries` counter, uncapped and never counted in `deferrals`/`maxDeferrals` (`UNCAPPED_DEFERRALS`). A thrown `resolveLane` is transient. `batch.mjs` `REQUEUABLE` accepts `lane-refused`, and `--add` requeues a `lane-refused` row (like `skipped`) instead of "already in batch".
Cite: #4791.

## Entry 2026-10-30 — North-star decision engine (#4766)

`decision-engine.mjs`: `loadPolicy` (forge.yaml `decisions:`, policy file NORTHSTAR.md > CLAUDE.md > AGENTS.md, authority matrix `human_only`), `splitEscalation` (deterministic: recovery | evidence | post-deploy | external | decision | mixed), `settle` (one injected `judge` call per decision part; one-way, low-confidence or clause-less answers escalate; shadow posts `FORGE:DECISION (shadow)`, live records via `recordDecisions`, clears needs-human and requeues; idempotent on the escalation id), `isVetoed`/`revertVeto`, `effectiveMode` (reversal rate above `reversal_max` forces shadow). `issuewatch-decisions.mjs` (#4793) is the caller: an issue-watch stage (active for `decisions.mode: live` or `sweep_needs_human: true`) that settles the open `needs-human` issues matching the watch selectors, keyed on the newest `FORGE:NEEDS_HUMAN` comment id (read only from OWNER/MEMBER/COLLABORATOR or `ownLogins`; at most 20 judge calls per round), with `max_issues`/`max_launches` caps, a `--dry-run` classify, status counts, evidence hand-off to a `prod_monitor` lane, post-deploy-only fold into `postdeploy_rollup` + close, and veto reversal. Telemetry `decision_engine`; the batch report lists rows with `decided` (orchestrate.mjs `formatOutcomeLists`). Docs: `docs/DECISIONS.md`.
Cite: #4766.

## Read-only capability relay (#4778)

`bin/lean/relay.mjs` (0 LLM) lets a sandbox lane use a host-only capability through an allowlisted read-only wrapper.
forge.yaml `execution.relay_commands` (`capability:command`, exact name or trailing-`*` prefix glob) is parsed by
`parseExecution` into `relay`; `remoteProvider` exposes `relays` (the capabilities with a command, only when the transport
has `relayPending`), so `placeLane` places those lanes remote. Flow: the builder runs `obs-psql ...` unchanged; the
entrypoint's shim (from `CS_RELAY_COMMANDS`) calls `pool/image/cs-relay`, which POSTs `{argv}` to the pool agent
(`CS_RELAY_BASE`, per-sandbox `CS_CRED_TOKEN`); the agent forwards it to the router's in-memory queue
(`/agent/relay/:id`, owner-checked, 8 pending, 64 args, 16 KB). The dispatcher's per-lane `status()` poll lists
`GET /sandboxes/:id/relay`, `servicePending` gates each request (`relayGate`), runs the allowed ones with `runRelayed`
(execFile, no shell, 120 s, 1 MB, redacted) or refuses them (rc 126), and posts `{rc, stdout, stderr}` back; cs-relay
polls for it. The router and agent never execute or gate; the key and the wrapper stay on the dispatching host.
Pre-fetch: `relayPrefetchCommands` takes the frozen contract's simple validate / repro_test commands that pass the gate
(engine-cli `readBody`, `prefetchOf`); the provider runs them at dispatch and ships `CS_RELAY_PREFETCH_B64` (96 KB cap),
which cs-relay serves on an identical argv. Lane gate: the provider sets `CS_RELAY_CAPS`; engine-cli `readRelayCaps`
passes it as `o.relayCaps`, and runCore's #4785 pre-build `contractHostNeeds` end ignores relayed capabilities. The
`hostCapabilityBlock` recovery is unchanged: an unreachable relay (cs-relay exit 125, old router/agent) still recovers
the lane locally once.
Answer cap (#4831): the router parses a POST body at 1 MiB, so `servicePending` runs the redacted answer through
`capAnswer` (`RELAY_ANSWER_MAX_BYTES` 512 KiB serialized): an answer that fits is posted unchanged; a larger one is trimmed
(stdout, then stderr, never mid-character), gets a `relay: output over N bytes, truncated` stderr line and rc 1. A 4xx
(not 429) answer failure is deterministic, so a small rc 1 "answer rejected by the router (HTTP n)" answer is posted for the
same rid instead of retrying (which re-ran the command every poll); 429, 5xx and statusless failures still retry next poll.

## Entry 2026-10-30 — Named issue watches (#4765)

`bin/lean/issuewatch.mjs` is `forgedock issue-watch`: named watches from forge.yaml `issue_watch.watches` (parsed by its own `parseWatches`, since `parseForgeYaml` reads one nested level), each with a per-(repo, name) lock and `status.json` under `~/.forge/watch/`, and a repo-wide `claims.json` (mkdir-locked) so an issue has one claim across watches. Pure selectors/lane/caps; gh, clock and launching are injected. `mode: batch` calls batch.mjs `addIssues` and starts a new batch once `report.json` exists. See docs/ISSUE-WATCH.md. `mode: release` (#4767) lives in `issuewatch-release.mjs`: pure pool score, triggers (`min_issues`, `min_score`, `max_age_days`, `immediate`), `theme_map` classification (one counted `io.classify` call for unclassified issues), `Depends on` closure under `max_release_issues`; `releaseTick` posts `FORGE:RELEASE_PLAN`, tags (milestone `release/<theme>-<date>` or label `release:<theme>-<date>`), starts one batch, then opens the deploy PR once and never merges it. `issue-watch run --dry-run` prints the would-cut set. #5088: `trust_app: true` (opt-in, narrowed by `trust_app_labels`) makes `classifyIssue` claim issues authored by the repo's own ForgeDock App (`isOwnApp`: bare login equals `APP_SLUG`; other bots, lookalikes and `NONE` humans stay untrusted, App `follow-up:` issues keep the `include_followups` rules); `planClaims` is the one selection shared by `tick` and the per-issue/batch `--dry-run` (would claim with lane and reason, would fold, skip with reason, registry read-only); `realIo.gh` is `ghRunner`, which captures gh's stderr, throws an error naming the call, and on HTTP 401/403 warns one line with the call and its effect on the pass (`ghFailureEffect`). `bin/lean/prodwatch-sources.mjs` (#4833) is the prod-watch signal layer: `parseSources` validates `prod_watch.sources`, `runAdapter` runs only the declared `list`/`read`/`run` commands via injected `io.exec` and normalises memo, Alertmanager, SQL and Prometheus output to `{id, source, title, severity, owner, first_seen, last_seen, body, query?}`; `closeSignal` is the sole path to `close` and writes an audit record before exec. `bin/lean/prodwatch-triage.mjs` (#4834) triages those signals: `fingerprint` (ids, timestamps, hosts and numbers stripped), `cluster` (groups copies; dedups against open issues embedding `<!-- FORGE:SIGNAL_REF fp=<fp> -->`, see `signalRef`), `classifyCluster` (incident|defect|monitoring-bug|expected-class|deploy-fallout|transient; rules from an optional `Alert rules:` list in the `loadPolicy` text, then built-in defaults), `validateCluster` (re-runs declared read-only queries via `runAdapter` only; no evidence means not fileable, expected-class is counted never filed) and `tallyClusters`. Fixtures: `bin/lean/fixtures/prodwatch/` (synthetic anonymised 70-memo set). `bin/lean/prodwatch-metrics.mjs` (#4837) holds the loop metrics: `computeMetrics` (per source: median signal-to-issue/merge/verified, false-positive, fix-ineffective and recurrence rates from caller-supplied issue rows), `sourceMode` (a false-positive rate above the cap over the minimum sample drops a source to shadow, calibrated like `effectiveMode`) and `emitMetrics` (one `PRODWATCH_METRICS` record per source, mapped to `prodwatch_metrics` by the telemetry seam). `bin/lean/prodwatch-governor.mjs` (#4835) is the prod-watch rate limiter: pure `admit(clusters, {governor, state, openProdIssues, now})` returns `{file, summary}`; candidates are fileable, non-duplicate, non-expected-class clusters, ordered incident then defect (then severity, size), admitted until the smallest of `max_issues_per_hour` (rolling hour over `state.filed`), `max_open_prod_issues` (standing cap on `openProdIssues`) and `max_cost_usd_per_round` (cost per cluster = `cluster.cost_usd ?? governor.cost_per_issue_usd ?? 0`) runs out; every deferred cluster goes into ONE summary `{title, body}` with no SIGNAL_REF, so a later round can re-admit them. Mapping to signal-planner Phase 0: `max_cost_usd_per_round` is `governor.max_cost_usd` applied per poll round; `max_issues_per_hour` is a rolling-hour rate where `governor.max_issues_per_run` is per run; `max_open_prod_issues` has no planner equivalent; a missing key is unlimited, and the effective cap is the minimum of the three. `bin/lean/prodwatch.mjs` (#4838) is `forgedock prod-watch`: `parseProdWatch` (3-level forge.yaml parse, sources via `parseSources`), `roundOnce` (open prod-watch issues listed in full via `gh api --paginate --slurp` (PRs dropped), so dedup and the open cap see every one; closed ones only as a `--limit 200` window for metrics/verify, whose failure degrades with a note while an open-list failure files nothing, #4873; kill-switch file, `runAdapter`, `cluster`/`classifyCluster`/`validateCluster`, `admit`, ONE injected `io.llm` call per admitted cluster whose cost counts against `max_cost_usd_per_round` (the real backend runs `claude --print --output-format json` and `llmResult` reads `total_cost_usd`; an unknown cost is charged `cost_per_issue_usd` or the whole cap, #4868), the storm summary kept as one open issue marked `SUMMARY_TAG` (edited by later rounds, excluded from the open-issue cap and metrics, closed only when the round deferred nothing for any reason, cost cap included, #4869/#4879; FORGE markers are trusted only in the body trailer via `trailerOf`, and every signal field written above the trailer (text, owner, class, severity, seen times, evidence source) is neutralised so it cannot forge one, #4879), `killSwitchSet` (absolute path as given, relative under the cwd), issue with SIGNAL_REF + PRODWATCH source marker + the `target_watch` label, `deployed_probe` verify that comments FORGE:VERIFIED, metrics via `emitMetrics`), human-only clusters collected into one owner digest issue per UTC day, only a P0 incident pages through `alert_channel`, `--dry-run` makes no writes; `prodWatchFromCli` mirrors `issueWatchFromCli` (lock and `status.json` under the watch dir). See docs/PROD-WATCH.md.
Bot authorship (`isBot`) comes from the issue author only: a `[bot]`/`app/` login, `is_bot`, or the ForgeDock App's bare login (`APP_SLUG`, #4467). A `FORGE:DEFERRED` marker in the body never makes an outsider's `follow-up:` issue a bot follow-up (release #4820 AUTH-1).
`claimIssue` is idempotent for the watch that holds the claim: the registry is written before the watch saves `status.json` or launches, so after a crash or a throwing `batch.start` the same watch re-claims and launches the issue on its next pass; another watch is still refused (release #4820 BUG-1).
Release mode (`issuewatch-release.mjs`, #4767) keeps this watch's own registry claims eligible (`unclaimedOrOwn`), reuses an existing `release/<tag>` milestone (422 already_exists), and claims only pool members, so a `Depends on` prerequisite that never passed `eligible` is not launched (release #4820 CONC-1, SPEC-2).
Cite: #4765.

## Entry 2026-10-30 — schedd listens on a named pipe on Windows (#4762)

Windows `net` servers refuse a filesystem path (`listen EACCES`), so `scheddPaths(dir, platform)` returns
`\\.\pipe\forgedock-schedd-<sha1(resolve(dir))[0..12]>` as `sock` on win32 (stable per sched dir, distinct across dirs);
POSIX keeps `<dir>/schedd.sock`. A pipe is not a file and vanishes with its server, so on win32 the stale-socket unlink
(startup and close) and the `lost socket` watchdog are skipped (the `schedd.lock` check still covers takeover) and
`scheddExists` tests the lock file. `defaultSpawn` resolves the `forgedock.mjs` script with `fileURLToPath` (`SCHEDD_SCRIPT`),
not `URL.pathname`, which gave `/C:/...` on Windows.

## Entry 2026-10-31 — Relay pre-fetch trust and answer cap (release #4820)

**Release #4820 hardening.** `relayPrefetchCommands` reads only a trusted `FORGE:CONTRACT` comment whose hash verifies, as `readFrozenContract` does, so an outsider's contract never chooses what the host runs at dispatch (API-1). `servicePending` caps each answer stream at `RELAY_ANSWER_STREAM_MAX` (256 KiB) and replaces an answer the router still rejects with an rc 125 error, so a command is never re-run on every poll (INFRA-1).

## Entry 2026-10-31 — Projector body read fails closed (#4860)

`makeLeanIo` now passes `{ repo }` to `makeProjector`, so the projector's `gh issue view --json body` carries `-R <repo>` (callers without a repo keep cwd resolution). `getBody` throws on non-JSON output or a missing/non-string `body` instead of returning `""`, so `writeState` makes no `gh issue edit` call on an unreadable read. `writeState` also refuses a body that would drop existing non-STATE issue text.
Cite: #4860.

## Entry 2026-10-31 — Live selftest and release gate (#4865)

`selftest-static.mjs` checks every `gh issue|pr view|list --json` field list in `bin/` against the host's `gh <cmd> --help`. `selftest-live.mjs` (`forgedock selftest --live --repo <sandbox>`) drives real gh, git and `orchestrate` through create, add, body, resume, merge, remote and cleanup, stopping at the first failure and naming it; all process access is injected through `io`. `selftest-gate.mjs` builds, parses and posts the `FORGE:SELFTEST` marker; `bin/review-staging.mjs` calls `selftestGate` after resolving the head and stops BLOCKED (fail closed) without a passing marker for that head. Docs: `docs/SELFTEST.md`.
Cite: #4865.

## Entry 2026-10-31 — Lane preflight (#4866)

`lanecheck.mjs` (pure, injected io) runs four checks: `preflight.pool_auth` (token resolves, router does not answer 401/403; #5131: through `io.poolToken`, which `hostLaneIo({ env })` wires to `poolCredential` on the dispatch env, so preflight and lane dispatch resolve the same token, and the agents read uses it too; the FAIL detail names the sources tried and the source used, never the value. A null or rejected token holds remote admission before any lane starts, so no lane defers on `sandbox.auth`), `preflight.pool_version` (router `GET /agents` version vs CLI, names the upgrade command), `preflight.path_loop` (heavy.mjs `findShimLoops`: a PATH wrapper resolving a shimmed tool back to the shim, names the dir), `preflight.gh_fields` (gh lacks a `--json` field the engine uses). It runs at daemon start (`schedd.mjs`, logged once), on each `orchestrate` admission pass (`preflight` seam: a failure holds admission, all lanes or remote only by scope, one row per distinct code+detail, re-checked each pass, never the breaker) and on demand as `forgedock doctor --lanes`. A sandbox clone failure ends `deferred` `sandbox.clone` with retry-in (`execution.mjs`), never an engine-error. Distinct from the contract preflight in `preflight.mjs`.

## Entry 2026-10-31 — issue-watch escalation is resumable, reopen last (#4891)

`issuewatch.mjs` `verifyClosed` now runs side effects before state. A failed merge verification posts the evidence comment, adds `needs-human`, and only then reopens, because the watch revisits only still-closed issues. Finished steps are recorded in `state.escalation[n]` (`comment`, `label`). A failing `gh` call throws with the issue closed and in `pendingVerify`, so the next tick resumes without repeating done steps. `merged`/`unverified`/`verifyFrom` change only after all steps succeed; the verified branch comments before the state push.
Cite: #4891.

## Entry 2026-10-31 — Prod-watch owner digest state persists after the gh write (#4872)

`digest()` in `bin/lean/prodwatch.mjs` builds the merged item list locally and calls `gh issue create`/`edit` through `write()`. `state.digest` (`date`, `issue`, `items`) is assigned only when `write()` returned non-null; an existing `state.digest` is never mutated beforehand. A failed write (error in `rep.errors`) leaves state unchanged, so the next round retries it with the new items. `--dry-run` still makes no writes or state changes.
Cite: #4872.

## Entry 2026-10-31 — Docs-freshness edits are implied deliverables (#4887)
A doc file (`.md`, `.mdx`, `.rst` or `.adoc` under a `docs/`, `doc/`, `devdocs/` or `documentation/` directory; build, dependency and agent-instruction files never qualify, per the staging review of #4884) newly changed by the step-3c docs round or a CI fix round, while the repo's
freshness script failed before the round and passes after it, gets an engine-synthesized `add-deliverable` amendment (why
"docs freshness rule", `impliedDocDeliverables` in `conformance.mjs`, merged in `amend()` in `lean.mjs`). The path comes from
the diff, never a hardcoded dossier path; any other out-of-contract file in the round is still `conformance.scope_creep`.

## Entry 2026-10-31 — guard_broken names the supersedes override (#4883)

`guardFailures` (`guardgate.mjs`) now starts each `conformance.guard_broken` detail with the override sentence: if the change intentionally changes the guarded behaviour (e.g. adding a code to an enum an exhaustiveness test enumerates), add `{"kind":"supersedes","guard":"#N","why":"..."}` to the amendments; the reviewer judges it. It leads the detail so `conformanceResumePrompt`'s 900-char slice keeps it. `builderImplementPrompt` lists the `supersedes` kind beside the other amendment kinds. `applyAmendments` and the precheck guard retirement are unchanged; row shape is unchanged.
Cite: #4883.

## Entry 2026-10-31 — FORGE:DECISION after the contract froze reaches requeued lanes (#4901)

A trusted `FORGE:DECISION` comment posted after the last `FORGE:CONTRACT` comment is now a binding note: `decisionNote` (`prompts.mjs`) renders it and `lean.mjs` appends it to the implement and plan-rerun prompts of a resumed, salvaged or recovery lane that holds a frozen contract, independent of `context_pack`. `reviewerPrompt` keeps trusted `FORGE:DECISION` comments and still drops every other `FORGE:` record. Untrusted decisions, decisions before the contract, and the lane's own `recovery pass` records are not passed.
Cite: #4901.

## Entry 2026-10-31 — per-lane phase ledger (#4908)

`phaseledger.mjs` records which engine phase a lane is in (`createLedger`, `enter`, `during`); `lean.mjs` marks the phase boundaries and puts `phases` ({id: {ms, model_ms?, usd?}}) on `RUN_TERMINAL` and the lane result, flattened to `phase_<id>_*` for FORGE:TELEMETRY. `orchestrate.mjs` `phasesOf` adds `queue_wait` to the batch row; the batch report and `forgedock stats` print p50/p90 per phase and the largest phase (`n/a` without data). The efficiency lines list merged issues with no acceptance probe.
Cite: #4908.

## Entry 2026-10-31 — schedd: a batch with pending issues is not finalised (#4917)

`runBatch` (`bin/engine-cli.mjs`) writes no `report.json` while
`state.json` `pending` is non-empty (a cancel still ends the batch), and the running schedd
re-hosts the batch (`--resume`) once the retry-at is near (`rehostLater`, 1-60 s).
Deliberate holds (budget, operator, drift, breaker) also leave the batch unfinished
(their issues stay pending): the loop still ends, and a `--resume` frees them. `requeue`/`add` on an unhosted batch re-host it when a
requeue or add entry is still unapplied, and the CLI prints `re-hosted by the schedd`
or `not re-hosted`. `schedd status` lists batch dirs with pending issues that are not hosted
(`unhosted: [{id, pending}]`).

## Entry 2026-10-31 — one lane per issue across batches and remote lanes (#4920)

A lane's default lease holder is `core_<host>_<pid>_<nonce>`: a sandbox's pid is 1, so `core_<pid>` made every remote lane the same holder and the lease never refused one. After writing the lease a lane reads it back and defers `lease-held` when another lane's id replaced the one it saw. `lanelock.mjs` (`otherLaneOwner`) reads GitHub, never host-local state: a live FORGE:STATE lease held by another, or an open `feat/issue-N-lean` PR that is not this lane's. `makeDispatchCheck` uses it before every lane start, so `orchestrate` records a `deferred` row (`lease.held`) and launches no sandbox, across batches and daemon restarts. A non-fast-forward push rejection with such an owner ends `deferred` `lease.held`; every other permanent push rejection stays needs-human.
Cite: #4920.

## Entry 2026-10-31 — Closed deferred-follow-up trackers are no longer silently reopened (#4924)

`scripts/file-deferred-followups.sh` `verify_num` treats a closed tracker as reusable only when its REST `state_reason` is `completed` and the last comment is not from a non-bot user (a fold, supersede or invalid resolution). A `not_planned`/`duplicate` or person-resolved tracker is skipped, so the items go to a fresh tracker (the post-create re-check applies the same filter). `append_items` reopens a closed tracker only when it appends new items, and then posts a `FORGE:FOLLOWUP_REOPENED` comment naming the parent (and `FORGE_RUN_ID` when set) and the new items; with nothing new it stays closed. Markers, exit codes and the open/rollup paths are unchanged. Cost: 0 LLM calls, one extra REST call per closed candidate.

## Entry 2026-11-01 — the dispatch check reads only a foreign lease (release review #4931)

`makeDispatchCheck` calls `otherLaneOwner` with `checkPr: false`. An open `feat/issue-N-lean` PR is the issue's own lane: ci.red / base.conflict recovery lanes and relaunches after engine-error or ci-pending resume it by design, and the #4920 PR check deferred every such start as `lease.held` until `max_deferrals` gave up. A lane still running on the branch always holds the FORGE:STATE lease, which the dispatch check still reads. The push-rejected path keeps the PR check, because it knows its own PR (`ownPr`).
Cite: #4933.

## Entry 2026-11-01 — the mutation check restores a deleted file and fails closed (release review #4931)

`runMutationCheck` restored with `git checkout HEAD -- <non-test files>`, which fails as a whole when the change deleted one of them (the revert re-creates it untracked), so nothing was restored and the lane continued on the reverted tree. The tree is verified clean before the revert, so the restore is now `git reset --hard HEAD` plus `git clean` of those paths, and a tree still dirty there afterwards throws (the lane ends engine-error instead of pushing the reverted change).
Cite: #4934.

## Entry 2026-11-01 — Nightly live selftest (#4894)

`selftest-nightly.mjs` is an opt-in schedd hook: `scheddDue` (`bin/engine-cli.mjs`) calls `nightlyDue` on each due pass, best effort, so other sweeps never stop. Off unless `forge.yaml` `selftest.nightly_interval_hours` is positive; the last run time is cached in `selftest-nightly.json` under the sched dir and written before the run. A failed run files one issue naming the failed step, marked `<!-- FORGE:SELFTEST_NIGHTLY -->`; the next failure edits the open issue with that marker instead of creating another (same dedupe as prodwatch). Runs on the host only; never throws. Docs: `docs/SELFTEST.md`, `docs/CONFIG.md`.

## Entry 2026-11-01 — Selftest release gate is opt-in on `selftest.sandbox_repo`

`bin/review-staging.mjs` `readConfig` now returns `sandboxRepo` (forge.yaml `selftest.sandbox_repo`), and the #4865 `selftestGate` check runs only when it is set. Unset, nothing is read and the CLI prints `SELFTEST: skipped (...)` on stderr; stdout stays the manifest (and pure JSON under `--json`). Before this, every staging->main review blocked on a missing marker, even in repos with no sandbox, where the harness cannot run. Found reviewing release PR #4946.
Cite: #4865.

## Entry 2026-11-01 — Release-review fixes to the selftest modules (PR #4946)

- **`selftest-gate.mjs`:** `readMarkerComments` keeps only `isTrustedComment` comments (`bin/engine/phases.mjs`), and `MARKER_RE` is anchored to the comment start, so a drive-by or quoted marker never opens the gate. A gh error throws, and `review-staging` stops BLOCKED with "could not read the FORGE:SELFTEST markers" instead of claiming there are none. `selftest.sandbox_repo` turns the gate on only when it matches `owner/repo`.
- **`selftest-nightly.mjs`:** `nightlyDue({launch})` only decides that a run is due, then launches. `scheddDue` spawns a detached `forgedock selftest --live --nightly-report <repo>`, because the harness's `orchestrate --add` calls back into schedd: inline, that deadlocked the daemon (watchdog kill) and held the due pass for up to 45 min. `reportNightly` holds the issue filing. A throwing harness reports step `harness`, a run that cannot start reports step `config`, the last-run file is per repo, and `neutralize` escapes every `<` and `>` (CodeQL js/bad-tag-filter).
- **`selftest-live.mjs`:** forge.yaml is read with `parseForgeYaml`, per section. Flags without a value throw. The sandbox may not be the project or release repo. The `--pr` head is read with `-R <release repo>` before the run.
- **`.forge/post-deploy-checks.json`:** removed. Its two checks were contradictory (one needed a pass, the other a fail), and their timeout was clamped to 900 s.
Cite: #4865, #4894.

## Entry 2026-11-01 — Nightly launch survives a spawn error

`launchNightly` (`selftest-nightly.mjs`) owns the detached spawn that `scheddDue` used to inline. It attaches an `'error'` listener before `unref()`. Without one, an async spawn failure (EAGAIN, EMFILE, a removed cwd) was an uncaught exception, and `schedd.mjs` stops the daemon on that. Now the failure costs only that night's run. The review-staging skip line now names a malformed `selftest.sandbox_repo` value instead of saying "not set". Found in the delta review of release PR #4946.
Cite: #4894.

## Entry 2026-11-01 — Batch setup reads run concurrently and show progress

`orchestrate.mjs` reads a new batch's issues through `pmap.mjs` `mapLimit` (`setupConcurrency`, default 6) instead of one at a time; `order`, edges and lanes are keyed by issue and come out unchanged. Before the first read it saves `state.json` with `phase: "setup"` and `setup: {read, total}` (updated per issue; absent once setup ends and ignored on resume), so a slow start is visible. `lane.mjs` `resolveLane` takes an optional per-batch `makeLaneCache()` (default-branch read once, `ls-remote` once per lane; failures and a missing lane branch are evicted so retries re-read) and a pre-read `milestone`, which `engine-cli.mjs` `readBody` supplies from the issue view it already makes.
Cite: #4963.

## Entry 2026-11-01 — Auto-add of epic and late children to a running batch

`autochildren.mjs` (pure, no LLM) backs `orchestration.auto_add_children: off | decomposed | epic | all` (default `decomposed`, today's behaviour) and `forgedock orchestrate --auto-children <mode> [--epic N]`. Both flags live in `plan.argv`, so `--resume` keeps the mode. In `epic`/`all`, `drainChildren` in `orchestrate.mjs` runs beside `drainAdds`, at most once per `auto_add_children_poll_s` (default 120) with one `gh issue list` per pass. It adds open children (`**Parent**: #P` line or GitHub sub-issues) of every batch issue and every `--epic` root, including ones filed after the batch started. `needs-human` children and issues another live batch of the repo holds are left out. #4982: a child whose author fails `isTrustedActor` (the `Blocked by` rule; the association comes from REST via `gh-assoc.mjs`, unreadable = untrusted) is skipped with one `skipped` row per issue. Each pass posts one decision and one `added` row listing the children and edges. `off` also stops the decomposed-lane join; `decomposed` and `epic` keep it. `decomposed` makes no list call.
Cite: #4965.

## Entry 2026-11-01 — Staging pre-dispatch scales to ~300 PRs (#4960)

`review-staging-pre.sh scope` reads each bundle PR in its own subshell (`scope_one_pr`), `FORGE_SCOPE_PARALLELISM` at a time (default 8), through `gh_retry`, and merges the per-PR result files in PR order. A read that still fails degrades that PR only: no commits are credited (they stay unreviewed, so review widens), it is listed in `scope.json` `degraded_prs`, and scope stays `scoped`. Global failures (git log/diff, missing `trusted-comments.sh`, empty PR list) still set `full`. Progress goes to stderr every 25 PRs and per phase; `review-prepare.sh` prints a line per phase (index, slices). Rationale: `devdocs/decisions/4960-review-staging-scope-degrade-per-pr.md`.
Cite: #4960.

## Entry 2026-11-01 — Reviewer sees the investigation verdict; generated requirements.txt is untracked

`lean.mjs` reads `.forge-lean/investigation.md` at the reviewer call and passes `investigationVerdict(md)` (the `**Verdict**:` word, `prompts.mjs`) to `reviewerPrompt`, which renders an `<investigation_verdict>` block plus `VERDICT_RULE`: a validation/finding-verdict criterion is met by the recorded verdict with a regression or repro test in the diff (no prose needed), and a gap the reviewer calls minor is not a failing row. The prompt is byte-identical without a verdict, and the rule stays out of the shared `REVIEW_RUBRIC` (builder token cap). `untrackToolState` takes `keep` (contract deliverable paths, from `keepPaths()` at both call sites) and also untracks an added `requirements*.txt` when the base is a Poetry/uv project (`strayGenerated`, `toolstate.mjs`), the base tracks none, and the path is not in `keep`. `conformance.mjs` row logic is unchanged.
Cite: #4959.

## Entry 2026-11-01 — Unrunnable validate commands are contract defects, not product decisions

`validateContract` rejects a validate or `repro_test` command that fails `bash -n` (`shellSyntaxError`, `conformance.mjs`). A rerun that dies before any test (`unrunnableValidate`: no tests selected, no pyproject at the cwd) is `contract.invalid_command`. A new `substitute-validate` amendment swaps in a runnable equivalent. `classifyBlock` turns a `human/product-decision` block whose summary describes an unrunnable validate into an untyped block, which gets the one corrective resume. `forge.yaml` `verification.test_runners` ({path prefix: runner}) is read by `engine-cli.mjs readEnvConfig` and checked at freeze by `testRunnerProblems` (`preflight.mjs`).
Cite: #4857.

## Entry 2026-11-01 — New-file lanes no longer parked by false duplicate-export and missing-anchor checks

`duplicateExports` (`postmerge.mjs`) skips entry-point names (`main`, `cli`) and manifest-less files under `scripts/` (standalone scripts, not a package). `applyAmendments` (`conformance.mjs`) takes `defaultWhy`, filling a blank `why`; `lean.mjs` sets it when the duplicate gate demanded a rename, so the engine's own amendment is not rejected. A `decision` anchor may also name a file the lane adds that the contract lists as a deliverable (`addedPaths`); other anchors must still exist on the base.
Cite: #4974.

## Entry 2026-11-02 — A substitute-validate stands only for a frozen command that cannot run; the guard baseline uses guard_command

`applyAmendments` (`conformance.mjs`) rejects a `substitute-validate` whose command runs no check (`noopCommand`: every segment is `true`, `:`, `exit 0`, `echo` or `printf`). `gate()` in `lean.mjs` reruns the frozen command of every substituted validate (`rerunSubstitutedOriginals`, beside the failed-validate rerun and the guard gate, logged as `SUBSTITUTE_RERUN`) and passes it to `precheck({substitutedRuns})`. `substituteVerdict` accepts the substitute only when that frozen command cannot run (`unrunnableValidate`, `cliUsageError`, `missingTool`, rc 127) or passes anyway; a frozen command that runs and fails is `validate_failed` (a substitute never hides a failing check, and a CI-verified head does not cover it), a missing rerun is `substitute_unverified` (fail closed), a timeout is `validate_timeout` unless CI-verified. `runGuards` (`guardgate.mjs`) builds the merge-base baseline command with `verify.guard_command` too (`commandFor(path, contract, guardCommand)`), so the baseline runs the same runner as the lane run; before, a guard_command-only extension got no baseline command and a real guard break was skipped as "baseline unavailable" or "fails on base". Cost: one extra rerun per substituted validate, 0 LLM calls.
The prompt-budget assertions in `lean.test.mjs` measure prompts with `FORGEDOCK_CLI` (and any `.../bin/forgedock.mjs` path) replaced by `<cli>`, so they pass or fail the same from any checkout depth; their messages print the headroom (`N of 1650 tokens`). The prompt the builder receives is unchanged.
Cite: release review of #4979 (SPEC-1, SPEC-2, BUG-1, BUG-3); #4969.

## Entry 2026-11-02 — A repeated substitute-validate keeps the frozen command; wider no-op detection

`applyAmendments` keeps `substituted.from` at the frozen command when a validate is substituted twice (before, the second substitute recorded the first substitute as `from`, so the engine reran a builder-chosen command and a nonexistent first substitute, rc 127, passed `substituteVerdict`). `noopCommand` also splits on newlines and treats `false`, `exit N`, `sleep N`, a constant `test`/`[ ]`, shell keywords, `node -e 0` and `python -c pass` as no-ops; it stays a best-effort denylist behind the engine's rerun of the frozen command.
`gate()` now runs the failed-validate rerun (`rerunFailedValidatesRaw`) and `rerunSubstitutedOriginals` one after the other inside a single `phaseLedger.during("validate")`, beside the guard gate, so phase wall time is not split by two overlapping validate phases; the `rerunFailedValidates` wrapper is gone. An engine-level lean test covers the wiring (a runnable failing frozen command blocks, an unrunnable one merges, `SUBSTITUTE_RERUN` is logged).
Cite: delta review of #4979 (SEC-11, SEC-12, SPEC-11, SPEC-13).

## Entry 2026-11-02 — A substitute-validate is rejected when the diff removes a path its frozen command names

`gate()` in `lean.mjs` collects deleted/renamed-away paths (`removedPathsOf`, `git diff --name-status -z -M base...HEAD`; a git error returns null and `precheck` fails closed `substitute_unverified`, #5003) when a validate is substituted and `precheck` (`conformance.mjs`) fails `substitute_removed_path` (`conformance.unimplemented`) if `removedNamedPaths` finds one named by `substituted.from` (tokens stripped of quotes, `--flag=` and `::node` ids; globs expanded against the base file list; a directory or bare-word token matches only a removed test file, #5003), before the rerun verdict. The rerun runs in the builder's tree, so a deleted test read as "unrunnable" and let the substitute stand.
Decision: option 3 (diff check, no rerun) over rerun on base (fails for tests the issue adds) and restore-named-paths-from-base (needs a rerun and worktree mutation). Environment-unrunnable commands with intact files keep their substitute.
Cite: delta review of #4979 (SEC-13); #4990.

## Entry 2026-11-02 — noopCommand judges the command after a leading shell keyword; frozen contracts cannot carry a substitution

`noopCommand` (`conformance.mjs`) strips leading `if`/`then`/`else`/`elif`/`do`/`while`/`until` from each segment and judges the rest, so `if [ -f x ]; then pytest; fi` is a real check (before, any keyword-led segment counted as a no-op and such substitutes were rejected); bare `fi`/`done` stay no-ops. `applyAmendments` drops a `substituted` field from the frozen contract's validate rows before replaying amendments, so only a `substitute-validate` amendment sets it and its `from` is always the planned command. Earlier entries now name the failed-validate rerun by its function, `rerunFailedValidatesRaw`.
Cite: delta review of #4979 (SEC-21, SEC-22, SPEC-22).

## Entry 2026-11-02 — noopCommand drops bare keyword lines and treats a constant-false guarded body as a no-op

`noopCommand` (`conformance.mjs`) now drops a bare `then`/`else`/`do` segment, so `if true\nthen\n  :\nfi` is a no-op. It also tracks the condition of each `if`/`elif`/`while`: when it is a constant false (`false`, `[ 0 = 1 ]`, `test -n ""`, a small fixed set, no shell parsing) the body up to `else`/`elif`/`fi`/`done` never runs and is ignored, so `if false; then pytest; fi` is a no-op. Real wrapped checks (`if [ -f x ]; then pytest; fi`, `for f in a b; do node --test $f; done`) stay real. Still a best-effort denylist behind the frozen-command rerun.
Cite: delta review of #4979 (SPEC-31, SEC-32); #4995.

## Entry 2026-11-02 — DCO sign-off rewrite runs on a clean tree; a failed rewrite is a mechanical engine-error

`ensureSignedOff` (`signoff.mjs`) saves tracked changes with `git stash create` pinned on `refs/forgedock/dco-stash`, resets hard, runs `filter-branch`, then `stash apply`s them and deletes the ref (kept, sha named in the error, on apply conflict). `filter-branch` refused a dirty tree ("You have unstaged changes") and the lane ended needs-human with the commit unpushed. A failure now carries `engineCode: engine.dco_rewrite`; `signOffUnpushed` keeps `ci.dco` only for `noIdentity`, and `runCore`'s catch finishes `engine-error` with the code, which the batch runner relaunches like any engine-error (not in `RECOVERABLE_CODES`).
Cite: #4997.

## Entry 2026-11-02 — `--add` of a new issue reopens a finished batch; the CLI says whether it is hosted

The schedd `add` op (`schedd.mjs`) now reopens a finished, unhosted batch (hosts it as `--resume`) when an issue was newly added, not only when a skipped one was requeued. Without a daemon, `addToBatch` clears `report.json` for a plain add too. `addToBatch` and `requeueBatch` (`engine-cli.mjs`) print whether the batch was reopened, is hosted, or is queued but not hosted (run `--resume <id>`), and return `hosted`/`reopened`. Finalising a batch with `pending` non-empty stays #4917.
Cite: #5000.

### #5005 A missing forgedock install is `env.tool_missing`
A frozen validate command names forgedock's own entry point (`.../forgedock/bin/lean/checks.mjs`, `.../forgedock/bin/forgedock.mjs`) by the absolute path of the install that wrote it, which may not exist on the host that runs it. `conformance.mjs` `resolveForgedockPaths(command, {exists, checksCli, forgedockCli})` rewrites each missing such token to the running install's path; `rerunFailedValidatesRaw` and `rerunSubstitutedOriginals` (`lean.mjs`) run commands through it (`CHECKS_CLI`/`FORGEDOCK_CLI`, `existsSync`) before `io.runCommand`. `missingTool` now returns `{tool:'forgedock', kind:'command'}` for a Node `Cannot find module` / `MODULE_NOT_FOUND` on those two absolute paths, so the failure is `env.tool_missing` (recoverable), not `conformance.unimplemented`. Other absolute, relative and repo-tracked module paths stay `validate_failed`. Cost: 0 LLM calls.
Cite: #5005.

## Entry 2026-11-03 — detached spawns hide the Windows console

Node gives a `detached: true` child its own console window on Windows, so every lane and lane sub-step opened a visible, focus-stealing terminal. Every detached spawn under `bin/` and `scripts/` now also passes `windowsHide: true` (a no-op off Windows): `launchLane` (`batch.mjs`), `runCheckCommand` (`effects.mjs`), the `issuewatch.mjs` launch/orchestrate spawns, `spawnProbe` (`probe.mjs`), schedd `defaultSpawn`, `selftest-live.mjs`, `launchNightly`, `bin/pool/agent.mjs`, `bin/runner.mjs` and `scripts/ci-local/run.mjs`. Spawn semantics (session, stdio, env, cwd) are unchanged. `bin/tests/windows-hide.test.mjs` scans non-test sources and fails on a `detached: true` options object lacking `windowsHide: true`.
Cite: #4764.

## Entry 2026-11-03 — schedd: no re-host loop after a breaker trip or a passed retry-at (#5015)

`rehostLater` (`schedd.mjs`, #4917) re-hosted a batch every second when the resumed run ended at once (a tripped breaker is kept with `keepBreaker`) while a pending issue's `notBefore` had already passed: no report is written, so each end scheduled another re-host at the 1 s floor. The timer now skips a batch whose saved `breaker` is tripped and not a transport trip (it waits for an operator `--resume`), and skips a retry-at that is already in the past when the run ends (that run saw it and did not admit, so a re-host would change nothing). Tests: `schedd.test.mjs` "#4917: a resume that leaves the waiting issue unadmitted..." and "#4917: a batch whose breaker tripped...". Found by the release review of #5013.

## Entry 2026-11-03 — lane rescue push uses the post-rewrite head (#5014)

`checkpoint()` (`lean.mjs`, #4958) captured `laneHead.sha` before `gitPush`, which untracks tool state and rewrites unpushed commits for DCO (`ensureSignedOff`) before it pushes. When that push then failed, `rescuePush` pushed the pre-rewrite commit and `lane_sha` / the `FORGE:LANE_BRANCH` line named a sha the branch no longer held. `rescuePush` now re-reads HEAD first (keeping the captured sha if `rev-parse` fails). Test: `lean.test.mjs` "#5014 the rescue pushes and reports the head after the pre-push sign-off rewrite...". Found by the release review of #5013.

## Entry 2026-11-03 — Live selftest harness hardening (#4952)

- **`selftest-live.mjs`:** `waitBatch` adopts only the new batch whose `plan.json` names the sandbox repo and the started issue, never "the first new id". The resume step kills the client and then runs `orchestrate --cancel` (`io.orchestrate.stop`), waits for the lane to stop, resumes, and fails if the pre-cancel lane pid is still there; cleanup stops the batch too. A lane is torn down by a cancel, so "re-adoption" now means the resumed batch picks the issue up again. Fixture paths and titles carry a run id (`uniqueFixture`). Each created issue is tracked as soon as it exists. Branch cleanup keeps only `forge/issue-<n>` (exact, `issue-5` never matches `issue-50`) and finds PRs by that head branch.
- **`selftest-static.mjs`:** a `--json` list that is not a string literal (`gh-assoc.mjs`, `prodwatch.mjs`, `pre-tool-use.mjs`, `autochildren.mjs`) is returned in `unchecked` and printed; it does not fail the check and is not counted as checked.
- **`selftest-nightly.mjs`:** the dedupe edits an open marker issue only when its author is the authenticated `gh api user` login; otherwise (or if the login is unreadable) it files a new issue.
- `bin/tests/review-staging.test.mjs` asserts the `commands/deploy-pr.md` jq exclusion filters equal `CI_EXCLUDED_CHECKS`.

## Entry 2026-11-03 — milestone-start gate accepts dependencies already on the lane (#4978)

`unmetDependencies` (`scripts/plan-validate-live.mjs`) treated a closed dependency as merged only when its closing PR's base equalled the dependent's lane, so a dependency merged into staging and reached by a milestone sync was always flagged. It now also fetches the PR's `mergeCommit` and passes when `isAncestor(sha, lane)` holds; `runBatch` (`engine-cli.mjs`) injects that as `git merge-base --is-ancestor <sha> origin/<lane>` (local `<lane>` as fallback). The base-equality fast path stays. A refusal names the commit (`merge commit <sha10> is not on <lane>`) and lists only the true positives; with no known commit the old text is kept. Holding such issues instead of refusing is deferred. Cost: 0 LLM calls.
Cite: #4978.

## Entry 2026-11-03 — `sched show` lists remote (pool) lanes and an unreachable pool (#4964)

Remote lanes never take a host slot (`grant()` returns before `tryAcquire`), so a pool-only batch looked idle in `sched show`. The host registry (`sched.mjs`) now carries additive `remote` (`{key: {pid, batch, repo, issue, sandbox, agent, at}}`) and `pool` (`{batch: {pid, state, reason, at}}`) maps: `noteRemote` / `dropRemote` / `notePool` are fail-open, `release(key)` also drops `remote[key]`, `reclaim` drops a dead dispatcher's entries, and `list()` returns both as arrays. They never touch `slots`, `queue`, `grantOrder` or the cap. `orchestrate.mjs` (optional-chained, so a registry stub without the methods works) publishes a lane when its handle arrives (`onStart`, adopt) and drops it in `done()`; it flags the pool unreachable when a configured `remote.capacity()` returns null or a lane defers with `sandbox.unreachable`, and clears it on the next sample. `schedFromCli show` prints `running N, queued M, remote K`, `remoteLines(st)` rows (`remote #2 o/r batch B sandbox fdrsbx-… agent legion`) and one `pool: unreachable (...)` line. Tests: `sched.test.mjs` "sched show lists remote (pool) lanes (#4964)", `orchestrate-blocked.test.mjs`.

## Entry 2026-11-03 — Live selftest reuses shared polling and marker helpers (#5032)

- **`retry.mjs`:** new `pollUntil(probe, {timeoutMs, pollMs, sleep, now})` returns the first truthy probe value, or null once the timeout passes (the probe runs at least once). `selftest-live.mjs` uses it in `waitFor`, `waitBatch` and `remote.run`; its timeouts and `gh` buffer are named constants. Behaviour is unchanged.
- **`prodwatch-triage.mjs`:** exports `neutralize` (escapes only `<!--`, the marker-forgery guard `prodwatch.mjs` already used) and `findMarked(issues, marker, accept)`, which matches the marker in the `trailerOf` run only. `prodwatch.mjs` imports `neutralize`.
- **`selftest-nightly.mjs`:** uses both helpers. The author check is the `accept` callback, so a marker quoted mid-body is no longer a dedupe hit. The body no longer escapes bare `<` and `>`.
Cite: #5032.

## Entry 2026-11-03 — conformance gaps after one resume are recoverable (#5035)

`conformance.unimplemented`, `conformance.omission` and `conformance.unjustified_deferral` are in `RECOVERABLE_CODES` (`outcome-codes.mjs`), each with a `RECOVER_HOW` note (`lean.mjs`). A batch row that ends `needs-human` with one gets one recovery lane on the `conformance` budget class (`recovery.max_attempts`, `recoveryClassOf`), resuming the pushed lane branch against the frozen contract. The omission and unjustified-deferral notes name the route for an optional, unquantified or non-AC clause: an `add-requirement` / `defer` amendment with a why, so the engine files the tracked follow-up instead of the lane stopping. `conformance.regression`, `guard_broken`, `scope_creep`, `e2e_unverified`, `untracked_deferral` and `preserve_violated` stay terminal. `commands/orchestrate.md` step 3 lists the new codes. Cost: one rerun lane per affected issue, 0 extra LLM calls in the runner.

## Entry 2026-11-03 — admit-and-hold for a dependency commit not yet on the base (#5031)

The milestone-start gate (`engine-cli.mjs` `runBatch`) no longer refuses a launch because a dependency merged but its commit is not yet on the dependent's base. `unmetDependencies` rows now carry `sha` and `kind` (`commit` when a merged PR's commit is missing from the base, else `other`); `commit` rows are admitted, one `held:` line is printed per issue, and `baseWaitOf` is passed to `orchestrate` as `baseWait(n)`. `orchestrate` (`refreshBaseWaits`) re-checks each pending issue every pass (`git fetch origin <base>` at most every 30s per base, then `git merge-base --is-ancestor <sha> origin/<base>`); `isReady` holds it, the batch polls at `pollMs`, and it runs once the commit lands. The waits are stored in `plan.json` `baseWaits` and restored on `--resume` (including a schedd restart); a landed commit releases on the first check. `other` rows (open or unreadable dependency) still refuse, and `--force "<reason>"` is unchanged. Fail-open: an error releases the issue to the engine's own `openDependency` guard. Cost: 0 LLM calls.
Cite: #5031, #4978.

## Entry 2026-11-03 — release review fixes: base waits survive a resume; setup saves never persist a half-read issue

Release review of #5045 (SPEC-1 / BUG-1, CONC-1 / BUG-2). `runBatch` computed `baseWaits` only in the fresh-start pre-flight, so `--resume` and a schedd restart passed `baseWait: null` and held issues ran on a base without their dependency's commit. The waits are now written to `plan.json` (`baseWaits: {issue: [{dep, sha, base}]}`) and restored on resume. In the concurrent setup (#4963), `readDeps` set `deps` before the lane, class and priority, and each completion saves state, so a hard kill mid-setup could leave an issue marked read (resume skips it) with no lane. `deps` is now set last. `docs/OUTCOME-CODES.md` lists the three recoverable conformance codes (#5035). Tests: `plan-validate-live.test.mjs` "keeps the base wait across a resume", `batch.test.mjs` "a setup save never records an issue as read before its lane is resolved". Cost: 0 LLM calls.

## Entry 2026-11-04 — milestone-start gate finds a dependency's lane PR when GitHub links none (#5086)

`unmetDependencies` (`scripts/plan-validate-live.mjs`) read a dependency's merged PR only from `closedByPullRequestsReferences`, which GitHub fills only for default-branch merges, so every dependency merged into a `milestone/*` lane read as "closed but not merged". When the references yield neither a PR on the base nor a merge commit, it now runs `gh pr list --head feat/issue-<dep>-lean --state merged` and applies the same rule to each PR (merged into the base, or `isAncestor(mergeCommit, base)`). A found PR whose commit is not on the base is held (`kind: commit`) as before. No merged PR, a failed lookup or a non-array reply keeps the refusal. `bin/engine-cli.mjs` is unchanged. Tests: `plan-validate-live.test.mjs` "closed with empty closedByPullRequestsReferences (#5086)". Cost: 0 LLM calls.

## Entry 2026-11-05 — milestone-start gate reads the engine record and PR bodies (#5120)

`unmetDependencies` (`scripts/plan-validate-live.mjs`) now has two more sources for a closed dependency whose closing references are empty, tried in order: the trusted FORGE:STATE `mergedTo` record on the dependency issue (same lane, PR reads merged with the recorded commit), then, after the `feat/issue-<dep>-lean` head lookup, merged PRs on the base whose title or body closes the dependency (`gh pr list --base <base> --search "<dep> in:body"`, closing verb required). Every hit goes through the same rule (merged into the base, or `isAncestor(mergeCommit, base)`, else held as `kind: commit`). Each lookup that fails finds nothing, so a dependency with no merged PR is still refused. No change to the review/merge step: lane PR bodies already end with `Closes #N`.

## Entry 2026-11-03 — `sched show` pool state follows only a failed capacity probe (#5048)

`orchestrate()` grant used `notePool(cap === null)`, so an unknown capacity (first admission pass, a provider without `capacity()`, a non-integer sample) showed `pool: unreachable` for a healthy pool. Now only a thrown `remote.capacity()` calls `notePool(true, "capacity probe failed")`; a non-null sample calls `notePool(false)`; null leaves the state unchanged and no call is made when `capacity` is not a function. `engine-cli.mjs` remembers a rejected provider probe (`capFailed`) and throws once on the next sync `capacity()` call; `sandbox-remote` `capacity()` still returns null on failure, and unknown capacity still admits. Tests: `orchestrate-blocked.test.mjs` "#5048". Cost: 0 LLM calls.

## Entry 2026-11-03 — pool 401s name their hop and a 401 on `status` is retried (#5053)

A pool lane could end `engine-error: sandbox status: HTTP 401`. Three hops answer 401 and were indistinguishable: the router (`bin/pool/router.mjs`, forgedock/agent/enroll token), the agent behind it (`bin/pool/agent.mjs`, router→agent token mismatch), and the agent's per-sandbox `credToken` routes. The router relayed an agent's 401 body verbatim and logged no response status.

Now router-origin 401 bodies carry `hop:"router"`, an agent 401 relayed by `launch`/`claim`/`forward` is rewritten to `hop:"agent"` with `agent:<name>`, and the router logs every response with status >= 400 (`rejected METHOD path -> status sandbox=<id> repo=<slug>`; never the query or a token). `httpTransport` puts the hop in the error (`HTTP 401 (agent a1 auth)`; `e.hop`), and a 401 on `status`/`result` of a launched sandbox is `transient`, so `providerLanes` `guard` retries it for `execution.unreachable_window_min` and then defers `sandbox.unreachable` (sandbox kept). A launch 401 is still `sandbox.auth`; its detail says the agent refused the router when `hop` is `agent`.

Open: the ForgeDock-only rate (9.4% vs 0.2%) is not provable from the repo. Candidates: a stale agent token after re-enroll or rotation (router forwards with the old token, so `hop:"agent"`); long ForgeDock lanes polling across a router restart or token reload (`hop:"router"`); a different token resolution on the dispatcher path. Diagnose with `journalctl --user -u computeshare-router | grep 'rejected'` and the hop in `~/.forge/batches/*/log.jsonl`. Tests: `computeshare.test.mjs`, `sandbox-provider.contract.test.mjs`, `execution.test.mjs` "#5053". Cost: 0 LLM calls. See `decisions/5053-pool-401-hops.md`.

Follow-up (#5053): every 401 body also has a `reason` (`router auth: bad or missing token`, `agent auth: router token rejected by agent`, `agent auth: bad sandbox credential`); the transport error reads `HTTP 401 (agent a1 auth: router token rejected by agent)`. There is no repo allow-list in the router, so "repo not allowed" is not a 401 reason.

## Entry 2026-11-03 — release review of #5057: decision stage reverted; pool-down probe, repro env miss, persistent 401

The release review of #5057 found the #4793 issue-watch decision stage (PR #5054) not ready, so it is reverted and #4793 is reopened with the findings. Those findings are a live decision that clears `needs-human` without relaunching a lane, judge errors stored as handled, shadow mode still closing issues, a CONTRIBUTOR-forgeable escalation, and no judge timeout. Three fixes ship:
- **REG-2/CONC-1 (#5048).** The pool transport's `capacity()` throws when the router answers neither `/status` nor `/agents`, and `remoteProvider.capacity()` passes that error on, so the engine wrapper's `capFailed` path really marks the pool down. `capFailed` stays set until the next successful sample, so every caller sees it.
- **BUG-1 (#5020).** The repro head rerun passes the worktree's `repoHas` to `reproEnvMiss`, so a missing module the repo itself tracks is the change's failure, not `env.repro_unrunnable`.
- **BUG-6 (#5053).** A 401 on status or result that outlasts `unreachable_window_min` ends `sandbox.auth` (retry 300 s, capped by `max_deferrals`), not the uncapped `sandbox.unreachable`.

Tests: `sandbox-provider.contract.test.mjs` "an unreachable router throws", `conformance.test.mjs` reproEnvMiss with repoHas, `execution.test.mjs` "#5053 ... ends sandbox.auth (capped)". Cost: 0 LLM calls.

## Entry 2026-11-03 — release review of #5068: decision relaunch in batch/release watches, salvage pick fetches the lane branch

The release review of #5068 (#4793 decision stage, #5063 salvage resume) found:
- **MAT-1 (HIGH).** A live decision in a batch or release watch cleared `needs-human` but no lane ran: the watch kept the issue in `claimed`, which `tick` and the release pass never re-select. `decisionLaunch` (issuewatch.mjs) now requeues a batch watch's claimed issue into its batch (`io.batch.requeue` → `orchestrate --requeue`, which checks the label and reopens a finished batch) and, for a release watch or an issue the watch never took, releases the claim so the next pass selects it. Per-issue watches launch as before.
- **CQ-1.** `issue-watch status` shows a failed decision round (`state.decisionError`), which was recorded but never displayed.
- **MAT-4.** `max_launches` counts a relaunch only when `launch` reports one.
- **MAT-2.** One `gh issue view` failure is an `error` row retried next round, not the end of the round.
- **BUG-1.** `settle` finishes a full live `FORGE:DECISION` whose label clear or requeue failed (clears the label and requeues, no new judge call, not counted twice) instead of skipping it as already handled; vetoed, shadow, escalated and mixed decisions stay handled.
- **BUG-2/SPEC-1/REG-1/CONC-3 (#5063).** `pickSalvage` fetches `origin/<branch>` before the ancestry check when the lane branch exists, so a missing local ref no longer hides the salvage and a stale one no longer resumes a ref behind the remote.

Tests: `issuewatch-decisions.test.mjs` "release #5068 ..." (5), `salvage-resume.test.mjs` lane-branch fetch (2). Cost: 0 LLM calls.

Delta review of #5072: `decisionStep` hands `settle` only trusted comments (OWNER/MEMBER/COLLABORATOR or `ownLogins`), so a forged `FORGE:DECISION` can neither finish nor suppress a decision (SEC-1). `decisionLaunch` checks `inflight` only for per-issue watches: a batch issue stays inflight until its batch reports, so a running batch is requeued and a reported one has its claim released (SPEC-1). A failed salvage pick logs `SALVAGE_PICK_FAILED` instead of dropping the salvage silently (SPEC-2).

## Entry 2026-11-04 — Deferred follow-ups routed by kind: rollup, host, per-batch external, engineering per parent (#5078)
`owner` now means credentials, spend, an account, a third party or a customer. `ownerRoute` (`conformance.mjs`, reached by `owner_route` in `scripts/file-deferred-followups.sh` through `scripts/followup-route.mjs`, so no regex is mirrored; #5197, as a safety net for frozen contracts) sends `owner:orchestrator`, `owner:promote:*` and post-promotion text (after promotion/release, rollout, purge, production-verify) to class post-deploy. That is the rollup: a line, never a new issue. Read-only production data or capture (the `prod_monitor` signals of `execution.mjs`, a read-only prod query), when no external need is named, goes to the new class/bucket `host`. Everything else is external. `bucketProblems` rejects an owner row that is only read-only prod access (`use bucket host`) and a `host` bucket on a post-deploy disposition. The script:
- also accepts the lowest open trusted issue labelled `FORGE_ROLLUP_LABEL` (forge.yaml `followups.rollup_issue_label`, `readFollowupsRollupLabel`) as the rollup when no marked one is open;
- adds host items to the parent's engineering follow-up of the same run (labelled `host-task`), else files one `followup:host` + `host-task` issue, never `needs-human`;
  Superseded by #5207: host items go to ONE host aggregate per batch (`FORGE:HOST_BATCH: <batch>`, `followup:host` + `host-task`, never `needs-human`).
- files class external into ONE aggregate per batch (`FORGE:EXTERNAL_BATCH: <FORGE_BATCH_ID|adhoc>`). It uses the same trusted lookup, lowest-number canonical and post-create re-check as the rollup, adds items under `### #<parent>` with normalized dedup, and is labelled `followup:external`, `external-prerequisite` and `needs-human`. An older per-parent external follow-up is still appended to.
- files class backlog (`[bucket:new-issue]` items, #5188) into ONE issue per batch (`FORGE:BACKLOG_BATCH: <FORGE_BATCH_ID|adhoc>`) through the same aggregate path: trusted lookup, lowest-number canonical, post-create re-check, `### #<parent>` sections with normalized dedup, labels `followup:engineering` and `followup:backlog`, no `needs-human`. `followupClass` (conformance.mjs) maps new-issue to backlog.
  Superseded by #5207: backlog is removed; an engineering/backlog row (explicit class, `[bucket:new-issue]`, no prefix) exits 2 (`engineering deferral: build it in-lane (#5207)`, `DEFERRED_TSV=INVALID`), nothing filed. `verify-now` and ops join the rollup and the external aggregate; no per-parent issue is read or filed for any class (existing ones are left as they are). `forgedock stats --self-filed [--repo R] [--since D]` (`bin/stats/selffiled.mjs`) reports the pipeline-filed share of new issues by kind against a 15% target. Decision: `devdocs/decisions/5207-no-self-filed-followups.md`. `forgedock stats --origin [--repo R] [--since D] [--json]` (`bin/stats/origin.mjs`, #5294) splits issues by origin (requested via a human author, production via the FORGE:PRODWATCH marker, review-finding, follow-up; otherwise unknown) and reports pipeline-originated outcomes (merged, closed-invalid, other-closed, open) and their share of recorded telemetry cost.
`fileFollowups` passes `batchId`/`rollupLabel` as `FORGE_BATCH_ID`/`FORGE_ROLLUP_LABEL`. `track()` records `followups: [{issue, class, count}]` on the lane result, and `formatOutcomeLists` prints one `follow-ups appended: #N (<class>: k item(s) from #a,#b)` line grouped by issue, naming the rollup. Decision: `devdocs/decisions/5078-followup-routing.md`.

Tests: `file-deferred-followups.test.sh` "routing:" / "external batch:" / "engineering:", `conformance.test.mjs` "#5078 owner is narrowed", `decision-engine.test.mjs` "#5078 the batch report lists follow-ups appended". Cost: 0 LLM calls.

## Review roster: Frontend path trigger (forge#5077)
`scripts/review-roster.sh` has a Frontend path trigger (`web/` or `app/` segment, `.tsx`/`.jsx`, `next.config.*`, `middleware.ts|js`) that calls `add_agent Frontend` in every tier except full, like Infra/Auth. Path triggers are additive to the top-2 score baseline, so a staging→main bundle selects the union of every path-triggered domain with no bundle flag. Output contract and the Security floor are unchanged. `commands/review-pr-agents/frontend.md` gains check 11 (dynamic APIs in static/ISR trees).

Tests: `review-roster.test.sh` "forge#5077" block (not-found.tsx in small/medium/standard, bundle union, negative case). Cost: 0 LLM calls.

## Entry 2026-11-04 — Already-fixed close, source-deliverable rule, host block routing (#5080)

- `reproFailures`: `BASE=RAN HEAD=RAN` is `repro_base_green`. With no source change in the diff, `alreadyFixedOnBase` closes the issue as completed, citing the base commit (lean.mjs, finish `already-fixed`).
- `precheck` adds `source_deliverable_untouched`: a diff of only test files cannot close an issue whose contract names a source deliverable (`conformance.unimplemented`).
- A credentials block naming only read-only production access (`READONLY_PROD_RE`, no `EXTERNAL_NEED_RE` match) is host work: on a remote lane `env.capability_remote` (recovered on the host); on a local lane it ends `host-task` (label `host-task`, comment `FORGE:HOST_TASK`, never `needs-human`); `splitEscalation` kind `host`; `prod_monitor` matches `prod_monitor` and read-only production telemetry, and `hostCapabilityBlock` accepts it when no capabilities are declared.
- `formatProbeSummary` prints the cause of an `error` row; `scripts/issue-dedup.sh` needs at least 2 shared tokens.

## Entry 2026-11-04 — Route reachability and e2e-weakening decisions (#5087)
forge.yaml `topology.route_reachability` (`readEnvConfig` -> `routeReachability`) is a repo-supplied command. After validate, `lean.mjs` maps the route handlers the diff adds (`routePathsFromFiles`, `routecheck.mjs`) to URL paths and runs it with them as args; a non-zero exit is a blocking `conformance.unimplemented` (`kind: route_unreachable`) passed to `precheck` as `routeFailures`. Unset = no check.
`validateContract` rejects a `decisions[]` row that replaces an e2e/integration check with mocked tests unless a `forge-probe` acceptance probe is declared (`weakenedE2eDecisions`); the #4726 `[type:e2e]` rule is untouched. `scripts/review-roster.sh` adds Infra for route-handler paths (`route-handler` trigger).
Tests: `routecheck.test.mjs`, `conformance.test.mjs` "#5087".

## Entry 2026-11-04 — One in-lane correction for invalid builder amendment kinds (#5089)
A builder that invented an amendment kind (`deliverable_change` for an impossible deliverable) used to park a finished lane as `conformance.unimplemented`, because the single conformance resume is shared across all failures. `amendmentKindProblems` (`conformance.mjs`) is a shape-only check (unknown kind, missing `path`/`requirement`; normalised slips and informational kinds pass) that returns the same rejection strings as `applyAmendments`, which is unchanged. At the top of `gate()` in `lean.mjs`, before `amend()`/`precheck`, a non-empty result runs ONE builder resume (`amendmentCorrectionPrompt`, `prompts.mjs`, naming the valid kinds and that an impossible deliverable is `defer`), re-reads `result.json`, and continues; it runs at most once per lane (`amendFixed`) and does not use the conformance `resumes` budget. If the builder still emits a bad kind, the existing conformance resume and `conformance.unimplemented` park apply. The builder prompt now says an impossible deliverable is a `defer`, not a new kind. Unknown kinds are deliberately not auto-mapped to `defer` (deferral changes scope; the reviewer judges it).

Tests: `conformance.test.mjs` "amendmentKindProblems (#5089)", `lean.test.mjs` "an unknown amendment kind ... (#5089)". Cost: 0 LLM calls when valid, one builder resume otherwise.

## Entry 2026-11-04 — Pool 5xx and pool usage limits are deferrals, not needs-human or engine-error (#5095)
- `httpTransport` marks 500 `transient` too and honours Retry-After on any 5xx; `retryable` stays 429/503 (capacity). `providerLanes` `startFailed` types any other launch 5xx (or `transient`) as `deferred` `sandbox.transient` (`retryInSeconds` from Retry-After, else 60), capped by `max_deferrals`; `sandbox.capacity` stays uncapped, so a pool answering 500 with free slots cannot hot-loop.
- The no-result path of `wait()` (and `adoptSaved`) checks the lane log tail with `usageLimitInTail` (the lean `usage limit hit; resets at` line, else `runner.mjs` `detectUsageLimit`) and returns `deferred` `rate_limited` with `resetAt`/`resetAtEpochMs`; `deferPolicy` holds it and the breaker never counts it.
- `remoteHoldId(provider)` = `remote:<provider.name>` is the pool account's hold key. `engine-cli.mjs` passes it as `providerLanes({holdId})` (every remote `rate_limited` result gets `backendId: holdId`, the sandbox's own id kept as `laneBackendId`) and as `remote.identity()`. In `grant()`, a remote-placed lane while that identity is held runs local in hybrid (`fallbackLocal`, local account not held; reason `fallback to local: pool usage limit until <ISO>`) or waits for the reset (remote-only). Without `remote.identity` orchestrate is unchanged.

Tests: `execution.test.mjs` "#5095 ...", `limits.test.mjs` "#5095: a held pool account places hybrid lanes local", `sandbox-provider.contract.test.mjs` "#5095 httpTransport". Cost: 0 LLM calls.

## Entry 2026-11-04 — Account rotators (tokenbaton): identity-aware holds, in-lane rotation, paused (quota) rows (#5094)
With `execution.account_rotator: tokenbaton` (`parseExecution` keeps only that value as `accountRotator`), an exhausted account no longer stalls the host. `rotator.mjs` is the adapter: `openRotator` reads `~/.tokenbaton/current` and `live.<n>` on every call (no cache, no writes, fail-open to null), `headroom()` is any account under 95% 5-hour and 100% weekly use (a passed reset counts as 0), `resumeAt()` is the earliest epoch at which one regains headroom, and `accountIdentity(n)` is `backendIdentity` over `CLAUDE_CONFIG_DIR=~/.claude-<n>`, the id a lane on that account records. `laneBackendId(env, rotator)` (`limits.mjs`) returns the rotator's current account, so a hold set for account A no longer blocks admissions once tokenbaton switched to B. In `orchestrate.mjs`, the `rotator` option makes `heldUntil()` return null while any account has headroom and `resumeAt()` when none does (admissions restart on their own). A `rate_limited` lane with headroom sets no host hold (`quotaRequeue`): one on a rotator account (or naming none) reruns at once, at most once per account; a remote sandbox credential that is not a rotator account waits its own reset. The requeue row is outcome `paused` with `quota.resumeAt` and detail `paused (quota) until <ISO>`. The paused attempt's cost and minutes are carried in a per-issue `quota` map (persisted in the batch state) and added once to the issue's next settled row. A still-pending issue at batch end stays `held` (the `--resume`/schedd marker), with `quota` and the carried cost; `formatTable` prints `paused (quota) until <ISO>`. In `lean.mjs`, `callRunner` re-sends the same args (including `resume`, as every `~/.claude-<n>/projects` is the shared session store) when `rotatorRetry` holds (headroom, fewer tries than accounts), logging `PHASE_ACCOUNT_ROTATED`; the deferred result's `backendId` is the rotator's current account. `engine-cli.mjs` wires the rotator into `orchestrate`, both `runCore` call sites and `limits show` (one line per account). Without the key, every path is unchanged.

With #5095, a remote lane limited on the pool account (`backendId` = `remote.identity()`, `remoteHoldId`) still records that pool hold while the rotator has headroom, so hybrid lanes fall back local; no host-account hold is recorded (`limits.test.mjs` "#5094 #5095 a limited pool account").

Tests: `rotator.test.mjs`, `limits.test.mjs` "#5094 rotator headroom" and "#5094 a hold set for identity A", `lean.test.mjs` "#5094 a rotator switches accounts mid-lane" and the rotation-cap/no-headroom cases. Cost: 0 LLM calls.

## Entry 2026-11-04 — Release review of #5103: already-fixed scope, read-only prod routing (#5105, #5106, #5108)

- `alreadyFixedOnBase`: any changed file that is neither a test (`isTestPath`) nor a doc (`DOC_ONLY_RE`: md, mdx, txt, rst, adoc) counts as lane work. A css, json, yaml, sql, vue, tf or html fix with a repro that already passes on base keeps `conformance.unimplemented`; it is never closed as already fixed with its branch dropped.
- `READONLY_PROD_RE` matches whole words only: `ssh <host>-monitor`, `obs-psql`, `prod(uction) monitor`, read-only ... prod, and prod ... query/queries/capture/telemetry/logs. Bare `*-monitor` and "production data" no longer match, and neither does "product".
- `EXTERNAL_NEED_RE` also matches password, passphrase, ssh key, private key, login, sudo, and production writes (delete, drop, truncate, wipe, destroy, modify, migrate, write, update, restart, rotate, remove, grant, alter). These stay external, never host.
- `ownerRoute`: an `EXTERNAL_NEED_RE` match wins over post-promotion wording, so "provide the API key before rollout" is external, not the post-deploy rollup.
- `scripts/file-deferred-followups.sh` `owner_route`/`host_route` call `scripts/followup-route.mjs`, which prints `ownerRoute`/`hostRoute` from `conformance.mjs`: one pattern source, no BSD-grep copy to drift (#5197). A missing node or helper aborts the run (exit 2). `scripts/owner-route-parity.test.sh` asserts the shell functions equal the JS exports and that no `*_ERE` is re-declared.

## Entry 2026-11-04 — Milestone reads page through every milestone (#5084)
Every milestone read in `bin/` goes through `lane.mjs` `listMilestones({gh, repo, state})`: one `gh api repos/<repo>/milestones?state=<state>&per_page=100 --paginate --jq '.[] | @json'` call, one object per line (a whole-JSON array reply is accepted too). `milestonesync.mjs` `syncMilestone`, `drift.mjs` `readMilestone` (and through it `integration.mjs` and `lifecycle.mjs`) and `integration.mjs` `listOpenMilestones` used to read only page 1, so a repo with more than 100 milestones made `milestone-sync` refuse an existing milestone. Tests: `lane.test.mjs` "(#5084) listMilestones", plus page-2 cases in `milestonesync.test.mjs`, `drift.test.mjs` and `integration.test.mjs`. Cost: 0 LLM calls.

## Entry 2026-11-04 — prior-attempts table cells escape backslashes (release review of #5103, CodeQL)

- `scripts/prior-attempts.mjs` `cell()` escapes `\` before `|`, so a title with a trailing backslash can no longer turn `\|` back into a column break in the `## Prior Attempts` table (CodeQL `js/incomplete-sanitization`).

## Entry 2026-11-05 — issue-watch App trust needs a bot signal (release review of #5123)

- `isOwnApp` (`bin/lean/issuewatch.mjs`) requires a bot signal as well as the App slug: the `<slug>[bot]` or `app/<slug>` login form, or `is_bot: true` for the bare GraphQL login. A human account registered under the slug's name (user logins and App slugs are separate namespaces) is never the App, so `trust_app: true` never claims its issues.

## Entry 2026-11-05 — e2e-weakening check is scoped, not co-occurrence (#5116)

- `weakenedE2eDecisions` (`bin/lean/conformance.mjs`) flags a decision only when a weakener (no/not/without/never/drop/skip/replace/downgrade/swap) governs the e2e term within a few words in one clause, or a mocked term is named as the substitute ("mocked tests instead of e2e"). A negated mock ("do not mock", "no stubs") and fake timers/clock no longer count as mocking, so "do not mock the API" and "fake timers, no sleeps" pass. The `forge-probe` exemption is unchanged. Test: `conformance.test.mjs` "#5116".

## Entry 2026-11-05 — e2e-weakening check: double negatives, word boundaries, trailing negations (#5130)

- `weakenedE2eDecisions` (`bin/lean/conformance.mjs`) now blanks negated weakeners ("do not skip the e2e suite", "e2e tests are not replaced") before matching, so they are not flagged. `MOCKED_RE` regains its trailing `\b` and `unit` matches only as a word, so "units", "United" and "Unity" are not mocks. `DROP_AFTER_RE` accepts trailing negations ("not needed/required/run", "no longer runs", "unnecessary"), and the clause-local gap is 5 words ("skip the slow flaky nightly e2e and use mocks"). The `forge-probe` exemption is unchanged. Test: `conformance.test.mjs` "#5130".

## Entry 2026-11-05 — e2e-weakening check: unittest forms and negator scope (#5145)

- `weakenedE2eDecisions` (`bin/lean/conformance.mjs`): `MOCKED_TERM` now matches `unittest`/`unittests`/`unit-testing` and "units" only as the named substitute ("use/using/via/by units"); bare "units", "United" and "Unity" stay unflagged. A bare negator (no/not/without/never) in `DROP_BEFORE_RE` cannot reach the e2e term across a preposition, so "no new fixtures needed for e2e" is not a weakening; the verb weakeners keep the 5-word gap. The `forge-probe` exemption is unchanged. Test: `conformance.test.mjs` "#5145".

## Entry 2026-11-06 — e2e-weakening check: negated verbs keep reaching e2e (#5157)

- `weakenedE2eDecisions` (`bin/lean/conformance.mjs`): #5145 stopped every bare negator at a preposition, so "do not need to run e2e; mocked tests cover it", "not with e2e" and "not for e2e" slipped through. Now only the determiner `no` + noun phrase stops at a preposition (`no new fixtures needed for e2e` stays unflagged); `not`/`without`/`never` and `no need/reason/point/requirement` keep the 5-word gap. The `forge-probe` exemption is unchanged. Test: `conformance.test.mjs` "#5157".
- `weakenedE2eDecisions` (`bin/lean/conformance.mjs`, #5184): the wide `not`/`without`/`never` gap flagged "will not forget to add the e2e test". Negated omission verbs (forget/fail/omit/neglect, with an optional "going/planning/intending/about/trying to" lead-in, `won't` included) are now blanked by `NEG_OMIT_RE` before matching, like `NEG_DROP_RE` (which accepts the same lead-in), so the double negative keeps e2e. The #5157/#5145 cases ("do not need to run e2e; mocked route tests cover it") stay flagged. Test: `conformance.test.mjs` "#5184".

## Entry 2026-11-05 — Domain checks in the lane review; review.enforce_domains (#5099)

- `review-trigger.mjs` `pathDomains(files)` runs the bundled `scripts/review-roster.sh` (`--files-file -`). It maps its path triggers to review domains: frontend-path → frontend, auth-path → auth, infra-path/route-handler → infra, migration-path → database, sdk-path → api. The roster stays the single source of domain path rules. A script failure is `null`: the reviewer runs without domain checks, with an anomaly and `REVIEW_DOMAINS {error: "roster.failed"}`, and the lane is never failed.
- `lean.mjs` `gate()` computes the domains on every gate, logs `REVIEW_DOMAINS {domains, enforced}` when the set changes, and passes them to `prompts.mjs` `reviewerPrompt({domains})`. With domains, the prompt ends in a `<domain_checks>` block: one line per domain, with `DOMAIN_CHECKS.frontend` for the dynamic API in a static/ISR tree (mirrors `commands/review-pr-agents/frontend.md`). Findings are reported as `regressions` rows, which block in shadow (`SHADOW_BLOCKS`). Without domains the prompt is byte-identical.
- forge.yaml `review.enforce_domains` (`engine-cli.mjs` `readReviewTrigger` → `reviewTrigger.enforceDomains`, `parseEnforceDomains`): a touched listed domain makes a shadow lane enforce, sticky. It reuses the #4398 `riskEnforced` path (`domain:<d>` entries) and the decision line "Conformance enforced (review.enforce_domains): …". Default empty. Cost: 0 LLM calls (one prompt block in the existing reviewer call).
Tests: `review-trigger.test.mjs` "pathDomains / domain checks (#5099)", `lean.test.mjs` "#5099 a web/ diff gets frontend domain checks…" and the `readReviewTrigger` test.

## Entry 2026-11-05 — late dependents of a decomposed issue, requeue re-reads edges, capacity fallback_local (#5112)

- `orchestrate` resolves every `deps` write through `throughDecomposed` (`readDeps`, the `drainAdds` / `drainChildren` pending re-reads, the dependency-open union): a dependency that ended `decomposed` with sub-issues is replaced by them (fixpoint), so an issue added (`--add`, resume, body re-read) after its dependency decomposed waits on the sub-issues instead of ending `skipped`. With autoChildren mode `off` nothing is resolved and the dependent is still skipped.
- `drainRequeues` re-reads each moved issue's body and REPLACES its edges (`declared` then `throughDecomposed`); an unreadable body keeps the old edges, an unchanged body leaves them unchanged. The decision text lists changed edges (`edges re-read: #N -> ...`). `--add` of a skipped issue routes through `batch.requeue`, so it gets the same re-read. No `--refresh-deps` flag.
- Capacity fallback: with `execution.fallback_local` (`remote.offlineFallback`), an issue deferred `remote.capacityFallbackAfter` times (`execution.capacity_fallback_after`, default `CAPACITY_FALLBACK_AFTER` = 3) for `sandbox.capacity` is placed local in `grant()` when `remote.headroom()` (engine-cli passes `execMod.hostHeadroom`, now hoisted out of the hybrid `place`) allows it; `ok: false` or a throw keeps it remote. The count is the persisted state key `capDeferrals` (separate from `deferrals`, so `sandbox.capacity` stays uncapped), reset on requeue. One decision per issue on the first fallback. Tests: `batch.test.mjs` "#5112".

## Entry 2026-11-07 — early batch health: BATCH UNHEALTHY alert, refusal record, status lines (#5167)

- `bin/lean/batch-health.mjs` (new): `evaluateHealth(state, {held, refused, config, batchId, repo})` is pure over `state.json`. Its causes are `root-failed` (roots are the issues with no in-batch dependency edge), `terminal-share` (non-merged terminal rows; `merged`/`invalid`/`decomposed` are good ends; `held` counts although it stays pending, at or above `terminalShare` with 0 merged), `stalled` (0 running, pending minus operator-held, not in `setup` and not cancelled) and `refused`. It also returns the exact recovery commands. `runCheck` (#5243) first asks the injected `resolve` (engine: `resolvedOnGithub`, a `gh issue view`/`gh pr view` re-read) which failed rows are already resolved on GitHub (issue CLOSED with a MERGED closing PR, or a `needs-human` row whose label was removed with a `FORGE:DECISION` comment) and passes them to `evaluateHealth` as `resolved`: they are good ends, so they raise no `root-failed`/`terminal-share` cause and get no `--requeue` suggestion; a read failure leaves the row failed. `runCheck` persists `health.json` (`checks`, `last`, `alertedAt`, `alert`) and alerts only when no `alertedAt` is recorded yet. `scheduleChecks` arms unref'd timers from `plan.created`, skipping checkpoints already recorded. `deliverAlert` sends a sink line, a `gh issue comment` on `orchestrate.health.issue` (else on each `--epic` issue), and `runNotify` (`notify.command` through the shell, JSON on stdin, `FORGEDOCK_ALERT*` env, 30 s timeout, never throws). `recordRefusal`/`readRefusals` read and write `<batch root>/refusals.json` (keeps the newest 20, shown for 24 h). `statusLines(root, {batch})` returns the lines for `forgedock status`.
- `runBatch` (`bin/engine-cli.mjs`) prints `health checks: …` after the `batch:` line, arms the timers before `orchestrate()`, clears them in its `finally`, and runs the `end` check after the report is written. The return value, the report and `report.json` are unchanged. Test seams: `deps.healthConfig`, `deps.healthNow`, `deps.healthTimer {set, clear}` and `deps.notify`. The #4659 refusal goes through `alertRefusal` (record plus channels, best effort) before the same error is rethrown. `readHealthConfig(cwd)` reads the flattened `orchestrate.*` keys and `notify.command`. `readDrift` ignores them.
- `forgedock status` (`bin/forgedock.mjs` `batchHealthSection`) always appends the batch-health lines. `--batch <id>` and its value are not taken as the status directory.
- Tests: `batch-health.test.mjs`, `batch.test.mjs` "#5167" (roots engine-error alert once at T+15 on every channel; a healthy batch emits no alert), `plan-validate-live.test.mjs` "#5167" (refusal record), `router.test.mjs` "#5167" (status lines, `--batch`).

## Held subtrees behind a failed root (#5162)

A dependent of a root that ends `needs-human`, `engine-error`, `deferred` or
`budget-exceeded` ends `held` (`blocked by #<root> (<outcome>)`, `root` and
`trigger` = the root, persisted), not `skipped`. The "dependency cycle" label is
reserved for real cycles (`cyclicNodes`, SCC over the pending deps); other stuck
rows name a cycle member. `--requeue <root>` (`REQUEUABLE` now includes
`engine-error` and `held`), a watched root merging, or removal of its
`needs-human` label on a resumed batch (`watchHeldRoots`) returns the root and
its held subtree to pending in dependency order. The report prints one
`held subtree: #<root> (...) holds ...; release: forgedock orchestrate --requeue <batch> <root>` line per root.

## Entry 2026-11-07 — delivered work is closed `completed`; dropped scope is read from labels (#5152)

- Close reasons: a merged change closes `completed` even when `closePlan` says `partial` (the FORGE:TRACKED note names the follow-ups); a builder `already-fixed` verdict closes `completed` (label and terminal `invalid` kept, Close row `issue closed (completed)`); a `decomposition.close_parent` parent closes `completed`. Only `invalid` and the duplicate owner ask close `not planned`. The pre-filter closes `ci-green` and ALREADY-FIXED `completed`, INVALID `not planned`.
- `closedScope` (`engine-cli.mjs`): a CLOSED issue labelled `workflow:merged` is `merged`; `workflow:decomposed` whose trusted FORGE:DECOMPOSED sub-issues are all closed is `moved`; a decomposition with an open or unreadable sub-issue is `moving`; else null. `makeDispatchCheck` reads `state,stateReason,labels`: merged/moved → `{outcome:"merged"}` (satisfied, never final), moving → non-final `invalid` (dependents' lanes wait on the sub-issues), and only an unlabelled NOT_PLANNED keeps `final: true` (#4687). `issueState` (#4725) returns `CLOSED` for merged/moved. Legacy NOT_PLANNED closes are covered because labels decide.
- Builder context (`context.mjs`): `closedResult` reports a closed `workflow:merged` / `workflow:decomposed` link as `completed` instead of its `stateReason`.

## Entry 2026-11-07 — claude login failure ends the lane `deferred` `backend.auth` (#5168)

`callRunner` turns a runner error with `authFailure` (and no usage limit) into `deferCode: backend.auth`, `retryInSeconds: AUTH_RETRY_SECONDS` (900) and `backendId: laneBackendId(...)`; the verifier catch rethrows it rather than recording a verifier failure, and the final `deferCode` finish passes `backendId` so the batch holds that account. Before, the lane ended `engine-error`, used its one relaunch and counted toward the breaker. Tests: `lean.test.mjs` "#5168".

## Entry 2026-11-08 — no account with capacity ends the lane `deferred` `quota.exhausted` (#5236)

`bin/lean/quota.mjs` (`poolExhausted`, `exhaustedDeferral`, `quotaFacts`): `callRunner` asks the rotator for a pick before each unpinned spawn; with none (`account:null`) it never spawns through the tokenbaton shim (which would fall back to the default profile and fail `backend.auth`), emits `QUOTA_EXHAUSTED` and ends `deferred` `quota.exhausted` carrying `resetAtEpochMs` (earliest reset). The same ending replaces the far-reset pause when a limit leaves no account to rotate to, and replaces `backend.auth` when a login failure happens with no account room. `orchestrate.deferPolicy` holds it like `rate_limited`. Account samples (`rotator.mjs`, `pool/router.mjs`): a `live.N` sample older than `SAMPLE_MAX_AGE_MS` (30 min, updated field > 0) is unknown for the 5-hour window and ranks after fresh ones; weekly 100% still excludes until its reset; a newer polled `used.N` percent replaces the 5-hour figure. A failing pick (the rotator throws) counts as exhausted: lean never spawns through the tokenbaton-exec shim, so its default-profile fallback is never reached from a lane; the shim itself is external.

## Entry 2026-11-07 — `forgedock fix-close-reasons` migration helper (#5177)

`fixclosereasons.mjs` `runFixCloseReasonsCli` (wrapper `engine-cli.mjs` `fixCloseReasonsFromCli`, command `fix-close-reasons <owner/repo> [--milestone <m>] [--apply]`): lists closed issues labelled `workflow:merged` / `workflow:decomposed` (`findMisclosed`) and keeps those whose close reason is `NOT_PLANNED`, never one also labelled `workflow:invalid`. With `--apply` each gets one `gh api -X PATCH ... state=closed state_reason=completed` (no reopen window) plus a comment saying the scope was delivered or moved to sub-issues; without it only the would-change list is printed. Idempotent (a `completed` issue is not selected); a failed write is counted and the exit code is 1. The lean lane's own close sites and the #4687 gate are untouched. Tests: `fixclosereasons.test.mjs`. Cost: 0 LLM calls.

## Entry 2026-11-07 — host overload hold, schedd status host field, heavy-step niceness (#5174)

- Remote lanes already run every heavy step in their sandbox: `sandbox-remote.mjs:214` launches `forgedock run-issue` wholesale there (precheck, lane checks, red/green), and host capabilities go through placement plus `relay.mjs`. No per-step sandbox executor was built; the dispatcher load comes from local placements and fallbacks.
- `hostload.mjs` (new): `overloadThreshold(cfg)` (forge.yaml `engine.overload_load_per_core`, default `OVERLOAD_DEFAULTS.load_per_core` = 2, 0 disables), `hostOverload` snapshot `{overloaded, load1, cores, perCore, threshold}` (an unreadable probe is never overloaded), `liveOverload(cfg)` (env `FORGEDOCK_OVERLOAD_LOAD_PER_CORE` overrides; `bin/tests/_tmp.mjs` sets it to 0 so test batches are never held on a busy host), `formatOverload` / `formatHostLoad`, `lowerPriority(pid)` (nice 10 plus detached `ionice -c3 -p` on Linux; never throws).
- `orchestrate` option `overload`: `grant()` holds every non-remote admission while overloaded (notBefore now+pollMs, the issue stays queued), with one `host-overloaded` row per episode. Separate from `admission.mjs` `max_load_per_core` (#4169), which stays off. engine-cli passes `liveOverload(readAdmission(cwd))` when the batch uses the host registry (`deps.overload` overrides).
- schedd `status` adds `host` (the `hostLoad` probe snapshot, null when it throws); `forgedock schedd status` prints `schedd: host_overloaded (...)` or `schedd: host load X.X/core (threshold T)`; `forgedock status` has a `host` row (`unknown` on any failure).
- `heavy.mjs` `runWrapped` passes `spawnInherit` an `onSpawn` hook that calls `lowerPriority` on the gated path only; the child stays in the lane's process group, so signal forwarding is unchanged.
Tests: `hostload.test.mjs`, `schedd.test.mjs` "#5174", `router.test.mjs` re-entry mini-dashboard host row.

## Entry 2026-11-07 — account rotation is detected, stale-aware, and pins the next account (#5205)

- Detection: `rotator.mjs` `rotatorKind({execution, env, which})`: explicit `account_rotator: tokenbaton` wins; `off`/`none`/`false` (`execution.mjs` maps them to `off`) or env `FORGEDOCK_ACCOUNT_ROTATOR=off` disables; unset detects `TOKENBATON_HOME` or the shim (`tokenbaton-exec` / `.tokenbaton/shim/claude`) as the first `claude` on PATH. `engine-cli.mjs` resolves it at the run-issue, batch lane, batch rotator and `limits show` sites. `bin/tests/_tmp.mjs` sets the env switch off for tests.
- Staleness: a window whose reset has passed is unknown, never 0%; `headroom`/`resumeAt`/`pick` take an `exclude` (accounts, or a Map account -> until ms). A stale account is worth one try but ranks after fresh ones; `limits show` prints `(stale)`.
- Pinning: `callRunner` (lean.mjs) reads the run's account from `/proc/<pid>/environ` (`accountOfPid`) on spawn, and keeps polling while the child lives (#5268, `account-watch.mjs` `watchAccount`: 200 ms, up to 15 s, unref'd timers), because the shim exports the account and only then execs claude under the same pid; the limit catch stops the watch and re-reads once before the exclusion, so a late-set account is still marked and excluded; on a usage limit it records `{account -> until}`, calls `markLimited` (best-effort `tokenbaton-ctl mark-limited`), and asks `pick({exclude})` (tokenbaton#3 `--pick --json --exclude` when present, else `live.<n>`). A named account relaunches the same args at once with `bin` = `realClaude()` (`effects.mjs` `makeLeanRunner` per-call `bin`) and `CLAUDE_CONFIG_DIR=~/.claude-<n>`, `PHASE_ACCOUNT_ROTATED {from,to}`; none uses tokenbaton's `earliestReset` for the existing pause/defer. Lane results carry `rotations` and `limited`. A rotator without `pick` (tests' fakes) keeps the #5094 retry.
- Holds: `orchestrate` keeps `limitedAccounts` (persisted in batch state, pruned on expiry) from lane results and passes it as `exclude` to `rotatorHold` and `quotaRequeue`; with no headroom a lane on a rotator account holds until `pick().earliestReset ?? resumeAt()`; lane-reported `rotations` add to `quota.rotations`. No rotator: `now + delay` as before.
- Remote: in a sandbox (`CS_CRED_BASE`, no rotator) a usage limit runs `cs-cred claude --limited <reset s|unknown>` and relaunches while it succeeds (cap `SANDBOX_CRED_RETRIES` = 8); the agent route `POST /sandboxes/:id/creds/claude/limited` drops its claude cache and forwards to the router's `POST /agent/creds/claude/limited`, which excludes the account last handed to that agent until `reset_at` (default now+1h). `pickClaudeLogin` treats stale samples as unknown and skips `limited` accounts; the 429 reset includes their untils. The 200 body adds `account`.
Tests: `rotator.test.mjs`, `lean.test.mjs`, `limits.test.mjs`, `computeshare.test.mjs` "#5205".

## Entry 2026-11-07 — Fix: a pool usage limit rotates accounts; --requeue releases a quota pause (#5203)

Since #5165 the pool router hands each sandbox the lowest-usage tokenbaton login, so the pool identity (`remote.identity()`) is a rotating account set under the dispatcher's `execution.account_rotator: tokenbaton`, not one account with its own reset. `quotaRequeue` takes `poolId`; a `rate_limited` result whose `backendId` is the pool identity reruns at once (`rotations` +1, no pool hold, no host hold, no batch-wide `notBefore`) while the rotator has headroom and `rotations < accounts.length`. When no account has headroom, the hold and the `paused (quota) until <ISO>` row use `rotator.resumeAt()`, the earliest reset across accounts, instead of the lane's own reset. Without a rotator the #5095 pool hold is unchanged. `forgedock orchestrate --requeue <id> N...` now also accepts a quota-paused pending issue (`batch.requeue`) and `drainRequeues` clears its `notBefore` and the pool hold; the wake loop polls while a quota-paused issue is pending. This supersedes the #5094/#5095 sentence that a limited pool account keeps its own hold under a rotator with headroom. Tests: `limits.test.mjs` "#5203 ...", `rotator.test.mjs`, `batch.test.mjs` "#5203 --requeue accepts a quota-paused pending issue".

## Entry 2026-11-07 — upgrade handover: interrupted lanes are logged, requeued and relabelled; remote lanes reattached or reaped (#5204)

- `orchestrate` options `version` (the running engine version) and `onInterrupted(n, {cause, why})` (best effort, errors swallowed). `save()` persists `engineVersion: version`. On a resume the cause is `upgrade v<saved.engineVersion>→v<version>` when both are set and differ, else `dispatcher restart`.
- `requeueLost(n, why)`: when it actually requeues (the issue is neither pending nor settled) it logs one row `{outcome: "deferred", code: "run.interrupted", pr: null, cost_usd: 0, minutes: 0, detail: "interrupted: <cause>; <why>; requeued"}` to `store.log`/`onUpdate` (never to the rows `orchestrate()` returns), records a `requeued (interrupted)` decision and calls `onInterrupted`. It counts no deferral, engine-error, recovery or needs-human, and the issue goes to the head of `pending`; the relaunch resumes from the pushed branch or salvage ref as before. `why` is one of `no adoptable pid or handle`, `adopt failed: <message>` (the adopt error is kept, no longer swallowed) or `the lane ended without a result` / `the adopted lane ended without a result`. #4454 is unchanged: after a halt nothing is requeued, logged or saved.
- A saved running record with `remote: true` but no `pid`/`handle` (the old dispatcher halted before `onStart` could save) is still passed to `adopt`. `providerLanes.adoptSaved` then looks up `ledgerFor(n).entries("sandbox")` for `provider.idFor(n)` with the same provider and uses its `handle`. A live sandbox is reattached (`onLive`, then awaited), an ended one returns its result, and a gone one or one that exited without a result is torn down (ledger released) before returning null, so the lane is requeued and the sandbox is never orphaned. An unreachable sandbox is still kept (#4672). No ledger entry returns null.
- schedd upgrade handover: `startDaemon` options `installedVersion` (default `readInstalledVersion()`: `version` of `../../package.json` of this install, null on error) and `respawn` (default: `defaultSpawn({dir})` unless `unitState()` is `active`/`activating`, where systemd `Restart=always` restarts the unit). The version is recorded at start. On each `lockCheckMs` tick, when the installed version is readable and differs, the daemon logs `schedd: install moved v<old> → v<new>; handing over` once, awaits `close()` (no admission, lanes keep running, lock and socket released) and then calls `respawn`. The new daemon resumes every batch and adopts the live lanes. Any lane it cannot adopt gets the interrupted row above, so this catches `npm i -g` as well as `forgedock update`.
- Label reconcile: engine-cli `runBatch` passes `version: ENGINE_VERSION` and `onInterrupted` (default: `gh issue edit <n> --remove-label workflow:building`, best effort; `deps.onInterrupted` overrides), so no requeued issue stays `workflow:building` with nothing running.
- Post-deploy check `schedd-upgrade-handover` (`.forge/post-deploy-checks.json`, 7d): `forgedock schedd status` lists no batch as `is not hosted`. The live 2 local + 2 remote upgrade is observed there.
Tests: `batch.test.mjs` "#5204", `execution.test.mjs` "#5204", `schedd.test.mjs` "#5204".

`release.mjs` (#5208): `forgedock release`, the resumable staging→default release job (state `~/.forge/releases/<id>/`, steps preflight → release-pr → review → fixes → promotion → post-merge, promotion opt-in via `--merge` / `release.auto_merge`); `release-review.mjs` is a blocked stub until #5212. `release-postmerge.mjs` (#5213) confirms or dispatches the publish run, polls `release.artifact_check` with backoff and opens/merges the `chore/sync-version-<V>` PR (blocked, resumable, when a bound runs out). ADRs `devdocs/decisions/5208-release-job.md`, `devdocs/decisions/5208-release-postmerge.md`.

`realReleaseIo.runningLanes` reads each unfinished batch's state through `openBatch(...).store.load()` (the handle `openBatch` exposes); `release-io.test.mjs` drives it against real batch dirs, since the step tests stub `io`.

`release-review.mjs` `withIntegrityMarker`: a release finding's body gets exactly one `FORGE:BODY-INTEGRITY` marker before `scripts/issue-create.sh` (programmatic mode refuses a body file without one), so the review step can file its findings instead of blocking.

`fixStep` skips a fix issue already closed as merged (`seam.issueMerged`: CLOSED + `workflow:merged`), so a resume after an intake lane or an earlier round merged the fix goes straight to the recut/pick and the delta review instead of blocking on an `invalid` lane; `fileCiIssue` reuses the issue filed for the same release head (exact title) instead of filing a duplicate.

`gateState` (promotion) reads `forge/deploy-gate` from the head's check runs and, when absent there, from its combined commit status: `gate-marker-check.yml` posts the gate as a commit status, so a check-runs-only read never saw it.

## Entry 2026-11-07 — Adaptive lane depth: eligibility signals and the depth report (#5209)

- `light.mjs` `lightEligibility` takes `hotspots` (scripts/hotspots.sh `files` rows `{path, lines, commits_90d, over}`). A predicted non-test file with `over` (beyond `maintenance.hotspot.file_lines`) is a new hard reason `hotspot` (`<path> (<lines> lines)`).
- It also returns `signals` (sorted like reasons), every evaluated signal whether or not it blocks: `repro`|`no_repro`, `files_named` (count of predicted non-test files), `churn_high` (commits_90d >= exported `CHURN_HIGH` = 20), `hotspot`, `risk_path`, `label_docs`/`label_config`/`label_chore` (also `type:`-prefixed), `size_S`|`size_M`|`size_L`|`size_none`. Signals never change verdict, `eligible` or `light`; mode off returns `signals: []`. `renderLiteReceipt` still reads only `reasons`.
- `lean.mjs`: `hotspotsOf` now runs once before eligibility (`namedHot`); the `LIGHT_ELIGIBILITY` event gains `signals`. A light try still sets no `hotFacts`, so its build prompt keeps no hotspot rule (#4451); a full lane and the upgrade path reuse `namedHot`.
- `bin/stats/depth.mjs` (`forgedock stats --depth`): joins each run-log slice's LIGHT_ELIGIBILITY with its outcome (merged/needs-human, first pass, cost, wall/model time, review findings, conformance failures) and post-merge defect signals over gh (reopen, revert, or a fix PR touching the same non-test files within 7 days; a gh failure is n/a, never false). Grouped by verdict and by every reason/signal code.
- Promotion rule (#5052): treatment = light|upgraded lanes, control = eligible full lanes in the same size buckets; cost ratio <= 1.2, wall/model <= 1.3, defect rate <= control; any cell under `--min-n` (10) is `insufficient data`. Flipping `lean.light.mode: on` stays a config decision.
Tests: `light.test.mjs` "#5209", `lean.test.mjs` "#4450 light lane" (#5209 cases), `bin/stats/depth.test.mjs`.

## Entry 2026-11-10 — `stats --depth` defect signal is line-level (#5364)

- The #5209 rule (a later `fix*`/`bug` PR sharing any non-test file within 7 days) flagged 47-80% of AlterLab merges on hot shared files. `bin/stats/depth.mjs` now uses the conformance-outcomes signals, imported from `conformance-outcomes.mjs` (`reverts`, `cites`, `sameHunks`, `isFix`), not copied: reverted, reopened, cited, `same_hunks` (blame of the later fix's old-side lines to the lane's merge commit, via `gitProbes`).
- Merge shas come from `repos/{repo}/pulls/N` (cached); `same_hunks` is null without a local clone, and `defect` is then null (n/a, counted in `defects_unresolved`) unless another signal is true. Defect cache version 2 drops the file-overlap values.
- The #5209 entry above describes the old rule and is history. Tests: `bin/stats/depth.test.mjs`.

## Conformance outcomes (#5210)

`forgedock stats --conformance-outcomes` (`bin/stats/conformance-outcomes.mjs`) reads whether the conformance gate earns its
blocks. For each merged lane PR, it joins the PR's last verdict to four post-merge defect signals inside `--window-days` (default 7):
reverted, closing issue reopened, cited by a later fix, and a later fix touching the same hunks. The verdict is the mode and
failure kinds from `query.mjs` `conformanceVerdicts`, read from FORGE:TELEMETRY, the run logs and the batch rows.
How to read it:
- Each row compares nonconforming-merged with conforming-merged as `defects/n rate [Wilson 95% interval]`. Rows are per repo,
  per mode and per failure kind. A cell under min n (default 20) is `n/a`.
- The last line is the conclusion. "higher defect rate" means the intervals do not overlap. Otherwise it says "no higher
  defect rate shown" or "insufficient data".
- A kind with a higher rate is a candidate to stay enforced. Kinds with no difference are candidates to narrow or to replace
  with property checks (#4149). That decision is separate work.
- Read only: one GraphQL search per 100 PRs plus local `git blame` (same-hunks is `null` outside a clone of the repo). No
  lane-path cost, no LLM. Definitions: `docs/STATS.md`.
- By surface and replay (#5283): PR changed files (first 100 per PR) give each lane PR its surfaces, `domain:*` from
  `pathDomains` (`review-roster.sh`) and `risk:*` from `riskClassOf`; each repo gains `surface <s>` rows (same 2x2, n/a under min n).
  `--replay <pr,...> [--enforce-domains d,.. --risk-paths glob,..]` (window-free) lists per PR mode, shadow verdict, surfaces and
  `enforced` (configured surface hit and nonconforming), `flagged` (hit, but the review would pass: enforce cannot block a passing
  review) or `none`. The global default stays shadow; enforcement is set per repo with `review.enforce_domains`/`review.risk_paths`.

## Entry 2026-11-07 — experiment arm-scoped config overrides (#5206)

A forge.yaml `experiment:` may carry `<arm>.<key>: <value>` overrides. The allowlist is `ARM_OVERRIDE_KEYS` in `bin/experiment.mjs`: `lean.explore`, `lean.explore_model`, `lean.light_mode`, `context_pack` (not `ab`) and `review.verifier`, each with a value check. Any other dotted key or a bad value makes `parseExperiment` return null and `warn` the reason (`readExperiment` writes it to stderr), so an override is never partly applied. `parseForgeYaml(raw, { dottedSections })` keeps dotted nested keys only in the sections named, here `experiment`; every other caller is unchanged. `runCore` begins with `applyArmOverrides(o, o.issue)`, which merges the arm's overrides into `o.explore`, `o.light`, `o.contextPack` and `o.verifier` before any of them is parsed. With no experiment it returns the same `o`. `expTag` is the returned tag, `{experiment, arm, arm_overrides}`, so `RUN_TERMINAL` and `PHASE_ATTEMPT_USAGE` carry the applied overrides (the telemetry seam maps `""` to `none`). `github-source.mjs` keeps them as `run.armOverrides`. `stats --experiment` reports `arms[a].applied`, the runs whose recorded overrides equal the arm's declared ones.

## Entry 2026-11-07 — issue-watch release mode starts the release job (#5214)

`releaseTick` (`issuewatch-release.mjs`) hands the deploy PR it opens or reuses to `io.release.start({repo, pr, tag})` once per release (`rel.job`; a failed start sets `rel.jobError` and never throws, so claims are not stranded). The real io (`issuewatch.mjs`) spawns `forgedock release --repo R` detached, never with `--merge`: promotion stays opt-in via `release.auto_merge`. `commands/review-pr-staging.md` now names `forgedock release` as the default path; the manual spec stays the fallback.

## Entry 2026-11-08 — repro command environment rule and repeat-signature stop (#5232)

`reproPlanNote` (`prompts.mjs`) requires a repro command's environment to come from the repo's lockfile or toolchain. `validateContract` (`conformance.mjs`, `guessedUvEnv`) rejects a `repro_test` or validate command of the form `uv run --offline --no-project --with <pkgs>` without `--with-requirements`: one plan-time correction, no LLM call. In `orchestrate.mjs`, a recovery attempt that ends with the same `env.repro_unrunnable` or `env.tool_missing` code and the same normalized detail (the command) as the run before it is not requeued (`REPEAT_ENV_CODES`); the row detail is prefixed "Environment defect" and the needs-human evidence names the command to run on the host. `env.validate_timeout` is excluded (load-dependent).

## Entry 2026-11-08 — an add after the runner's last pass is re-hosted, not stranded (#5242)
A batch run past its dispatch loop (probe/alert/report tail) still counts as hosted, so `add`/`requeue` answered `hosted:true` and nothing read the entry; `runBatch` then wrote `report.json` over it and `rehostLater` (#4917) skips reported batches, so the issue waited for a manual `--resume`. Now `runBatch` leaves no report while `unrunAdds()`/`unrunRequeues()` exist (unless cancelled), and the schedd (`rehostUnrun`, `schedd.mjs`) hosts `--resume` again once such a run ends, once per distinct set of unrun entries (no loop on a cancel or tripped breaker). The hosted line of `--add` says when the runner next passes.
Cite: #5242, #5000, #4917.

## Entry 2026-11-08 — intake host triage (#5250)

`intakeHostWork` (`conformance.mjs`) reads the issue's `## Acceptance` checklist at intake. When it is non-empty and every item needs live production measurement or a real-browser capture (`LIVE_EVIDENCE_RE` or `READONLY_PROD_RE`, no `EXTERNAL_NEED_RE` match), `runCore` (`lean.mjs`, before the worktree step, skipped on resume or recovery) adds `host-task`, posts `FORGE:HOST_TASK` and ends `host-task`: no builder runs. One code-shaped item keeps the code lane, and backlog aggregates (`FORGE:DEFERRED_FROM` / `FORGE:BACKLOG_BATCH`) are exempt. Cost: 0 LLM calls.

## Entry 2026-11-08 — finding lifecycle resolved at close (#5254)

`resolveFindingLabel` (`findinglabel.mjs`) runs after `label("merged")` (not when kept open) and after an `invalid` close in `lean.mjs`: a `review-finding` issue goes `needs-validation` → `validated` (merged) or `false-positive` (INVALID) through `io.validateLabel` (`effects.mjs`, `transition-label.sh --validate`). Best effort: a failure is a `T.anomalies` entry. `scripts/backfill-finding-labels.mjs` applies the same mapping to old closed findings (`workflow:merged` → validated; `workflow:invalid` or not planned → false-positive); dry run unless `--apply`.

## Entry 2026-11-08 — doctor I4/I6 stop flagging lean lanes, lane PRs and dependency bots (#5255)

`scripts/doctor-pipeline-state.sh` I4 counts `FORGE:BUILDER|CONTRACT|PLAN|WORK-ON` as builder evidence (lean lanes never write `FORGE:BUILDER`) and skips `workflow:building` issues updated within `--stuck-hours`, so a fresh lane is never CRITICAL. I6 fetches `author,headRefName` and skips PRs whose head is `feat|fix/issue-N-lean`, whose author is the pipeline app (`rapiercraft-forgedock`) or a dependency bot (`dependabot`, `renovate`); a hand-made PR with no `FORGE:` marker still warns. Output shape, exit codes and fail-open `add_skip` are unchanged. Tests: `bin/tests/doctor-pipeline-state.test.mjs` (fake `gh` on PATH).

## Entry 2026-11-08 — release rehearsal step (#5253)

`release.mjs` runs `RELEASE_STEPS` preflight, release-pr, review, fixes, **rehearsal**, promotion, post-merge. `release-rehearsal.mjs` `rehearsalStep` runs forge.yaml `release.rehearsal_command` (flat keys `rehearsal_command`/`_timeout` seconds/`_blocking`, `parseRehearsalConfig`; the forge.yaml parser reads two levels) through `io.rehearse` (host `sh -c`, captured output, configurable timeout) on the release-PR head. Unset: the step is skipped with no `gh` calls. A failure files one open `release-blocker` issue per head (dedup by the hidden `FORGE:RELEASE_BLOCKER head=<sha>` marker; a rerun comments) with the output tail and head SHA, and returns `{stopped:true}` so promotion is held and `--resume` retries; `blocking: false` only records. The result lands in `state.steps.rehearsal` and a `FORGE:REHEARSAL` section of the release PR body. Config: `docs/CONFIG.md` `release`. **Snapshot mode** (#5276, `release.mode: snapshot`, default `freeze` = the original hold): `release-snapshot.mjs` `cutSnapshot` pushes `release/<id>` at the staging tip (refused while any branch under the pattern prefix exists: one release in flight) and `state.release` holds the `FORGE:RELEASE` record (snapshot, range, bundle, issues, picks), mirrored as a hidden marker in the PR body by `writeRecord`. Preflight neither refuses nor sets K=1, so `state.held` stays empty. `fixStep` then calls `pickFixes` (merged staging PRs labelled `release-blocker` or closing a blocker issue, built with `merge-tree --write-tree` + `commit-tree`, no working tree, `(cherry picked from commit X)` trailer, picks saved in state before the push, a conflict blocks) or `recut` (force-move to the staging tip, picks reset). `checkChain` is the verifier: snapshot on staging, head = snapshot + exactly the recorded picks, linear, each tree equal to a fresh cherry-pick of its staging commit; promotion runs it with `exact` and stops otherwise; `forgedock release verify <sha>` exposes it. Post-merge deletes the branch.

## Entry 2026-11-08 — cancel confirms or reports each lane, releases its lease; dead-lease takeover; one batch per issue (#5241)

`--cancel --stop-remote` no longer fires once and forgets. `orchestrate.mjs` `stop` records whether `stopLane` accepted the stop,
re-sends a refused one every `stopRetryMs` (15 s) and, when a lane outlives `stopTimeoutMs` (120 s), posts a `cancelled` row and
decision naming it and why (`rec.stopNote`, set by `providerLanes.stopLane` from `remoteProvider.stopReason`: no transport stop,
404/405, error); the pass keeps polling while a stop is unconfirmed. When a lane of a cancelled batch settles, the `releaseLease`
seam (engine-cli: `lanelock.clearLease` through the projector) clears the issue's lease unless a live lane of another batch runs the
issue (`batch.batchesOwning`). A lane that never ends keeps its lease and is reported. `--requeue`/`--release` of a pending issue
waiting out a deferral (`notBefore`) while a cancelled batch of the repo owns it (`batch.cancelledOwners`) is accepted: the lease is
cleared, `drainRequeues` drops the wait and the next pass relaunches it. A fresh `orchestrate N...` skips each issue pending or
running in another active batch of the repo (no report, no cancel, state saved within 3 h) with a line naming the batch, and refuses
when none is left; `--force "<reason>"` starts them anyway. Cost: 0 LLM calls.

## Base red (#5239)

`bin/lean/basered.mjs` handles a `verify.invariants` guard that still fails. `lean.mjs` `guardRed` runs it once on a detached worktree of the base (`runOnBase`, same pattern as `guardgate.mjs`), `classifyBaseRed` splits base-red from lane-own, `attribute` names the newest base commit touching the files the failure names (`git log -1`) and its issue (`issueOf`), and `reportBaseRed` comments on or reopens that issue (or files one). A base-red guard ends the lane `deferred` with `base.red` (retry 900 s), spending no builder round; a lane-own failure blocks with `ci.red` (`guardFailing`, switch `verify.guard_block`, default on). `postMergeGate` also runs the invariants on the base-synced merged tree and returns the `stuck` ones. Without `invariants` nothing changes.

## Entry 2026-11-08 — Checklist close gate and inert-rollout note (#5240)

`closePlan(contract, {title, review, issueText})` now also judges the issue's unticked `- [ ]` items for non-investigation
issues: an item whose contract quote matches (`matchCriterion`) and whose requirement is a `deliver` row the review did not
mark `implemented`, or a `defer`/`post-deploy` row with no tracking issue, makes the plan `partial` (`checklist: true`,
`open`, `unticked`). The close step then leaves the issue open (not `completed`) and posts a FORGE:TRACKED "Left open:
partial" note listing the criteria and tracked follow-ups. Items no quote matches are not judged here (issue_coverage owns
coverage); a skipped review judges dispositions only; investigations keep their #4398 behaviour (close `completed`).
`activation.mjs` `rolloutModes(cfg, changedFiles, read)` reads the current mode of registry flags (forge.yaml
`rollouts.files`) that the changed files name; a non-live mode (shadow/off) adds a trajectory decision "Inert in
production" and a line in the partial note, so the production outcome is never claimed. Intake triage of
live-measurement issues is not part of this change.

**Relaxation gate (#5237).** `relaxation.mjs` `analyzeRelaxations` reads `git diff -U0 base...HEAD` when the lane touches a declared `review.risk_paths` glob (`riskPathHits`; built-in risk words do not count). In non-test risk files it flags added accept/rescue/allow branches (`class: accept`) and removed deny lines (`deny_removed`), and counts negative assertions added in changed test files. `relaxationFailures` is a blocking `conformance.unimplemented` (kind `relaxation_untested`, passed to `precheck` as `relaxationFailures`) when the diff adds fewer negative assertions than relaxed files. The detection is syntactic and per file, not per semantic rescue class. A relaxation lane also gets a `<relaxation_checks>` block in the reviewer and verifier prompts (counterexamples, negative corpus), and the independent verifier (#4397) runs in enforce for it even with `review.verifier: off`, which is the second reviewer. Run log: `RELAXATION_DETECTED {files, count, negatives}`. No new forge.yaml key; 0 LLM calls for detection.

## Entry 2026-11-08 — release promotion reads the PR state first (#5266)

`release.mjs` `promotionStep` now runs `gh pr view --json state,mergeCommit,headRefOid` before any gate or opt-in check. A `MERGED` PR (merged by hand after the default GATE_PASS stop, or by a `--merge` run that crashed after `gh pr merge`) returns `{merged:true, alreadyMerged:true, mergeCommit, head}` so `--resume` reaches post-merge with the merge sha; it never gates and never calls `pr merge` again. A `CLOSED` PR returns `{stopped:true}`. An `OPEN` PR keeps the existing flow (GATE_PASS, opt-in stop, deploy-gate, `--match-head-commit` merge).

## Entry 2026-11-10 — Actions-minutes budget and `ci.mode` placement (#5278)

`ci-budget.mjs` detects repo visibility, plan and month-to-date Actions usage across the owner (billing usage API, runner-rate weighted), projects the month and resolves `ci.mode` (`remote|local-first|local-attested|auto`, default `auto`; flat keys `mode`, `monthly_minutes`, `reserve_pct`, `included_minutes`, `plan` because the forge.yaml parser is one level deep). Public repos are free and never auto-switched; an unreadable billing API stays `remote`. The effective mode is recomputed from GitHub each time; `~/.forge/ci-budget/` (FORGEDOCK_CI_BUDGET_DIR) holds only rebuildable caches (last effective mode, parity rows, seen repos). `engine-cli.mjs` `readVerify` coerces verify.mode `ci|hybrid` to `local` under `local-first`/`local-attested` (for `auto`, the cached resolution); the batch report and `forgedock release` print one budget line that says when `auto` switched. `checkFromCli` appends a parity row (local green -> remote red hit rate, paired later from check runs by `forgedock ci budget`) and, in `local-attested`, posts the `forgedock/ci-local` commit status. `forgedock ci budget [--digest] [--propose] [--set-mode] [--budget]` is the CLI; setup skill: `commands/forgedock-ci-setup.md`.

## Entry 2026-11-10 — host preflight, draft release PR, mark ready (#5277)

`release-preflight.mjs` adds two optional steps to `RELEASE_STEPS`: `host-preflight` (before `release-pr`) and `mark-ready` (after `fixes`). Both read forge.yaml `release.preflight_command` (flat keys `preflight_command`/`_timeout`/`_blocking`, `parsePreflightConfig`, `readReleaseConfig().preflight`) and run it through `io.rehearse` on the host. Unset: both return `{skipped:true}` and `runRelease` does not record them (`OPTIONAL_STEPS`), so state and `gh` calls are unchanged. Set: `host-preflight` runs on the staging head (`gh api commits/<staging>`) and a failure files one `release-blocker` per head+kind (`fileBlocker({kind:"preflight"})`, marker `FORGE:RELEASE_BLOCKER head=<sha> kind=preflight`) and stops, so no PR is opened on a failing head; `releasePrStep` then opens the PR with `--draft`; `fixStep` re-runs `runHostPreflight` on the new head before each delta review; `mark-ready` re-runs it on the final head and calls `gh pr ready` only on a pass. Actions CI is opted out of drafts by the repo (`docs/CONFIG.md`). `commands/deploy-pr.md` Phase 3 counts `pending` as not-passed: unfinished-only checks print `CI gate: PENDING` and defer to Phase 5, never PASSED.

## Entry 2026-11-10 — Live-deferral close gate and real-browser check for interactive UI (#5285)

`activation.mjs` `liveDeferralBlocks(contract, modes)`: when `rolloutModes` says a touched rollout flag is live (default-on) and a
requirement is deferred for live/post-deploy verification (bucket post-deploy/verify-now/host, or live-acceptance wording), it returns
`[{id, flag}]`. `closePlan({liveBlocks})` then returns `partial` with `liveBlocked`; `lean.mjs` keeps the issue open and posts a
`FORGE:TRACKED` note naming the blockers (a default-off rollout still ships with its deferral). `e2e.mjs` `uiInteractiveChanged(files)`
(dialog/CTA/layout component files) makes `e2eWanted` run the repo's e2e (CI label or workflow, never a local browser install). With no
trigger configured the skip is a trajectory decision; on a `review.risk_paths` hit `precheck`'s `uiBrowser` input yields
`conformance.e2e_unverified` kind `ui_browser_unverified`. Without `rollouts.files` default-on cannot be detected and the gate does not fire.

## Entry 2026-11-10 — New-user journey selftest (#5305)

`selftest-journey.mjs` (`forgedock selftest --journey`, routed from `selftestFromCli`) runs stage 1 (packed tarball via `npx --package`, in Docker or a node+git-only PATH; cases banner, help, doctor, unknown command; assertions for false success wording, doctor exit and wording, jargon errors, placeholder `forge.yaml` values; scrubbed output compared with `bin/tests/fixtures/journey-snapshots`) and stage 2 (sandbox repo: `demo`, `doctor`, `demo --run` to a merged PR; records time to first merge and prompts; always cleans up; skipped when gh or claude is unavailable). All process access goes through `io`. `selftest-gate.mjs` adds the separate `FORGE:JOURNEY` marker, posted with `--pr`; `review-staging` does not read it, so it never replaces the `FORGE:SELFTEST` gate result. Snapshots are regenerated with `--update-snapshots`. Docs: `docs/SELFTEST.md`.
Cite: #5305.

## Entry 2026-11-10 — production parity beyond ingress (#5284)

forge.yaml `topology.prod_parity` (block map `{path glob: command | "note: how to verify"}`, read by `readEnvConfig` → `prodParity`) generalises `route_reachability` (#5087) to runtime build mode, DB role/ownership and env scope. `bin/lean/prodparity.mjs` matches the lane's changed files to the globs; a command rule runs once with the matching paths (non-zero or rc 127 → `conformance.unimplemented` kind `prod_parity_failed`), a note rule needs `parity: [{surface, justification}]` in the result file (else kind `prod_parity_unjustified`). Failures enter `precheck` as `prodParityFailures`, beside `routeFailures`. The plan prompt lists touched surfaces and the review rubric treats a surface with no evidence as not delivered. No key, no check. Record: `devdocs/decisions/5284-prod-parity.md`.

## Entry 2026-11-10 — dispatch-stall watchdog, fail-loud add, first-hour report (#5314)

The schedd (`bin/lean/schedd.mjs`, `watchBatches`, every `FORGEDOCK_SCHEDD_STALL_CHECK_MS`, default 60s) polls every
daemon batch with `evaluateDispatchStall` (`batch-health.mjs`): ready pending issues (not held, no future retry-at,
in-batch dependencies ended well), a free lane and no progress for `FORGEDOCK_SCHEDD_STALL_MIN` (default 10) minutes.
An unhosted batch is re-hosted (`--resume`, once per ready set); a hosted-but-silent one, or a re-host that did not
help, records one needs-you item in `health.json` (`stall`, `alertedAt`; shown by `forgedock status` and `sched show`).
Cancelled, reported and tripped-breaker batches are skipped. Every daemon batch also gets `first-hour.json` and a line in
`batch.log` once (at T+60 or when it ends): dispatched / running / merged / stuck and why; `sched show` prints the summary.
`--add` / `--requeue` exit non-zero (`batch.not-hosted`) when no schedd hosts the batch after queueing; `--resume <id> N...`
and the runner's auto-add stay soft.

## Entry 2026-11-10 — issue-watch parity with the owner's bash intake watcher (#5313)

`issuewatch-parity.mjs` holds the pure helpers: `isPullRequest`, `closingPrIssues` (open PRs' `closingIssuesReferences`), `skipLabelHit` with `DEFAULT_SKIP_LABELS`, `releaseInFlight` (a `~/.forge/releases/<id>/state.json` with no end `status` and a fresh mtime, since `runRelease` writes `status` only when the job ends) and `watchLiveness`. `planClaims` and the release pass skip PRs, issues with an open closing PR and `skip_labels` (default for `mode: batch`); a `search` selecting PRs fails at load. `runWatch` stamps `state.heartbeat` every pass and, with `release_pause` (default in batch), writes `state.paused` and skips the pass while a release job runs; the next pass resumes. `tick` re-checks `batch.reported` right before `batch.add` so a finished batch is never added to. `status` prints running/paused/stale/done with the heartbeat. Cost: 0 LLM calls.

## Entry 2026-11-10 — lanes no longer share mutable state (#5333)

`stagestamp.mjs`: the builder writes `forge-stamp: issue=N contract=HASH` as the first line of each `.forge-lean/*.md` stage note (rule added to the builder prompt in `prompts.mjs`). `readStage` (`lean.mjs`) verifies it: a note stamped for another issue or contract (e.g. a `git stash pop` that applied another lane's files) is not posted (`STAGE_STAMP_MISMATCH` event plus anomaly), the comment is rendered from `result.json` instead, and `recheckStages` re-reads it after the builder's final turn. A missing stamp is accepted. `branchlock.mjs`: one writer per lane branch, a lock file in the shared git common dir (`forge-branch-locks/`, atomic create, pid liveness, stale takeover); `builderOnce` holds it, waits `branchLockWaitMs` (default 10 min) for another session (fix-up beside recovery), then defers `host.busy`. `builderOnce` also defers `run.interrupted` when the worktree is gone. `teardown` waits for the builder pids to exit (`waitPidsExit`: SIGKILL after a grace period) before `worktree remove`; a survivor keeps worktree and branch (`TEARDOWN_KEPT`). The builder env carries `FORGE_LANE_WORKTREE=1`; `bin/hooks/pre-tool-use.mjs` then denies `git stash` push/pop/apply/drop (list/show allowed) and names the WIP commit. Post-deploy check `implementation-comment-file-overlap` (`.forge/post-deploy-checks.json`, 7d).
Cite: #5333.

## Entry 2026-11-10 — env.tool_missing: remote tool check, best validate result, per-service lockfiles (#5331)

`toolplace.mjs` (pure): `toolMisses` keeps the validate preflight's executable/module misses (never an unset env var) with their validate ids; `lackedTools` names the frozen contract's tools a target is known to lack. At the remote pre-build check `lean.mjs` ends a lane with `env.tool_missing` (`REMOTE_TOOL_MISSING`) before the builder starts, and `orchestrate.mjs` `placeOf` places a lane local when `remote.contractOf(n)` names a tool in `remote.lacks` (both optional; recovery placement and `ENV_CAPABILITY_REMOTE` are unchanged). `validatebest.mjs` (pure) keeps the best result per validate id: a 126/127 row never replaces a pass. `buildResumeDigest` uses it over every trusted FACTS record (takes `head`), marking passes "already passed"; it stays pure and byte-capped. `conformance.mjs` still re-runs all ids. `depcache.mjs` `detect` also finds `services|packages|apps/<name>/uv.lock|poetry.lock` when the root has none (cap 8); each is prepared in its own dir, so those repos are no longer "skipped: no lockfile". Root-lockfile detection and keys are unchanged.

## Entry 2026-11-10 — feature-level acceptance: every epic carries a runnable journey (#5336)

`acceptance.mjs` is deterministic (no model call). An epic declares a top-level ```` ```forge-acceptance ```` block: `journey:` sections with probe keys `run`, `pass`, `timeout` and `when: milestone|post-deploy` (`parseAcceptance`, `validateEpic` = the creation gate behind `forgedock acceptance check`; `probe.mjs` exports `fencedBlocks` for the shared fence scan, and the declarer is `isProbeDeclarer`, fail closed). `runMilestoneJourneys` runs the milestone journeys on the branch head and posts `FORGE:ACCEPTANCE` on each epic (head, time, site, per-journey result). `gateMilestone`/`gateByRef` (`forgedock acceptance gate --stage ship|close`) block on a red journey, a journey never run on the current head, an epic with no journey, or (close) a post-deploy journey not yet passed; a milestone without an epic is not gated. At `--stage close` after ship the milestone branch is deleted, so an unreadable head does not fail closed: the last milestone-site `FORGE:ACCEPTANCE` record must pass every milestone journey (#5393). `review-staging --summary` calls it for a `milestone/<slug>` release PR (`acceptanceBlock`): blocked journeys, or a test-gate SKIP on a milestone with an epic, is BLOCK DEPLOY. `makeIntegration({journeys})` runs `makeJourneyRunner` (detached worktree of the milestone branch) after each child merge; `engine-cli` wires it for real runs only. The close.md C3 parent close and the `milestone` ship/close specs call the gate.

## Entry 2026-11-10 — Interrupted runs record the usage they streamed (#5334)

A builder session cut off before its `result` line (host kill, idle kill, timeout, lane limit, or an engine SIGTERM
mid-call) used to record nothing: `RUN_TERMINAL` showed `model_ms: 0` and no turns. Now `runCliBackendAsync` attaches the
streamed `usage`, `turns` and `toolUses` to every stream kill (`CLI_IDLE`, `CLI_TIMEOUT`, a host kill's
`CLI_BACKEND_FAILED`) and fills the caller's `session.snapshot()`. `lean.mjs` records one `PHASE_ATTEMPT_USAGE` per
killed session (`killedAttempt`): from the error on a kill branch, or from `flushInflight()` at the start of `finish`
on a signal, always before `RUN_TERMINAL`; `err.usageRecorded` prevents a double count. A killed stream has no CLI
cost, so `cost_usd` is estimated from tokens (`runner.mjs` `estimateCostUsd`, per model family; unnamed model = the
middle tier) and flagged `cost_estimated: true`. A kill that streamed nothing carries `usage_unknown: true` (turns
`null`), and `RUN_TERMINAL` copies the flag; never a silent 0. `forgedock stats` needs no change: it sums
`PHASE_ATTEMPT_USAGE` rows.

Run-file naming is a contract for readers: `~/.forge/runs/<owner>__<repo>__<issue>.jsonl` (`runLogPath`); the bare
`<issue>.jsonl` is legacy and collides across repos. Parse with `/(?:^|__)(\d+)\.jsonl$/` as `stats/local-source.mjs`
does, and take the repo from the RUN_START slice, never from the number alone.

## Clean first review (#5345)

`forgedock check` also runs `selfreview.mjs` `selfReviewFindings` (the deterministic subset of `precheck()`, plus a
preserve-touch check): findings land in the `review` section of `.forge-lean/self-check.json`, make `ok` false, and a
fixed result with a red record gets one builder resume (`SELF_CHECK_RED`) before any reviewer runs. An incomplete reviewer
reply whose gaps are row ids (`reaskable()`) is repaired in place by `mergeReviewRows`, never a new review round.
`RUN_TERMINAL` carries `first_review` (first gate state, finding kinds, rounds, `incomplete`, change type, risk surfaces);
`forgedock stats --first-review` reports the clean rate by repo, change type and risk surface, maps finding kinds to
contract sections, and flags long-clean cells as light-lane candidates (never a risk surface, #5283). Recurring finding
classes reach the builder as `FINDING_PITFALLS` in the implement prompt.

`selfReviewFindings` applies the `result.json` typed amendments (`applyAmendments`, problems ignored — the engine gate
reports them) to the frozen contract first, so an `add-deliverable` file is not `scope_creep` and an amended preserve
path is authorized (#5380).

## Sibling awareness (#5340)

- **Context pack default.** `resolveContextMode` (`context.mjs`): an explicit `engine.context_pack` (shadow|off|on|ab) always wins; unset, a lane with a milestone or a parent epic runs `on`, every other lane stays `shadow`. `parseContextPackConfig({})` is unchanged. Sibling facts (same parent or milestone, at most `MAX_SIBLING_READS`) rank before other lanes' facts, after the declarations of in-flight siblings.
- **Shared surfaces.** `engine.shared_surfaces` in `forge.yaml` lists globs (comma scalar or block list). After the contract freezes, a lane whose deliverables touch one takes a one-slot host reservation per surface (`surfaces.mjs` `claimSurfaces`, over `seqlease.mjs`; key spans every lane branch, so the milestone lane and the default branch share it) until teardown, and declares what it adds (`declare`/`declared`/`undeclare`, `surface-declared` under the sched dir). `glob => command` marks an append-only registry: never reserved, and the builder is told to run the command instead of hand-editing. The merge-gate sequence check also runs against the default branch(es). No declaration, no behaviour change; a failed lease is fail-open.
- **Prerequisite pull-in.** `orchestrate` calls `prereq.mjs` `openPrerequisites` after reading dependencies and adds an open, non-`needs-human` prerequisite outside the batch, so `edges()` orders it first. The `dependency-open` admission refusal and requeue remain the fallback.

## Walking skeleton first (#5337)

- **Validation.** `bootstrap-validate.mjs` takes a plan flag `skeleton: true` (becomes the `skeleton` label, applied by `bootstrap-create.mjs`). Milestone 1 needs exactly one skeleton issue whose text names a #5336 journey (`missing-skeleton`, `multiple-skeletons`, `skeleton-misplaced`, `skeleton-no-journey`); every other issue depends on it transitively (`not-behind-skeleton`; the spike key and needs-human issues are exempt). `plan-validate-live.mjs` checks the same per open milestone from the `skeleton` label and `Depends on`, exit 1 on violation. The greenfield scaffold (CI, harness, dependency bootstrap, first build) is spec text in `commands/bootstrap.md`, not mechanically checked.
- **Admission.** `makeIntegration({skeleton})` (on for real runs in `engine-cli`) loads open `skeleton` issues in `prime()`; `holds(n,{lane})` refuses every sibling of the lane until the skeleton merges. The `holds` signature is unchanged.
- **Journey gate.** `makeJourneyRunner` resolves `{summary, red, ran, head}` (a string when nothing ran). A red result files or updates ONE `integration-red` issue (marker `FORGE:INTEGRATION:journey:<slug>`) naming the last merged PR and the PRs since the last green run, and holds admission; a green run closes it. `prime()` reloads that hold. A red journey before the skeleton merges files nothing.
- **Metric.** `firstMergeAt` and `firstJourneyGreenAt` are stored in the milestone's `FORGE:INTEGRATION` block and shown by `integration status`.

## Release #5379 review follow-ups (#5382)

- **Journey hold exit.** `holds(n,{lane})` admits the open `integration-red` issue itself (it is the fix); a merge that lands while a journey run is in flight queues one rerun (`journeyAgain`) so a green rerun clears the hold.
- **Epic transfer.** `closePlan` with `liveBlocks` also reports `transferred` and `transfer` (the e2e/manual post-deploy rows); `lean.mjs` transfers `closing.transfer ?? closing.open`.
- **Protection read.** `requiredChecksRead` returns `{checks, unreadable}` (non-404 failure = unreadable); `review-staging` `requiredSet` then yields `[]`, so every red check blocks (fail closed). `requiredChecksFor` still returns the names.
- **Cleanup.** `formatSelfReview` and `holdEdges` removed (no callers); `budgetAlerts({facts, seen})`; shared `runMinutes` in `ci-budget.mjs`.

## Entry 2026-11-10 — release reviewer sessions pin the job's forgedock (#5388)

- **PATH shim.** `release-review.mjs` `realSeam.runAgent` passes the runner an env whose PATH starts with a lazily made tmp dir holding a `forgedock` shim that execs `process.execPath ROOT/bin/forgedock.mjs`, so briefs, spec-panel prompts and the test gate run this build (`--post-reviewer`), not the globally installed CLI. The dir is removed on process exit; `makeRunner` is an injection point for tests.
- **Session failures.** `reviewRound` records each failed reviewer session (domain, exit, last lines) instead of swallowing it, and appends `session failures: ...` to the `finalize stopped` and degraded-panel `fail` reasons.

## Entry 2026-11-10 — release/* PRs skip the spec-size budget; regex escapes (#5396)

- **Release skip.** `check-spec-size.sh` (and the `spec-size-budget` job `if:` in `check-commands.yml`) now skip same-repo PRs to `main` whose head is `staging` or `release/*`; forks, non-main bases and missing `PR_SAME_REPO` are still budgeted. CI runs the script from the base ref, so the job `if:` is what takes effect first.
- **Backslash escape.** `mechfix.mjs` `word()` escapes `\` as well as `$` when building the symbol regex (CodeQL incomplete-escaping).
- **Barrel others (#5406).** `renameDuplicates` reads each detector `others` file: one that imports the name (ES `import`/`export … from` clause incl. default/aliased, or python from-import) or cannot be read sends the dup to `remaining` with nothing rewritten, since a barrel (import then export) is listed as a declarer but breaks when only the declaring file is renamed. A genuine declaring other (no import) still permits the rename; the detector output is unchanged.
- **Deploy gate re-run (#5417).** `release.mjs` promotion: with GATE_PASS present and `forge/deploy-gate` pending/absent, `retriggerGate` runs `gh run rerun` on the newest `gate-marker-check.yml` run for the head (the bot comment never triggers it), then `awaitGate` polls `gateState` (12 × 10 s) until success/failure, before the opt-in stop and merge. A failed rerun is ignored; a gate still pending stops with "after 12 polls".

## Entry 2026-11-11 — user docs gate for user-facing surfaces (#5419)

- **Config.** forge.yaml `docs: {required_for, paths, registries, surfaces, link_prefixes, link_check}`; unset `required_for` = off (`parseDocsConfig`, `readEnvConfig` -> `docsConfig`).
- **Lane.** `docsgate.mjs` `docsFailures` runs beside `routeFailures` and `precheck` blocks `docs_missing` (surface touched, no docs file changed, no `docs: [{surface, justification}]` in the result) and `docs_link_broken` (added `/docs/...` link: `link_check` command, else a docs file under `paths`). `docsPlanNote` asks the planner for an R-docs requirement. 0 LLM calls.
- **Review.** `docs` is a review domain (`pathDomains(files, {docs})`, `DOMAIN_CHECKS.docs`); never enforced by default.
- **Milestone.** `forgedock docs gate --milestone T --repo o/r` (`milestoneDocsGate`): user-facing children (labelled a configured kind or `user-facing`) need a closed child labelled `docs`; `/milestone` plans that child and gates close. `/review-pr-staging` Phase 1G lists undocumented user-facing changes as blockers.

## Entry 2026-11-11 — page gate for public pages (#5428)

- **Config.** forge.yaml `pages: {enabled, routes, icp_doc, require, sitemap, metadata_patterns, canonical_patterns, structured_data_patterns, forbid_patterns, lint}`; default on only for repos tracking `app/**/page.*` (`parsePagesConfig`, `readEnvConfig` -> `pagesConfig`).
- **Contract time.** `validateContract(..., {pages})` -> `contractBriefProblems`: a page deliverable needs `page_gate` {design_spec, seo, geo}; `pagePlanNote` tells the planner.
- **Lane.** `pagegate.mjs` `pageFailures` beside `docsFailures`; `precheck` blocks `page_*` rows (design spec, 390/1440 screenshots, metadata, canonical, structured data, sitemap, forbidden patterns, links, lint). 0 LLM calls.
- **Review.** `design` and `seo-geo` domains (`pathDomains(files, {pages})`, `DOMAIN_CHECKS`); `/review-pr-staging` Phase 1H blocks. GSC baseline capture is owner work.

## Entry 2026-11-11 — issue-watch batch intake cap, slow batch start and pass errors (#5425)

`issuewatch.mjs`: in `mode: batch` `max_inflight` defaults to `parallel` (others 4). `tick` first `--add`s claims to a running batch of the same repo and lane (`io.batch.running`: plan.json repo and `--lane`, state.json present, no report.json or cancel), else `io.batch.start`; a throwing start (real io attaches `before`, the batch ids seen) no longer escapes: claims stay and `state.pendingStart {issues, at, before, error}` holds new claims while later passes adopt the batch via `io.batch.find(before)`, or after `PENDING_START_MS` (10 min) `releaseClaims` drops them from the registry. `runWatch` wraps each pass in try/catch: `state.passError` is saved to `status.json`, logged, shown by `formatStatus`, and the loop continues (`--once` rethrows after saving). Tests: `issuewatch.test.mjs` "#5425" (6). Cost: 0 LLM calls.

## Entry 2026-11-11 — duplicate feature requests are INVALID, not CONFIRMED (#5432)

`prompts.mjs` `builderPlanPrompt` and `PREFILTER_SYSTEM`: a feature request whose behaviour is already reachable (same semantics under another name, or a stdlib or dependency function the project wraps or re-exports) is a duplicate. The verdict is INVALID (result status `invalid`, no new verdict value), with the equivalent and its path as evidence; the project deprecating that capability counts against adding an alias.

## Entry 2026-11-11 — overlapped lane setup (#5434)

`runLane` no longer serialises setup before the plan session. Deps install, heavy shims and `env.setup` run as one promise (`setupP`, `bin/lean/lean.mjs`); `gateSetup()` awaits it before anything that builds or runs lane commands: the refactor:split step, the light build, the contract checks after a plan, and the implement stage (resumed and frozen-contract lanes reach it directly). A failed `env.setup` still ends the lane needs-human, now at that gate, and `finish` awaits the setup so teardown never removes the worktree under an install. The residual wait is the `deps_install` ledger phase; the ledger stays sequential. Hotspots, enumerating tests and the context pack are awaited for at most `contextWaitSeconds` (default 5, 0 = unbounded): late hotspots skip the light lane and plan without hotspot facts; a late pack is not in the plan prompt but is read before the implement prompt. New run-log events: `LANE_SETUP_TIMING` (`step`: deps, heavy_shims, env_setup, hotspots, context_pack; `ms`) and `FIRST_SESSION` (`ms` from the lane clock to the first model session, the instrument for the p50 ≤ 10 s target measured by the #5370 bench). Existing DEPS_PREPARED, HEAVY_SHIMS, LIGHT_ELIGIBILITY and CONTEXT_PACK events are unchanged.
