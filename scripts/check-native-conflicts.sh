#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-native-conflicts.sh — Validate that ForgeDock command names do not shadow
#                              native Claude Code built-in slash commands.
#
# ForgeDock commands are installed as custom slash commands in ~/.claude/commands/.
# If a command file shares its name with a native Claude Code built-in (e.g. /resume,
# /status), it shadows the native command entirely — users lose access to core
# Claude Code functionality.
#
# This script:
#   1. Maintains a blocklist of known native Claude Code slash command names.
#   2. Scans all .md files in commands/ (recursively) and extracts the command
#      name (filename without .md extension).
#   3. Checks each command name against the blocklist (case-insensitive).
#   4. Exits non-zero if any conflict is found, printing the offending file(s).
#
# Usage:
#   check-native-conflicts.sh [<commands_dir>]
#     commands_dir: path to the commands/ directory (default: ./commands)
#
# Exit codes:
#   0  no conflicts found
#   1  one or more conflicts found (names listed to stderr)
#   2  usage / dependency error (commands_dir not found)
#
# <!-- Added: forge#1074 -->

set -euo pipefail

COMMANDS_DIR="${1:-./commands}"

if [ ! -d "$COMMANDS_DIR" ]; then
  echo "ERROR: commands directory not found: $COMMANDS_DIR" >&2
  echo "Usage: $0 [<commands_dir>]" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Blocklist of known native Claude Code slash command names.
# These are names that Claude Code reserves as built-in commands.
# Command names are always lowercase — comparison is case-insensitive.
#
# To update this list: add the new native command name (without leading /).
# Keep entries alphabetically sorted within logical groups for readability.
# ---------------------------------------------------------------------------
NATIVE_COMMANDS=(
  # Core session management
  resume
  status
  exit
  clear
  compact
  config
  memory
  permissions
  rewind
  init

  # Model and capability controls
  model
  plan
  effort
  focus

  # Code and diff operations
  diff
  review
  debug
  run
  verify
  branch
  rename
  copy

  # Help and onboarding
  help
  doctor
  feedback
  setup-bedrock
  setup-vertex
  terminal-setup
  web-setup
  team-onboarding
  upgrade

  # Agents and orchestration
  agents
  context
  tasks
  fork
  batch
  loop
  goal
  background
  teleport
  remote-control
  remote-env

  # Skills and plugins
  skills
  plugin
  reload-plugins
  reload-skills
  run-skill-generator

  # Review and code quality
  code-review
  security-review
  simplify
  ultraplan
  ultrareview

  # Usage and billing
  usage
  extra-usage
  usage-credits

  # UI and display
  theme
  tui
  statusline
  powerup

  # Workflow and scheduling
  schedule
  workflows
  stop
  recap

  # MCP
  mcp

  # Miscellaneous
  btw
  sandbox
  voice
  radio
  stickers
  release-notes
  privacy-settings
  setup
)

# ---------------------------------------------------------------------------
# Build a fast-lookup set from the blocklist (bash associative array).
# ---------------------------------------------------------------------------
declare -A BLOCKLIST
for name in "${NATIVE_COMMANDS[@]}"; do
  BLOCKLIST["${name,,}"]=1   # store as lowercase
done

# ---------------------------------------------------------------------------
# Scan commands/ for .md files and check each basename against the blocklist.
#
# Scope: TOP-LEVEL files in commands/ only.
#
# ForgeDock installs commands preserving their relative path:
#   commands/foo.md          → ~/.claude/commands/foo.md          → /foo
#   commands/work-on/bar.md  → ~/.claude/commands/work-on/bar.md  → /work-on/bar
#
# Only top-level .md files resolve to a root-level slash command (e.g. /foo).
# Sub-phase files in subdirectories (commands/work-on/*.md) resolve to namespaced
# commands (/work-on/bar) and cannot shadow native root commands.
# ---------------------------------------------------------------------------
CONFLICTS=()

while IFS= read -r -d '' md_file; do
  # Extract command name: basename without .md extension, lowercased.
  basename_no_ext="${md_file##*/}"
  basename_no_ext="${basename_no_ext%.md}"
  cmd_name="${basename_no_ext,,}"

  if [[ -n "${BLOCKLIST[$cmd_name]+_}" ]]; then
    CONFLICTS+=("$md_file  (conflicts with native /$cmd_name)")
  fi
done < <(find "$COMMANDS_DIR" -maxdepth 1 -name "*.md" -print0 | sort -z)

# ---------------------------------------------------------------------------
# Report and exit.
# ---------------------------------------------------------------------------
if [ ${#CONFLICTS[@]} -gt 0 ]; then
  echo "ERROR: ForgeDock command name(s) shadow native Claude Code built-in commands:" >&2
  echo "" >&2
  for conflict in "${CONFLICTS[@]}"; do
    echo "  $conflict" >&2
  done
  echo "" >&2
  echo "Native Claude Code commands are inaccessible when a ForgeDock command" >&2
  echo "shares their name. Rename the conflicting file(s) before publishing." >&2
  echo "" >&2
  echo "To update the native command blocklist, edit:" >&2
  echo "  scripts/check-native-conflicts.sh (NATIVE_COMMANDS array)" >&2
  exit 1
fi

echo "OK: No native Claude Code command conflicts detected in $COMMANDS_DIR"
exit 0
