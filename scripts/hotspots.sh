#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# hotspots.sh — deterministic size and churn facts for named files (forge#4195). No LLM, no network: git + wc + jq,
# yq (optional) only to read forge.yaml. Run from the repo root.
#
# Usage: hotspots.sh [--base <ref>] [--] <path>...
# Config: forge.yaml maintenance.hotspot {enabled, file_lines, growth_lines, exclude_globs}; defaults true/2000/150/[]
#   (also when forge.yaml or yq is missing).
# Output (stdout, one JSON object):
#   {"enabled","file_lines","growth_lines","files":[{path,lines,commits_90d,hotspot,over,excluded,base_lines,growth}]}
# lines = `wc -l` of the working-tree file (0 when missing); commits_90d = `git rev-list --count --since=90.days HEAD`;
# hotspot = lines × commits_90d; over = lines > file_lines; excluded = linguist-generated / linguist-vendored set by
# .gitattributes, or a match of an exclude_glob (shell pattern, `*` crosses `/`). Without --base no blob is read and
# base_lines/growth are null; with --base they are the line count at git merge-base(<ref>, HEAD) (0 when absent there)
# and lines - base_lines. enabled:false prints files:[] and does no per-file work.
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
CFG='{}'
if [ -f forge.yaml ] && command -v yq >/dev/null 2>&1; then
  c=$(yq -o=json '.maintenance.hotspot // {}' forge.yaml 2>/dev/null) || c=""
  printf '%s' "$c" | jq -e 'type == "object"' >/dev/null 2>&1 && CFG="$c"
fi
CFG=$(printf '%s' "$CFG" | jq -c '
  def pos($d): if type == "number" and . > 0 then floor else $d end;
  { enabled: (.enabled != false), file_lines: (.file_lines | pos(2000)), growth_lines: (.growth_lines | pos(150)),
    exclude_globs: ([(.exclude_globs // [])[]? | strings]) }')
ENABLED=$(printf '%s' "$CFG" | jq -r '.enabled')
FILE_LINES=$(printf '%s' "$CFG" | jq -r '.file_lines')
GROWTH_LINES=$(printf '%s' "$CFG" | jq -r '.growth_lines')
head_json() { printf '%s' "$CFG" | jq -c --argjson files "$1" '{enabled, file_lines, growth_lines, files: $files}'; }
[ "$ENABLED" = true ] || { head_json '[]'; exit 0; }

MB=""
if [ -n "$BASE" ]; then
  git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "bad base ref: $BASE"
  MB=$(git merge-base "$BASE" HEAD) || die "no merge base for $BASE and HEAD"
fi
HAS_HEAD=0; git rev-parse --verify -q "HEAD^{commit}" >/dev/null && HAS_HEAD=1
GLOBS=$(printf '%s' "$CFG" | jq -r '.exclude_globs[]')

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
  excluded=false
  if git check-attr linguist-generated linguist-vendored -- "$p" 2>/dev/null | grep -qE ': (set|true)$'; then excluded=true; fi
  if [ "$excluded" = false ] && [ -n "$GLOBS" ]; then
    while IFS= read -r g; do
      [ -n "$g" ] || continue
      # shellcheck disable=SC2254
      case "$p" in $g) excluded=true; break ;; esac
    done <<EOF
$GLOBS
EOF
  fi
  base_lines=null; growth=null
  if [ -n "$MB" ]; then
    base_lines=0
    git cat-file -e "$MB:$p" 2>/dev/null && base_lines=$(git show "$MB:$p" | wc -l | tr -d ' ')
    growth=$((lines - base_lines))
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$lines" "$commits" "$excluded" "$base_lines" "$growth" >> "$T/rows"
done

FILES=$(jq -R -s -c --argjson fl "$FILE_LINES" '
  [split("\n")[] | select(length > 0) | split("\t") |
   { path: .[0], lines: (.[1] | tonumber), commits_90d: (.[2] | tonumber) } as $r |
   $r + { hotspot: ($r.lines * $r.commits_90d), over: ($r.lines > $fl), excluded: (.[3] == "true"),
          base_lines: (.[4] | fromjson), growth: (.[5] | fromjson) }]' < "$T/rows")
head_json "$FILES"
