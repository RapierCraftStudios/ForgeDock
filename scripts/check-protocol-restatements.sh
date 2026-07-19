#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-protocol-restatements.sh — Guard against future restatements of normative
#                                   FORGE protocol content in commands/**/*.md.
#
# ForgeDock keeps four protocol/policy definitions in designated normative
# source files:
#
#   docs/FORGE-PROTOCOL.md            — FORGE annotation format (annotation
#                                        types, schemas, completion sentinels)
#   docs/WORKFLOW.md                  — Label state machine (workflow:* transitions)
#   commands/review-pr-agents.md      — Evidence-Based Review Protocol (review
#                                        agent behaviour, structured findings format)
#   commands/shared/agent-policies.md — Agent model policy (default tier) +
#                                        plan-mode ban (forge#2677)
#
# Once these are single-sourced, command specs should reference them via a
# one-line pointer, NOT restate the full content. This script detects
# heading-level (or, for the two AGENT_* patterns, full-line) signatures that
# indicate a full restatement has crept back in.
#
# Detected patterns (heading-level restatement signatures, unless noted):
#
#   FORGE_ANNOTATION_PROTOCOL  — "# FORGE Annotation Protocol"
#                                 "## FORGE Annotation Protocol"
#   ANNOTATION_TYPES           — "## Annotation Types"
#                                 "### Annotation Types"
#   WORKFLOW_STATE_MACHINE     — "# Workflow State Machine"
#                                 "## Workflow State Machine"
#   LABEL_STATE_MACHINE        — "# Label State Machine"
#                                 "## Label State Machine"
#   REVIEW_PROTOCOL            — "## Evidence-Based Review Protocol"
#                                 (outside its normative source)
#   AGENT_MODEL_POLICY_DEFAULT — full-line: the exact default-tier
#                                 "**Agent model policy**: ..." sentence
#                                 (a command with a genuinely different model/
#                                 effort tier or extra caveats is not a match —
#                                 see commands/shared/agent-policies.md)
#   PLAN_MODE_BAN               — full-line: "**NEVER use plan mode (EnterPlanMode).**"
#
# Each pattern is keyed to a NORMATIVE_SOURCE — the one file allowed to contain
# that heading/line. All other files in commands/ that match are flagged as
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
  "AGENT_MODEL_POLICY_DEFAULT"
  "PLAN_MODE_BAN"
)

# Each regex matches one or more heading levels for the given protocol section,
# OR (for the two AGENT_* entries added at forge#2677) a full-line content
# signature rather than a heading — these two are exact-duplicate prose lines,
# not section headings, so the anchor is the whole line instead of a "^#{1,2}"
# heading prefix. Anchored (^...$) so prose references mid-sentence are not
# false positives, and so a file with a genuinely different policy (different
# model, different effort tier, extra dispatcher-specific caveats — see
# commands/shared/agent-policies.md's "Usage" section) is NOT flagged: those
# lines carry additional trailing content and no longer match the anchor.
# The allowlist comment token exclusion is handled in a separate grep -v pass.
PATTERN_REGEXES=(
  "^#{1,2} FORGE Annotation Protocol"
  "^#{2,3} Annotation Types[[:space:]]*$"
  "^#{1,2} Workflow State Machine"
  "^#{1,2} Label State Machine"
  "^#{1,2} Evidence-Based Review Protocol"
  '^\*\*Agent model policy\*\*: `model: "\{DEFAULT_MODEL\}"` — resolved from forge\.yaml `agents\.default_model`, else "sonnet" \(standard tier\)\. Fallback: `model: "opus"` if rate-limited\. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2\.1\.154\.$'
  '^\*\*NEVER use plan mode \(EnterPlanMode\)\.\*\*$'
)

NORMATIVE_SOURCES=(
  "docs/FORGE-PROTOCOL.md"
  "docs/FORGE-PROTOCOL.md"
  "docs/WORKFLOW.md"
  "docs/WORKFLOW.md"
  "commands/review-pr-agents.md"
  "commands/shared/agent-policies.md"
  "commands/shared/agent-policies.md"
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
  echo "Normative sources (these files may contain the headings/lines):" >&2
  echo "  docs/FORGE-PROTOCOL.md            — FORGE annotation format" >&2
  echo "  docs/WORKFLOW.md                  — Label state machine" >&2
  echo "  commands/review-pr-agents.md      — Evidence-Based Review Protocol" >&2
  echo "  commands/shared/agent-policies.md — Agent model policy / plan-mode ban" >&2
  exit 1
fi

echo "OK: No FORGE protocol restatement headings detected in $COMMANDS_DIR"
exit 0
