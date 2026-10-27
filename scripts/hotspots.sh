#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# hotspots.sh — deterministic size and churn facts for named files (forge#4195). No LLM, no network: git + wc + jq,
# yq (optional) only to read forge.yaml. Run from the repo root.
#
# Usage: hotspots.sh [--base <ref>] [--] <path>...
# Config: forge.yaml maintenance.hotspot {enabled, file_lines, growth_lines, exclude_globs}; defaults true/2000/150/[] (lockfiles are always excluded)
#   (also when forge.yaml or yq is missing); maintenance.generated_paths (forge#4519): shell globs of generated,
#   bot-owned files, default [].
# Output (stdout, one JSON object):
#   {"enabled","file_lines","growth_lines","generated_paths",
#    "files":[{path,lines,commits_90d,hotspot,over,generated,excluded,base_lines,growth}]}
# lines = `wc -l` of the working-tree file (0 when missing); commits_90d = `git rev-list --count --since=90.days HEAD`;
# hotspot = lines × commits_90d; over = lines > file_lines; generated = linguist-generated set by .gitattributes, a
# match of a generated_paths glob, or `@generated` / `DO NOT EDIT` in the first 5 lines of the working-tree file;
# excluded = generated, linguist-vendored, or a match of an exclude_glob (shell pattern, `*` crosses `/`). Without --base no blob is read and
# base_lines/growth are null; with --base they are the line count at git merge-base(<ref>, HEAD) (0 when absent there)
# and lines - base_lines. enabled:false prints files:[] (generated_paths still set) and does no per-file work.
# Exit: 0 ok | 2 usage or bad ref. bash 3.2 portable.
set -uo pipefail

die() { echo "hotspots: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"
BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] && [ -n "$2" ] || die "usage: hotspots.sh [--base <ref>] [--] <path>..."; BASE="$2"; shift 2 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *) break ;;
  esac
done

# ---- config: maintenance.hotspot as JSON, {} when unreadable ----
CFG='{}'; GEN_CFG='[]'
if [ -f forge.yaml ] && command -v yq >/dev/null 2>&1; then
  c=$(yq -o=json '.maintenance.hotspot // {}' forge.yaml 2>/dev/null) || c=""
  printf '%s' "$c" | jq -e 'type == "object"' >/dev/null 2>&1 && CFG="$c"
  g=$(yq -o=json '.maintenance.generated_paths // []' forge.yaml 2>/dev/null) || g=""
  printf '%s' "$g" | jq -e 'type == "array"' >/dev/null 2>&1 && GEN_CFG="$g"
fi
GEN_CFG=$(printf '%s' "$GEN_CFG" | jq -c '[.[] | strings | select(length > 0)]')
CFG=$(printf '%s' "$CFG" | jq -c '
  def pos($d): if type == "number" and . > 0 then floor else $d end;
  { enabled: (.enabled != false), file_lines: (.file_lines | pos(2000)), growth_lines: (.growth_lines | pos(150)),
    exclude_globs: ([(.exclude_globs // [])[]? | strings]) }')
ENABLED=$(printf '%s' "$CFG" | jq -r '.enabled')
FILE_LINES=$(printf '%s' "$CFG" | jq -r '.file_lines')
head_json() { printf '%s' "$CFG" | jq -c --argjson files "$1" --argjson gen "$GEN_CFG" '{enabled, file_lines, growth_lines, generated_paths: $gen, files: $files}'; }
[ "$ENABLED" = true ] || { head_json '[]'; exit 0; }

MB=""
if [ -n "$BASE" ]; then
  git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "bad base ref: $BASE"
  MB=$(git merge-base "$BASE" HEAD) || die "no merge base for $BASE and HEAD"
fi
HAS_HEAD=0; git rev-parse --verify -q "HEAD^{commit}" >/dev/null && HAS_HEAD=1
# #4685: lockfiles are never hotspots (one dependency adds hundreds of lines); configured globs come on top
LOCKFILE_GLOBS='package-lock.json
*/package-lock.json
yarn.lock
*/yarn.lock
pnpm-lock.yaml
*/pnpm-lock.yaml
bun.lockb
*/bun.lockb
Cargo.lock
*/Cargo.lock
poetry.lock
*/poetry.lock
uv.lock
*/uv.lock
go.sum
*/go.sum
Gemfile.lock
*/Gemfile.lock
composer.lock
*/composer.lock'
GLOBS=$(printf '%s\n%s' "$LOCKFILE_GLOBS" "$(printf '%s' "$CFG" | jq -r '.exclude_globs[]')")
GEN_GLOBS=$(printf '%s' "$GEN_CFG" | jq -r '.[]')
# 0 when $1 matches a newline-separated list of shell patterns in $2 (`*` crosses `/`)
glob_hit() {
  [ -n "$2" ] || return 1
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254
    case "$1" in $g) return 0 ;; esac
  done <<EOF
$2
EOF
  return 1
}

T=$(mktemp -d "${TMPDIR:-/tmp}/hotspots.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$T"' EXIT
: > "$T/rows"
# one history walk per file, 8 at a time: wall time is the slowest batch, not the sum
i=0
for p in "$@"; do
  i=$((i+1))
  [ "$HAS_HEAD" = 1 ] && [ -n "${p#./}" ] && { git rev-list --count --since=90.days HEAD -- "${p#./}" > "$T/c.$i" 2>/dev/null & }
  [ $((i % 8)) -eq 0 ] && wait
done
wait
i=0
for p in "$@"; do
  i=$((i+1))
  p=${p#./}
  [ -n "$p" ] || continue
  lines=0; [ -f "$p" ] && lines=$(wc -l < "$p" | tr -d ' ')
  commits=$(cat "$T/c.$i" 2>/dev/null); case "$commits" in ''|*[!0-9]*) commits=0 ;; esac
  generated=false; excluded=false
  if git check-attr linguist-generated -- "$p" 2>/dev/null | grep -qE ': (set|true)$' || glob_hit "$p" "$GEN_GLOBS" \
    || { [ -f "$p" ] && head -n 5 "$p" 2>/dev/null | grep -qE '@generated|DO NOT EDIT'; }; then generated=true; excluded=true; fi
  if [ "$excluded" = false ] && git check-attr linguist-vendored -- "$p" 2>/dev/null | grep -qE ': (set|true)$'; then excluded=true; fi
  if [ "$excluded" = false ] && glob_hit "$p" "$GLOBS"; then excluded=true; fi
  base_lines=null; growth=null
  if [ -n "$MB" ]; then
    base_lines=0
    git cat-file -e "$MB:$p" 2>/dev/null && base_lines=$(git show "$MB:$p" | wc -l | tr -d ' ')
    growth=$((lines - base_lines))
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$lines" "$commits" "$excluded" "$base_lines" "$growth" "$generated" >> "$T/rows"
done

FILES=$(jq -R -s -c --argjson fl "$FILE_LINES" '
  [split("\n")[] | select(length > 0) | split("\t") |
   { path: .[0], lines: (.[1] | tonumber), commits_90d: (.[2] | tonumber) } as $r |
   $r + { hotspot: ($r.lines * $r.commits_90d), over: ($r.lines > $fl), generated: (.[6] == "true"), excluded: (.[3] == "true"),
          base_lines: (.[4] | fromjson), growth: (.[5] | fromjson) }]' < "$T/rows")
head_json "$FILES"
