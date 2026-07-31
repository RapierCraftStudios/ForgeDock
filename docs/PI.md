# Pi Support

ForgeDock ships a Pi-native runtime adapter as a Pi package. The shared workflow remains in `commands/**/*.md`; Pi supplies the execution runtime, while ForgeDock owns phase state, GitHub coordination, review policy, and audit receipts.

## Install

For a stable global installation:

```bash
npx forgedock pi install
```

From a ForgeDock checkout during development:

```bash
./install-pi.sh
```

Restart Pi or run `/reload` in an existing session. A one-off checkout test is also possible:

```bash
pi -e ./pi/extensions/forgedock.ts
```

Start Pi from the repository you want ForgeDock to operate on. The Pi adapter separates the ForgeDock package root from the target project root and reads the target project's `forge.yaml`.

## Commands

After installation, Pi gets:

- `/forge` — router and overview
- `/forge-work-on #123` — run one issue through the durable Pi-backed engine
- `/forge-review-pr 456` — run the shared PR review workflow
- `/forge-orchestrate <query>` — build and execute a durable dependency DAG
- `/forge-<command>` — one wrapper per shared command spec

Nested command specs map by replacing path separators and punctuation with hyphens. Examples:

- `commands/work-on.md` -> `/forge-work-on`
- `commands/work-on/build/context.md` -> `/forge-work-on-build-context`
- `commands/orchestrate/phase-2.5-synthesis.md` -> `/forge-orchestrate-phase-2-5-synthesis`

## Durable Pi engine

`/forge-work-on` and `/forge-orchestrate` use the existing ForgeDock durable engine with isolated Pi phase workers. The engine, not the model, owns phase selection and completion:

1. Resolve the issue and current GitHub state.
2. Run investigation, context, architecture, build, review, and close phases in order.
3. Create the implementation worktree under `.pi/worktrees/` for Pi workers.
4. Run each selected phase with `pi --no-session` in the project root or issue worktree.
5. Verify FORGE markers, labels, commits, PR state, and terminal outcomes.
6. Release DAG dependents only after the predecessor completes successfully.
7. Preserve the local run-log and GitHub `FORGE:STATE` for resume/recovery.

The Pi worker inherits the active session's selected model and effective thinking level. The child process receives explicit `--model` and `--thinking` flags when those values are available. Claude is not invoked by this path.

For a fast-lane issue without a milestone, the normal PR target is `staging`:

```text
.pi/worktrees/fix-<slug>-<issue>
  -> fix/<slug>-<issue>
  -> pull request targeting staging
```

Milestone issues continue to follow the shared feature-lane policy and target `milestone/{slug}` unless the workflow explicitly specifies another base.

## Orchestration

The native controller performs compact deterministic preflight for issue resolution, explicit dependencies, scoped file overlap, database serialization, domains, priorities, and the initial ready queue. It asks for confirmation unless `--auto` or `--confirm` is supplied.

```text
/forge-orchestrate milestone/<slug> --max-concurrent 4
/forge-orchestrate #123 #124
/forge-orchestrate fast-lane --include-in-flight
```

Use `--include-in-flight` only when intentionally resuming issues already labeled `workflow:building` or `workflow:in-review`. Unsupported queries and deep plans fail closed rather than dispatching an incomplete DAG.

## Runtime mapping

When a workflow spec references Claude-specific mechanics, Pi translates them as follows:

- Claude slash command -> matching `/forge-*` Pi command
- `Skill("x")` -> read and execute the referenced shared phase spec
- `Task(...)` / `Agent(...)` -> `forge_subagent` or a durable Pi phase worker when isolation or parallelism is required
- `Bash`, `Read`, `Grep`, `Glob` -> Pi shell/file tools with `gh`, `git`, `rg`, and `find`
- `WebFetch` -> `gh`, `curl`, or available web tooling

The Claude adapter and headless Claude runner remain available, but they are separate runtime implementations. Pi must not silently fall back to Claude when its selected provider fails; the phase is recorded as a runtime error and remains recoverable from GitHub state.

Preserve ForgeDock invariants across runtimes: GitHub issues/PRs are state, structured `FORGE:*` comments remain machine-readable, workflow labels track state, builders do not approve their own work, and unsafe or unavailable phases fail closed to a blocked/`needs-human` state.
