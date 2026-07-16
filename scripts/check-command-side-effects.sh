#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-command-side-effects.sh — Scan commands/**/*.md for two classes of
#                                  spec-as-code side-effect defects.
#
# Command specs are spec-as-code: they drive autonomous side effects (auto-merge,
# gh gist create, git push, label mutations, issue creation). This script catches
# two defect classes before they reach staging:
#
#   Class A — Unconditionally prohibited patterns (full-corpus, always blocked):
#     `gh gist create --public` or `gh gist edit --public` anywhere in a code block.
#     Gists created by the pipeline MUST be secret — --public exposes private repo
#     titles, root causes, and file paths to the world. (Ref: forge#1587)
#
#   Class B — Side-effect verbs in sections with no DRY_RUN/governor guard (diff-aware):
#     When added lines introduce a side-effect verb (gh issue create, gh pr merge,
#     git push, gh issue edit|comment, --auto-merge, --add/remove-label) inside a
#     code block in a section that has no guard expression (DRY_RUN, GOVERNOR,
#     --dry-run) anywhere in that section's code blocks, the change is flagged.
#     Operates on the diff (GITHUB_BASE_SHA or HEAD^) to avoid flagging legacy corpus.
#     (Ref: forge#1609 — signal-planner.md DRY_RUN guard placed after the create it guards)
#
# Allowlist: add <!-- allowlist:check-command-side-effects --> on the same line as
# the side-effect verb to suppress that specific hit.
#
# Usage:
#   check-command-side-effects.sh [--full] [<commands_dir>]
#     --full         Scan entire corpus (not just diff) for Class A violations only.
#                    Class B is diff-aware by design — --full does not change Class B.
#     commands_dir   Path to the commands/ directory (default: ./commands)
#
# Environment:
#   GITHUB_BASE_SHA   When set, used as the base commit for Class B diff mode.
#
# Exit codes:
#   0  no violations found
#   1  one or more violations found (listed to stderr)
#   2  usage / dependency error
#
# <!-- Added: forge#1609 -->

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

FULL_MODE=0
COMMANDS_DIR="./commands"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# *//'
      exit 0
      ;;
    --full) FULL_MODE=1 ;;
    -*) echo "ERROR: unknown option: $arg" >&2; exit 2 ;;
    *) COMMANDS_DIR="$arg" ;;
  esac
done

if [ ! -d "$COMMANDS_DIR" ]; then
  echo "ERROR: commands directory not found: $COMMANDS_DIR" >&2
  echo "Usage: $0 [--full] [<commands_dir>]" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Code fence marker — stored in variable to avoid backtick shell-expansion bugs.
# Do NOT inline as grep -E '^[[:space:]]*\`\`\`' — escaped backticks in grep
# patterns undergo shell expansion, turning the pattern into '^[[:space:]]*'
# which matches every line. (forge#1609)
FENCE='```'

# Guard expressions: any occurrence in a section's code blocks marks it as guarded
GUARD_PATTERN='DRY_RUN|GOVERNOR|--dry-run|DRY_RUN_MODE|DryRun'

# Class B side-effect verbs (in code blocks)
SIDE_EFFECT_PATTERN='gh[[:space:]]+(issue[[:space:]]+(create|edit|comment)|pr[[:space:]]+(merge|create|edit)|gist[[:space:]]+(create|edit))|git[[:space:]]+push|--auto-merge|--add-label|--remove-label'

ALLOWLIST_TOKEN='allowlist:check-command-side-effects'

VIOLATIONS=0

# ---------------------------------------------------------------------------
# Class A: Scan for gh gist create/edit --public in code blocks (full corpus)
# This runs regardless of --full or diff mode.
# ---------------------------------------------------------------------------

class_a_scan() {
  local file="$1"
  local IN_CB=0
  local HAS_GIST=0
  local BLOCK_LINES=""
  local BLOCK_START=0
  local LINENO=0
  local line PUBLIC_LINENO ACTUAL_LINE

  while IFS= read -r line; do
    LINENO=$((LINENO + 1))

    if echo "$line" | grep -qF "$FENCE"; then
      if [ "$IN_CB" -eq 0 ]; then
        IN_CB=1
        HAS_GIST=0
        BLOCK_LINES=""
        BLOCK_START=$LINENO
      else
        # End of code block — check if it had both gh gist and --public
        if [ "$HAS_GIST" -eq 1 ] && echo "$BLOCK_LINES" | grep -qE '^[[:space:]]*--public([[:space:]]|$)'; then
          # Find the line number of --public within the block
          PUBLIC_LINENO=$(echo "$BLOCK_LINES" | grep -n '^[[:space:]]*--public' | head -1 | cut -d: -f1)
          ACTUAL_LINE=$((BLOCK_START + PUBLIC_LINENO))
          if ! echo "$BLOCK_LINES" | grep -qF "$ALLOWLIST_TOKEN"; then
            echo "HIGH | $file | line ~$ACTUAL_LINE | Class A: 'gh gist create/edit --public' in code block — gists MUST be secret (omit --public); --public exposes private repo data. (forge#1587)" >&2
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
        fi
        IN_CB=0
        HAS_GIST=0
        BLOCK_LINES=""
      fi
      continue
    fi

    if [ "$IN_CB" -eq 1 ]; then
      BLOCK_LINES="${BLOCK_LINES}${line}
"
      # Check if this line has gh gist create/edit (even with line continuation \)
      if echo "$line" | grep -qE 'gh[[:space:]]+gist[[:space:]]+(create|edit)'; then
        HAS_GIST=1
      fi
    fi
  done < "$file"
}

while IFS= read -r file; do
  [ -f "$file" ] || continue
  class_a_scan "$file"
done < <(find "$COMMANDS_DIR" -name '*.md' | sort)

# ---------------------------------------------------------------------------
# Class B: Diff-aware scan for unguarded side-effect verbs in added lines
# ---------------------------------------------------------------------------

# Determine base SHA for diff
BASE_SHA=""
if [ -n "${GITHUB_BASE_SHA:-}" ]; then
  BASE_SHA="$GITHUB_BASE_SHA"
elif [ -n "${GITHUB_EVENT_PULL_REQUEST_BASE_SHA:-}" ]; then
  BASE_SHA="$GITHUB_EVENT_PULL_REQUEST_BASE_SHA"
else
  BASE_SHA="$(git rev-parse HEAD^ 2>/dev/null || echo '')"
fi

if [ -z "$BASE_SHA" ]; then
  echo "INFO: No git base SHA available — Class B (diff-aware) check skipped" >&2
else
  # Get list of changed command spec files
  CHANGED_SPECS=$(git diff --name-only "$BASE_SHA"...HEAD -- "${COMMANDS_DIR}" 2>/dev/null \
    | grep -E '\.md$' | grep -v '^$' || true)

  if [ -z "$CHANGED_SPECS" ]; then
    echo "OK (Class B): No commands/*.md files changed — diff check skipped"
  else
    echo "Class B: Checking changed spec files for unguarded side-effect verbs:"
    echo "$CHANGED_SPECS"
    echo ""

    while IFS= read -r file; do
      [ -f "$file" ] || continue

      # Get added lines for this file
      ADDED_CONTENT=$(git diff "$BASE_SHA"...HEAD -- "$file" 2>/dev/null \
        | grep '^+' | grep -v '^+++' | sed 's/^+//' || true)

      # Skip if no added lines contain side-effect verbs
      if ! echo "$ADDED_CONTENT" | grep -qE "$SIDE_EFFECT_PATTERN"; then
        continue
      fi

      # Parse the full file to map sections → (has_guard, has_side_effect_in_added_lines)
      IN_CB=0
      SECTION="(top)"
      SECTION_HAS_GUARD=0
      SECTION_HAS_ADDED_SE=0
      SECTION_SE_LINE=0
      SECTION_SE_VERB=""
      LINENO=0

      flush_and_reset() {
        local new_heading="$1"
        if [ "$SECTION_HAS_ADDED_SE" -eq 1 ] && [ "$SECTION_HAS_GUARD" -eq 0 ]; then
          echo "HIGH | $file | line $SECTION_SE_LINE | Class B: side-effect '$SECTION_SE_VERB' added to section '$SECTION' which has no DRY_RUN/governor guard — add guard before this line or wrap in DRY_RUN check" >&2
          VIOLATIONS=$((VIOLATIONS + 1))
        fi
        SECTION="$new_heading"
        SECTION_HAS_GUARD=0
        SECTION_HAS_ADDED_SE=0
        SECTION_SE_LINE=0
        SECTION_SE_VERB=""
        IN_CB=0
      }

      while IFS= read -r line; do
        LINENO=$((LINENO + 1))

        # Section heading reset
        if echo "$line" | grep -qE '^#{1,4}[[:space:]]+'; then
          heading=$(echo "$line" | sed 's/^#*[[:space:]]*//' | sed 's/[[:space:]]*$//')
          flush_and_reset "$heading"
          continue
        fi

        # Code block fence
        if echo "$line" | grep -qF "$FENCE"; then
          [ "$IN_CB" -eq 0 ] && IN_CB=1 || IN_CB=0
          continue
        fi

        if [ "$IN_CB" -eq 1 ]; then
          if echo "$line" | grep -qF "$ALLOWLIST_TOKEN"; then continue; fi

          # Check for guard
          echo "$line" | grep -qE "$GUARD_PATTERN" && SECTION_HAS_GUARD=1

          # Check if this line is in the diff's added lines AND has a side-effect verb
          if [ "$SECTION_HAS_ADDED_SE" -eq 0 ] && echo "$line" | grep -qE "$SIDE_EFFECT_PATTERN"; then
            # Is this specific line in the added content?
            if echo "$ADDED_CONTENT" | grep -qF "${line:0:80}" 2>/dev/null; then
              SECTION_HAS_ADDED_SE=1
              SECTION_SE_LINE=$LINENO
              SECTION_SE_VERB=$(echo "$line" | grep -oE "$SIDE_EFFECT_PATTERN" | head -1 || echo "side-effect")
            fi
          fi
        fi
      done < "$file"

      flush_and_reset "(end-of-file)"

    done <<< "$CHANGED_SPECS"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "check-command-side-effects: $VIOLATIONS violation(s) found. See stderr for details." >&2
  exit 1
fi

echo "OK: No side-effect violations found"
exit 0
