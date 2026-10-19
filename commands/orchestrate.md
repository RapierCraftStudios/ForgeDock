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

## 2. Resolve, triage and build the DAG

Do this yourself from issue text and the code. Spawn no sub-agents here.

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
   (the green run link). It checks K issues at a time. Its last line is `lanes: #A #B ...`: continue with only
   those issues. This is the only pre-filter in this command: lanes run `forgedock run-issue`, which does not
   pre-filter again. Keep its
   `pre-filter:` line for the report.
3. **Triage.** For each issue, read it once (`gh issue view N --json title,body,labels`) and record:
   - **Ready / skip.** Skip when it is labelled `needs-human` or `workflow:merged`, or an open PR already
     closes it (`gh pr list --search "Closes #N" --state open`). Say why.
   - **Files.** The files or areas it will likely touch: paths named in the issue, or a quick
     `git grep` of the symbols it names. Keep this to a few greps per issue, not an investigation.
   - **Size.** S, M or L, from the scope the issue describes.
4. **Build the DAG.** Edge X → N means N waits until X merges:
   - **Explicit:** `Depends on #X` / `Blocked by #X` where X is in the set. Match it case-insensitively and
     also in bold or list form (`**Depends on** #X`, `- Depends on: #X, #Y`). An open X outside the set
     means N is skipped as blocked.
   - **Logical:** one issue's fix is needed by another (for example, it adds the helper the other uses).

   These are the only edges. File overlap is **never** an edge: two issues that touch the same file or
   function still run in parallel, because each lane merges `origin/<lane>` into a conflicting PR and
   resolves the conflict itself. Note the overlap in the plan table as a warning only.

   If you find a cycle, break it at the weakest (logical) edge and say so.
5. **Show the plan** as one table: issue, title, size, likely files, waits-on (explicit/logical only),
   overlaps (warning). There are no waves. Then proceed without asking.

`K` = `--parallel` if given, otherwise `orchestration.max_concurrent` from the repo's `forge.yaml`
(`yq '.orchestration.max_concurrent' forge.yaml`), otherwise 3. State the value of K and where it came
from in the plan.

**Lanes (base branches).** Each issue has its own lane, and ForgeDock works it out: an issue with a milestone
goes to forge.yaml `branches.feature_pattern` (`milestone/<slug>`, which must exist on origin), any other issue
to `branches.staging`. The default (production) branch is never a lane. Do not pass `--lane`; a `--lane` that
differs from the issue's lane is refused (`lane-refused`, `lane.mismatch`). A dependency edge between two lanes
(for example a milestone issue waiting on a staging-lane fix) never gets that fix on its base: list it in the
plan and either re-milestone the dependency or wait for a milestone sync. Never mix lanes silently.

## 3. Launch lanes

Schedule from the DAG, not in waves. An issue is **ready** when every issue it waits on has merged (or it
waits on nothing). Keep at most K lanes running. Whenever a lane is free, start the highest-priority ready
issue right away (priority label first, then the smaller size). Never hold a ready issue back until other
lanes finish. To reduce simultaneous base-syncs, don't start two lanes that name the same function within the
same minute; start another ready issue first instead of waiting.

- **Batch runner (default, when `forgedock` is on PATH).** Launch the whole set as one durable batch in a single
  `Bash` call with `run_in_background: true`. Do NOT write a scheduler, wrapper or queue script, and do not launch one
  `run-issue` per issue yourself: the runner schedules from the issues' `Depends on` / `Blocked by` lines.

  ```bash
  forgedock orchestrate <N...> --parallel K
  ```

  Its first line is `batch: <id> (...)`. The batch state lives in `~/.forge/batches/<id>/` and every lane runs in its
  own session, so the batch survives this session: if the runner dies, run `forgedock orchestrate --resume <id>`
  (live lanes are re-adopted, nothing is launched twice). Change K of a running batch with
  `forgedock orchestrate --set-parallel <id> K`. The runner requeues `deferred` lanes by code (host busy after its
  retry-in, a usage limit holds admissions for that account (backend identity) until the reset, across every batch on
  the host, while a lane on another account is admitted; `forgedock limits show` lists holds and
  `forgedock limits clear <id>|--all` drops them; transient merge/push/idle failures back off; non-host
  deferrals stop after `orchestration.max_deferrals`), relaunches an `engine-error` once, and stops admitting after
  `orchestration.breaker` engine-errors (`errors` within `window_min`; held issues continue on `--resume`). Logical
  edges you found in step 2.4 must be written to the dependent issue as a `Depends on #X` line before launching. The
  last lines are the report table.
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
- `deferred` with "host busy" (code `host.busy`: the host is short of memory, tmp space or CPU headroom;
  no lease was taken and nothing was posted): put the issue back in the queue and lower the effective K by
  1 for the next 5 minutes, never below 1. Before raising K back, start one lane and check that it is not
  host busy again.
- `deferred` with `rate_limited` (usage limit; the last output line carries the reset time): stop launching
  new lanes until that reset time, let running lanes finish, then resume the queue.
- `dependency-open`: the engine or the builder found a dependency you missed (its output names it). This is a
  scheduling fact, not a failure: add the edge and requeue the issue behind it. Do not skip its dependents.
  If the dependency is outside the set and agents can resolve it, add it to the batch and launch it.
- `lane-refused` (codes `lane.mismatch`, `lane.default_branch`, `lane.branch_missing`, `lane.unresolved`): nothing
  ran (no lease, comment or worktree). Report the code and its detail (for example a missing `milestone/<slug>`
  branch), and mark the issue's dependents skipped. Do not retry it with a different `--lane`.
- `dependency-blocked`: its dependency is open and labelled `needs-human`. Report it as blocked by that issue,
  do not label it `needs-human`, and mark its dependents skipped.
- `decomposed`: the builder split the issue and the engine filed sub-issues (listed in its output, each with
  `**Parent**` and `**Depends on**` lines). Add them to the DAG, launch them, and let the parent's dependents
  wait on the sub-issues.
- `merged` or `invalid`: start the next ready issue.
- `needs-human`: an external action agents cannot take (credentials, spend, promotion, customer) or a product
  decision too critical for agents. Read the issue's last comment for the reason, and mark its dependents skipped. Only
  explicit or logical edges skip a dependent; an issue that merely overlaps the same file keeps running.
- `engine-error`: relaunch it once.
- `ci-pending` or `deferred`: leave it. A later `/orchestrate` resumes it.

## 4. Report

When all lanes have finished, print one table: issue, outcome, PR, minutes (issues the pre-filter closed
show `invalid (pre-filter)`). Then the `pre-filter:` line from step 2.2 (count closed and spend avoided), then
list each `needs-human` or skipped issue with its one-line reason. Nothing else.
