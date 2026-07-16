#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-spec-markers.sh — Validate FORGE: annotation markers in commands/**/*.md and
#                          detect unsubstituted {PLACEHOLDER} tokens in CI workflow files.
#
# Command specs contain two classes of spec-as-code marker defects:
#
#   1. Non-registry FORGE: markers — a typo or invented marker (e.g. FORGE:INVESTIAGOR,
#      FORGE:NOTES) in a command spec will cause agents to look for a comment annotation
#      that is never emitted, silently breaking pipeline state detection. (Ref: forge#633)
#
#   2. Unsubstituted {PLACEHOLDER} tokens in CI workflow YAML — a template variable like
#      {GH_REPO} or {NUMBER} left unsubstituted in a workflow inline script means every
#      CI run executes a malformed command that fails silently or produces wrong output.
#      (Ref: forge#318; note: {PLACEHOLDER} tokens in commands/*.md are intentional
#       spec notation and are NOT flagged by this check.)
#
# This script:
#   1. Scans all *.md files in commands/ for <!-- FORGE:XXXX --> annotations.
#   2. Validates XXXX against the known registry (see MARKER_REGISTRY below).
#   3. Scans .github/workflows/*.yml for unsubstituted {PLACEHOLDER} tokens in run: blocks.
#
# Registry: covers all reserved types from packages/protocol/src/types.js
# (RESERVED_TYPE_NAMES) plus all operational/pipeline markers used throughout the
# ForgeDock spec corpus. Compound markers (FORGE:TYPE-SUBTYPE, FORGE:TYPE:SUBTYPE)
# are validated by their primary type (the part before the first - or :).
# Update the registry when adding new marker types.
#
# Allowlist: add <!-- allowlist:check-spec-markers --> on the same line as the marker
# to suppress that specific hit.
#
# Usage:
#   check-spec-markers.sh [<commands_dir> [<repo_root>]]
#     commands_dir: path to the commands/ directory (default: ./commands)
#     repo_root:    path to repo root for workflow scanning (default: .)
#
# Exit codes:
#   0  no violations found
#   1  one or more violations found (listed to stderr)
#   2  usage / dependency error (commands_dir not found)
#
# <!-- Added: forge#1609 -->

set -euo pipefail

COMMANDS_DIR="${1:-./commands}"
REPO_ROOT="${2:-.}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# *//'
  exit 0
fi

if [ ! -d "$COMMANDS_DIR" ]; then
  echo "ERROR: commands directory not found: $COMMANDS_DIR" >&2
  echo "Usage: $0 [<commands_dir> [<repo_root>]]" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# FORGE: marker registry
#
# Sources:
#   - packages/protocol/src/types.js — RESERVED_TYPE_NAMES (reserved lifecycle types)
#   - Operational pipeline markers used in commands/**/*.md specs
#
# Compound markers (FORGE:REVIEW-AGENT:material-change, FORGE:PHASE:COMPLETE) are
# validated by their PRIMARY type only (the part before the first - or : after FORGE:).
# Add entries for each primary type; sub-types are unrestricted.
#
# Update this list when new marker types are added to the protocol or spec corpus.
# Keep sorted alphabetically for readability.
# ---------------------------------------------------------------------------
MARKER_REGISTRY="
  ACCEPTANCE_GATE
  ADR_EXTRACTED
  ANCESTRY_FAILED
  ARCHITECT
  AUDIT
  AUTOPILOT_CYCLE
  AUTOPILOT_GATE
  AUTOPILOT_IMPACT
  BATCHABLE
  BATCH_ID
  BATCH_MEMBERS
  BENCH_SCORECARD
  BLOCKED_ON_HUMAN_MERGE
  BUILDER
  CALIBRATION_CHECK
  CARD
  CHECKPOINT
  CLAIM
  CLAIM_RELEASED
  CONTEXT
  CONTRACT
  COORD_ISSUE
  CRITIQUE
  DECISION_RECORD
  DECOMPOSED
  DESIGN
  DISPATCHER
  DOSSIER_UPDATED
  FAST_PATH
  FINDING_SOURCE
  FIX_CI
  GATE_FAILED
  GATE_FAILURE
  GATE_PASS
  HEARTBEAT
  INDEP_VERIFY
  INDEP_VERIFY_FAIL
  INDEP_VERIFY_PASS
  INVESTIGATOR
  JSONL_PARSER_UTIL
  KNOWLEDGE_GIST
  LEARNED
  LEARNED_RULES
  LEDGER_INDEXED
  MEMORY_INDEX
  MEMORY_INDEXED
  MILESTONE_INDEX
  MODEL_TIER_NOTE
  ORPHAN_ESCALATED
  ORPHAN_RECOVERED
  PATTERN
  PHASE
  PHASE_COMPLETE
  PLAN_DAG
  PRIOR_DECISIONS
  PRIOR_GIST
  PROTOCOL_SOURCE
  PUSH_BLOCKED
  PUSH_BLOCKED_EMPTY_BRANCH
  PUSH_FAILED
  REMEDIATION
  REREVIEW_SKIPPED
  REVIEW
  REVIEWER
  REVIEW_ROUTE
  REVIEW_STARTED
  SECURITY_AUDIT
  SIGNAL_RESOLVED
  SIGNAL_UNRESOLVED
  SPAWN_POLICY
  SPEC_DOCTOR_COMPLETE
  SPEC_LOADED
  STALL_DETECTED
  STATE
  SYNTHESIS_BRIEF
  TEST_GATE
  TRAIN_CANDIDATE
  TRAJECTORY
  UNBLOCKED
  USER_FEEDBACK
"

# Build an alternation pattern for registry lookup.
# Words separated by | for use with grep -E: ^(WORD1|WORD2|...)$
REGISTRY_NAMES=$(echo "$MARKER_REGISTRY" | tr -s '[:space:]' '\n' | grep -vE '^\s*$' | sort -u | tr '\n' '|' | sed 's/|$//')
REGISTRY_PATTERN="^(${REGISTRY_NAMES})$"

# Allowlist token — a line containing this token is exempt
ALLOWLIST_TOKEN='allowlist:check-spec-markers'

VIOLATIONS=0

# ---------------------------------------------------------------------------
# Pass 1: Validate FORGE: markers in commands/**/*.md
# ---------------------------------------------------------------------------

find_md_files() {
  find "$COMMANDS_DIR" -name '*.md' | sort
}

while IFS= read -r file; do
  [ -f "$file" ] || continue

  # Extract all lines containing <!-- FORGE:XXXX --> annotations with their line numbers.
  while IFS= read -r markerline; do
    [ -z "$markerline" ] && continue
    lineno="${markerline%%:*}"
    content="${markerline#*:}"

    # Skip allowlisted lines
    if echo "$content" | grep -qF "$ALLOWLIST_TOKEN"; then
      continue
    fi

    # Skip markers that are inside code spans (backtick-quoted) — those are docs examples
    # Heuristic: if the FORGE:TYPE appears between backticks on the same line, skip it
    # We check for backtick on either side of the FORGE: marker
    if echo "$content" | grep -qE "\`[^\`]*FORGE:[A-Z_]"; then
      continue
    fi

    # Extract the full marker string after FORGE: — everything up to a space, -->, or end
    # This captures compound markers like REVIEW-AGENT:material-change
    full_marker=$(echo "$content" | grep -oE 'FORGE:[A-Z][A-Z0-9_:-]*' | head -1 | sed 's/^FORGE://')

    [ -z "$full_marker" ] && continue

    # Extract PRIMARY type: part before the first - or : separator
    primary_type=$(echo "$full_marker" | sed 's/[-:].*//')

    # Validate primary type against registry
    if ! echo "$primary_type" | grep -qE "$REGISTRY_PATTERN"; then
      echo "HIGH | $file:$lineno | unknown FORGE: marker 'FORGE:${full_marker}' (primary type '${primary_type}') — not in registry" >&2
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done < <(grep -nE '<!--[[:space:]]*FORGE:[A-Z]' "$file" 2>/dev/null || true)

done < <(find_md_files)

# ---------------------------------------------------------------------------
# Pass 2: Detect unsubstituted {PLACEHOLDER} in .github/workflows/*.yml
#
# In workflow YAML, {PLACEHOLDER} tokens (not bash ${VAR} expansions) indicate
# a template variable that should have been resolved before committing.
#
# Bash ${VAR} references are excluded — we strip ${...} patterns before scanning.
# Pattern: {UPPERCASE_3+} — e.g. {GH_REPO}, {NUMBER}, {WORKTREE_PATH}
# ---------------------------------------------------------------------------

WORKFLOWS_DIR="${REPO_ROOT}/.github/workflows"

if [ -d "$WORKFLOWS_DIR" ]; then
  # Pattern: { followed by uppercase letter, then 2+ uppercase/digit/underscore, then }
  # Preceded by something other than $ (to exclude bash ${VAR} expansions)
  PLACEHOLDER_PATTERN='\{[A-Z][A-Z0-9_]{2,}\}'

  while IFS= read -r wf_file; do
    [ -f "$wf_file" ] || continue

    LINENO=0

    while IFS= read -r line; do
      LINENO=$((LINENO + 1))

      # Skip allowlisted lines
      if echo "$line" | grep -qF "$ALLOWLIST_TOKEN"; then
        continue
      fi

      # Skip comment lines
      if echo "$line" | grep -qE '^[[:space:]]*#'; then
        continue
      fi

      # Strip bash ${VAR} and $VAR patterns before checking for template placeholders
      # so that ELAPSED in "${ELAPSED}s" doesn't false-positive as {ELAPSED}
      stripped=$(echo "$line" | sed 's/\${\([^}]*\)}/BASH_VAR/g; s/\$[A-Za-z_][A-Za-z0-9_]*/BASH_VAR/g')

      if echo "$stripped" | grep -qE "$PLACEHOLDER_PATTERN"; then
        placeholder=$(echo "$stripped" | grep -oE "$PLACEHOLDER_PATTERN" | head -1)
        echo "HIGH | $wf_file:$LINENO | unsubstituted placeholder '$placeholder' in workflow" >&2
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
    done < "$wf_file"
  done < <(find "$WORKFLOWS_DIR" -name '*.yml' | sort)
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "check-spec-markers: $VIOLATIONS violation(s) found. See stderr for details." >&2
  exit 1
fi

echo "OK: No marker or placeholder violations found"
exit 0
