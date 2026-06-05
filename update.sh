#!/bin/bash
# RapierCraft Forge — Auto-Update
#
# Pulls latest changes from origin/main and reinstalls any new commands.
# Safe to run from cron — only fast-forwards, never forces.

set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
LOG="$FORGE_HOME/.update.log"

{
    echo "--- $(date '+%Y-%m-%d %H:%M:%S') ---"

    cd "$FORGE_HOME"

    # Only pull if on main branch
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ "$BRANCH" != "main" ]; then
        echo "Not on main branch ($BRANCH) — skipping"
        exit 0
    fi

    # Fast-forward only — never creates merge commits
    BEFORE=$(git rev-parse HEAD)
    git fetch origin main --quiet 2>&1
    git merge --ff-only origin/main --quiet 2>&1 || {
        echo "Cannot fast-forward — local changes exist. Skipping."
        exit 0
    }
    AFTER=$(git rev-parse HEAD)

    if [ "$BEFORE" = "$AFTER" ]; then
        echo "Already up to date."
    else
        echo "Updated: $(git log --oneline ${BEFORE}..${AFTER})"

        # Reinstall to pick up any new commands
        "$FORGE_HOME/install.sh" 2>&1
    fi
} >> "$LOG" 2>&1
