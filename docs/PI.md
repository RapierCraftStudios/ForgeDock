# Pi Support

ForgeDock ships a Pi-native adapter as a Pi package.

## Install

From this repo:

```bash
./install-pi.sh
# restart Pi or run /reload in an existing Pi session
```

The installer runs `pi install <this repo>` and exports `FORGE_HOME` in common shell profiles when possible. You can also install manually:

```bash
pi install /absolute/path/to/ForgeDock
```

For a one-off test without installing:

```bash
pi -e ./pi/extensions/forgedock.ts
```

## Commands

After install, Pi gets extension slash commands:

- `/forge` — router and overview
- `/forge-work-on #123` — run the full issue pipeline
- `/forge-review-pr 456` — run PR review
- `/forge-orchestrate <query>` — deterministic DAG preflight, confirmation, and parallel orchestration
- `/forge-<command>` — one generated command per file under `commands/`

Nested command specs map by replacing path separators and punctuation with hyphens. Examples:

- `commands/work-on.md` -> `/forge-work-on`
- `commands/work-on/build/context.md` -> `/forge-work-on-build-context`
- `commands/orchestrate/phase-2.5-synthesis.md` -> `/forge-orchestrate-phase-2-5-synthesis`

## Runtime Mapping

The shared source of truth remains `commands/**/*.md`. The Pi adapter does not fork the workflow specs.

When a ForgeDock workflow references runtime-specific mechanics, translate them as follows:

- Claude slash command -> matching `/forge-*` Pi command
- `Skill("x")` -> read and follow the corresponding file under `commands/`
- `Task(...)` / `Agent(...)` -> use the `forge_subagent` Pi tool, which starts an isolated `pi --no-session -p ...` subprocess, when the spec requires real parallelism or fresh-context review; otherwise continue explicitly and document the limitation
- `Bash`, `Read`, `Grep`, `Glob` -> Pi shell/file tools with `gh`, `git`, `rg`, `find`, etc.
- `WebFetch` -> `gh`, `curl`, or available web tooling

The Pi adapter now has a native `forge_orchestrate` controller rather than delegating orchestration entirely to the model. It uses ForgeDock's deterministic preflight to resolve issues, render a DAG, show a confirmation checkpoint, and run ready issues concurrently in isolated Pi worker processes. Dependents are released only after predecessors complete. Use `--include-in-flight` or the tool's `includeInFlight: true` to resume `workflow:building` and `workflow:in-review` issues. Coordination/claims-board issues are excluded automatically.

Workers poll GitHub for terminal state and stop their Pi subprocess as soon as the issue reaches a terminal state, preventing the post-close runaway behavior. The worker prompt still follows the complete shared `/work-on` workflow, and its own `forge_subagent` tool remains available for nested review/build agents. Pi sub-subagent workflows can recurse as long as the source spec's depth budget permits it.

Compact preflight intentionally handles the mechanical DAG needed for fast execution: explicit dependencies, scoped affected-file overlap, database serialization, domains, and priorities. Use `--deep-plan` when the full prose workflow requires its extended conflict/history analysis; unsupported patterns fail closed rather than silently dispatching an incomplete plan.

Preserve ForgeDock invariants across runtimes: GitHub issues/PRs are state, structured FORGE annotations stay machine-readable, labels track workflow state, and unsafe or unavailable phases fail closed with `needs-human`/blocked state rather than being skipped.
