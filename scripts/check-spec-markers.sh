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
  BASESYNC_FAILED
  BASESYNC_REMEDIATION
  BATCH_MEMBERS
  BENCH_SCORECARD
  BLOCKED_ON_HUMAN_MERGE
  BODY
  BUILDER
  BUILD_BLOCKED
  CALIBRATION_CHECK
  CARD
  CHECKPOINT
  CI_REMEDIATION
  CLAIM
  CLAIM_RELEASED
  CLASS
  CONTEXT
  CONTRACT
  COORD_ISSUE
  CRITIQUE
  DECISION_RECORD
  DECOMPOSED
  DECOMPOSE_BLOCKED
  DESIGN
  DIFF_SIZE
  DISPATCH
  DISPATCHER
  DOSSIER_UPDATED
  ENGINE_FALLBACK
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
  INPR_FIX
  INPR_FIX_WAIVED
  INPR_REMEDIATION
  INVESTIGATOR
  JSONL_PARSER_UTIL
  KNOWLEDGE_GIST
  LEARNED
  LEARNED_RULES
  LEASE
  LEASE_RELEASED
  LEDGER_INDEXED
  MEMORY_INDEX
  MEMORY_INDEXED
  MILESTONE_INDEX
  MODEL_TIER_NOTE
  NOTE_DISPOSITION
  ORPHAN_ESCALATED
  ORPHAN_RECOVERED
  PATTERN
  PHASE
  PHASE_COMPLETE
  PHASE_TRAIL_ERROR
  PHASE_TRAIL_FAILED
  PHASE_TRAIL_OVERRIDE
  PHASE_TRAIL_OVERRIDE_APPLIED
  PHASE_TRAIL_RELEASED
  PLAN_DAG
  PRIOR_DECISIONS
  PRIOR_GIST
  PROTOCOL_SOURCE
  PUSH_BLOCKED
  PUSH_BLOCKED_EMPTY_BRANCH
  PUSH_FAILED
  QUALITY_GATE
  RECOVERY_CLAIM
  RECOVERY_CLAIM_RELEASED
  REMEDIATION
  REREVIEW_DISPATCHED
  REREVIEW_RELEASED
  REREVIEW_SKIPPED
  REVIEW
  REVIEWER
  REVIEW_ROUTE
  REVIEW_STARTED
  SECURITY_AUDIT
  SIGNAL_RESOLVED
  SIGNAL_UNRESOLVED
  SIZE_OVERRIDE
  SPAWN_POLICY
  SPEC_DOCTOR_COMPLETE
  SPEC_LOADED
  STALE_REREVIEW
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
    if [[ "$content" == *"$ALLOWLIST_TOKEN"* ]]; then
      continue
    fi

    # Skip markers that are inside code spans (backtick-quoted) — those are docs examples
    # Heuristic: if the FORGE:TYPE appears between backticks on the same line, skip it
    # We check for backtick on either side of the FORGE: marker
    if [[ "$content" =~ \`[^\`]*FORGE:[A-Z_] ]]; then
      continue
    fi

    # Extract the full marker string after FORGE: — everything up to a space, -->, or end
    # This captures compound markers like REVIEW-AGENT:material-change
    [[ "$content" =~ FORGE:([A-Z][A-Z0-9_:-]*) ]] || continue
    full_marker="${BASH_REMATCH[1]}"

    [ -z "$full_marker" ] && continue

    # Extract PRIMARY type: part before the first - or : separator
    primary_type="${full_marker%%[-:]*}"

    # Validate primary type against registry
    if ! [[ "$primary_type" =~ $REGISTRY_PATTERN ]]; then
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
      if [[ "$line" == *"$ALLOWLIST_TOKEN"* ]]; then
        continue
      fi

      # Skip comment lines
      if [[ "$line" =~ ^[[:space:]]*# ]]; then
        continue
      fi

      # Strip bash ${VAR} and $VAR patterns before checking for template placeholders
      # so that ELAPSED in "${ELAPSED}s" doesn't false-positive as {ELAPSED}
      stripped="$line"
      while [[ "$stripped" =~ \$\{[^}]*\} ]]; do
        stripped="${stripped/"${BASH_REMATCH[0]}"/BASH_VAR}"
      done
      while [[ "$stripped" =~ \$[A-Za-z_][A-Za-z0-9_]* ]]; do
        stripped="${stripped/"${BASH_REMATCH[0]}"/BASH_VAR}"
      done

      if [[ "$stripped" =~ $PLACEHOLDER_PATTERN ]]; then
        placeholder="${BASH_REMATCH[0]}"
        echo "HIGH | $wf_file:$LINENO | unsubstituted placeholder '$placeholder' in workflow" >&2
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
    done < "$wf_file"
  done < <(find "$WORKFLOWS_DIR" -name '*.yml' | sort)
fi

# ---------------------------------------------------------------------------
# Merged-trail hold must not be keyed on the verifier (forge#3169)
# ---------------------------------------------------------------------------

P4_SPEC="$COMMANDS_DIR/orchestrate/phase-4-execution.md"
if [ -f "$P4_SPEC" ]; then
  # ABSENT arm of classify_predecessor_state() (scoped to that function body): text from a line-start "ABSENT)"
  # inside that function body (an ABSENT) arm elsewhere is ignored) up to the first ";;", whitespace-collapsed so one-line and multi-line
  # forms reduce to the same span.
  ABSENT_ARM=$(awk '
    /^classify_predecessor_state\(\)[[:space:]]*\{/ { infn = 1; next }
    infn && !inarm && /^\}/ { infn = 0 }
    infn && !inarm && /^[[:space:]]*ABSENT\)/ { inarm = 1 }
    inarm {
      line = $0
      # Comments are not code: skip full-line comments and drop a trailing
      # whitespace-preceded "#..." so comment text cannot satisfy or perturb
      # the assertions below (not quote-aware; the arm text has no quoted "#").
      if (line ~ /^[[:space:]]*#/) next
      sub(/[[:space:]]+#.*$/, "", line)
      idx = index(line, ";;")
      if (idx > 0) { buf = buf " " substr(line, 1, idx - 1); exit }
      buf = buf " " line
    }
    END { print buf }
  ' "$P4_SPEC" | tr -s '[:space:]' ' ' || true)
  # WIRE:PROVEN — manual mutation in a temp copy of commands/: renamed hold_merged_trail, renamed the ABSENT arm, ABSENT->echo DONE, and moved the comment before add-label; each fired its matching HIGH violation; comment-only GATED fires HIGH, comment-only DONE/reverify_merged_trail does not, comment-only gh issue comment before add-label does not count, real arm still passes; a decoy earlier ABSENT) arm outside classify_predecessor_state does not change the result, removing the function declaration fires ABSENT arm missing, and add-label=needs-human / single-quoted forms are accepted
  if [ -z "${ABSENT_ARM// /}" ]; then
    echo "HIGH | $P4_SPEC | ABSENT arm missing from classify_predecessor_state (label-only hold must be classified explicitly)" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  else
    if [[ "$ABSENT_ARM" == *reverify_merged_trail* ]] || [[ "$ABSENT_ARM" == *DONE* ]]; then
      echo "HIGH | $P4_SPEC | merged + needs-human + ABSENT classifies DONE / calls the verifier (must fail closed to GATED)" >&2
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
    if ! [[ "$ABSENT_ARM" =~ (echo|printf)[^\;]*GATED ]]; then
      echo "HIGH | $P4_SPEC | ABSENT arm does not resolve to GATED" >&2
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi

  # hold_merged_trail() (forge#3223): the needs-human label must be added
  # before the FORGE:PHASE_TRAIL_FAILED comment is posted, so a comment can
  # never exist without the label (comment-without-label reads as a release).
  HOLD_ORDER=$(awk '
    /^hold_merged_trail\(\)[[:space:]]*\{/ { infn = 1; found = 1; next }
    infn && /^\}/ { infn = 0 }
    infn {
      line = $0
      if (line ~ /^[[:space:]]*#/) next
      sub(/[[:space:]]+#.*$/, "", line)
      if (!cmt && (line ~ /gh issue comment/ || line ~ /FORGE:PHASE_TRAIL_FAILED/)) cmt = NR
      if (!lbl && line ~ /add-label(=|[[:space:]]+)[\047"]?needs-human/) lbl = NR
    }
    END { printf "%d %d %d\n", found + 0, cmt + 0, lbl + 0 }
  ' "$P4_SPEC" || true)
  set -- $HOLD_ORDER
  HOLD_FOUND="${1:-0}"; HOLD_CMT="${2:-0}"; HOLD_LBL="${3:-0}"
  if [ "$HOLD_FOUND" -eq 0 ]; then
    echo "HIGH | $P4_SPEC | hold_merged_trail() function missing" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  elif [ "$HOLD_CMT" -eq 0 ] || [ "$HOLD_LBL" -eq 0 ]; then
    echo "HIGH | $P4_SPEC | hold_merged_trail() lacks the PHASE_TRAIL_FAILED comment or the needs-human add-label" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  elif [ "$HOLD_LBL" -ge "$HOLD_CMT" ]; then
    echo "HIGH | $P4_SPEC | hold_merged_trail() posts the PHASE_TRAIL_FAILED comment before adding needs-human (label must come first)" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Router claim pre-check must classify the existing/winning claim's lease (forge#3431)
# ---------------------------------------------------------------------------

WORKON_SPEC="$COMMANDS_DIR/work-on.md"
if [ -f "$WORKON_SPEC" ]; then
  # Scope: the "Claim pre-check" paragraph only, from its "**Claim pre-check" line up to the line before
  # "**Terminal fallback". Full-line HTML comments are skipped, then each numbered step (N. ...) is collapsed
  # to one whitespace-normalised line tagged "STEP<N>:" so tokens in other steps, the Terminal fallback
  # paragraph, or comments cannot satisfy another step's assertion.
  PRECHECK_STEPS=$(awk '
    /^\*\*Terminal fallback/ { inpre = 0 }
    /^\*\*Claim pre-check/ { inpre = 1; next }
    inpre {
      line = $0
      if (line ~ /^[[:space:]]*<!--.*-->[[:space:]]*$/) next
      gsub(/<!--[^>]*-->/, "", line)
      if (match(line, /^[0-9]+\. /)) {
        n = substr(line, 1, RLENGTH - 2)
        cur = n
        steps[cur] = "STEP" n ": " substr(line, RLENGTH + 1)
        next
      }
      if (line ~ /^Only after the read-back/) { cur = ""; next }
      if (cur != "") steps[cur] = steps[cur] " " line
    }
    END { for (k in steps) print steps[k] }
  ' "$WORKON_SPEC" | tr -s '[:space:]' ' ' | sed 's/ STEP/\nSTEP/g' || true)
  # WIRE:PROVEN: manual mutation in a temp copy of commands/work-on.md: removing `STALE` from step 4 only fired step 4, removing it from step 2 only fired step 2, tokens only in an HTML comment or only in the Terminal fallback paragraph still fired, a router-local REREVIEW_LEASE_SECS= or rereview_lease_state fired, clean tree passes
  for STEP_N in 2 4; do
    STEP_TXT=$(printf '%s\n' "$PRECHECK_STEPS" | grep "^STEP${STEP_N}:" || true)
    if [ -z "$STEP_TXT" ] \
       || [[ "$STEP_TXT" != *STALE* ]] \
       || [[ "$STEP_TXT" != *phase-4-execution.md* ]] \
       || [[ "$STEP_TXT" != *fallback* ]]; then
      echo "HIGH | $WORKON_SPEC | claim pre-check step $STEP_N does not route STALE to the terminal fallback via the shared phase-4-execution.md Step 1 classification" >&2
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
  # The router must reference the orchestrator's single lease definition, never redefine it.
  if grep -qE '^[[:space:]]*REREVIEW_LEASE_SECS=' "$WORKON_SPEC"; then
    echo "HIGH | $WORKON_SPEC | router redefines REREVIEW_LEASE_SECS (single definition lives in phase-4-execution.md Step 1)" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
  if grep -rq 'rereview_lease_state' "$COMMANDS_DIR" 2>/dev/null; then
    echo "HIGH | $COMMANDS_DIR | competing lease helper rereview_lease_state reintroduced (router must reuse the shared Step 1 classification)" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
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
