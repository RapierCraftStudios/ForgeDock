#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-protocol-restatements.sh — Guard against future restatements of normative
#                                   FORGE protocol content in commands/**/*.md.
#
# ForgeDock keeps three protocol definitions in designated normative source files:
#
#   docs/FORGE-PROTOCOL.md       — FORGE annotation format (annotation types,
#                                   schemas, completion sentinels)
#   docs/WORKFLOW.md             — Label state machine (workflow:* transitions)
#   commands/review-pr-agents.md — Evidence-Based Review Protocol (review agent
#                                   behaviour, structured findings format)
#
# Once these are single-sourced, command specs should reference them via a
# one-line pointer, NOT restate the full content. This script detects
# heading-level signatures that indicate a full restatement has crept back in.
#
# Detected patterns (heading-level restatement signatures):
#
#   FORGE_ANNOTATION_PROTOCOL — "# FORGE Annotation Protocol"
#                                "## FORGE Annotation Protocol"
#   ANNOTATION_TYPES          — "## Annotation Types"
#                                "### Annotation Types"
#   WORKFLOW_STATE_MACHINE    — "# Workflow State Machine"
#                                "## Workflow State Machine"
#   LABEL_STATE_MACHINE       — "# Label State Machine"
#                                "## Label State Machine"
#   REVIEW_PROTOCOL           — "## Evidence-Based Review Protocol"
#                                (outside its normative source)
#
# Each pattern is keyed to a NORMATIVE_SOURCE — the one file allowed to contain
# that heading. All other files in commands/ that match are flagged as
# restatements.
#
# Allowlist: to permit a heading in an additional file (e.g. a migration guide),
# add an HTML comment directly after the heading on the same line:
#
#   ## Evidence-Based Review Protocol <!-- allowlist:check-protocol-restatements -->
#
# Usage:
#   check-protocol-restatements.sh [<commands_dir> [<docs_dir>]]
#     commands_dir: path to the commands/ directory (default: ./commands)
#     docs_dir:     path to the docs/ directory     (default: ./docs)
#
# Exit codes:
#   0  no restatements found
#   1  one or more restatement headings found (listed to stderr)
#   2  usage / dependency error (directory not found)
#
# <!-- Added: forge#1270 -->

set -euo pipefail

COMMANDS_DIR="${1:-./commands}"
DOCS_DIR="${2:-./docs}"

if [ ! -d "$COMMANDS_DIR" ]; then
  echo "ERROR: commands directory not found: $COMMANDS_DIR" >&2
  echo "Usage: $0 [<commands_dir> [<docs_dir>]]" >&2
  exit 2
fi

if [ ! -d "$DOCS_DIR" ]; then
  echo "ERROR: docs directory not found: $DOCS_DIR" >&2
  echo "Usage: $0 [<commands_dir> [<docs_dir>]]" >&2
  exit 2
fi

# Normalise paths so comparisons against normative sources work correctly.
COMMANDS_DIR="$(cd "$COMMANDS_DIR" && pwd)"
DOCS_DIR="$(cd "$DOCS_DIR" && pwd)"
REPO_ROOT="$(dirname "$COMMANDS_DIR")"

# ---------------------------------------------------------------------------
# Pattern table — parallel arrays (same index = one pattern rule)
#
# PATTERN_NAMES    : human-readable pattern ID (for error messages)
# PATTERN_REGEXES  : grep -E regex, anchored to line start (^)
# NORMATIVE_SOURCES: repo-root-relative path of the one file that MAY contain
#                    the heading; all other files in commands/ are violations
# ---------------------------------------------------------------------------
PATTERN_NAMES=(
  "FORGE_ANNOTATION_PROTOCOL"
  "ANNOTATION_TYPES"
  "WORKFLOW_STATE_MACHINE"
  "LABEL_STATE_MACHINE"
  "REVIEW_PROTOCOL"
)

# Each regex matches one or more heading levels for the given protocol section.
# Anchored (^) so prose references mid-sentence are not false positives.
# The trailing [[:space:]]* allows trailing whitespace; we stop before the
# allowlist comment token so lines with it are excluded in a second pass.
PATTERN_REGEXES=(
  "^#{1,2} FORGE Annotation Protocol[[:space:]]*$"
  "^#{2,3} Annotation Types[[:space:]]*$"
  "^#{1,2} Workflow State Machine[[:space:]]*$"
  "^#{1,2} Label State Machine[[:space:]]*$"
  "^#{1,2} Evidence-Based Review Protocol[[:space:]]*$"
)

NORMATIVE_SOURCES=(
  "docs/FORGE-PROTOCOL.md"
  "docs/FORGE-PROTOCOL.md"
  "docs/WORKFLOW.md"
  "docs/WORKFLOW.md"
  "commands/review-pr-agents.md"
)

# ---------------------------------------------------------------------------
# Scan: for each pattern, grep all .md files in commands/, exclude the
# normative source and allowlisted lines, collect violations.
# ---------------------------------------------------------------------------
VIOLATIONS=()

for i in "${!PATTERN_NAMES[@]}"; do
  pattern_name="${PATTERN_NAMES[$i]}"
  regex="${PATTERN_REGEXES[$i]}"
  normative_rel="${NORMATIVE_SOURCES[$i]}"
  normative_abs="${REPO_ROOT}/${normative_rel}"

  # grep -rn: recursive, print filename:lineno:content
  # --include: only .md files
  # We pipe through grep -v to:
  #   1. Exclude the normative source file itself
  #   2. Exclude lines carrying the allowlist token
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    # hit format: <filepath>:<lineno>:<line_content>
    filepath="${hit%%:*}"
    rest="${hit#*:}"
    lineno="${rest%%:*}"
    line_content="${rest#*:}"

    # Display a repo-root-relative path for readability.
    rel_path="${filepath#"${REPO_ROOT}/"}"

    VIOLATIONS+=("${rel_path}:${lineno}: restatement of ${pattern_name}")
    VIOLATIONS+=("  heading: '${line_content}'")
  done < <(
    grep -rnE "$regex" "$COMMANDS_DIR" --include="*.md" 2>/dev/null \
      | grep -v "^${normative_abs}:" \
      | grep -v '<!-- allowlist:check-protocol-restatements -->' \
      || true
  )
done

# ---------------------------------------------------------------------------
# Report and exit.
# ---------------------------------------------------------------------------
if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  echo "ERROR: FORGE protocol restatement heading(s) found in commands/:" >&2
  echo "" >&2
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "These headings indicate a full restatement of normative protocol content." >&2
  echo "Replace the section with a one-line pointer to the normative source, e.g.:" >&2
  echo "  > Protocol reference: see docs/FORGE-PROTOCOL.md" >&2
  echo "" >&2
  echo "To permit a heading in this file intentionally, add the allowlist token:" >&2
  echo "  ## <Heading> <!-- allowlist:check-protocol-restatements -->" >&2
  echo "" >&2
  echo "Normative sources (these files may contain the headings):" >&2
  echo "  docs/FORGE-PROTOCOL.md       — FORGE annotation format" >&2
  echo "  docs/WORKFLOW.md             — Label state machine" >&2
  echo "  commands/review-pr-agents.md — Evidence-Based Review Protocol" >&2
  exit 1
fi

echo "OK: No FORGE protocol restatement headings detected in $COMMANDS_DIR"
exit 0
