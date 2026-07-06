#!/bin/bash
# RapierCraft Forge — Install Pipeline Commands
#
# Symlinks all Forge commands into ~/.claude/commands/ for global availability.
# Run this once after cloning, or after adding new commands.

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/.claude/commands"

# Worktree guard — refuse to install when running from a git worktree.
# In a worktree, .git is a regular file (not a directory); installing from a
# worktree would repoint all ~/.claude/commands/ symlinks to an ephemeral path
# that disappears when the worktree is cleaned up, breaking every Forge command.
# <!-- Added: forge#1037 -->
if [ -f "$FORGE_HOME/.git" ]; then
    echo "ERROR: install.sh is running from a git worktree." >&2
    echo "       FORGE_HOME: $FORGE_HOME" >&2
    echo "       Installing from a worktree would repoint ~/.claude/commands/ symlinks" >&2
    echo "       to an ephemeral path that breaks when the worktree is deleted." >&2
    echo "       Run install.sh from the main repository clone instead." >&2
    exit 1
fi

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
        # Symlink exists — check if it points to us.
        # Use plain readlink (not -f) to read the stored link value without
        # resolving the target. readlink -f fails with exit 1 on broken symlinks,
        # which crashes the script under set -euo pipefail. Plain readlink reads
        # the stored path and always succeeds for any symlink. <!-- forge#1037 -->
        current=$(readlink "$target")
        if [ "$current" = "$cmd" ]; then
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

# Write .symlink-source sentinel so other tools can detect who owns the symlinks
# and refuse to over-install from a different (possibly ephemeral) source.
# <!-- Added: forge#1037 -->
SENTINEL="$TARGET_DIR/.symlink-source"
INSTALL_TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S")
cat > "$SENTINEL" <<SENTINEL_EOF
# Forge command symlinks — DO NOT REPOINT
# Source: $FORGE_HOME/commands/
#
# These symlinks are managed by RapierCraft Forge.
# Running another tool's install script here will repoint them away from Forge,
# breaking all forge commands if the new source is an ephemeral worktree.
#
# To reinstall: cd $FORGE_HOME && ./install.sh
# Last installed: $INSTALL_TIMESTAMP
SENTINEL_EOF

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
