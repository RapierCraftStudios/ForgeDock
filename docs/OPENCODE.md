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

Restart OpenCode after install or update. OpenCode loads commands and plugins
at startup.

The installer does not edit `opencode.json` or `opencode.jsonc`. It writes only
ForgeDock-owned files under OpenCode's config directory and records them in
`forgedock/manifest.json` for safe updates and removal.

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
- selects Git Bash on Windows only when the user has not explicitly configured
  an OpenCode shell, because the shared workflows and helper scripts use Bash.

OpenCode's provider configuration remains entirely user-owned. ForgeDock does
not require Anthropic when invoked through OpenCode; any provider and model
supported by the user's OpenCode configuration can execute the commands.

## Token Efficiency

The adapter follows these rules:

- No global ForgeDock `instructions` entry.
- No generated skill for every source file. Large skill catalogs add metadata
  to every session even when ForgeDock is unused.
- Only top-level user entry commands are registered.
- Nested phase specs are loaded only when their dispatcher reaches them.
- Task/Agent work uses OpenCode subagents only for the parallelism, isolation,
  or context-pressure cases required by the shared workflow.
- GitHub state and the durable engine remain the recovery source instead of
  replaying prior prompt context.

The generated adapter preamble is intentionally small. It maps Claude Code's
in-conversation `Skill(...)` loading to a lazy read of the corresponding shared
spec. It maps isolated `Task(...)` and permitted `Agent(...)` calls to
OpenCode's native `task` tool.

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

Updates are deterministic and prune stale ForgeDock-owned command files.
Uninstall removes only files listed in the ownership manifest and still marked
with a ForgeDock sentinel. User-owned commands and plugins are never removed.
Install also removes the previous ForgeDock-managed `~/.opencode-forge.md`
instructions file and its exact legacy config entries when they are present.

## Locations

Default global location:

```text
~/.config/opencode/
  commands/forge/*.md
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

Claude's `PreToolUse` safety hook has not yet been ported to an OpenCode plugin.
The shared workflow rules and deterministic scripts still apply, but equivalent
mechanical enforcement must be implemented and tested before claiming complete
Claude-runtime safety parity.

OpenCode 1.18.4 keeps background subagents experimental. When they are not
enabled, the command adapter requires independent foreground tasks to be
launched concurrently where supported and uses ForgeDock's GitHub-label polling
fallback. This preserves isolated review contexts but does not yet prove equal
wall-clock behavior for `/forge/orchestrate`.

Commands that inspect Claude-specific transcripts or Claude installation state
remain runtime-specific and should not be represented as portable until they
receive dedicated implementations.

## Source References

- Shared workflows: [`commands/`](../commands/)
- Installer implementation: [`bin/opencode-adapter.mjs`](../bin/opencode-adapter.mjs)
- FORGE protocol: [`docs/spec/forge-protocol-v1.md`](spec/forge-protocol-v1.md)
