#!/bin/bash
# ForgeDock — Install Aider Adapter
#
# Writes ~/.aider-forge.md — a conventions file that Aider loads at session
# start via --read, giving it ForgeDock workflow awareness without modifying
# the existing Claude Code or Codex install paths.
#
# Usage:
#   ./install-aider.sh
#
# After running:
#   aider --read ~/.aider-forge.md
#   # or add to .aider.conf.yml — see docs/AIDER.md

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
TARGET_FILE="$HOME/.aider-forge.md"

# Sentinel written at the top of the conventions file so install and uninstall
# can identify ForgeDock-managed content without comparing full file content.
SENTINEL="<!-- ForgeDock managed — do not remove this line -->"

echo "ForgeDock — Installing Aider adapter"
echo "  Source: $FORGE_HOME/commands/"
echo "  Target: $TARGET_FILE"
echo ""

write_conventions_file() {
    cat > "$TARGET_FILE" << EOF
${SENTINEL}
# ForgeDock — Aider Conventions

You are an AI coding agent running the ForgeDock autonomous development
pipeline. ForgeDock uses GitHub as a structured knowledge graph: every
pipeline stage writes a structured annotation (FORGE:INVESTIGATOR,
FORGE:CONTRACT, FORGE:BUILDER, etc.) to GitHub issue comments and reads
prior annotations to reconstruct context after compaction or session restart.

## Runtime: Aider

You are operating as an Aider agent. ForgeDock was designed for Claude Code,
but the FORGE annotation protocol is transport-agnostic. Translate Claude
Code tool invocations as follows:

| Claude Code | Aider equivalent |
|-------------|-----------------|
| \`Skill("work-on", args="123")\` | \`/read $FORGE_HOME/commands/work-on.md\` then execute |
| \`Skill("review-pr", args="456")\` | \`/read $FORGE_HOME/commands/review-pr.md\` then execute |
| \`Skill("quality-gate")\` | \`/read $FORGE_HOME/commands/quality-gate.md\` then execute |
| \`Bash("...")\` | \`/run ...\` in Aider |
| \`Read("path")\` | Read file directly |
| \`Grep(pattern)\` | \`/run rg 'pattern' path\` |
| \`Glob("**/*.md")\` | \`/run find . -name "*.md"\` |
| \`WebFetch(url)\` | \`/run curl -s url\` |
| \`Agent(...)\` | Continue the sub-task yourself |

## Entry Points

Load a pipeline command on demand with \`/read\`:

\`\`\`
/read $FORGE_HOME/commands/work-on.md
\`\`\`

Then invoke it by reading the command spec and following it step by step,
using \`/run\` for all shell operations.

Common entry points:
- \`/read $FORGE_HOME/commands/work-on.md\`       — full issue pipeline
- \`/read $FORGE_HOME/commands/review-pr.md\`     — PR review
- \`/read $FORGE_HOME/commands/orchestrate.md\`   — parallel multi-issue
- \`/read $FORGE_HOME/commands/quality-gate.md\`  — pre-commit checks
- \`/read $FORGE_HOME/commands/autopilot.md\`     — continuous self-improvement

## GitHub Operations

All FORGE annotations are written to GitHub issue/PR comments via the \`gh\`
CLI. Use \`/run gh ...\` for every GitHub operation. Examples:

\`\`\`bash
# Label management
/run gh issue edit 123 --add-label "workflow:investigating"

# Post a FORGE annotation comment
/run gh issue comment 123 --body "<!-- FORGE:INVESTIGATOR -->
## Investigation Report
..."

# Read existing annotations
/run gh api repos/OWNER/REPO/issues/123/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Create a PR
/run gh pr create --base staging --head feat/my-branch --title "feat: ..." --body "..."
\`\`\`

## Worktrees

ForgeDock uses git worktrees to isolate branch work. Create them with:

\`\`\`bash
/run git worktree add .claude/worktrees/feat-my-feature-123 -b feat/my-feature-123 origin/staging
\`\`\`

Work inside the worktree for all file edits and commits.

## FORGE Annotation Protocol

Every pipeline stage writes a structured annotation to GitHub. Key rules:
1. Check for existing annotations BEFORE starting a phase (idempotency)
2. Write annotations AFTER completing each significant step (compaction resilience)
3. Delete and restart interrupted partial annotations (missing \`:COMPLETE\` sentinel)
4. Respect label state machine: \`workflow:investigating\` → \`workflow:ready-to-build\` → \`workflow:building\` → \`workflow:in-review\` → \`workflow:merged\`

Terminal states that stop the pipeline: \`workflow:merged\`, \`workflow:invalid\`, \`needs-human\`, \`workflow:decomposed\`.

## Reference

- Full pipeline spec: \`$FORGE_HOME/commands/work-on.md\`
- Annotation protocol: \`$FORGE_HOME/docs/FORGE-PROTOCOL.md\`
- Aider adapter guide: \`$FORGE_HOME/docs/AIDER.md\`
EOF
}

# Check if file already exists with our sentinel
if [ -f "$TARGET_FILE" ]; then
    if grep -qF "$SENTINEL" "$TARGET_FILE" 2>/dev/null; then
        # Regenerate to pick up any FORGE_HOME path changes
        write_conventions_file
        echo "Updated: $TARGET_FILE"
    else
        echo "WARNING: $TARGET_FILE exists but was not written by ForgeDock."
        echo "         Skipping to avoid overwriting user content."
        echo "         Remove it manually and re-run to install the ForgeDock conventions."
        exit 0
    fi
else
    write_conventions_file
    echo "Installed: $TARGET_FILE"
fi

echo ""
echo "Next steps:"
echo ""
echo "  Option A — pass on the command line:"
echo "    aider --read ~/.aider-forge.md"
echo ""
echo "  Option B — add to .aider.conf.yml in your project root:"
echo "    read:"
echo "      - ~/.aider-forge.md"
echo ""
echo "  Then load a pipeline command:"
echo "    /read $FORGE_HOME/commands/work-on.md"
echo "    (follow the command spec, using /run for shell operations)"
echo ""
echo "Reference: $FORGE_HOME/docs/AIDER.md"
