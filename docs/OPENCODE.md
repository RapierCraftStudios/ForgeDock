# OpenCode Support

ForgeDock has an OpenCode adapter that lets OpenCode run the ForgeDock pipeline
using its native bash tool and the `gh` CLI.

## Architecture

Shared source:
- `commands/**/*.md` remains the workflow spec for all runtimes

Claude Code wrapper:
- `install.sh` (or `npx forgedock`) symlinks command files into `~/.claude/commands/`

Codex wrapper:
- `install-codex.sh` generates namespaced skills in `~/.codex/skills/`

Aider wrapper:
- `install-aider.sh` writes `~/.aider-forge.md` loaded via `--read`

**OpenCode wrapper** (this document):
- `install-opencode.sh` writes `~/.opencode-forge.md` — a conventions file
  OpenCode loads via the `instructions` field in `opencode.json`
- `install-opencode.sh` also patches `~/.config/opencode/opencode.json` to
  register ForgeDock pipeline commands as native OpenCode slash commands
  (`/work-on`, `/review-pr`, `/quality-gate`, `/orchestrate`)

This is a conventions-file + command-registration architecture. The shared
`commands/` directory remains the single source of truth — the adapter
registers entry points that read from it.

## Feasibility

OpenCode is the **highest-fidelity** non-Claude Code adapter because:

| Capability | Requirement | OpenCode support |
|-----------|-------------|-----------------|
| Load instruction files | `instructions` field in `opencode.json` | Native |
| Execute shell commands | `gh`, `git`, standard tools | Native `Bash` tool |
| Read/write files | File editing | Native `Read`/`Write`/`Edit` tools |
| GitHub API | `gh` CLI | Via `Bash("gh ...")` |
| Multi-step workflows | Follow sequential instructions | Supported |
| Compaction resilience | Re-read GitHub state at phase start | Supported (via `Bash("gh ...")`) |
| Native slash commands | `/work-on 967` in TUI | Via `command` config |
| Tool name parity | Same tool names as Claude Code | Direct — no translation needed |

**Key advantage over Aider and Cursor**: OpenCode shares Claude Code's tool
names (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`) — no
translation table required for most operations. Pipeline command specs run
nearly unmodified.

## Install

### Option A — standalone bash installer

```bash
cd /path/to/forgedock
./install-opencode.sh
```

This writes `~/.opencode-forge.md` with ForgeDock conventions and patches
`~/.config/opencode/opencode.json` with:
- `instructions`: adds `~/.opencode-forge.md` to OpenCode's system prompt
- `command`: registers `/work-on`, `/review-pr`, `/quality-gate`, `/orchestrate`

### Option B — via npx forgedock

When `opencode` is detected on your PATH, `npx forgedock` writes
`~/.opencode-forge.md` and patches `opencode.json` as an additional install
step. No existing Claude Code files are affected.

```bash
npx forgedock
```

## Usage

### Native slash commands (recommended)

After running `install-opencode.sh`, use ForgeDock commands in the OpenCode
TUI:

```
/work-on 967
/review-pr 123
/quality-gate
```

Or headlessly via `opencode run`:

```bash
opencode run --command work-on "967"
opencode run --command review-pr "123"
```

### Manual pipeline loading

Read a pipeline command spec directly and follow it:

```
Read the file /path/to/forgedock/commands/work-on.md and run the pipeline for issue 967.
```

OpenCode will load the spec and execute each phase using its native tools.

### Phase routing with forge-run.sh

`forge-run.sh` emits JSON phase state for the current issue without invoking
an LLM. Use it to determine the current pipeline phase:

```bash
Bash("/path/to/forgedock/scripts/forge-run.sh work-on 967 -R OWNER/REPO")
```

Output (NDJSON):
```json
{"event":"phase_detected","command":"work-on","issue":967,"phase":"no-comments","ts":"..."}
{"event":"phase_detail","phase":"no-comments","lane":"feature","branch":"milestone/dev-exp","labels":[]}
{"event":"action_required","phase":"no-comments","action":"No pipeline activity detected. Invoke /work-on 967 to start investigation.","ts":"..."}
```

## Tool Translation

OpenCode and Claude Code share the same tool names. Most pipeline operations
run without modification:

| Claude Code | OpenCode | Notes |
|-------------|----------|-------|
| `Bash("git status")` | `Bash("git status")` | Direct |
| `Read("path/to/file")` | `Read("path/to/file")` | Direct |
| `Write("path", content)` | `Write("path", content)` | Direct |
| `Edit("path", ...)` | `Edit("path", ...)` | Direct |
| `Glob("**/*.md")` | `Glob("**/*.md")` | Direct |
| `Grep(pattern, path)` | `Grep(pattern, path)` | Direct |
| `WebFetch(url)` | `WebFetch(url)` | Direct |
| `Skill("work-on", args="123")` | Read `commands/work-on.md` | No skill loader — read spec directly |
| `Skill("review-pr", args="456")` | Read `commands/review-pr.md` | No skill loader — read spec directly |
| `Agent(...)` / `Task(...)` | Continue the sub-task inline | No sub-agent model; inline it |

### Nested Skill references

When a command spec calls `Skill("x")` or references another command, read
the referenced command spec directly:

```
# Load the referenced command spec:
Read("/path/to/forgedock/commands/quality-gate.md")
```

Map command names to file paths:
- `Skill("work-on")` → `commands/work-on.md`
- `Skill("review-pr")` → `commands/review-pr.md`
- `Skill("quality-gate")` → `commands/quality-gate.md`
- `Skill("orchestrate")` → `commands/orchestrate.md`

## GitHub Operations

All FORGE annotations are written to GitHub issue/PR comments via the `gh`
CLI. Use `Bash()` for every GitHub operation.

### Label management

```bash
Bash("gh issue edit 123 -R OWNER/REPO --add-label 'workflow:investigating'")
Bash("gh issue edit 123 -R OWNER/REPO --remove-label 'workflow:investigating'")
```

### Reading existing annotations

```bash
Bash("gh api repos/OWNER/REPO/issues/123/comments \
  --jq '.[] | select(.body | contains(\"FORGE:INVESTIGATOR\")) | .body'")
```

### Writing a FORGE annotation comment

For multi-line comment bodies, write the content to a temp file first:

```bash
# Write comment body to temp file (avoids shell quoting issues)
Write("/tmp/forge_comment.md", """<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: CONFIRMED
...
<!-- INVESTIGATION:COMPLETE -->""")

Bash("gh issue comment 123 -R OWNER/REPO --body \"$(cat /tmp/forge_comment.md)\"")
```

### Creating a PR

```bash
Write("/tmp/pr_body.md", """## Summary
...

Closes #967""")

Bash("gh pr create -R OWNER/REPO \
  --base milestone/developer-experience-distribution \
  --head feat/opencode-adapter-967 \
  --title 'feat: OpenCode adapter (#967)' \
  --body \"$(cat /tmp/pr_body.md)\"")
```

## Worktrees

ForgeDock uses git worktrees to isolate branch work. Create one with:

```bash
Bash("git fetch origin")
Bash("git worktree add .claude/worktrees/feat-my-feature-123 \
  -b feat/my-feature-123 origin/staging")
```

Work inside the worktree for all file edits and commits:

```bash
Read("/path/to/repo/.claude/worktrees/feat-my-feature-123/file.py")
Edit("/path/to/repo/.claude/worktrees/feat-my-feature-123/file.py", ...)
Bash("git -C /path/to/repo/.claude/worktrees/feat-my-feature-123 status")
```

## FORGE Annotation Protocol

Every pipeline stage writes a structured annotation to GitHub. Key rules:

1. **Idempotency**: Check for existing annotations BEFORE starting a phase.
   Do not re-run a completed phase.
2. **Compaction resilience**: Write annotations AFTER completing each
   significant step. GitHub is the persistent state layer.
3. **Restart partial annotations**: If an annotation exists without its
   `:COMPLETE` sentinel, delete it and restart the phase.
4. **Respect label state**: Labels track workflow state. Read and set them
   at each phase boundary.

### Label state machine

```
workflow:investigating
    → workflow:ready-to-build   (investigation complete)
    → workflow:building         (build started)
    → workflow:in-review        (PR created)
    → workflow:merged           (PR merged) [TERMINAL]

workflow:invalid                [TERMINAL]
workflow:decomposed             [TERMINAL]
needs-human                     [TERMINAL]
```

Stop the pipeline when any terminal label is set.

## Limitations

| Capability | Claude Code | OpenCode (this adapter) |
|------------|-------------|------------------------|
| Skill loading | Dynamic (`~/.claude/commands/`) | Read `commands/*.md` directly |
| Native slash commands | `/work-on 967` | `/work-on 967` (via `command` config) |
| Tool name parity | Native | Direct (same names) |
| Sub-agent invocation | `Skill("review-pr")` | Read `commands/review-pr.md` directly |
| Session continuity | Native compaction resilience | Re-read GitHub state each session |
| Multi-phase pipeline | Automatic (single continuous session) | Supported (GitHub state is persistent) |

**Sub-skill invocation**: When a command spec calls `Skill("x")`, OpenCode
has no native skill loader. Read the referenced command spec file directly
instead.

**Parallel tasks**: When a command spec calls `Agent(...)` or `Task(...)` for
parallelism (e.g., multi-agent review in `review-pr-agents.md`), execute the
sub-tasks sequentially. OpenCode runs one agent context at a time.

## Configuration

`install-opencode.sh` patches `~/.config/opencode/opencode.json`. Example
of what is added:

```json
{
  "instructions": [
    "~/.opencode-forge.md"
  ],
  "command": {
    "work-on": {
      "description": "Run the ForgeDock full issue pipeline (investigate → build → review → merge)",
      "template": "Read /path/to/forgedock/commands/work-on.md and execute the pipeline for issue {{args}}."
    },
    "review-pr": {
      "description": "Run the ForgeDock PR review pipeline",
      "template": "Read /path/to/forgedock/commands/review-pr.md and execute the PR review for PR {{args}}."
    },
    "quality-gate": {
      "description": "Run ForgeDock pre-commit quality checks",
      "template": "Read /path/to/forgedock/commands/quality-gate.md and run all quality gate checks."
    },
    "orchestrate": {
      "description": "Run ForgeDock parallel multi-issue orchestration",
      "template": "Read /path/to/forgedock/commands/orchestrate.md and orchestrate the issues: {{args}}."
    }
  }
}
```

Existing config keys (provider, model, etc.) are preserved. ForgeDock only
adds to the `instructions` array and `command` object — never overwrites.

## Reference

- [FORGE Protocol spec](FORGE-PROTOCOL.md) — annotation format, label state machine
- [Aider adapter](AIDER.md) — parallel adapter reference (Aider uses `/run` translation)
- [Codex adapter](CODEX.md) — parallel adapter reference (Codex skill model)
- [Pipeline commands](../commands/) — shared workflow specs (authoritative for all runtimes)
- [`install-opencode.sh`](../install-opencode.sh) — installer script
- [`scripts/forge-run.sh`](../scripts/forge-run.sh) — universal shell phase router
