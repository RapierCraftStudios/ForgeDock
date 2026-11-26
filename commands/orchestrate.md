---
description: Orchestrate several issues in parallel — launches one lean work-on lane per issue (background shell or agent), GitHub is the register
argument-hint: "<#1 #2 #3 | milestone <slug> | label <name>> [--parallel K] [--path full]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — parallel lean work-on lanes

**Input**: $ARGUMENTS

You are the orchestrator. Resolve the issues, order them, and run each one in its own lane. Each lane
runs the lean work-on (validate → plan → implement → fix/regression review → PR → merge), which records
every step on the issue. You triage and order the set yourself (no sub-agent investigations), but never implement an
issue yourself.

## 1. Legacy path

If the input contains `--path full`, stop: read `${CLAUDE_PLUGIN_ROOT}/commands/orchestrate/legacy.md`
and follow it instead (the previous multi-phase orchestrator).

## 2. Resolve and triage

Do this yourself. Spawn no sub-agents here.

1. **Resolve.**
   - Explicit numbers (`#12 13 14`) are used as given.
   - `milestone <slug>` uses `gh issue list --milestone "<slug>" --state open --json number --jq '.[].number'`.
   - `label <name>` uses the same with `--label`.

   Keep only plain integers and drop closed issues.
2. **Pre-filter already-fixed issues** (when `forgedock` is on PATH). Before reading anything else, run once
   for the whole set:

   ```bash
   forgedock triage <N...> --parallel <K>
   ```

   It closes, with the evidence on the issue and no lane, every issue that a merged PR already fixed (one
   short read-only validation on a small model) or an auto-filed CI failure whose workflow is green again
   (the green run link), unless it is flaky (wording or `flaky` label), was reopened after a pre-filter close, or
   the workflow failed and passed at the same SHA. It checks K issues at a time. Its last line is `lanes: #A #B ...`: continue with only
   those issues. This is the only pre-filter in this command: lanes run `forgedock run-issue`, which does not
   pre-filter again. Keep its
   `pre-filter:` line for the report.
3. **Skip** an issue labelled `needs-human` or `workflow:merged`, or one an open PR already closes
   (`gh pr list --search "Closes #N" --state open`). Say why.
4. **The DAG and the plan table are code** (`bin/lean/dag.mjs`, #5824): `forgedock orchestrate` prints
   `plan:` and one row per issue (title, waits on, likely files, overlap warning) before the first lane. Do not
   build or print a DAG yourself. Edge X → N (N waits until X merges) comes only from a trusted `Depends on #X` /
   `Blocked by #X` line (any case, bold, list, `:`, comma/`and` lists), or, logically, when X's frozen contract
   delivers a new file N's body names. File overlap is **never** an edge: overlapping issues run in parallel and
   each lane merges its base and resolves the conflict; the table shows the overlap as a warning. A logical edge
   that closes a cycle is dropped. An edge you believe is missing goes on the dependent as a `Depends on #X` line
   before launching. The report's `false holds:` line counts planned edges an operator removed. Without
   `forgedock` (agent lanes), apply the same edge rules yourself and show the same table.

`K` = `--parallel` if given, otherwise `orchestration.max_concurrent` from the repo's `forge.yaml`
(`yq '.orchestration.max_concurrent' forge.yaml`), otherwise 3.

**Lanes (base branches).** ForgeDock picks each issue's lane: a milestone issue goes to forge.yaml
`branches.feature_pattern` (`milestone/<slug>`, must exist on origin), any other to `branches.staging`, never the
default branch. Do not pass `--lane` (a mismatch is refused: `lane-refused`, `lane.mismatch`). A cross-lane dependency
never gets the fix on its base: list it, then re-milestone the dependency or wait for a milestone sync.

## 3. Launch lanes

Schedule from the DAG, not in waves. An issue is **ready** when every issue it waits on has merged (or it
waits on nothing). Keep at most K lanes running. Whenever a lane is free, start the highest-priority ready
issue right away (priority label first, then the smaller size). Never hold a ready issue back until other
lanes finish. To reduce simultaneous base-syncs, don't start two lanes that name the same function within the
same minute; start another ready issue first instead of waiting.

**Maintenance budget** (off unless forge.yaml `maintenance.enabled: true`). The runner pulls open issues carrying a
`maintenance.labels` label into the batch and admits in this order: P0/P1 features > maintenance, while maintenance
starts stay within `maintenance.share` of all starts (0.2 = 1 lane in 5) > P2+ features. With `when_idle` it drains the
remaining maintenance once no feature is pending; otherwise the rest ends `held (maintenance share)` for a later batch.

- **Batch runner (default, when `forgedock` is on PATH).** Launch the whole set as one durable batch in a single
  `Bash` call with `run_in_background: true`. Do NOT write a scheduler, wrapper or queue script, and do not launch one
  `run-issue` per issue yourself: the runner schedules from the issues' `Depends on` / `Blocked by` lines.

  ```bash
  forgedock orchestrate <N...> --parallel K
  ```

  Its first line is `batch: <id> (...)`. The batch state lives in `~/.forge/batches/<id>/` and every lane runs in its
  own session, so the batch survives this session: if the runner dies, run `forgedock orchestrate --resume <id>`
  (live lanes are re-adopted, nothing is launched twice). The runner is hosted by the detached `forgedock schedd` daemon,
  which resumes every daemon-hosted batch that has no report yet when it starts, so a closed session needs no manual
  `--resume`; a batch started without the daemon still needs `forgedock orchestrate --resume <id>`. Change K of a running batch with
  `forgedock orchestrate --set-parallel <id> K`. Change its remote lane cap or placement with `forgedock orchestrate --set-max-remote <id> N` and
  `--set-placement <id> remote|hybrid|local` (remote/hybrid only for a batch started with a remote provider; running lanes keep running). Issues filed while a batch runs join it with
  `forgedock orchestrate --add <id> N...` (or `--resume <id> N...`), under its K and DAG; never start a second batch
  for them. After a decision (a `FORGE:DECISION` posted and `needs-human` removed), a blocked issue that already ended in the batch
  (`needs-human`, `invalid`, `skipped`, `dependency-*`, `ci-pending`, `deferred`) returns to it with
  `forgedock orchestrate --requeue <id> N... --reason "..."` (it also releases an issue shown as `paused (quota) until <ISO>`) (refused while it is labelled `needs-human` or closed; skipped dependents
  return to pending with it; a finished batch is reopened); `--add` on a `skipped` issue re-queues it (other ended issues still report `already in batch`). A dependency-skipped issue shows as `waiting on #X` while the batch runs (the blocker is re-checked each pass; merged or closed re-admits it, closed as not planned keeps it skipped) and ends `skipped` only if the blocker never resolved. Its pre-filter still closes already-fixed ones. The runner requeues `deferred` lanes by code (host busy and a full sandbox pool after their
  retry-in, uncapped, a usage limit holds admissions for that account (backend identity) until the reset, never capped, across every batch on
  the host; `forgedock limits show|clear <id>|--all` lists or drops holds; transient merge/push/idle failures back off; other
  deferrals stop after `orchestration.max_deferrals`), relaunches an `engine-error` once, and stops admitting after
  `orchestration.breaker` engine-errors (`errors` within `window_min`; held issues continue on `--resume`). Lanes are
  capped host-wide (`orchestration.global_parallel`, `forgedock sched cap N|show`), highest priority first; within a
  priority, slots are shared across repos by weight (`forgedock sched weight <owner/repo> N`, default equal). The
  last lines are the report table.
  Issue-level readiness (#4773): `--add` prints the edges it created; an issue labelled `blocked` (`orchestration.blocked_label`) is admitted but not dispatched until the label is removed.
- **Agent lane (only when the `forgedock` CLI is unavailable).** Spawn one background agent per issue.
  The prompt is:

  > Resolve issue #N (gh issue view N --comments). If already fixed or invalid, comment the file:line
  > evidence and stop. Otherwise fix it with a regression test, run the relevant tests, commit on a
  > branch, push, open a PR with Closes #N, and comment a summary (root cause, changes, tests, PR) on
  > the issue.

  The agent does not merge.

When a lane finishes (agent lanes; the batch runner applies the same rules itself):
- `deferred` (lease held by another or a dead session): put it back in the queue and retry after the
  lease time printed in its output.
- `deferred` `host.busy` (host short of memory, tmp or CPU; nothing taken or posted): requeue it and lower K by 1
  for 5 minutes (never below 1); before raising K, check one lane is not host busy again.
- `deferred` `rate_limited`: launch nothing until the reset time on its last line; running lanes finish.
- `dependency-open`: the engine or the builder found a dependency you missed (its output names it). A
  scheduling fact, not a failure: add the edge and requeue the issue behind it. Keep its dependents.
  If the dependency is outside the set and agents can resolve it, add it to the batch and launch it.
- `lane-refused` (codes `lane.mismatch`, `lane.default_branch`, `lane.branch_missing`, `lane.unresolved`): nothing
  ran (no lease, comment or worktree). Report the code and its detail (for example a missing `milestone/<slug>`
  branch), and mark the issue's dependents skipped. Do not retry it with a different `--lane`.
- `dependency-blocked`: its dependency is open and labelled `needs-human`. Report it as blocked by that issue,
  do not label it `needs-human`, and mark its dependents skipped. Once the blocker is cleared, `forgedock orchestrate --requeue <id> N...`
  returns the issue and its skipped dependents to the batch.
- `decomposed`: the builder split the issue and the engine filed sub-issues (listed in its output, each with
  `**Parent**` and `**Depends on**` lines). Add them to the DAG, launch them, and let the parent's dependents
  wait on the sub-issues.
- `merged` or `invalid`: start the next ready issue.
- `needs-human` with a **recoverable code**: `ci.red`, `base.conflict` (merge conflict), `ci-pending` on a conflicting
  PR, `contract.invalid` caused by an issue edited mid-run, `builder.block_untyped` (an in-scope technical choice),
  and the environment codes `env.tool_missing` (a validate command the host cannot run) and `env.repro_unrunnable`
  (the repro harness could not run the repro test), and the conformance gaps `conformance.unimplemented`,
  `conformance.omission` and `conformance.unjustified_deferral` (the recovery lane delivers the gap, or defers an optional
  clause with a why so a tracked follow-up is filed; `conformance.regression`, `guard_broken`, `scope_creep` and
  `e2e_unverified` stay terminal).
  These are mechanical. **Do not ask for confirmation on them.** The batch runner recovers each one itself
  (`orchestration.recovery.max_attempts`, default 1 per issue). It launches one recovery lane under the same lease, lane
  and admission rules as any lane, with `run-issue --recover <code> [--recover-attempt n]` (core path only:
  `--path full` rejects `--recover`; recovery is off when `engine.path: full`). That lane:
  - removes `needs-human`;
  - resumes the open PR: merges the base, fixes the failed required checks from their logs, and pushes new commits only;
  - re-queues the issue, keeping its dependents queued in the same batch.

  Report what was recovered afterwards. A failed recovery stays `needs-human` with its evidence, re-labelled exactly once per issue, by the final attempt only (failed = `needs-human`, `ci-pending`, or a final `engine-error`/`deferred`; `invalid`, `decomposed` and `dependency-*` are not failures and never re-label). With `max_attempts > 1` a non-final attempt adds no label or comment: the runner either launches the next attempt or, when none follows, re-labels it once itself, so the label does not flap between attempts. There
  is no second attempt beyond `max_attempts`.
- `needs-human` with a **human code** (`builder.blocked`: product-decision, spend, credentials, promotion, customer): an
  external action agents cannot take, or a product decision too critical for agents. It is never auto-recovered. Read
  the issue's last comment for the reason, mark its dependents skipped, and add it to the escalation list (step 4). Only
  explicit or logical edges skip a dependent (after you decide the block in scope, clear the label and run
  `forgedock orchestrate --requeue <id> N... --reason "..."`, never a second batch); an issue that merely overlaps the same file keeps running.
- `needs-human` with a **terminal code** that is neither recoverable nor human (for example `conformance.regression`, or
  `contract.invalid` without a mid-run issue edit): the runner does not recover it and it is not an escalation. The
  batch report lists it as `unrecovered: #N (<code>: <detail>)`, like a recovery that did not merge. Mark its dependents
  skipped and leave the issue for a later run once its cause is fixed.
- `engine-error`: relaunch it once. A repeat of the same error, or an `env.tool_missing` the host still has, ends `held` (waiting on engine/env change): an engine upgrade, `--set-env` or the tool appearing re-admits it. Do not `--requeue` it.
- `ci-pending` (PR not conflicting) or `deferred`: leave it. A later `/orchestrate` resumes it.

**Operational decisions are yours.** Decide them without asking and keep going. Record each one as a
`<!-- FORGE:DECISION -->` comment (what, why, alternative) on the issue, or on the batch for batch-wide choices. The
runner posts its own decisions (recovery, relaunch, dependency requeue, sub-issues added). The decisions you take
yourself:
- **Requirement tracked post-deploy:** `<!-- FORGE:DECISION {"requirement":"R5","disposition":"post-deploy","quote":"<row quote>"} -->`; `quote` survives renumbering. Never add a check id.
- **Recovery and retries:** relaunch, resume, fix-ci, base-sync, and stopping and relaunching a stuck lane.
- **Scheduling:** K changes under host pressure, ordering, adding logical `Depends on` edges, and adding newly filed or
  decomposed sub-issues to the running batch.
- **Engine gaps:** file each engine-gap issue you discover and queue it.
- **In-scope technical choices** a builder escalates as `untyped` or ambiguous: pick the option most consistent with the
  issue, the repo's conventions and prior merged decisions, and note the alternative.

Escalate only these:
- product direction (`product-decision`);
- spend;
- credentials;
- customer-facing actions;
- staging→main release or deploy, unless the operator approved it for the session.

Collect escalations into one question list and ask it once, at the end of the batch. Never ask per issue, and keep every
other lane running meanwhile.

## 3b. Settle scope (#4665)

At settle, freeze the milestone's issue set and classify later issues with `scripts/settle-scope.mjs` (its header documents the rules).

## 4. Report

When all lanes have finished, print one table: issue, outcome, PR, minutes (issues the pre-filter closed
show `invalid (pre-filter)`). Then print:
1. the `pre-filter:` line from step 2.2 (count closed and spend avoided);
2. the runner's `recovered: #A (ci.red) #B (base.conflict)` line;
3. its `unrecovered:` lines (mechanical codes whose recovery did not merge);
4. each skipped issue with its one-line reason;
5. one escalation list: the human-code `needs-human` issues only, asked once.

Nothing else.

## Standing orders (`--select`)

`forgedock orchestrate --select '<query>'` (a GitHub issue search: `no:milestone`, `milestone:X`, `label:Y`) stores the selector in the batch and keeps owning it; no watcher process is needed (the schedd-hosted runner reconciles every few minutes):

- matching open issues join under the same DAG, priority and lane rules as `--add`; closed or moved ones leave.
- an issue stays scheduled until it is closed, merged, or blocked by a human code (credentials, spend, customer, promotion, product decision). Re-admission needs no operator command: `deferred` retries with exponential backoff (cap 2 h); `held` / `engine-error` re-admit on an agent or lane-image version change or after a 6 h cooldown; a conformance failure gets one more attempt after the base moves, then is listed in a single "needs decision" digest; the engine's `env.*` issue joins the order and its closure re-admits the waiters.
- the breaker resets itself after a cooldown when the failures were environmental (VM restart, mirror, network) and the pool is healthy, with a FORGE:DECISION.
- a merge into a staging lane branch closes the issue (and notes it on the post-deploy rollup when `FORGE_POSTDEPLOY_ROLLUP=<issue>` is set).

`forgedock orchestrate --status <id>` shows the coverage: matching open = running + queued + backing-off + waiting on deps + human-blocked (listed) + unscheduled. `unscheduled: 0` is the healthy state.
