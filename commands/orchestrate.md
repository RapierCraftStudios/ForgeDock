---
description: Orchestrate several issues in parallel — launches one lean work-on lane per issue (background shell or agent), GitHub is the register
argument-hint: "<#1 #2 #3 | milestone <slug> | label <name>> [--parallel K] [--lane L] [--path full]"
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
2. **Triage.** For each issue, read it once (`gh issue view N --json title,body,labels`) and record:
   - **Ready / skip.** Skip when it is labelled `needs-human` or `workflow:merged`, or an open PR already
     closes it (`gh pr list --search "Closes #N" --state open`). Say why.
   - **Files.** The files or areas it will likely touch: paths named in the issue, or a quick
     `git grep` of the symbols it names. Keep this to a few greps per issue, not an investigation.
   - **Size.** S, M or L, from the scope the issue describes.
3. **Build the DAG.** Edge X → N means N waits until X merges:
   - **Explicit:** `Depends on #X` / `Blocked by #X` where X is in the set. Match it case-insensitively and
     also in bold or list form (`**Depends on** #X`, `- Depends on: #X, #Y`). An open X outside the set
     means N is skipped as blocked.
   - **Logical:** one issue's fix is needed by another (for example, it adds the helper the other uses).

   These are the only edges. File overlap is **never** an edge: two issues that touch the same file or
   function still run in parallel, because each lane merges `origin/<lane>` into a conflicting PR and
   resolves the conflict itself. Note the overlap in the plan table as a warning only.

   If you find a cycle, break it at the weakest (logical) edge and say so.
4. **Show the plan** as one table: issue, title, size, likely files, waits-on (explicit/logical only),
   overlaps (warning). There are no waves. Then proceed without asking.

`K` = `--parallel` if given, otherwise `orchestration.max_concurrent` from the repo's `forge.yaml`
(`yq '.orchestration.max_concurrent' forge.yaml`), otherwise 3. State the value of K and where it came
from in the plan. `L` = `--lane` if given, otherwise the repo's base lane from forge.yaml.

## 3. Launch lanes

Schedule from the DAG, not in waves. An issue is **ready** when every issue it waits on has merged (or it
waits on nothing). Keep at most K lanes running. Whenever a lane is free, start the highest-priority ready
issue right away (priority label first, then the smaller size). Never hold a ready issue back until other
lanes finish. To reduce simultaneous base-syncs, don't start two lanes that name the same function within the
same minute; start another ready issue first instead of waiting.

- **Shell lane (default, when `forgedock` is on PATH).** Each lane is its own `Bash` call with
  `run_in_background: true`, so every running lane appears as its own background shell in this session.
  Do NOT write a scheduler, wrapper or queue script that launches lanes for you. You are the scheduler:
  start a lane, and when a lane's completion notification arrives, start the next ready issue.

  ```bash
  forgedock run-issue <N> --lane <L>
  ```

  The harness notifies you when the lane exits. Its last line is `issue #N → <outcome>`.
- **Agent lane (only when the `forgedock` CLI is unavailable).** Spawn one background agent per issue.
  The prompt is:

  > Resolve issue #N (gh issue view N --comments). If already fixed or invalid, comment the file:line
  > evidence and stop. Otherwise fix it with a regression test, run the relevant tests, commit on a
  > branch, push, open a PR with Closes #N, and comment a summary (root cause, changes, tests, PR) on
  > the issue.

  The agent does not merge.

When a lane finishes:
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

When all lanes have finished, print one table: issue, outcome, PR, minutes. Then list each
`needs-human` or skipped issue with its one-line reason. Nothing else.
