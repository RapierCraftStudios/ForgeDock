# OpenCode Support

ForgeDock's OpenCode integration uses native OpenCode commands, subagents, and
plugins while keeping `commands/**/*.md` as the only workflow source of truth.
The older global-instructions and `opencode.json` patching adapter has been
retired because it loaded ForgeDock prose into unrelated sessions, registered
only four commands, used the wrong argument placeholder, and assumed OpenCode
had neither skills nor subagents.

## Install

```bash
npx forgedock opencode install
```

For the optional command tier:

```bash
npx forgedock opencode install --extras
```

Restart OpenCode after install or update. OpenCode loads commands, skills, and
plugins at startup.

The native adapter does not add or modify user-owned OpenCode settings. It
writes only ForgeDock-owned files under OpenCode's config directory and records
them in `forgedock/manifest.json` for safe updates and removal.

## Usage

Commands are namespaced to avoid collisions:

```text
/forge/work-on 967
/forge/review-pr 123
/forge/quality-gate
/forge/orchestrate milestone checkout-v2
```

Headless OpenCode invocation uses the same command names:

```bash
opencode run --command forge/work-on "967"
```

## Architecture

The installed command files are thin entry adapters. A command loads exactly
one authoritative spec from ForgeDock's stable installation and translates
runtime mechanics without copying workflow behavior.

```text
OpenCode /forge/work-on
  -> small generated command adapter
  -> commands/work-on.md
  -> only the nested phase spec reached by the dispatcher
  -> GitHub labels and FORGE annotations remain durable state
```

The generated plugin has no prompt text. It:

- injects `FORGE_HOME` into OpenCode shell environments;
- defaults `subagent_depth` to 2 when the user has not configured it, while
  preserving explicit lower limits;
- grants the built-in `general` subagent permission to invoke native `task`
  unless the user explicitly configured a task permission;
- opts into OpenCode background subagents for the orchestrator's explicit
  ready-issue dispatches so each completed issue can wake the parent independently; set
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` to opt out;
- selects Git Bash on Windows only when the user has not explicitly configured
  an OpenCode shell, because the shared workflows and helper scripts use Bash.

The adapter also registers every eligible ForgeDock workflow as a native
OpenCode skill. Top-level and nested source paths are normalized to valid
hyphenated skill names while the wrapper continues to point at the authoritative
source file:

```text
commands/work-on.md             -> skills/work-on/SKILL.md
commands/work-on/investigate.md -> skills/work-on-investigate/SKILL.md
commands/review-pr.md           -> skills/review-pr/SKILL.md
```

The wrapper is intentionally thin. It carries the workflow's `name` and
`description` frontmatter, preserves the current-context arguments, and loads
only the referenced `commands/**/*.md` spec.

OpenCode's provider configuration remains entirely user-owned. ForgeDock does
not require Anthropic when invoked through OpenCode; any provider and model
supported by the user's OpenCode configuration can execute the commands.

## Token Efficiency

The adapter follows these rules:

- No global ForgeDock `instructions` entry.
- Top-level user entry commands are registered under `/forge/*`.
- Every eligible workflow is registered as a native skill so nested
  `Skill(...)` dispatch resolves through OpenCode's `skill` tool instead of
  filesystem guessing.
- Nested phase specs are loaded only when their dispatcher reaches them.
- Task/Agent work uses OpenCode subagents only for the parallelism, isolation,
  or context-pressure cases required by the shared workflow.
- Orchestration dispatches independent issues with `task(background=true)` and
  processes each injected task-result event immediately; it does not wait for a
  wave or the slowest sibling.
- The `/orchestrate` entrypoint reads only runtime config, then runs
  `bin/orchestrate-preflight.mjs` before loading the phase specs. The helper batches the initial GitHub
  snapshot and emits only the compact ready queue needed for the first native task.
  Interactive runs keep the confirmation gate; `--auto` or `--confirm` is the
  explicit headless authorization.
- The full Phase 3/4 prose is reserved for investigations, unsupported or multi-repo
  queries, explicit deep planning, and recovery after a task-result event. It remains
  authoritative for cascade handling, leases, cleanup, and reporting.
- GitHub state and the durable engine remain the recovery source instead of
  replaying prior prompt context.

The generated adapter preamble is intentionally small. It maps Claude Code's
in-conversation `Skill(...)` loading to the normalized native skill name and
authoritative shared spec. It maps isolated `Task(...)` and permitted
`Agent(...)` calls to OpenCode's native `task` tool. Before the shared review
specs evaluate Claude's literal `Task`/`Agent` names, an OpenCode runtime marker
selects `DISPATCH_TOOL=task`; the absence of those Claude names must not produce
a false `FORGE:REVIEW_BLOCKED` result.

Every isolated review dispatch uses a foreground native task. Every
native task call must include the schema-required `subagent_type` at the top
level alongside its `description` and `prompt`:

```js
{ description: "...", prompt: "...", subagent_type: "general", background: false }
```

Implementation and review work uses `general`; read-only discovery uses
`explore`. Claude `general-purpose` maps to `general` and
`codebase-explorer` maps to `explore`. When a source task omits its type, the
generated adapter safely defaults it to `general`; unsupported types stop with
`FORGE_OPENCODE_CAPABILITY_ERROR` instead of reaching schema validation.
If the native `task` capability itself is unavailable, the workflow posts
`FORGE:REVIEW_BLOCKED` and stops rather than falling back to inline review or
another pipeline controller.
The generated plugin defaults omitted `background` to `false`. Only the
orchestrator's ready-issue dispatcher sets `background: true`; setting
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` forces foreground execution.

`commands/work-on.md` is still a large entry dispatcher and is loaded in full,
matching the Claude Code path. The adapter prevents additional eager loading,
but reducing that entry cost requires decomposing the shared authoritative spec
rather than maintaining an OpenCode-only copy.

## Lifecycle

```bash
npx forgedock opencode status
npx forgedock opencode install          # update/repair
npx forgedock opencode install --extras
npx forgedock opencode uninstall
```

`npx forgedock update` also refreshes an existing managed OpenCode adapter,
including its plugin and generated skills. It preserves the installed core vs.
`--extras` tier, migrates the sentinel-marked legacy adapter, and does not
install OpenCode files when no ForgeDock adapter is already registered.

Updates are deterministic and prune stale ForgeDock-owned command files.
Uninstall removes only files listed in the ownership manifest and still marked
with a ForgeDock sentinel. User-owned commands, plugins, and files placed in
the `forgedock/` namespace are never removed; that namespace is pruned only
when it is empty.
For backward compatibility, install and uninstall may rewrite `opencode.json`
only to remove legacy entries whose two-key `description` and `template` still
exactly match one of the definitions emitted by the retired adapter and point to
the active ForgeDock home (or the home recorded in the ownership manifest during
uninstall), and the sentinel-marked legacy instructions file is present. It also
removes references to that managed `~/.opencode-forge.md` instructions file. The
migration does not rewrite `opencode.jsonc`. User-owned settings and customized commands are preserved;
definitions with extra keys, edited fields, different
paths, a missing ownership marker, or ambiguous ownership are left in place. If
a legacy config cannot be parsed or written, the migration leaves the legacy
artifacts in place.

## Locations

Default global location:

```text
~/.config/opencode/
  commands/forge/*.md
  skills/<workflow-name>/SKILL.md
  plugins/forgedock.js
  forgedock/manifest.json
```

`XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` are honored when set. An npm/npx
installation first persists the required ForgeDock payload under `~/.forge` so
generated commands never point into an evictable package cache. A stable Git
clone is referenced directly.

## Current Boundary

This integration provides native interactive command and subagent execution.
The separate `forgedock run` and `forgedock run-issue` backend still supports
only Claude CLI and the Anthropic API. An OpenCode engine backend must be added
and validated before ForgeDock can claim provider-neutral headless parity.

The ForgeDock plugin provides the OpenCode-specific runtime boundary for shell
and task execution. Its `tool.execute.before` hook rejects Claude-backed and
recursive ForgeDock controller commands, and normalizes native task arguments
before execution; the shared workflow rules and deterministic scripts remain
the source of truth for all other behavior.

OpenCode 1.18.4 keeps background subagents experimental. ForgeDock opts into
that feature by default because the streaming DAG depends on the parent session
receiving one completion event per child. A native background task returns a
`<task id="..." state="running">` marker immediately and later injects a
`state="completed"` or `state="error"` result into the parent session. The
orchestrator maps that id to the issue, re-reads GitHub state, and dispatches
newly unlocked successors in the same response.

If `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` is explicitly set,
ForgeDock uses independent foreground tasks where OpenCode can execute them
concurrently and labels the run as degraded. Foreground tasks cannot provide
the same per-completion wake behavior, so this opt-out intentionally restores a
wave-like fallback rather than silently claiming Claude-equivalent throughput.

Commands that inspect Claude-specific transcripts or Claude installation state
remain runtime-specific and should not be represented as portable until they
receive dedicated implementations.

The preflight is intentionally bounded. It handles explicit issue sets and the
common single-repository `fast-lane`, `milestone`, `next`, `priority`, and
`no:milestone` queries, plus explicit dependencies and scoped issue-body file
overlap. It also accepts a same-repository GitHub issue-search URL such as:

```text
https://github.com/RapierCraftStudios/ForgeDock/issues?q=is%3Aissue+state%3Aopen+no%3Amilestone+sort%3Aupdated-desc
```

The URL `q` value is decoded with `URLSearchParams`. The compact path permits
`is:issue`, `state:open`, supported `sort`/`order` modifiers, and
`no:milestone`, `milestone:<name>`, or `label:<name>` predicates. URL label and
milestone values use GitHub's case-insensitive name identity without punctuation
or whitespace folding; raw ForgeDock slugs such as `no:milestone` retain their
existing slug behavior. URLs must target the configured repository; malformed,
cross-repository, closed-state, `is:pr`, missing-query, and unknown predicates
fail closed with an actionable diagnostic and fall back to the shared phase specs
rather than silently weakening their safety rules.

A GitHub issue-search URL is a standing query rather than a frozen T0 list.
After each ordinary task completion, the compact runtime re-runs the same raw
preflight input and admits newly matched issues through the refreshed eligibility
and dependency plan before it can report the batch complete.

## Orchestration Runtime

OpenCode orchestration uses the native OpenCode `task` tool for isolated issue
work and follows the shared `commands/work-on.md` state machine. Each ready
issue is launched as `task(subagent_type="general", background=true)` and its
task-result event is treated as the completion notification for that issue. It
must not
route through `forgedock run-issue` when that would select the Claude CLI or
Anthropic API backend. If the host does not expose an OpenCode runtime marker,
set the runtime explicitly before launching a headless command:

```bash
FORGE_RUNTIME=opencode opencode run --command forge/orchestrate "fast-lane"
```

Each task re-reads GitHub labels and `FORGE:*` comments after every phase and
continues until `workflow:merged`, `workflow:invalid`, `needs-human`, or
`workflow:awaiting-merge`. The parent orchestrator processes every child
completion independently, so a completed predecessor can unlock and dispatch
its successors while unrelated issues continue running. If native task
dispatch is unavailable, post a
`FORGE:OPENCODE_BLOCKED` diagnostic naming the missing capability and add
`needs-human`; do not leave an issue stranded at `workflow:engine-error`.

If a generated command or skill cannot load its authoritative workflow, it must
stop with an actionable `FORGE_OPENCODE_CAPABILITY_ERROR`. It must not recover
by invoking `forgedock run-issue`, `npx forgedock run-issue`, or a recursive
`opencode run`; those paths select a competing controller or Claude-backed
backend.

The same boundary is enforced below the plugin for direct CLI callers. With
`FORGE_RUNTIME=opencode`, `forgedock run`, `forgedock run-issue`, and Claude
backend preflight fail before selecting a provider. The stable error is
`FORGE_OPENCODE_CAPABILITY_ERROR`; continue by using the registered native
Skill and Task workflow instead.

This runtime branch is additive. Claude keeps its existing engine and
background-agent paths, and Codex keeps its installed namespaced skills and
repo-local adapters.

## Runtime Paths

The shared orchestration spec resolves `classify-lane.sh` by runtime:

| Runtime | Helper precedence | Worktree root |
|---------|-------------------|---------------|
| Claude | `${FORGE_HOME}/scripts`, then `~/.claude/scripts`, then the repository `scripts/` | `.claude/worktrees/` |
| OpenCode | `${FORGE_HOME}/scripts`, then the repository `scripts/`, then `~/.opencode/scripts` | `.opencode/worktrees/` |
| Codex | `${FORGE_HOME}/scripts`, then the repository `scripts/` | `.codex/worktrees/` |

Set `FORGE_RUNTIME=opencode` for headless OpenCode sessions when no native
OpenCode marker is available. The resolver is used by initial dispatch and all
review-finding classification loops, so an OpenCode installation never needs
`~/.claude` while the Claude precedence and fallback remain unchanged.

## Source References

- Shared workflows: [`commands/`](../commands/)
- Installer implementation: [`bin/opencode-adapter.mjs`](../bin/opencode-adapter.mjs)
- FORGE protocol: [`docs/spec/forge-protocol-v1.md`](spec/forge-protocol-v1.md)
