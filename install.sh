#!/bin/bash
# RapierCraft Forge — Install Pipeline Commands
#
# Symlinks all Forge commands into ~/.claude/commands/ for global availability.
# Run this once after cloning, or after adding new commands.

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/.claude/commands"

echo "RapierCraft Forge — Installing pipeline commands"
echo "  Source: $FORGE_HOME/commands/"
echo "  Target: $TARGET_DIR/"
echo ""

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Track what we do
INSTALLED=0
SKIPPED=0
UPDATED=0

# Recursively find all .md files under commands/, preserving subdirectory structure
while IFS= read -r cmd; do
    # Compute relative path from the commands/ directory
    rel="${cmd#"$FORGE_HOME/commands/"}"
    target="$TARGET_DIR/$rel"

    # Ensure parent directory exists (for subdirectory commands like work-on/investigate.md)
    target_dir="$(dirname "$target")"
    mkdir -p "$target_dir"

    if [ -L "$target" ]; then
        # Symlink exists — check if it points to us
        current=$(readlink -f "$target")
        expected=$(readlink -f "$cmd")
        if [ "$current" = "$expected" ]; then
            SKIPPED=$((SKIPPED + 1))
        else
            # Points somewhere else — update it
            ln -sf "$cmd" "$target"
            echo "  Updated: $rel (was pointing to $current)"
            UPDATED=$((UPDATED + 1))
        fi
    elif [ -f "$target" ]; then
        # Regular file exists — don't clobber, warn
        echo "  WARNING: $target is a regular file (not a symlink). Skipping."
        echo "           Remove it manually if you want Forge to manage this command."
        SKIPPED=$((SKIPPED + 1))
    else
        # Doesn't exist — create symlink
        ln -s "$cmd" "$target"
        echo "  Installed: $rel"
        INSTALLED=$((INSTALLED + 1))
    fi
done < <(find "$FORGE_HOME/commands" -name "*.md" | sort)

echo ""
echo "Done. Installed: $INSTALLED, Updated: $UPDATED, Skipped: $SKIPPED"
echo ""
echo "Forge commands are now available as slash commands in any Claude Code session."
echo "Pipeline docs: $FORGE_HOME/docs/"

# Set FORGE_HOME in shell profile(s) if not already set
PROFILE_UPDATED=0
for profile in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$profile" ] && ! grep -q "FORGE_HOME" "$profile" 2>/dev/null; then
        echo "" >> "$profile"
        echo "# RapierCraft Forge — autonomous development pipeline" >> "$profile"
        echo "export FORGE_HOME=\"$FORGE_HOME\"" >> "$profile"
        echo "Added FORGE_HOME to $profile"
        PROFILE_UPDATED=$((PROFILE_UPDATED + 1))
    fi
done
if [ "$PROFILE_UPDATED" -gt 0 ]; then
    echo ""
    echo "Restart your shell or run:"
    echo "  export FORGE_HOME=\"$FORGE_HOME\""
fi
