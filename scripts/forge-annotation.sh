#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# forge-annotation.sh — Deterministic FORGE annotation read/write/validate engine
#
# Every `commands/*.md` phase boundary posts or reads a machine-readable
# `<!-- FORGE:MARKER -->` HTML-comment annotation on a GitHub issue/PR. Until
# this script existed, each command spec re-derived the annotation body via
# inline heredoc/prose and re-derived the read/grep query independently, so
# annotation format drift between specs was possible and undetected. This
# script is the single source of truth for the annotation schema: it knows
# every marker's required fields and completion terminator, and exposes a
# stable write/read/validate CLI so pipeline phases stop hand-rolling both.
#
# Usage:
#   forge-annotation.sh write <MARKER> [--field KEY=VALUE]... [--field-file KEY=FILE]...
#   forge-annotation.sh read <ISSUE_NUMBER> [GH_FLAG...] <MARKER> [--all]
#   forge-annotation.sh validate <MARKER> [FILE]
#   forge-annotation.sh list-markers
#   forge-annotation.sh -h | --help
#
# Subcommands:
#   write         Renders a well-formed `<!-- FORGE:MARKER -->` comment body to
#                 stdout, ready to be piped into `gh issue comment --body-file -`
#                 (or captured into a variable for `--body`). Fails (exit 1) if
#                 a required field for MARKER is missing.
#   read          Fetches the latest comment matching MARKER on ISSUE_NUMBER via
#                 `gh api` and prints its raw body to stdout. Prints nothing and
#                 exits 0 if no matching comment exists (mirrors the existing
#                 `| last | .body // ""` prose convention — "absent" is not an
#                 error). GH_FLAG tokens (e.g. `-R owner/repo`) may appear
#                 between ISSUE_NUMBER and MARKER, matching transition-label.sh's
#                 argument convention. Pass `--all` to print every matching
#                 comment body as a JSON array (newest last) instead of just the
#                 latest raw body.
#   validate      Reads a candidate comment body (from FILE, or stdin if FILE is
#                 omitted) and checks it has the correct `<!-- FORGE:MARKER -->`
#                 header and, if MARKER requires one, its completion terminator
#                 (e.g. `<!-- INVESTIGATION:COMPLETE -->` for INVESTIGATOR).
#                 Exits 1 with a clear message on any malformed body.
#   list-markers  Prints all known markers and their completion-terminator
#                 requirement (or "none").
#
# Exit codes: 0 = success, 1 = error (bad args, missing field, malformed body,
#             gh/api failure, unknown marker).
#
# This is a UNIVERSAL-tier script (ships with the npm package). See
# devdocs/project/architecture.md → Script Precedence for the 4-tier
# resolution hierarchy this script participates in.

set -euo pipefail

SCRIPT_NAME="forge-annotation.sh"

# NOTE: this script does not export FORGEDOCK_SCRIPTS/FORGEDOCK_HOME. Those
# exports are meaningless when a script is invoked via `bash script.sh`
# (a subprocess) rather than sourced — the exported vars never reach the
# caller's shell. This exact dead-code pattern was confirmed and removed from
# classify-lane.sh in #852/#854; do not reintroduce it here.

usage() {
  cat >&2 <<EOF
Usage:
  $SCRIPT_NAME write <MARKER> [--field KEY=VALUE]... [--field-file KEY=FILE]...
  $SCRIPT_NAME read <ISSUE_NUMBER> [GH_FLAG...] <MARKER> [--all]
  $SCRIPT_NAME validate <MARKER> [FILE]
  $SCRIPT_NAME list-markers
  $SCRIPT_NAME -h | --help

Known markers: ${!COMPLETION_MARKER[*]} ${KNOWN_NO_TERMINATOR_MARKERS[*]}
EOF
}

# ---------------------------------------------------------------------------
# Marker registry
#
# COMPLETION_MARKER[MARKER]   = literal completion-terminator string that MUST
#                               appear in the body for the marker to be
#                               considered COMPLETE. Absence from this map
#                               means the marker has no required terminator
#                               (it is a single-shot, always-complete post).
# PARTIAL_MARKER[MARKER]      = literal alternate terminator accepted in place
#                               of the COMPLETE one when a phase intentionally
#                               posts a partial result under a time budget.
# ---------------------------------------------------------------------------
declare -A COMPLETION_MARKER=(
  [INVESTIGATOR]="INVESTIGATION:COMPLETE"
  [CONTEXT]="FORGE:CONTEXT:COMPLETE"
  [ARCHITECT]="FORGE:ARCHITECT:COMPLETE"
  [BUILDER]="FORGE:BUILDER:COMPLETE"
  [DECOMPOSED]="FORGE:DECOMPOSED:COMPLETE"
)

declare -A PARTIAL_MARKER=(
  [CONTEXT]="FORGE:CONTEXT:PARTIAL"
  [ARCHITECT]="FORGE:ARCHITECT:PARTIAL"
)

# Markers with no required completion terminator (single-shot posts).
KNOWN_NO_TERMINATOR_MARKERS=(
  CONTRACT CHECKPOINT FAST_PATH HEARTBEAT LEARNED TRAJECTORY
  DECISION_RECORD REVIEW_STARTED
)

is_known_marker() {
  local m="$1"
  [[ -n "${COMPLETION_MARKER[$m]+x}" ]] && return 0
  local known
  for known in "${KNOWN_NO_TERMINATOR_MARKERS[@]}"; do
    [[ "$known" == "$m" ]] && return 0
  done
  return 1
}

normalize_marker() {
  # Accepts INVESTIGATOR, FORGE:INVESTIGATOR, or lowercase variants.
  local raw="${1^^}"
  raw="${raw#FORGE:}"
  echo "$raw"
}

# ---------------------------------------------------------------------------
# Template registry — one function per marker, using {{FIELD}} placeholders.
# Substitution is plain bash parameter-expansion string replacement (handles
# multi-line replacement values fine, no sed/awk needed).
# ---------------------------------------------------------------------------

render_template() {
  local marker="$1"
  local body=""

  case "$marker" in
    INVESTIGATOR)
      body='<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: {{VERDICT}}
**Confidence**: {{CONFIDENCE}}
**Severity**: {{SEVERITY}}
**Task Type**: {{TASK_TYPE}}

### What Was Claimed
{{WHAT_CLAIMED}}

### What We Found
{{WHAT_FOUND}}

### Root Cause
{{ROOT_CAUSE}}

### Affected Files
{{AFFECTED_FILES}}

### Evidence
{{EVIDENCE}}

### Recommendation
{{RECOMMENDATION}}

### Related Issues
{{RELATED_ISSUES}}

### Decomposition Assessment
**{{DECOMPOSE}}** — {{DECOMPOSE_REASON}}
{{DECOMPOSE_DETAILS}}

<!-- INVESTIGATION:COMPLETE -->'
      ;;
    CONTRACT)
      body='<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: {{TASK_TYPE}}

### Proposed Approach
{{APPROACH}}

### Deliverables
| File | Change | Why |
|------|--------|-----|
{{DELIVERABLES_ROWS}}

### Acceptance Criteria
{{ACCEPTANCE_CRITERIA}}

### Quality Considerations
{{QUALITY_CONSIDERATIONS}}

### Out of Scope
{{OUT_OF_SCOPE}}'
      ;;
    BUILDER)
      body='<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: `{{BRANCH}}`
**Commits**: {{COMMITS}}
**Files changed**: {{FILES_CHANGED}}

### Approach
{{APPROACH}}

### Changes
{{CHANGES}}

### Acceptance Criteria Status
{{ACCEPTANCE_STATUS}}

### Testing Checklist
{{TESTING_CHECKLIST}}

<!-- FORGE:BUILDER:COMPLETE -->'
      ;;
    CHECKPOINT)
      body='<!-- FORGE:CHECKPOINT -->
```json
{"phase": "{{PHASE}}", "status": "{{STATUS}}", "next_phase": "{{NEXT_PHASE}}", "timestamp": "{{TIMESTAMP}}"}
```'
      ;;
    *)
      echo "ERROR: no write template registered for marker '$marker' (known write templates: INVESTIGATOR, CONTRACT, BUILDER, CHECKPOINT)" >&2
      return 1
      ;;
  esac

  echo "$body"
}

required_fields_for() {
  case "$1" in
    INVESTIGATOR) echo "VERDICT CONFIDENCE SEVERITY TASK_TYPE WHAT_CLAIMED WHAT_FOUND ROOT_CAUSE AFFECTED_FILES EVIDENCE RECOMMENDATION DECOMPOSE DECOMPOSE_REASON" ;;
    CONTRACT)     echo "TASK_TYPE APPROACH DELIVERABLES_ROWS ACCEPTANCE_CRITERIA" ;;
    BUILDER)      echo "BRANCH COMMITS FILES_CHANGED APPROACH CHANGES ACCEPTANCE_STATUS TESTING_CHECKLIST" ;;
    CHECKPOINT)   echo "PHASE STATUS NEXT_PHASE" ;;
    *)            echo "" ;;
  esac
}

default_for_field() {
  # Optional-field defaults, applied only when the field was not supplied.
  local marker="$1" key="$2"
  case "$marker:$key" in
    INVESTIGATOR:RELATED_ISSUES)   echo "None found." ;;
    INVESTIGATOR:DECOMPOSE_DETAILS) echo "" ;;
    CONTRACT:QUALITY_CONSIDERATIONS) echo "None." ;;
    CONTRACT:OUT_OF_SCOPE)         echo "None." ;;
    CHECKPOINT:TIMESTAMP)          date -u +"%Y-%m-%dT%H:%M:%SZ" ;;
    *)                             echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# write
# ---------------------------------------------------------------------------
cmd_write() {
  if [ $# -lt 1 ]; then
    echo "ERROR: write requires a MARKER argument" >&2
    usage
    exit 1
  fi

  local marker
  marker="$(normalize_marker "$1")"
  shift

  case "$marker" in
    INVESTIGATOR|CONTRACT|BUILDER|CHECKPOINT) ;;
    *)
      echo "ERROR: '$marker' has no registered write template. Supported: INVESTIGATOR, CONTRACT, BUILDER, CHECKPOINT" >&2
      exit 1
      ;;
  esac

  declare -A FIELDS=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --field)
        if [ $# -lt 2 ] || [[ "$2" != *=* ]]; then
          echo "ERROR: --field requires KEY=VALUE" >&2
          exit 1
        fi
        local kv="$2" key val
        key="${kv%%=*}"
        val="${kv#*=}"
        FIELDS["$key"]="$val"
        shift 2
        ;;
      --field-file)
        if [ $# -lt 2 ] || [[ "$2" != *=* ]]; then
          echo "ERROR: --field-file requires KEY=FILE" >&2
          exit 1
        fi
        local kvf="$2" fkey ffile
        fkey="${kvf%%=*}"
        ffile="${kvf#*=}"
        if [ ! -f "$ffile" ]; then
          echo "ERROR: --field-file: file not found: $ffile" >&2
          exit 1
        fi
        FIELDS["$fkey"]="$(cat "$ffile")"
        shift 2
        ;;
      *)
        echo "ERROR: unknown write argument: $1" >&2
        exit 1
        ;;
    esac
  done

  # Fill optional-field defaults for anything not explicitly supplied.
  case "$marker" in
    INVESTIGATOR)
      for k in RELATED_ISSUES DECOMPOSE_DETAILS; do
        [[ -n "${FIELDS[$k]+x}" ]] || FIELDS["$k"]="$(default_for_field "$marker" "$k")"
      done
      ;;
    CONTRACT)
      for k in QUALITY_CONSIDERATIONS OUT_OF_SCOPE; do
        [[ -n "${FIELDS[$k]+x}" ]] || FIELDS["$k"]="$(default_for_field "$marker" "$k")"
      done
      ;;
    CHECKPOINT)
      [[ -n "${FIELDS[TIMESTAMP]+x}" ]] || FIELDS["TIMESTAMP"]="$(default_for_field "$marker" "TIMESTAMP")"
      ;;
  esac

  # Validate required fields are present (and non-empty).
  local missing="" f
  for f in $(required_fields_for "$marker"); do
    if [[ -z "${FIELDS[$f]+x}" ]] || [[ -z "${FIELDS[$f]}" ]]; then
      missing="$missing $f"
    fi
  done
  if [ -n "$missing" ]; then
    echo "ERROR: missing required field(s) for MARKER '$marker':$missing" >&2
    echo "       Required fields: $(required_fields_for "$marker")" >&2
    exit 1
  fi

  local body
  body="$(render_template "$marker")" || exit 1

  local key
  for key in "${!FIELDS[@]}"; do
    body="${body//\{\{$key\}\}/${FIELDS[$key]}}"
  done

  # Fail loudly if any placeholder was left unsubstituted — this catches
  # template/field-name drift between this script and the callers of it.
  if [[ "$body" == *"{{"*"}}"* ]]; then
    echo "ERROR: unsubstituted placeholder(s) remain in rendered '$marker' body — check field names:" >&2
    grep -oE '\{\{[A-Z_]+\}\}' <<<"$body" | sort -u >&2 || true
    exit 1
  fi

  echo "$body"
}

# ---------------------------------------------------------------------------
# read
# ---------------------------------------------------------------------------
cmd_read() {
  if [ $# -lt 2 ]; then
    echo "ERROR: Usage: $SCRIPT_NAME read <ISSUE_NUMBER> [GH_FLAG...] <MARKER> [--all]" >&2
    exit 1
  fi

  local issue_number="$1"
  shift

  if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ISSUE_NUMBER must be a positive integer, got: '$issue_number'" >&2
    exit 1
  fi

  local all_flag=0
  local args=("$@")
  local filtered=()
  local i
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "--all" ]; then
      all_flag=1
    else
      filtered+=("${args[$i]}")
    fi
  done

  if [ ${#filtered[@]} -lt 1 ]; then
    echo "ERROR: MARKER is required" >&2
    exit 1
  fi

  local last_index=$(( ${#filtered[@]} - 1 ))
  local marker
  marker="$(normalize_marker "${filtered[$last_index]}")"
  local gh_args=("${filtered[@]:0:$last_index}")

  if ! is_known_marker "$marker"; then
    echo "WARNING: '$marker' is not a known registered marker — reading anyway (unknown markers are not rejected, only unvalidated)." >&2
  fi

  # Resolve owner/repo for the gh api REST path. gh_args may contain `-R owner/repo`.
  local repo=""
  for ((i = 0; i < ${#gh_args[@]}; i++)); do
    if [ "${gh_args[$i]}" = "-R" ]; then
      if [ $((i + 1)) -ge ${#gh_args[@]} ]; then
        echo "ERROR: -R requires a value <owner/repo>" >&2
        echo "Usage: $SCRIPT_NAME read <ISSUE_NUMBER> [GH_FLAG...] <MARKER> [--all]" >&2
        exit 1
      fi
      repo="${gh_args[$((i + 1))]}"
      break
    fi
  done

  if [ -z "$repo" ]; then
    repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
    if [ -z "$repo" ]; then
      echo "ERROR: could not resolve owner/repo — pass -R <owner/repo> or run inside a repo with gh context" >&2
      exit 1
    fi
  fi

  if ! [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "ERROR: resolved repo is not owner/repo format: '$repo'" >&2
    exit 1
  fi

  local needle="FORGE:${marker}"
  local comments_json
  if ! comments_json="$(gh api "repos/${repo}/issues/${issue_number}/comments" --paginate 2>&1)"; then
    echo "ERROR: gh api call failed: $comments_json" >&2
    exit 1
  fi

  # `gh api --paginate` writes one JSON array PER PAGE to stdout, concatenated
  # (not merged into a single top-level array). Issues with >100 comments span
  # multiple pages. Feeding that multi-document stream directly into a jq filter
  # written for one document makes jq re-run the filter once per page — the
  # default/latest mode below would print one "latest per page" body per page
  # instead of a single global latest, and --all mode would emit N separate
  # JSON arrays concatenated instead of one valid array. Aggregate all pages
  # into a single array first so behavior is correct regardless of page count;
  # this is a no-op for the common single-page case.
  local aggregated_json
  if ! aggregated_json="$(jq -s 'add' <<<"$comments_json" 2>&1)"; then
    echo "ERROR: failed to aggregate paginated comments: $aggregated_json" >&2
    exit 1
  fi
  comments_json="$aggregated_json"

  if [ "$all_flag" -eq 1 ]; then
    jq --arg needle "$needle" '[.[] | select(.body | contains($needle)) | .body]' <<<"$comments_json"
  else
    jq -r --arg needle "$needle" '[.[] | select(.body | contains($needle))] | last | .body // ""' <<<"$comments_json"
  fi
}

# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------
cmd_validate() {
  if [ $# -lt 1 ]; then
    echo "ERROR: Usage: $SCRIPT_NAME validate <MARKER> [FILE]" >&2
    exit 1
  fi

  local marker
  marker="$(normalize_marker "$1")"
  shift

  local body
  if [ $# -ge 1 ]; then
    if [ ! -f "$1" ]; then
      echo "ERROR: file not found: $1" >&2
      exit 1
    fi
    body="$(cat "$1")"
  else
    body="$(cat -)"
  fi

  if [ -z "$body" ]; then
    echo "ERROR: empty body — nothing to validate" >&2
    exit 1
  fi

  if ! is_known_marker "$marker"; then
    echo "ERROR: unknown marker '$marker' — run 'list-markers' for the known set" >&2
    exit 1
  fi

  local header="FORGE:${marker}"
  if [[ "$body" != *"<!-- ${header} -->"* ]]; then
    echo "ERROR: body is missing required header '<!-- ${header} -->'" >&2
    exit 1
  fi

  if [[ -n "${COMPLETION_MARKER[$marker]+x}" ]]; then
    local complete_marker="${COMPLETION_MARKER[$marker]}"
    local partial_marker="${PARTIAL_MARKER[$marker]:-}"
    if [[ "$body" == *"$complete_marker"* ]]; then
      : # complete — OK
    elif [[ -n "$partial_marker" ]] && [[ "$body" == *"$partial_marker"* ]]; then
      echo "OK: '${marker}' annotation is well-formed (PARTIAL — terminator '${partial_marker}' present)"
      return 0
    else
      echo "ERROR: '${marker}' annotation is missing its completion marker. Expected to find: <!-- ${complete_marker} -->" >&2
      exit 1
    fi
  fi

  if [ "$marker" = "CHECKPOINT" ]; then
    local json_block
    json_block="$(sed -n '/```json/,/```/p' <<<"$body" | sed '1d;$d')"
    if [ -z "$json_block" ]; then
      echo "ERROR: CHECKPOINT annotation is missing its \`\`\`json ... \`\`\` block" >&2
      exit 1
    fi
    if ! echo "$json_block" | jq -e '.phase and .status and .next_phase and .timestamp' >/dev/null 2>&1; then
      echo "ERROR: CHECKPOINT JSON block is missing one of the required keys: phase, status, next_phase, timestamp" >&2
      exit 1
    fi
  fi

  echo "OK: '${marker}' annotation is well-formed"
}

# ---------------------------------------------------------------------------
# list-markers
# ---------------------------------------------------------------------------
cmd_list_markers() {
  echo "MARKER               COMPLETION_TERMINATOR"
  local m
  for m in "${!COMPLETION_MARKER[@]}"; do
    printf '%-20s  %s\n' "$m" "${COMPLETION_MARKER[$m]}"
  done | sort
  for m in "${KNOWN_NO_TERMINATOR_MARKERS[@]}"; do
    printf '%-20s  %s\n' "$m" "none"
  done | sort
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ $# -lt 1 ]; then
  usage
  exit 1
fi

SUBCOMMAND="$1"
shift

case "$SUBCOMMAND" in
  write)        cmd_write "$@" ;;
  read)         cmd_read "$@" ;;
  validate)     cmd_validate "$@" ;;
  list-markers) cmd_list_markers ;;
  -h|--help)    usage; exit 0 ;;
  *)
    echo "ERROR: unknown subcommand: $SUBCOMMAND" >&2
    usage
    exit 1
    ;;
esac
