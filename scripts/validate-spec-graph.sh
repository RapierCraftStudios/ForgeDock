#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# validate-spec-graph.sh — Self-consistency validator over the Spec Knowledge Graph
#
# Consumes the spec knowledge graph produced by `build-spec-graph.mjs`
# (`.forgedock/graph/spec-graph.json`) and reports drift that is invisible in a
# ~1.2 MB prose spec corpus. Three classes of inconsistency are checked:
#
#   1. Orphan annotations (SOFT — warn)
#        FORGE:* markers that are WRITTEN but never READ, or READ but never
#        WRITTEN. These are usually intentional (a one-sided handshake) but
#        worth a periodic triage. Isolated inline doc-scaffolding markers
#        (e.g. FORGE:DISPATCHER, FORGE:PHASE_COMPLETE) are reported as INFO
#        only — they are prose annotations, never posted via `gh comment`.
#
#   2. Dangling cross-refs (HARD — fail)
#        A spec invokes `Skill(skill="X")` where X does not resolve to a real
#        command/sub-phase node. The graph builder silently DROPS unresolved
#        Skill/script/devdoc references (it only emits an edge when the target
#        exists), so this check scans `commands/**/*.md` directly rather than
#        querying graph edges.
#
#   3. Broken label transitions (HARD — fail)
#        A `workflow:*` label node that is set by NO command (no incoming
#        TRANSITIONS edge from any `--add-label`). Also surfaces (as INFO) the
#        add/remove asymmetry where a label is `--remove-label`-d but never
#        `--add-label`-ed, which signals a state-machine gap.
#
# Exit codes:
#   0  no HARD inconsistencies (SOFT warnings / INFO may still be printed),
#      or --soft was passed (warn-only mode)
#   1  one or more HARD inconsistencies (dangling refs, broken transitions),
#      or a usage / dependency error
#
# Usage:
#   validate-spec-graph.sh [--soft] [--graph <path>] [--root <dir>] [--quiet] [--json] [-h|--help]
#
# Flags:
#   --soft          Warn-only mode: report HARD findings but exit 0 anyway.
#                   Used when first wiring into CI so the documented baseline
#                   orphans/refs do not break the build before triage.
#   --graph <path>  Validate a specific graph JSON (default:
#                   <repo>/.forgedock/graph/spec-graph.json). If the default is
#                   absent (it is gitignored), the graph is auto-built on the
#                   fly via build-spec-graph.mjs — no committed graph required.
#   --root <dir>    Repo root to scan for Skill() refs and to auto-build from
#                   (default: parent of this script's dir).
#   --quiet         Suppress the human-readable report; print only the summary
#                   line (and set the exit code).
#   --json          Emit findings as a single JSON object on stdout instead of
#                   the human-readable report.
#   -h | --help     Show this help.
#
# This is a UNIVERSAL-tier script (ships with the npm package). It is read-only:
# it never mutates the repo or the committed graph (it only writes a temp graph
# under $TMPDIR when it must auto-build, removed on exit). See
# devdocs/project/architecture.md for the scripts-layer precedence model and
# docs/spec-graph-schema.md for the graph schema.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths & dependency checks
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BUILDER="$SCRIPT_DIR/build-spec-graph.mjs"
DEFAULT_GRAPH="$REPO_ROOT/.forgedock/graph/spec-graph.json"

# Exported so per-repo adaptive scripts can delegate (see architecture.md).
export FORGEDOCK_SCRIPTS="$SCRIPT_DIR"
export FORGEDOCK_HOME="$REPO_ROOT"

# Inline doc-scaffolding annotations: real markers in the corpus that are used
# to annotate the spec prose itself (HTML comments inside the spec body), never
# posted via `gh ... comment --body`. They legitimately have neither WRITES nor
# READS edges, so they must NOT be flagged as orphans. Reported as INFO only.
#
# Keep this list sorted. Add a marker here only if it is a prose-scaffolding
# annotation by design (a `<!-- FORGE:X -->` that documents the spec, not a
# pipeline handshake posted to an issue/PR).
SCAFFOLDING_ANNOTATIONS=(
  "FORGE:ANCESTRY_FAILED"
  "FORGE:DISPATCHER"
  "FORGE:GATE_FAILED"
  "FORGE:JSONL_PARSER_UTIL"
  "FORGE:KNOWLEDGE_GIST"
  "FORGE:MILESTONE_INDEX"
  "FORGE:PHASE"
  "FORGE:PHASE_COMPLETE"
  "FORGE:PRIOR_GIST"
  "FORGE:PUSH_BLOCKED"
  "FORGE:PUSH_FAILED"
  "FORGE:REVIEW_STARTED"
  "FORGE:TYPE"
)

print_help() {
  # Echo the leading comment block (between the shebang and `set -euo`).
  sed -n '3,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" \
    | sed '$d' \
    | sed 's/^# \{0,1\}//'
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_dep() {
  command -v "$1" >/dev/null 2>&1 || die "required dependency '$1' not found on PATH"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

SOFT=0
QUIET=0
JSON=0
GRAPH_PATH=""
ROOT_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --soft)
      SOFT=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --json)
      JSON=1
      shift
      ;;
    --graph)
      [ "$#" -ge 2 ] || die "--graph requires a path"
      GRAPH_PATH="$2"
      shift 2
      ;;
    --root)
      [ "$#" -ge 2 ] || die "--root requires a path"
      ROOT_OVERRIDE="$2"
      shift 2
      ;;
    -*)
      die "unknown flag: $1 (try --help)"
      ;;
    *)
      die "unexpected argument: $1 (this validator takes no positionals; try --help)"
      ;;
  esac
done

if [ -n "$ROOT_OVERRIDE" ]; then
  REPO_ROOT="$ROOT_OVERRIDE"
  DEFAULT_GRAPH="$REPO_ROOT/.forgedock/graph/spec-graph.json"
fi

require_dep jq

# ---------------------------------------------------------------------------
# Resolve the graph JSON (auto-build if absent — the graph is gitignored)
# ---------------------------------------------------------------------------

GRAPH=""
TMP_GRAPH=""

cleanup() {
  [ -n "$TMP_GRAPH" ] && [ -f "$TMP_GRAPH" ] && rm -f "$TMP_GRAPH" || true
}
trap cleanup EXIT

resolve_graph() {
  if [ -n "$GRAPH_PATH" ]; then
    [ -f "$GRAPH_PATH" ] || die "graph file not found: $GRAPH_PATH"
    GRAPH="$GRAPH_PATH"
    return
  fi
  if [ -f "$DEFAULT_GRAPH" ]; then
    GRAPH="$DEFAULT_GRAPH"
    return
  fi
  # Auto-build to a temp file (the default path is gitignored / may not exist).
  require_dep node
  [ -f "$BUILDER" ] || die "graph is absent and builder not found: $BUILDER"
  TMP_GRAPH="$(mktemp "${TMPDIR:-/tmp}/spec-graph.XXXXXX.json")"
  if ! node "$BUILDER" --root "$REPO_ROOT" --stdout --quiet >"$TMP_GRAPH" 2>/dev/null; then
    die "failed to auto-build spec graph via $BUILDER"
  fi
  GRAPH="$TMP_GRAPH"
}

resolve_graph

# Validate the graph document shape early so jq filters can assume it.
jq -e '.graph.nodes and .graph.edges' "$GRAPH" >/dev/null 2>&1 \
  || die "not a valid spec-graph document (missing .graph.nodes/.graph.edges): $GRAPH"

# ---------------------------------------------------------------------------
# Findings accumulation
#   Each finding is one line: "<SEVERITY>\t<CLASS>\t<message>"
#   SEVERITY in {HARD, SOFT, INFO}. Collected then rendered/summarized.
# ---------------------------------------------------------------------------

FINDINGS=""

add_finding() {
  # add_finding <severity> <class> <message>
  FINDINGS="${FINDINGS}${1}"$'\t'"${2}"$'\t'"${3}"$'\n'
}

# ---------------------------------------------------------------------------
# Check 1: Orphan annotations
# ---------------------------------------------------------------------------

check_orphans() {
  # written-never-read and read-never-written, computed from graph edges.
  # Emits one finding per annotation. Scaffolding markers (no read AND no write)
  # are downgraded to INFO via the allowlist; any non-allowlisted isolated
  # marker is still surfaced (as SOFT) so new scaffolding gets curated.
  local scaffold_json
  scaffold_json="$(printf '%s\n' "${SCAFFOLDING_ANNOTATIONS[@]}" | jq -R . | jq -sc .)"

  # Produce TSV rows: <kind>\t<ann-name> where kind is one of:
  #   WRITTEN_NEVER_READ | READ_NEVER_WRITTEN | ISOLATED_SCAFFOLD | ISOLATED_UNKNOWN
  local rows
  rows="$(jq -r --argjson scaffold "$scaffold_json" '
    .graph as $g
    | ([$g.edges[] | select(.type=="WRITES") | .to]) as $written
    | ([$g.edges[] | select(.type=="READS")  | .to]) as $read
    | $g.nodes[]
    | select(.type=="annotation")
    | .id as $id | (.name) as $name
    | ($written | index($id) != null) as $w
    | ($read    | index($id) != null) as $r
    | if ($w and ($r|not)) then "WRITTEN_NEVER_READ\t\($name)"
      elif (($w|not) and $r) then "READ_NEVER_WRITTEN\t\($name)"
      elif (($w|not) and ($r|not)) then
        (if ($scaffold | index($name)) then "ISOLATED_SCAFFOLD\t\($name)"
         else "ISOLATED_UNKNOWN\t\($name)" end)
      else empty end
  ' "$GRAPH")"

  local kind name
  while IFS=$'\t' read -r kind name; do
    [ -n "$kind" ] || continue
    case "$kind" in
      WRITTEN_NEVER_READ)
        add_finding SOFT orphan-annotation "$name is WRITTEN but never READ by any spec." ;;
      READ_NEVER_WRITTEN)
        add_finding SOFT orphan-annotation "$name is READ but never WRITTEN by any spec." ;;
      ISOLATED_SCAFFOLD)
        add_finding INFO scaffold-annotation "$name is an inline doc-scaffolding marker (no WRITES/READS edge — expected)." ;;
      ISOLATED_UNKNOWN)
        add_finding SOFT orphan-annotation "$name has neither a WRITES nor a READS edge and is not an allowlisted scaffolding marker — triage or add to the allowlist." ;;
    esac
  done <<< "$rows"
}

# ---------------------------------------------------------------------------
# Check 2: Dangling cross-refs (Skill() targets)
# ---------------------------------------------------------------------------

check_dangling() {
  # The builder DROPS unresolved Skill()/script/devdoc refs, so we scan the spec
  # corpus directly. We restrict to Skill(skill="X") — the only *structured*
  # cross-reference form — to avoid false positives on illustrative filename
  # mentions in prose.
  local commands_dir="$REPO_ROOT/commands"
  [ -d "$commands_dir" ] || return 0

  # Set of known command/sub-phase node names (e.g. "work-on", "work-on:build").
  local known
  known="$(jq -r '.graph.nodes[] | select(.type=="command" or .type=="sub-phase") | .name' "$GRAPH" | sort -u)"

  # Extract every Skill(skill="X") / Skill(skill='X') target with file+line.
  # grep -rn over the whole tree (no fixed -A/-m window that could truncate).
  local hits
  hits="$(grep -rnoE "Skill\(\s*skill\s*=\s*[\"'][a-z][a-z0-9:_-]*[\"']" "$commands_dir" 2>/dev/null || true)"

  [ -n "$hits" ] || return 0

  local line target relpath
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # line form: <path>:<lineno>:Skill( skill = "X" )
    relpath="${line%%:*}"
    relpath="${relpath#"$REPO_ROOT"/}"
    # Pull the quoted target.
    target="$(printf '%s' "$line" | grep -oE "[\"'][a-z][a-z0-9:_-]*[\"']" | head -1 | tr -d "\"'")"
    [ -n "$target" ] || continue
    if ! printf '%s\n' "$known" | grep -qxF "$target"; then
      add_finding HARD dangling-ref "$relpath references Skill(skill=\"$target\") but no command/sub-phase node \"$target\" exists in the graph."
    fi
  done <<< "$hits"
}

# ---------------------------------------------------------------------------
# Check 3: Broken label transitions
# ---------------------------------------------------------------------------

check_transitions() {
  # A label node set by no --add-label TRANSITIONS edge is a broken transition.
  local orphan_labels
  orphan_labels="$(jq -r '
    .graph as $g
    | ([$g.edges[] | select(.type=="TRANSITIONS") | .to]) as $set
    | $g.nodes[] | select(.type=="label")
    | select(.id as $id | ($set | index($id)) == null)
    | .name
  ' "$GRAPH")"

  local lbl
  while IFS= read -r lbl; do
    [ -n "$lbl" ] || continue
    add_finding HARD broken-transition "Label $lbl is defined/referenced but set by NO command (no --add-label transition) — state-machine gap."
  done <<< "$orphan_labels"

  # Add/remove asymmetry: labels that are --remove-label-d but never
  # --add-label-ed anywhere in the corpus. INFO — usually a defensive removal,
  # but flags a potential dead state.
  local commands_dir="$REPO_ROOT/commands"
  [ -d "$commands_dir" ] || return 0

  local added removed
  added="$(jq -r '.graph.edges[] | select(.type=="TRANSITIONS") | .to | sub("^label:"; "")' "$GRAPH" | sort -u)"
  removed="$(grep -rhoE -- "--remove-label[[:space:]]+[\"'][^\"']*[\"']" "$commands_dir" 2>/dev/null \
    | grep -oE 'workflow:[a-z][a-z0-9-]*' | sort -u || true)"

  local r
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    if ! printf '%s\n' "$added" | grep -qxF "$r"; then
      add_finding INFO transition-asymmetry "Label $r is removed (--remove-label) but never added (--add-label) by any command."
    fi
  done <<< "$removed"
}

# ---------------------------------------------------------------------------
# Run checks
# ---------------------------------------------------------------------------

check_orphans
check_dangling
check_transitions

# Sort findings deterministically (severity rank, then class, then message).
sev_rank() {
  case "$1" in
    HARD) echo 0 ;;
    SOFT) echo 1 ;;
    INFO) echo 2 ;;
    *)    echo 9 ;;
  esac
}

SORTED_FINDINGS="$(printf '%s' "$FINDINGS" \
  | awk -F'\t' 'NF>=3 { r=($1=="HARD"?0:($1=="SOFT"?1:($1=="INFO"?2:9))); print r"\t"$0 }' \
  | sort -t$'\t' -k1,1n -k3,3 -k4,4 \
  | cut -f2-)"

HARD_COUNT="$(printf '%s\n' "$SORTED_FINDINGS" | awk -F'\t' 'NF>=3 && $1=="HARD"' | grep -c . || true)"
SOFT_COUNT="$(printf '%s\n' "$SORTED_FINDINGS" | awk -F'\t' 'NF>=3 && $1=="SOFT"' | grep -c . || true)"
INFO_COUNT="$(printf '%s\n' "$SORTED_FINDINGS" | awk -F'\t' 'NF>=3 && $1=="INFO"' | grep -c . || true)"

# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------

if [ "$JSON" -eq 1 ]; then
  printf '%s\n' "$SORTED_FINDINGS" \
    | awk -F'\t' 'NF>=3 { print $1"\t"$2"\t"$3 }' \
    | jq -R -s --argjson hard "$HARD_COUNT" --argjson soft "$SOFT_COUNT" --argjson info "$INFO_COUNT" '
        split("\n")
        | map(select(length>0) | split("\t") | {severity: .[0], class: .[1], message: .[2]})
        | { summary: {hard: $hard, soft: $soft, info: $info}, findings: . }
      '
elif [ "$QUIET" -eq 0 ]; then
  echo "Spec graph self-consistency report"
  echo "  graph: $GRAPH"
  echo ""
  if [ -z "$SORTED_FINDINGS" ]; then
    echo "  (no findings — graph is internally consistent)"
  else
    printf '%s\n' "$SORTED_FINDINGS" \
      | awk -F'\t' 'NF>=3 { printf "  [%-4s] %-22s %s\n", $1, $2, $3 }'
  fi
  echo ""
fi

if [ "$QUIET" -eq 0 ] && [ "$JSON" -eq 0 ]; then
  echo "Summary: ${HARD_COUNT} hard, ${SOFT_COUNT} soft, ${INFO_COUNT} info"
elif [ "$QUIET" -eq 1 ]; then
  echo "spec-graph-validate: ${HARD_COUNT} hard, ${SOFT_COUNT} soft, ${INFO_COUNT} info"
fi

# ---------------------------------------------------------------------------
# Exit code
# ---------------------------------------------------------------------------

if [ "$HARD_COUNT" -gt 0 ] && [ "$SOFT" -eq 0 ]; then
  exit 1
fi
exit 0
