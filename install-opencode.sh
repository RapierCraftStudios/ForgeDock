#!/bin/bash
# ForgeDock — Install OpenCode Adapter
#
# Writes ~/.opencode-forge.md — a conventions file loaded by OpenCode via the
# "instructions" field in opencode.json, giving it ForgeDock workflow awareness
# without modifying the existing Claude Code or Codex install paths.
#
# Also patches ~/.config/opencode/opencode.json to register ForgeDock pipeline
# commands as native OpenCode slash commands (work-on, review-pr, quality-gate,
# orchestrate) and to add the conventions file to the "instructions" array.
#
# Usage:
#   ./install-opencode.sh
#
# After running:
#   opencode run --command work-on "967"
#   # or launch the TUI and type /work-on 967
#   # see docs/OPENCODE.md

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
CONVENTIONS_FILE="$HOME/.opencode-forge.md"
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_CONFIG="$OPENCODE_CONFIG_DIR/opencode.json"

# Sentinel written at the top of the conventions file so install and uninstall
# can identify ForgeDock-managed content without comparing full file content.
SENTINEL="<!-- ForgeDock managed — do not remove this line -->"

echo "ForgeDock — Installing OpenCode adapter"
echo "  Source: $FORGE_HOME/commands/"
echo "  Conventions: $CONVENTIONS_FILE"
echo "  Config: $OPENCODE_CONFIG"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Write conventions file (~/.opencode-forge.md)
# ---------------------------------------------------------------------------

write_conventions_file() {
    cat > "$CONVENTIONS_FILE" << EOF
${SENTINEL}
# ForgeDock — OpenCode Conventions

You are an AI coding agent running the ForgeDock autonomous development
pipeline. ForgeDock uses GitHub as a structured knowledge graph: every
pipeline stage writes a structured annotation (FORGE:INVESTIGATOR,
FORGE:CONTRACT, FORGE:BUILDER, etc.) to GitHub issue comments and reads
prior annotations to reconstruct context after compaction or session restart.

## Runtime: OpenCode

You are operating as an OpenCode agent. ForgeDock was designed for Claude Code,
but the FORGE annotation protocol is transport-agnostic. OpenCode shares the
same tool names as Claude Code, so most operations work without translation.

### Tool Parity (Claude Code → OpenCode)

| Claude Code | OpenCode equivalent | Notes |
|-------------|---------------------|-------|
| \`Bash("...")\` | \`Bash("...")\` | Direct — same tool name |
| \`Read("path")\` | \`Read("path")\` | Direct — same tool name |
| \`Write("path")\` | \`Write("path")\` | Direct — same tool name |
| \`Edit("path")\` | \`Edit("path")\` | Direct — same tool name |
| \`Glob("**/*.md")\` | \`Glob("**/*.md")\` | Direct — same tool name |
| \`Grep(pattern)\` | \`Grep(pattern)\` | Direct — same tool name |
| \`WebFetch(url)\` | \`WebFetch(url)\` | Direct — same tool name |
| \`Skill("work-on", args="123")\` | Read \`$FORGE_HOME/commands/work-on.md\` then execute | No native skill loader; read spec directly |
| \`Skill("review-pr", args="456")\` | Read \`$FORGE_HOME/commands/review-pr.md\` then execute | No native skill loader; read spec directly |
| \`Skill("quality-gate")\` | Read \`$FORGE_HOME/commands/quality-gate.md\` then execute | No native skill loader; read spec directly |
| \`Agent(...)\` | Continue the sub-task yourself | No sub-agent model in OpenCode; inline it |

## Entry Points

### Via slash commands (if commands are registered in opencode.json)

If \`install-opencode.sh\` registered ForgeDock commands in your opencode.json,
use OpenCode's native command interface:

\`\`\`
/work-on 967
/review-pr 123
/quality-gate
\`\`\`

### Via pipeline command files

Read a pipeline command spec directly and follow it:

\`\`\`bash
# Load and execute the work-on pipeline
Read("$FORGE_HOME/commands/work-on.md")
\`\`\`

Then follow the command spec step by step. Use Bash() for all shell operations.

Common entry points:
- \`$FORGE_HOME/commands/work-on.md\`       — full issue pipeline
- \`$FORGE_HOME/commands/review-pr.md\`     — PR review
- \`$FORGE_HOME/commands/orchestrate.md\`   — parallel multi-issue
- \`$FORGE_HOME/commands/quality-gate.md\`  — pre-commit checks
- \`$FORGE_HOME/commands/autopilot.md\`     — continuous self-improvement

### Via forge-run.sh (phase routing)

\`forge-run.sh\` emits JSON phase state for the current issue. Use it to
determine which pipeline phase to start from:

\`\`\`bash
Bash("$FORGE_HOME/scripts/forge-run.sh work-on 967 -R OWNER/REPO")
\`\`\`

## GitHub Operations

All FORGE annotations are written to GitHub issue/PR comments via the \`gh\`
CLI. Use Bash() for every GitHub operation. Examples:

\`\`\`bash
# Label management
Bash("gh issue edit 123 --add-label 'workflow:investigating'")

# Post a FORGE annotation comment
Bash("gh issue comment 123 --body '<!-- FORGE:INVESTIGATOR -->
## Investigation Report
...'")

# Read existing annotations
Bash("gh api repos/OWNER/REPO/issues/123/comments \\
  --jq '.[] | select(.body | contains(\"FORGE:INVESTIGATOR\")) | .body'")

# Create a PR
Bash("gh pr create --base staging --head feat/my-branch --title 'feat: ...' --body '...'")
\`\`\`

## Worktrees

ForgeDock uses git worktrees to isolate branch work. Create them with:

\`\`\`bash
Bash("git worktree add .claude/worktrees/feat-my-feature-123 -b feat/my-feature-123 origin/staging")
\`\`\`

Work inside the worktree for all file edits and commits:

\`\`\`bash
Read("/path/to/repo/.claude/worktrees/feat-my-feature-123/file.py")
Bash("git -C /path/to/repo/.claude/worktrees/feat-my-feature-123 status")
\`\`\`

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
- OpenCode adapter guide: \`$FORGE_HOME/docs/OPENCODE.md\`
EOF
}

# Check if conventions file already exists with our sentinel
if [ -f "$CONVENTIONS_FILE" ]; then
    if grep -qF "$SENTINEL" "$CONVENTIONS_FILE" 2>/dev/null; then
        # Regenerate to pick up any FORGE_HOME path changes
        write_conventions_file
        echo "Updated: $CONVENTIONS_FILE"
    else
        echo "WARNING: $CONVENTIONS_FILE exists but was not written by ForgeDock."
        echo "         Skipping to avoid overwriting user content."
        echo "         Remove it manually and re-run to install the ForgeDock conventions."
        exit 0
    fi
else
    write_conventions_file
    echo "Installed: $CONVENTIONS_FILE"
fi

# ---------------------------------------------------------------------------
# Step 2: Patch ~/.config/opencode/opencode.json
# ---------------------------------------------------------------------------

# Create config directory if it doesn't exist
mkdir -p "$OPENCODE_CONFIG_DIR"

# Read existing config or start with empty object
if [ -f "$OPENCODE_CONFIG" ]; then
    EXISTING_CONFIG=$(cat "$OPENCODE_CONFIG")
else
    EXISTING_CONFIG="{}"
fi

# Patch the config using node — it handles JSON merging, JSONC stripping,
# and atomic write (write to .tmp then rename) consistently with forgedock.mjs.
# This avoids bash-level JSON manipulation which is error-prone.
node - "$OPENCODE_CONFIG" "$CONVENTIONS_FILE" "$FORGE_HOME" << 'NODE_EOF'
const { readFileSync, writeFileSync, renameSync, existsSync } = require("fs");
const path = require("path");

const configPath = process.argv[2];
const conventionsPath = process.argv[3];
const forgeHome = process.argv[4];

// Strip JSONC (comments and trailing commas) before parsing.
// Character-by-character parser — mirrors stripJsonc() in forgedock.mjs.
// Correctly handles // and /* inside string literals (e.g., https:// URLs).
function stripJsonc(raw) {
  let result = "";
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const ch = raw[i];

    // Inside a string literal — copy until unescaped closing quote
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const sc = raw[i];
        result += sc;
        if (sc === "\\" && i + 1 < len) {
          i++;
          result += raw[i];
        } else if (sc === '"') {
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // Single-line comment — skip until newline
    if (ch === "/" && i + 1 < len && raw[i + 1] === "/") {
      while (i < len && raw[i] !== "\n") i++;
      continue;
    }

    // Block comment — skip until */
    if (ch === "/" && i + 1 < len && raw[i + 1] === "*") {
      i += 2;
      while (i + 1 < len && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i + 1 < len) i += 2;
      continue;
    }

    // Trailing comma before } or ]
    if (ch === ",") {
      let j = i + 1;
      while (j < len && (raw[j] === " " || raw[j] === "\t" || raw[j] === "\r" || raw[j] === "\n")) j++;
      if (j < len && (raw[j] === "}" || raw[j] === "]")) {
        i++;
        continue;
      }
    }

    result += ch;
    i++;
  }
  return result;
}

// Atomic write: write to .tmp then rename
function atomicWriteFile(filePath, content) {
  const tmpPath = filePath + ".forgedock.tmp";
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(tmpPath);
    } catch {
      // already gone or never created
    }
    throw err;
  }
}

// Read existing config
let config = {};
if (existsSync(configPath)) {
  try {
    const raw = readFileSync(configPath, "utf-8");
    config = JSON.parse(stripJsonc(raw));
  } catch (err) {
    process.stderr.write(
      `WARNING: Could not parse ${configPath}: ${err.message}\n` +
      `         Skipping opencode.json patch to avoid corruption.\n`
    );
    process.exit(0);
  }
}

// Ensure "instructions" array exists
if (!Array.isArray(config.instructions)) {
  config.instructions = [];
}

// Add conventions file to instructions if not already present
if (!config.instructions.includes(conventionsPath)) {
  config.instructions.push(conventionsPath);
}

// Ensure "command" object exists
if (typeof config.command !== "object" || config.command === null || Array.isArray(config.command)) {
  config.command = {};
}

// Register ForgeDock pipeline commands
const commands = {
  "work-on": {
    description: "Run the ForgeDock full issue pipeline (investigate → build → review → merge)",
    template: `Read ${forgeHome}/commands/work-on.md and execute the pipeline for issue {{args}}.`,
  },
  "review-pr": {
    description: "Run the ForgeDock PR review pipeline",
    template: `Read ${forgeHome}/commands/review-pr.md and execute the PR review for PR {{args}}.`,
  },
  "quality-gate": {
    description: "Run ForgeDock pre-commit quality checks",
    template: `Read ${forgeHome}/commands/quality-gate.md and run all quality gate checks.`,
  },
  "orchestrate": {
    description: "Run ForgeDock parallel multi-issue orchestration",
    template: `Read ${forgeHome}/commands/orchestrate.md and orchestrate the issues: {{args}}.`,
  },
};

// Only add commands that are not already defined (don't overwrite user customizations)
for (const [name, def] of Object.entries(commands)) {
  if (!config.command[name]) {
    config.command[name] = def;
  }
}

// Write back
atomicWriteFile(configPath, JSON.stringify(config, null, 4) + "\n");
process.stdout.write(`Patched: ${configPath}\n`);
process.stdout.write(`  + instructions: ${conventionsPath}\n`);
process.stdout.write(`  + commands: work-on, review-pr, quality-gate, orchestrate\n`);
NODE_EOF

echo ""
echo "Next steps:"
echo ""
echo "  Option A — use native slash commands in the OpenCode TUI:"
echo "    opencode"
echo "    > /work-on 967"
echo ""
echo "  Option B — run headlessly:"
echo "    opencode run --command work-on '967'"
echo ""
echo "  Option C — load the pipeline spec directly:"
echo "    opencode"
echo "    > Read $FORGE_HOME/commands/work-on.md then run the pipeline for issue 967"
echo ""
echo "Reference: $FORGE_HOME/docs/OPENCODE.md"
