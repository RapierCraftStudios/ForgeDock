#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# structure-delta.sh — deterministic cross-package structure facts for one change (forge#4159). No LLM, no network:
# git + jq only. Run from the repo root.
#
# Usage: structure-delta.sh <base>...<head> | <base> <head>      (the old side is git merge-base base head)
# Output (stdout, one JSON object):
#   {} when the repo declares no workspace packages (root package.json `workspaces` / pnpm-workspace.yaml), else
#   {"package_edges_added":[{from,to,kind,manifest}], "package_edges_removed":[...],
#    "import_pairs":[{from,to,files_added,files_removed}],
#    "boundary_config_changed":{changed,files[],loosens,tightens}}
# A package edge is a dependencies/devDependencies/peerDependencies key naming another workspace package. An import
# pair counts changed non-test source files whose added (removed) lines quote an exact workspace name, optionally with
# a subpath ('@s/x' or '@s/x/sub'); `import type` / `export type` lines are ignored. Counts only report.
# Exit: 0 ok | 2 usage or bad ref. bash 3.2 portable.
set -uo pipefail

die() { echo "structure-delta: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"
case "${1:-}" in
  *...*) BASE="${1%%...*}"; HEAD="${1#*...}" ;;
  "") die "usage: structure-delta.sh <base>...<head>" ;;
  *) BASE="$1"; HEAD="${2:-}" ;;
esac
[ -n "$BASE" ] && [ -n "$HEAD" ] || die "usage: structure-delta.sh <base>...<head>"
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "bad base ref: $BASE"
git rev-parse --verify -q "$HEAD^{commit}" >/dev/null || die "bad head ref: $HEAD"
OLD=$(git merge-base "$BASE" "$HEAD") || die "no merge base for $BASE and $HEAD"
NEW=$(git rev-parse "$HEAD^{commit}")

T=$(mktemp -d "${TMPDIR:-/tmp}/structure-delta.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$T"' EXIT

# ---- workspace globs, from the repo only ----
for ref in "$OLD" "$NEW"; do
  git show "$ref:package.json" 2>/dev/null | jq -r '(.workspaces // empty) | if type == "array" then .[] elif type == "object" then (.packages // [])[] else empty end | strings' 2>/dev/null
  git show "$ref:pnpm-workspace.yaml" 2>/dev/null | awk '
    /^packages:/ { on = 1; next }
    on && /^[^ \t#-]/ { on = 0 }
    on && /^[ \t]*-[ \t]*/ { sub(/^[ \t]*-[ \t]*/, ""); sub(/[ \t]+#.*$/, ""); gsub(/["\047]/, ""); sub(/[ \t]+$/, ""); if ($0 != "") print }'
done | sed 's#^\./##; s#/$##' | sort -u > "$T/globs"
[ -s "$T/globs" ] || { echo '{}'; exit 0; }

# glob -> anchored ERE (`**` any depth, `*` one segment); `!glob` excludes
to_re() { printf '%s' "$1" | sed 's/[.+^$()|{}[]/\\&/g; s/\*\*/%%/g; s/\*/[^\/]*/g; s/%%/.*/g; s/?/[^\/]/g'; }
: > "$T/inc"; : > "$T/exc"
while IFS= read -r g; do
  case "$g" in \!*) echo "^$(to_re "${g#!}")\$" >> "$T/exc" ;; *) echo "^$(to_re "$g")\$" >> "$T/inc" ;; esac
done < "$T/globs"

# ---- workspace manifests at each ref: lines "ref<TAB>dir<TAB>manifest" ----
: > "$T/manifests"
for side in old new; do
  ref=$OLD; [ "$side" = new ] && ref=$NEW
  git ls-tree -r --name-only "$ref" | grep -E '/package\.json$' | grep -v '(^|/)node_modules/' | while IFS= read -r m; do
    d=${m%/package.json}
    printf '%s\n' "$d" | grep -qE -f "$T/inc" || continue
    if [ -s "$T/exc" ] && printf '%s\n' "$d" | grep -qE -f "$T/exc"; then continue; fi
    printf '%s\t%s\t%s\n' "$side" "$d" "$m"
  done >> "$T/manifests"
done

# ---- names and deps: lines "side<TAB>dir<TAB>manifest<TAB>name" and "side<TAB>manifest<TAB>kind<TAB>dep" ----
: > "$T/names"; : > "$T/deps"
while IFS="$(printf '\t')" read -r side d m; do
  ref=$OLD; [ "$side" = new ] && ref=$NEW
  git show "$ref:$m" 2>/dev/null > "$T/pj" || continue
  n=$(jq -r '.name // empty | strings' "$T/pj" 2>/dev/null) || continue
  [ -n "$n" ] || continue
  printf '%s\t%s\t%s\t%s\n' "$side" "$d" "$m" "$n" >> "$T/names"
  jq -r --arg s "$side" --arg m "$m" '["dependencies","devDependencies","peerDependencies"][] as $k | (.[$k] // {}) | objects | keys[] | [$s, $m, $k, .] | @tsv' "$T/pj" 2>/dev/null >> "$T/deps"
done < "$T/manifests"
[ -s "$T/names" ] || { echo '{}'; exit 0; }
cut -f4 "$T/names" | sort -u > "$T/wsnames"

# ---- package edges: "manifest<TAB>from<TAB>to<TAB>kind" per side, then set difference ----
for side in old new; do
  awk -F'\t' -v s="$side" '
    FILENAME == ARGV[1] { ws[$1] = 1; next }
    FILENAME == ARGV[2] { if ($1 == s) name[$3] = $4; next }
    $1 == s && ($4 in ws) && ($2 in name) && name[$2] != $4 { print $2 "\t" name[$2] "\t" $4 "\t" $3 }
  ' "$T/wsnames" "$T/names" "$T/deps" | sort -u > "$T/edges.$side"
done
edges_json() { jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {from: .[1], to: .[2], kind: .[3], manifest: .[0]})'; }
ADDED=$(comm -13 "$T/edges.old" "$T/edges.new" | edges_json)
REMOVED=$(comm -23 "$T/edges.old" "$T/edges.new" | edges_json)

# ---- import pairs: one -U0 diff pass over source files ----
# workspace dirs (both sides, longest first) for "which package owns this file"
cut -f2,4 "$T/names" | sort -u | awk -F'\t' '{ print length($1) "\t" $0 }' | sort -t"$(printf '\t')" -k1,1nr | cut -f2- > "$T/dirs"
git diff -U0 --no-color --no-renames --no-ext-diff "$OLD" "$NEW" -- \
  '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs' '*.mts' '*.cts' '*.vue' '*.svelte' '*.astro' 2>/dev/null > "$T/diff"
IMPORTS=$(awk -F'\t' '
  FILENAME == ARGV[1] { nd++; dir[nd] = $1; own[nd] = $2; next }
  FILENAME == ARGV[2] { nw++; ws[nw] = $1; next }
  function owner(f,   i) { for (i = 1; i <= nd; i++) if (index(f, dir[i] "/") == 1) return own[i]; return "" }
  function istest(f) { return f ~ /(^|\/)(test|tests|__tests__|spec|specs)\// || f ~ /\.(test|spec)\.[A-Za-z0-9]+$/ }
  # true when line quotes exactly name n: a quote, n, then a closing quote of the same kind or a "/" subpath
  function quotes(line, n,   q, qi, rest, p, nx) {
    for (qi = 1; qi <= 2; qi++) {
      q = (qi == 1) ? "\"" : "\047"; rest = line
      while ((p = index(rest, q n)) > 0) {
        nx = substr(rest, p + 1 + length(n), 1)
        if (nx == q || nx == "/") return 1
        rest = substr(rest, p + 1)
      }
    }
    return 0
  }
  /^diff --git / { f = $0; sub(/^diff --git a\/.* b\//, "", f); from = owner(f); skip = (from == "" || istest(f)); hdr = 1; next }
  /^@@/ { hdr = 0; next }
  hdr { next }
  /^[+-]/ {
    if (skip) next
    s = substr($0, 1, 1); l = substr($0, 2)
    if (l ~ /^[ \t]*(import|export)[ \t]+type([ \t{]|$)/) next
    for (i = 1; i <= nw; i++) if (ws[i] != from && quotes(l, ws[i])) hit[f SUBSEP ws[i] SUBSEP s] = 1
    fromof[f] = from
  }
  END {
    for (k in hit) {
      split(k, a, SUBSEP); f = a[1]; to = a[2]; s = a[3]
      if (s == "+" && !((f SUBSEP to SUBSEP "-") in hit)) add[fromof[f] SUBSEP to]++
      if (s == "-" && !((f SUBSEP to SUBSEP "+") in hit)) rem[fromof[f] SUBSEP to]++
    }
    for (k in add) pair[k] = 1
    for (k in rem) pair[k] = 1
    for (k in pair) { split(k, a, SUBSEP); print a[1] "\t" a[2] "\t" (add[k] + 0) "\t" (rem[k] + 0) }
  }
' "$T/dirs" "$T/wsnames" "$T/diff" | sort | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {from: .[0], to: .[1], files_added: (.[2] | tonumber), files_removed: (.[3] | tonumber)})')

# ---- boundary config (eslint-plugin-boundaries, dependency-cruiser, Nx depConstraints) ----
: > "$T/bfiles"; LOOSE=false; TIGHT=false
git diff --name-only --no-renames "$OLD" "$NEW" | while IFS= read -r f; do
  case "${f##*/}" in .eslintrc|.eslintrc.*|eslint.config.*|.dependency-cruiser.*|nx.json|project.json) printf '%s\n' "$f" ;; esac
done > "$T/bcand"
while IFS= read -r f; do
  git diff -U0 --no-color --no-renames "$OLD" "$NEW" -- "$f" | grep -E '^[+-][^+-]' > "$T/bd" || true
  grep -qE 'boundaries|allow|disallow|forbidden|depConstraints|DependOnLibsWithTags' "$T/bd" || continue
  printf '%s\n' "$f" >> "$T/bfiles"
  if grep -E '^\+' "$T/bd" | grep -iv 'disallow' | grep -qE 'allow|onlyDependOnLibsWithTags.*\*'; then LOOSE=true; fi
  if grep -E '^-' "$T/bd" | grep -iv 'disallow' | grep -qE 'allow'; then TIGHT=true; fi
  if grep -E '^\+' "$T/bd" | grep -qE 'disallow|forbidden|notDependOnLibsWithTags'; then TIGHT=true; fi
done < "$T/bcand"
BFILES=$(jq -R -s -c 'split("\n") | map(select(length > 0))' < "$T/bfiles")

jq -n -c --argjson a "$ADDED" --argjson r "$REMOVED" --argjson i "$IMPORTS" --argjson b "$BFILES" --argjson lo "$LOOSE" --argjson ti "$TIGHT" \
  '{package_edges_added: $a, package_edges_removed: $r, import_pairs: $i, boundary_config_changed: {changed: ($b | length > 0), files: $b, loosens: $lo, tightens: $ti}}'
