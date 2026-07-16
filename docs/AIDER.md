# Aider Support

ForgeDock has an additive Aider-native install path. The goal is to give Aider
users access to the ForgeDock pipeline without regressing the existing Claude
Code or Codex setups.

## Architecture

Shared source:
- `commands/**/*.md` remains the workflow spec for all runtimes

Claude Code wrapper:
- `install.sh` (or `npx forgedock`) symlinks command files into `~/.claude/commands/`

Codex wrapper:
- `install-codex.sh` generates namespaced skills in `~/.codex/skills/`

**Aider wrapper** (this document):
- `install-aider.sh` writes `~/.aider-forge.md` — a conventions file Aider
  loads at session start via `--read`
- The conventions file provides runtime mapping rules and entry point references
- Aider reads ForgeDock command specs on demand with `/read $FORGE_HOME/commands/x.md`

This is intentionally a conventions-file architecture, not a duplicate command
tree. The shared `commands/` directory remains the single source of truth.

## Install

### Option A — standalone bash installer

```bash
cd /path/to/forgedock
./install-aider.sh
```

This writes `~/.aider-forge.md` with ForgeDock conventions and runtime mapping
rules.

### Option B — via npx forgedock

If you already use `npx forgedock` for Claude Code:

```bash
npx forgedock
```

When `aider` is detected on your PATH, `npx forgedock` writes `~/.aider-forge.md`
as an additional install step. No existing Claude Code files are affected.

## Usage

### Per-session (command line)

```bash
aider --read ~/.aider-forge.md
```

### Always-on (`.aider.conf.yml`)

Add to your project's `.aider.conf.yml`:

```yaml
read:
  - ~/.aider-forge.md
```

Or to `~/.aider.conf.yml` for global application across all projects.

### Loading a pipeline command

Once Aider has the conventions file loaded, load a command spec on demand:

```
/read /path/to/forgedock/commands/work-on.md
```

Then follow the command spec step by step, using `/run` for all shell
operations.

## Tool Translation Rules

ForgeDock command specs reference Claude Code-specific tools. Translate them
to Aider equivalents:

| Claude Code | Aider equivalent | Notes |
|-------------|-----------------|-------|
| `Skill("work-on", args="123")` | `/read $FORGE_HOME/commands/work-on.md` | Load the spec and execute it |
| `Skill("review-pr", args="456")` | `/read $FORGE_HOME/commands/review-pr.md` | Load the spec and execute it |
| `Skill("quality-gate")` | `/read $FORGE_HOME/commands/quality-gate.md` | Load the spec and execute it |
| `Bash("git status")` | `/run git status` | Direct shell execution |
| `Read("path/to/file")` | Read the file directly | Aider's native file read |
| `Grep(pattern, path)` | `/run rg 'pattern' path` | Use `rg` (ripgrep) |
| `Glob("**/*.md")` | `/run find . -name "*.md"` | Shell find |
| `WebFetch(url)` | `/run curl -s url` | curl or wget |
| `Agent(...)` / `Task(...)` | Continue the sub-task yourself | No sub-agent support; inline it |
| `EnterWorktree(path)` | `/run cd path` then use `/run` | Work in worktree directory |

### Nested Skill references

When a command spec calls `Skill("x")` or references another command:

```
# Load the referenced command spec manually:
/read $FORGE_HOME/commands/x.md
```

Map command names to file paths:
- `Skill("work-on")` → `commands/work-on.md`
- `Skill("review-pr")` → `commands/review-pr.md`
- `Skill("quality-gate")` → `commands/quality-gate.md`
- `Skill("orchestrate")` → `commands/orchestrate.md`

## GitHub Operations

All FORGE annotations are written to GitHub issue/PR comments via the `gh`
CLI. Use `/run gh ...` for every GitHub operation.

### Label management

```bash
/run gh issue edit 123 -R OWNER/REPO --add-label "workflow:investigating"
/run gh issue edit 123 -R OWNER/REPO --remove-label "workflow:investigating"
```

### Reading existing annotations

```bash
/run gh api repos/OWNER/REPO/issues/123/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'
```

### Writing a FORGE annotation comment

```bash
/run gh issue comment 123 -R OWNER/REPO --body "<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: CONFIRMED
...
<!-- INVESTIGATION:COMPLETE -->"
```

For multi-line comment bodies, write the content to a temp file first:

```bash
cat > /tmp/comment.md << 'EOF'
<!-- FORGE:INVESTIGATOR -->
## Investigation Report
...
<!-- INVESTIGATION:COMPLETE -->
EOF
/run gh issue comment 123 -R OWNER/REPO --body "$(cat /tmp/comment.md)"
```

### Creating a PR

```bash
/run gh pr create -R OWNER/REPO \
  --base staging \
  --head feat/my-branch-123 \
  --title "feat: description (#123)" \
  --body "$(cat /tmp/pr_body.md)"
```

## Worktrees

ForgeDock uses git worktrees to isolate branch work. Create one with:

```bash
/run git fetch origin
/run git worktree add .claude/worktrees/feat-my-feature-123 \
  -b feat/my-feature-123 origin/staging
```

Work inside the worktree for all file edits and commits. Aider's `/run`
commands execute in the worktree directory if you `cd` to it:

```bash
/run cd /path/to/repo/.claude/worktrees/feat-my-feature-123
```

Or pass the path explicitly in each command:

```bash
/run git -C /path/to/repo/.claude/worktrees/feat-my-feature-123 status
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

## Feasibility Analysis

Aider is the highest-feasibility non-Claude agent for ForgeDock because:

| Capability | Requirement | Aider support |
|-----------|-------------|---------------|
| Load instruction files | `--read` flag / `.aider.conf.yml` | Native |
| Execute shell commands | `gh`, `git`, `rg` via shell | `/run` command |
| Read/write files | File editing | Native |
| GitHub API | `gh` CLI | Via `/run gh ...` |
| Multi-step workflows | Follow sequential instructions | Supported |
| Compaction resilience | Re-read GitHub state at phase start | Supported (via `/run gh ...`) |

**Limitation**: Aider has no native sub-agent/parallel task model (`Agent(...)`,
`Task(...)`). Phase 3 parallel context gathering (`FORGE:CONTEXT`) and
multi-agent review (`review-pr-agents.md`) must be executed sequentially.
For the orchestrate command (`/orchestrate`), run one issue at a time or
use separate Aider sessions per issue.

## Trust and Configuration

Aider does not have a project trust model. Once `~/.aider-forge.md` is loaded,
all operations in that session have access to shell execution via `/run`.

**Security note**: ForgeDock's shell operations are limited to `gh`, `git`,
`rg`, `find`, and standard POSIX tools. The conventions file does not execute
arbitrary code at load time — it only provides instruction text.

## Usage Notes

- Use `--read ~/.aider-forge.md` on every session, or add it to
  `.aider.conf.yml` for automatic loading.
- Load command specs on demand with `/read $FORGE_HOME/commands/x.md` —
  do not load all commands at once.
- Keep `CLAUDE.md` and `AGENTS.md` aligned with ForgeDock conventions;
  Aider and Claude Code can differ at the wrapper layer but not on FORGE
  workflow invariants (annotation format, label state machine, branch
  naming, worktree conventions).
- For pipeline stages that post FORGE annotations, always write the body
  to a temp file before passing to `gh issue comment` to avoid shell
  quoting issues with multi-line content.

## Reference

- [FORGE Protocol spec](FORGE-PROTOCOL.md) — annotation format, label state machine, conformance tests
- [Codex adapter](CODEX.md) — parallel reference for OpenAI Codex CLI
- [Pipeline commands](../commands/) — shared workflow specs (authoritative for all runtimes)
- [`install-aider.sh`](../install-aider.sh) — installer script
