#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# graph-query.sh — Read-only query interface over the Spec Knowledge Graph
#
# Queries the spec knowledge graph produced by `build-spec-graph.mjs`
# (`.forgedock/graph/spec-graph.json`). The graph is a self-map of ForgeDock's
# own command specs: which command WRITES/READS which FORGE annotation, which
# scripts a command INVOKES, which devdocs it REQUIRES, etc. This script is the
# consumer-facing query API so agents (and humans) don't hand-write jq.
#
# Usage:
#   graph-query.sh <subcommand> <arg> [--human] [--graph <path>]
#
# Subcommands:
#   readers <annotation>  — commands/specs that READ the annotation
#   writers <annotation>  — commands/specs that WRITE (post) the annotation
#   impact  <node>        — blast radius: everything transitively affected if
#                           <node> changes (annotation | label | script | command/spec)
#   deps    <command>     — what a command reads/invokes/requires/contains
#                           (its full input + output set), grouped by edge type
#   load-set <command>    — minimal spec set to read for a command: the command
#                           itself plus its transitively reachable sub-phases
#                           (CONTAINS) and required devdocs (REQUIRES), as a flat
#                           list of repo-relative file paths. This is the inverse
#                           of `impact` (forward instead of reverse reachability)
#                           and powers selective spec loading in the pipeline.
#   search  <term>        — substring lookup over node ids / names / paths
#
# Arguments are normalized, so all of these are accepted:
#   readers CONTRACT  ==  readers FORGE:CONTRACT  ==  readers ann:FORGE:CONTRACT
#   deps work-on      ==  deps cmd:work-on
#   deps work-on:build:implement  ==  deps cmd:work-on:build:implement
#   load-set work-on  ==  load-set cmd:work-on
#   impact classify-lane.sh  ==  impact script:classify-lane.sh
#   impact workflow:merged   ==  impact label:workflow:merged
#
# Staleness detection (no daemon):
#   A persisted graph carries `builtFromHash`, a sha256 fingerprint of the spec
#   corpus it was built from. On each query against a persisted graph, this
#   script cheaply recomputes the current fingerprint (build-spec-graph.mjs
#   --hash) and compares. If they differ, the persisted graph is stale: a
#   `stale-graph` banner is printed to STDERR and the graph is transparently
#   rebuilt for this query (stdout stays pure JSON). The no-change path does one
#   cheap hash compare and no rebuild — no background process, no watcher.
#
# Flags:
#   --human         Render an aligned table instead of compact JSON.
#   --graph <path>  Use a specific graph JSON (default:
#                   <repo>/.forgedock/graph/spec-graph.json). If the default is
#                   absent (it is gitignored), the graph is auto-built on the fly
#                   via build-spec-graph.mjs — no committed graph is required.
#   --strict-stale  Do NOT auto-rebuild a stale persisted graph — error (exit 1)
#                   instead. Useful in CI to assert the committed graph is fresh.
#   --no-stale-check Skip the staleness check entirely (query the persisted graph
#                   as-is, even if the spec corpus has changed).
#   -h | --help     Show this help.
#
# Output:
#   Default is compact, agent-consumable JSON (a JSON array for
#   readers/writers/impact/search/load-set; a JSON object keyed by edge type
#   for deps). load-set returns a sorted, de-duplicated array of repo-relative
#   file paths. With --human, an aligned text table is printed instead.
#
# Exit codes: 0 = success, 1 = error (bad args, missing deps, unknown node).
#
# This is a UNIVERSAL-tier script (ships with the npm package). It is read-only:
# it never mutates the repo or the graph (it only writes a temp cache under
# $TMPDIR when it must auto-build, removed on exit). See
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

SUBCMD=""
ARG=""
HUMAN=0
GRAPH_PATH=""
STRICT_STALE=0
STALE_CHECK=1

if [ "$#" -eq 0 ]; then
  print_help
  exit 1
fi

POSITIONAL=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --human)
      HUMAN=1
      shift
      ;;
    --graph)
      [ "$#" -ge 2 ] || die "--graph requires a path"
      GRAPH_PATH="$2"
      shift 2
      ;;
    --strict-stale)
      STRICT_STALE=1
      shift
      ;;
    --no-stale-check)
      STALE_CHECK=0
      shift
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do POSITIONAL+=("$1"); shift; done
      ;;
    -*)
      die "unknown flag: $1"
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [ "${#POSITIONAL[@]}" -ge 1 ]; then SUBCMD="${POSITIONAL[0]}"; fi
if [ "${#POSITIONAL[@]}" -ge 2 ]; then ARG="${POSITIONAL[1]}"; fi
if [ "${#POSITIONAL[@]}" -gt 2 ]; then
  die "too many arguments: expected '<subcommand> <arg>', got ${#POSITIONAL[@]} positionals"
fi

[ -n "$SUBCMD" ] || die "no subcommand given (one of: readers writers impact deps load-set search)"

case "$SUBCMD" in
  readers|writers|impact|deps|load-set|search) ;;
  *) die "unknown subcommand '$SUBCMD' (one of: readers writers impact deps load-set search)" ;;
esac

[ -n "$ARG" ] || die "subcommand '$SUBCMD' requires an argument"

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

# Rebuild the graph to a temp file and point GRAPH at it. Shared by the
# absent-graph auto-build path and the stale-graph rebuild path.
build_graph_to_temp() {
  require_dep node
  [ -f "$BUILDER" ] || die "graph is absent and builder not found: $BUILDER"
  TMP_GRAPH="$(mktemp "${TMPDIR:-/tmp}/spec-graph.XXXXXX.json")"
  if ! node "$BUILDER" --root "$REPO_ROOT" --stdout --quiet >"$TMP_GRAPH" 2>/dev/null; then
    die "failed to build spec graph via $BUILDER"
  fi
  GRAPH="$TMP_GRAPH"
}

# Staleness check for a PERSISTED graph (default path or --graph). Cheaply
# recompute the current spec-corpus fingerprint and compare to the graph's
# stored builtFromHash. On mismatch: warn (stderr) and rebuild, unless
# --strict-stale (error) is set. A graph with no builtFromHash (pre-staleness
# schema) is treated as stale. Diagnostics go to stderr only; stdout stays pure.
check_staleness() {
  [ "$STALE_CHECK" -eq 1 ] || return 0
  # `node` is required to recompute the hash; if it is unavailable, skip the
  # check rather than failing an otherwise-valid query.
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$BUILDER" ] || return 0

  local stored current
  stored="$(jq -r '.graph.builtFromHash // ""' "$GRAPH" 2>/dev/null || echo "")"
  current="$(node "$BUILDER" --root "$REPO_ROOT" --hash --quiet 2>/dev/null || echo "")"

  # If we could not compute the current hash, do not block the query.
  [ -n "$current" ] || return 0
  # Fresh: stored hash matches current corpus → use the persisted graph as-is.
  [ "$stored" = "$current" ] && return 0

  # Stale (mismatch, or missing builtFromHash on an older graph).
  if [ "$STRICT_STALE" -eq 1 ]; then
    die "stale-graph: persisted graph ($GRAPH) is out of date — spec corpus changed since it was built (run: node $BUILDER). --strict-stale set, refusing to auto-rebuild."
  fi
  echo "stale-graph: spec corpus changed since graph was built — rebuilding for this query" >&2
  build_graph_to_temp
}

resolve_graph() {
  if [ -n "$GRAPH_PATH" ]; then
    [ -f "$GRAPH_PATH" ] || die "graph file not found: $GRAPH_PATH"
    GRAPH="$GRAPH_PATH"
    check_staleness
    return
  fi
  if [ -f "$DEFAULT_GRAPH" ]; then
    GRAPH="$DEFAULT_GRAPH"
    check_staleness
    return
  fi
  # Auto-build to a temp file (the default path is gitignored / may not exist).
  # A freshly built graph is current by construction — no staleness check needed.
  build_graph_to_temp
}

resolve_graph

# Validate the graph document shape early so jq filters can assume it.
jq -e '.graph.nodes and .graph.edges' "$GRAPH" >/dev/null 2>&1 \
  || die "not a valid spec-graph document (missing .graph.nodes/.graph.edges): $GRAPH"

# ---------------------------------------------------------------------------
# Argument normalization to canonical node ids
#   annotation -> ann:FORGE:<NAME>
#   label      -> label:workflow:<name>
#   script     -> script:<file>.sh
#   command    -> cmd:<name[:sub[:sub]]>
# ---------------------------------------------------------------------------

normalize_ann() {
  # Accept: CONTRACT | FORGE:CONTRACT | ann:FORGE:CONTRACT
  local a="$1"
  case "$a" in
    ann:FORGE:*) echo "$a" ;;
    FORGE:*)     echo "ann:$a" ;;
    *)           echo "ann:FORGE:$a" ;;
  esac
}

normalize_cmd() {
  # Accept: work-on | work-on:build:implement | cmd:work-on
  local c="$1"
  case "$c" in
    cmd:*) echo "$c" ;;
    *)     echo "cmd:$c" ;;
  esac
}

# For `impact`, the node may be any type. Resolve to a canonical id by trying,
# in order: exact id match in the graph, then type-specific normalizers.
normalize_node() {
  local n="$1"
  # Already a fully-qualified id present in the graph?
  if node_exists "$n"; then echo "$n"; return; fi
  case "$n" in
    ann:*|label:*|script:*|cmd:*|devdoc:*)
      echo "$n" ;;                                  # explicit prefix, trust it
    FORGE:*)
      echo "ann:$n" ;;
    workflow:*)
      echo "label:$n" ;;
    *.sh)
      echo "script:$n" ;;
    *)
      # Bare token: prefer annotation, then command, then label — whichever
      # exists in the graph. Fall back to annotation form.
      if node_exists "ann:FORGE:$n"; then echo "ann:FORGE:$n"
      elif node_exists "cmd:$n";       then echo "cmd:$n"
      elif node_exists "label:workflow:$n"; then echo "label:workflow:$n"
      elif node_exists "script:$n";    then echo "script:$n"
      else echo "ann:FORGE:$n"
      fi
      ;;
  esac
}

node_exists() {
  jq -e --arg id "$1" 'any(.graph.nodes[]; .id == $id)' "$GRAPH" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

# List .from of edges of a given type pointing at a target node. JSON array.
query_edge_from() {
  local etype="$1" target="$2"
  jq -c --arg t "$etype" --arg to "$target" \
    '[.graph.edges[] | select(.type == $t and .to == $to) | .from] | unique' "$GRAPH"
}

# All outbound edges from a command, grouped by edge type. JSON object.
query_deps() {
  local from="$1"
  jq -c --arg from "$from" '
    [.graph.edges[] | select(.from == $from)]
    | reduce .[] as $e ({}; .[$e.type] += [$e.to])
    | map_values(unique)
  ' "$GRAPH"
}

# Transitive reverse-reachability: everything that (transitively) depends on the
# seed node. Walk edges where .to is in the frontier, collecting .from, to a
# fixpoint. Excludes the seed. JSON array of node ids.
query_impact() {
  local seed="$1"
  jq -c --arg seed "$seed" '
    .graph.edges as $edges
    | def step(set):
        ( [ $edges[] | select(.to as $to | set | index($to)) | .from ] ) as $froms
        | (set + $froms | unique) as $next
        | if ($next | length) == (set | length) then set else step($next) end;
      (step([$seed]) - [$seed]) | unique
  ' "$GRAPH"
}

# Transitive FORWARD-reachability: the minimal spec set to read for a command.
# Seeds at the command node, then walks CONTAINS (sub-phases) and REQUIRES
# (devdocs) edges in the forward direction (.from in frontier -> collect .to) to
# a fixpoint. The resolved node ids are mapped to their repo-relative `.path`
# (nodes without a path — e.g. annotations — are dropped). Includes the seed
# command's own path. Output is a sorted, de-duplicated JSON array of paths.
#
# This is the inverse of query_impact (forward instead of reverse) and shares
# its cycle-safe length-equality termination, so a spurious self-CONTAINS edge
# cannot cause a non-terminating walk. Only CONTAINS/REQUIRES are followed —
# READS/WRITES/TRANSITIONS/INVOKES are NOT part of the spec-read set (annotations
# and labels have no spec file; scripts are resolved separately at invoke time).
query_load_set() {
  local seed="$1"
  jq -c --arg seed "$seed" '
    [.graph.edges[] | select(.type == "CONTAINS" or .type == "REQUIRES")] as $edges
    | (reduce .graph.nodes[] as $n ({}; .[$n.id] = ($n.path // null))) as $path
    | def step(set):
        ( [ $edges[] | select(.from as $f | set | index($f)) | .to ] ) as $tos
        | (set + $tos | unique) as $next
        | if ($next | length) == (set | length) then set else step($next) end;
      step([$seed])
      | map($path[.] // empty)
      | unique
  ' "$GRAPH"
}

# Substring search over node id / name / path. JSON array of {id,type,name}.
query_search() {
  local term="$1"
  jq -c --arg term "$term" '
    ($term | ascii_downcase) as $t
    | [ .graph.nodes[]
        | select(
            (.id   | ascii_downcase | contains($t)) or
            (.name | ascii_downcase | contains($t)) or
            ((.path // "") | ascii_downcase | contains($t))
          )
        | {id, type, name} ]
    | sort_by(.id)
  ' "$GRAPH"
}

# ---------------------------------------------------------------------------
# Human-readable rendering
# ---------------------------------------------------------------------------

render_list_human() {
  # stdin: JSON array of strings. Print one per line, or "(none)".
  local title="$1"
  local rows
  rows="$(jq -r '.[]' 2>/dev/null || true)"
  echo "$title"
  if [ -z "$rows" ]; then
    echo "  (none)"
  else
    echo "$rows" | sed 's/^/  /'
  fi
}

render_deps_human() {
  # stdin: JSON object {EDGE_TYPE: [to, ...]}. Group by edge type.
  local obj
  obj="$(cat)"
  if [ "$(echo "$obj" | jq 'length')" -eq 0 ]; then
    echo "(no outbound edges)"
    return
  fi
  echo "$obj" | jq -r 'to_entries[] | "\(.key):\n" + ([.value[] | "  " + .] | join("\n"))'
}

render_search_human() {
  # stdin: JSON array of {id,type,name}. Aligned 2-col table.
  jq -r '.[] | "\(.type)\t\(.id)"' | column -t -s $'\t' 2>/dev/null \
    || jq -r '.[] | "\(.type)  \(.id)"'
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "$SUBCMD" in
  readers)
    target="$(normalize_ann "$ARG")"
    result="$(query_edge_from READS "$target")"
    if [ "$HUMAN" -eq 1 ]; then
      echo "$result" | render_list_human "Specs that READ $target:"
    else
      echo "$result"
    fi
    ;;
  writers)
    target="$(normalize_ann "$ARG")"
    result="$(query_edge_from WRITES "$target")"
    if [ "$HUMAN" -eq 1 ]; then
      echo "$result" | render_list_human "Specs that WRITE $target:"
    else
      echo "$result"
    fi
    ;;
  deps)
    from="$(normalize_cmd "$ARG")"
    node_exists "$from" || die "no command/spec node '$from' in the graph (try: graph-query.sh search ${ARG})"
    result="$(query_deps "$from")"
    if [ "$HUMAN" -eq 1 ]; then
      echo "Dependencies of $from:"
      echo "$result" | render_deps_human
    else
      echo "$result"
    fi
    ;;
  load-set)
    from="$(normalize_cmd "$ARG")"
    node_exists "$from" || die "no command/spec node '$from' in the graph (try: graph-query.sh search ${ARG})"
    result="$(query_load_set "$from")"
    if [ "$HUMAN" -eq 1 ]; then
      echo "$result" | render_list_human "Minimal spec set for $from:"
    else
      echo "$result"
    fi
    ;;
  impact)
    seed="$(normalize_node "$ARG")"
    node_exists "$seed" || die "no node '$seed' in the graph (try: graph-query.sh search ${ARG})"
    result="$(query_impact "$seed")"
    if [ "$HUMAN" -eq 1 ]; then
      echo "$result" | render_list_human "Impact (blast radius) of changing $seed:"
    else
      echo "$result"
    fi
    ;;
  search)
    result="$(query_search "$ARG")"
    if [ "$HUMAN" -eq 1 ]; then
      echo "$result" | render_search_human
    else
      echo "$result"
    fi
    ;;
esac
