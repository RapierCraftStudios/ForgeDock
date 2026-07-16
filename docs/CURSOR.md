# Cursor Support

ForgeDock has a Cursor adapter that lets Cursor Agent mode run the ForgeDock pipeline via shell commands and the `gh` CLI.

## Architecture

Shared source:
- `commands/**/*.md` remains the canonical workflow spec for all runtimes

Cursor wrapper:
- `templates/cursor/forge.mdc` — a static Cursor rules file that instructs Cursor Agent to execute pipeline phases using shell commands, `gh` CLI, and `git`
- Users install this file into their repo's `.cursor/rules/forge.mdc`

This is a static injection model, not a dynamic skill-loading mechanism. The adapter cannot replicate Claude Code's `Skill()` invocation or Codex's installed skill wrappers. Instead, it instructs the agent to read command specs directly from `commands/` and execute them using available terminal tools.

## Install

### Automatic (via `npx forgedock`)

If your project already has a `.cursor/` directory, `npx forgedock` will detect it and automatically write `templates/cursor/forge.mdc` to `.cursor/rules/forge.mdc`:

```bash
npx forgedock
```

The installer skips this step if `.cursor/rules/forge.mdc` already exists (idempotent — never overwrites customizations).

### Manual

Copy the template directly:

```bash
mkdir -p .cursor/rules
cp node_modules/forgedock/templates/cursor/forge.mdc .cursor/rules/forge.mdc
# or, if installed globally:
cp "$(npx forgedock which-dir)/templates/cursor/forge.mdc" .cursor/rules/forge.mdc
```

Commit the file to version control so all team members get it:

```bash
git add .cursor/rules/forge.mdc
git commit -m "chore: add ForgeDock Cursor rules adapter"
```

## Usage

### Running the Pipeline

Open a Cursor Agent session and describe the pipeline task:

```
Work on GitHub issue #123 using the ForgeDock pipeline.
Read commands/work-on.md and follow all phases.
```

The rules file will instruct Cursor Agent to:

1. Load issue context from GitHub using `gh issue view`
2. Follow the Universal Phase Dispatcher in `commands/work-on.md`
3. Write FORGE annotations (HTML comments) to issue comments after each phase
4. Transition `workflow:*` labels as phases complete
5. Continue until a terminal label is set

### Checking Pipeline State

```bash
# See current workflow state
gh issue view NUMBER --json labels --jq '[.labels[].name]'

# Read existing pipeline annotations
gh api repos/OWNER/REPO/issues/NUMBER/comments \
  --jq '.[] | select(.body | contains("FORGE:")) | {body: .body[:200]}'
```

### Continuing After a Phase

Because Cursor Agent mode does not persist between invocations, start a new session and describe the resume:

```
Resume the ForgeDock pipeline for GitHub issue #123.
Read commands/work-on.md — it will re-read GitHub state and pick up from the current label.
```

The pipeline is designed for compaction resilience — every phase re-reads GitHub state at the start, so a new Cursor Agent session picks up exactly where the previous session left off.

## Limitations

| Capability | Claude Code | Cursor (this adapter) |
|------------|-------------|----------------------|
| Skill loading | Dynamic (`~/.claude/commands/`) | Static (this rules file) |
| Multi-phase pipeline | Automatic (single continuous session) | Manual (re-invoke agent per phase) |
| Sub-skill invocation | `Skill("review-pr")` | Read `commands/review-pr.md` directly |
| Session continuity | Native compaction resilience | Re-read GitHub state each invocation |
| Tool set | Claude-native (`Bash`, `Read`, `Grep`, `Glob`, `WebFetch`) | Cursor Agent terminal tools |

### Multi-Phase Pipeline

The ForgeDock pipeline has 7 phases (investigate → build → review → merge → close → trajectory). Cursor Agent mode does not automatically advance through all phases in a single session. After each phase completes, you will need to start a new agent invocation and ask it to continue.

The pipeline's compaction resilience handles this correctly: each invocation re-reads the issue's labels and comments, determines the current phase, and continues from there. No context is lost between sessions.

### Sub-Skill Invocation

When the pipeline spec calls `Skill("review-pr")` or `Skill("quality-gate")`, Cursor Agent should read the referenced command spec file directly:

```bash
cat commands/review-pr.md   # Then execute that spec
cat commands/quality-gate.md
```

### Project Board Steps

Some pipeline phases (0C: Sync to Project board) call GitHub Projects API operations. These work via `gh` CLI but require the project number and field IDs from `forge.yaml`. Verify your `forge.yaml` has the correct project configuration before running the pipeline.

## Configuration

ForgeDock reads `forge.yaml` for project-specific settings:

```bash
cat forge.yaml   # Review before running the pipeline
```

Key fields used by the pipeline:
- `project.github.owner` / `project.github.repo` — GitHub repo coordinates
- `branches.staging` — target branch for fast-lane PRs
- `branches.main` — default branch

## Reference

- `commands/work-on.md` — Full pipeline spec (all phases)
- `commands/review-pr.md` — PR review spec
- `commands/quality-gate.md` — Pre-commit quality checks (14+ domains)
- `docs/FORGE-PROTOCOL.md` — FORGE annotation protocol specification
- `docs/CODEX.md` — Codex CLI adapter (dynamic skill model)
