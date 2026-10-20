#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# repo-facts.sh — deterministic repo facts the builder reads instead of re-learning them each lane (forge#4272). No LLM,
# no network, runs none of the repo's commands: git + jq + awk + node. Codebase-agnostic.
#
# Usage: repo-facts.sh [--repo-path DIR] [--output FILE | --stdout]
#   default output <repo>/.forge/repo-facts.json, rewritten on every run (an optional cache; the builder prompt cites
#   it by path when present, deleting it restores today's prompts).
# Output: {"version":1,
#   "toolchain": bin/lean/toolchain.mjs detectPins(repo) {pm, node, notes} (forge#4163),
#   "slow_suites": [{command, source, why}]: test-map entries (.forge/test-map.json when valid, else test-map.sh) whose
#     command names e2e|playwright|cypress|integration|docker, or whose CI job sets `services:` or timeout-minutes >= 20,
#   "layer_rules": {packages:[{name,dir}], edges:[{from,to,kind,manifest}], boundary_configs:[path]}: the workspace
#     package graph at HEAD, same workspace and edge definitions as scripts/structure-delta.sh (forge#4159); boundary
#     configs are eslint/dependency-cruiser/Nx files naming boundary rules,
#   "hotspots": scripts/hotspots.sh over the tracked files, over-threshold and not excluded, by hotspot desc, max 20
#     (forge#4195)}
# Exit: 0 ok | 2 usage or bad repo path. bash 3.2 portable.
set -uo pipefail

die() { echo "repo-facts: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="."; OUT=""; STDOUT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) [ $# -ge 2 ] && [ -n "$2" ] || die "usage: repo-facts.sh [--repo-path DIR] [--output FILE | --stdout]"; REPO="$2"; shift 2 ;;
    --output) [ $# -ge 2 ] && [ -n "$2" ] || die "usage: repo-facts.sh [--repo-path DIR] [--output FILE | --stdout]"; OUT="$2"; shift 2 ;;
    --stdout) STDOUT=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -d "$REPO" ] || die "repo path not found: $REPO"
case "$OUT" in ""|/*) ;; *) OUT="$PWD/$OUT" ;; esac
cd "$REPO" || die "cannot enter $REPO"

T=$(mktemp -d "${TMPDIR:-/tmp}/repo-facts.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$T"' EXIT
HAS_HEAD=0; git rev-parse --verify -q "HEAD^{commit}" >/dev/null 2>&1 && HAS_HEAD=1
# -z and quotepath=off (#4298): non-ASCII and spaced paths come out verbatim, never C-quoted
if [ "$HAS_HEAD" = 1 ]; then git -c core.quotepath=off ls-tree -r -z --name-only HEAD | tr '\0' '\n' > "$T/files"; else : > "$T/files"; fi
# file content at HEAD
at_head() { git show "HEAD:$1" 2>/dev/null; }

# ---- toolchain (reuses #4163 detection) ----
TOOLCHAIN=$(node --input-type=module -e '
  const { detectPins } = await import(process.argv[1]);
  console.log(JSON.stringify(await detectPins(process.argv[2])));
' "$HERE/../bin/lean/toolchain.mjs" "$PWD" 2>/dev/null) || TOOLCHAIN=""
printf '%s' "$TOOLCHAIN" | jq -e 'type == "object"' >/dev/null 2>&1 || TOOLCHAIN='{"pm":null,"node":null,"notes":["toolchain detection failed"]}'

# ---- slow suites ----
MAP=""
[ -f .forge/test-map.json ] && MAP=$(jq -c 'select(.version == 1 and (.entries | type == "array"))' .forge/test-map.json 2>/dev/null)
[ -n "$MAP" ] || MAP=$(bash "$HERE/test-map.sh" --stdout 2>/dev/null)
[ -n "$MAP" ] || MAP='{"version":1,"entries":[]}'
# CI jobs: "workflow#jobs.<job> TAB services(0|1) TAB timeout-minutes(0 when unset)"
: > "$T/jobs"
grep -E '^\.github/workflows/[^/]+\.(yml|yaml)$' "$T/files" | while IFS= read -r wf; do
  [ -f "$wf" ] || continue
  awk -v wf="$wf" '
    function indent(s) { match(s, /^ */); return RLENGTH }
    function flush() { if (job != "") print wf "#jobs." job "\t" svc "\t" tmo }
    /^jobs:[ \t]*$/ { on = 1; next }
    on && /^[^ \t#]/ { flush(); job = ""; on = 0; next }
    on && /^ +[A-Za-z0-9_-]+:[ \t]*$/ && (jind == 0 || indent($0) == jind) { flush(); jind = indent($0); job = $0; sub(/^ +/, "", job); sub(/:.*$/, "", job); svc = 0; tmo = 0; next }
    on && job != "" && indent($0) == jind + 2 && /^ *services:/ { svc = 1 }
    on && job != "" && indent($0) == jind + 2 && /^ *timeout-minutes:[ \t]*[0-9]+/ { t = $0; sub(/^ *timeout-minutes:[ \t]*/, "", t); tmo = t + 0 }
    END { flush() }
  ' "$wf" >> "$T/jobs"
done
JOBS=$(jq -R -s -c '[split("\n")[] | select(length > 0) | split("\t") | {key: .[0], value: {services: (.[1] == "1"), timeout: (.[2] | tonumber)}}] | from_entries' < "$T/jobs")
SLOW=$(printf '%s' "$MAP" | jq -c --argjson jobs "$JOBS" '
  [.entries[] | . as $e
   | ($e.command | ascii_downcase | [scan("e2e|playwright|cypress|integration|docker")] | first) as $w
   | ($jobs[$e.source] // null) as $j
   | (if $w then "command names \($w)"
      elif $j and $j.services then "CI job \($e.source) uses services"
      elif $j and $j.timeout >= 20 then "CI job \($e.source) sets timeout-minutes \($j.timeout)"
      else null end) as $why
   | select($why) | {command: $e.command, source: $e.source, why: $why}]')

# ---- layer rules: workspace packages and their edges at HEAD (structure-delta.sh definitions) ----
{
  at_head package.json | jq -r '(.workspaces // empty) | if type == "array" then .[] elif type == "object" then (.packages // [])[] else empty end | strings' 2>/dev/null
  at_head pnpm-workspace.yaml | awk '
    /^packages:/ { on = 1; next }
    on && /^[^ \t#-]/ { on = 0 }
    on && /^[ \t]*-[ \t]*/ { sub(/^[ \t]*-[ \t]*/, ""); sub(/[ \t]+#.*$/, ""); gsub(/["\047]/, ""); sub(/[ \t]+$/, ""); if ($0 != "") print }'
} | sed 's#^\./##; s#/$##' | sort -u > "$T/globs"
to_re() { printf '%s' "$1" | sed 's/[.+^$()|{}[]/\\&/g; s/\*\*/%%/g; s/\*/[^\/]*/g; s/%%/.*/g; s/?/[^\/]/g'; }
: > "$T/inc"; : > "$T/exc"; : > "$T/names"; : > "$T/deps"
while IFS= read -r g; do
  case "$g" in \!*) echo "^$(to_re "${g#!}")\$" >> "$T/exc" ;; *) echo "^$(to_re "$g")\$" >> "$T/inc" ;; esac
done < "$T/globs"
if [ -s "$T/inc" ]; then
  grep -E '/package\.json$' "$T/files" | grep -v -E '(^|/)node_modules/' | while IFS= read -r m; do
    d=${m%/package.json}
    grep -qE -f "$T/inc" <<<"$d" || continue
    if [ -s "$T/exc" ] && grep -qE -f "$T/exc" <<<"$d"; then continue; fi
    at_head "$m" > "$T/pj" || continue
    n=$(jq -r '.name // empty | strings' "$T/pj" 2>/dev/null)
    [ -n "$n" ] || continue
    printf '%s\t%s\t%s\n' "$d" "$m" "$n" >> "$T/names"
    jq -r --arg m "$m" '["dependencies","devDependencies","peerDependencies"][] as $k | (.[$k] // {}) | objects | keys[] | [$m, $k, .] | @tsv' "$T/pj" 2>/dev/null >> "$T/deps"
  done
fi
PACKAGES=$(jq -R -s -c '[split("\n")[] | select(length > 0) | split("\t") | {name: .[2], dir: .[0]}] | sort_by(.name)' < "$T/names")
EDGES=$(awk -F'\t' '
  FILENAME == ARGV[1] { name[$2] = $3; ws[$3] = 1; next }
  ($3 in ws) && ($1 in name) && name[$1] != $3 { print name[$1] "\t" $3 "\t" $2 "\t" $1 }
' "$T/names" "$T/deps" | sort -u | jq -R -s -c '[split("\n")[] | select(length > 0) | split("\t") | {from: .[0], to: .[1], kind: .[2], manifest: .[3]}]')
: > "$T/bfiles"
while IFS= read -r f; do
  case "${f##*/}" in
    .eslintrc|.eslintrc.*|eslint.config.*|.dependency-cruiser.*|nx.json|project.json)
      # here-string, not `at_head | grep -q`: under pipefail an early grep exit SIGPIPEs at_head and reads as no match (#4298)
      c=$(at_head "$f"); grep -qE 'boundaries|forbidden|depConstraints|DependOnLibsWithTags|no-restricted-paths' <<<"$c" && printf '%s\n' "$f" >> "$T/bfiles" ;;
  esac
done < "$T/files"
BOUNDARY=$(jq -R -s -c 'split("\n") | map(select(length > 0))' < "$T/bfiles")

# ---- hotspots (reuses #4195 facts) ----
# hotspots.sh with no paths reports its config; only files over file_lines can be hotspots, so only those are passed
HOT='[]'
FL=$(bash "$HERE/hotspots.sh" 2>/dev/null | jq -r 'select(.enabled) | .file_lines' 2>/dev/null)
if [ -s "$T/files" ] && [ -n "$FL" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    n=$(wc -l < "$f" | tr -d ' '); [ "$n" -gt "$FL" ] && printf '%s\n' "$f"
  done < "$T/files" > "$T/big"
  H=""; [ -s "$T/big" ] && { H=$(tr '\n' '\0' < "$T/big" | xargs -0 -n 200 bash "$HERE/hotspots.sh" -- 2>/dev/null) || H=""; }
  HOT=$(printf '%s' "$H" | jq -s -c '[.[].files[]? | select(.over and (.excluded | not)) | {path, lines, commits_90d, hotspot}] | sort_by(-.hotspot, .path) | .[:20]' 2>/dev/null) || HOT='[]'
  [ -n "$HOT" ] || HOT='[]'
fi

FACTS=$(jq -n -c --argjson tc "$TOOLCHAIN" --argjson slow "$SLOW" --argjson pk "$PACKAGES" --argjson ed "$EDGES" --argjson bc "$BOUNDARY" --argjson hot "$HOT" \
  '{version: 1, toolchain: $tc, slow_suites: $slow, layer_rules: {packages: $pk, edges: $ed, boundary_configs: $bc}, hotspots: $hot}') || die "jq failed"

if [ "$STDOUT" = 1 ]; then printf '%s\n' "$FACTS"; exit 0; fi
[ -n "$OUT" ] || OUT=".forge/repo-facts.json"
mkdir -p "$(dirname "$OUT")" || die "cannot create $(dirname "$OUT")"
printf '%s\n' "$FACTS" > "$OUT.tmp.$$" && mv "$OUT.tmp.$$" "$OUT" || die "cannot write $OUT"
echo "$OUT"
