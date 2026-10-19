#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# milestone-drift.sh — deterministic structural drift of a milestone branch since its fork point (forge#4161). No LLM,
# no network: git + jq + awk, plus `jscpd` only when it is on PATH. Run from inside the repo (fetch the refs first).
#
# Usage: milestone-drift.sh <slug> [--base <ref>] [--head <ref>] [--summary FILE] [--top N] [--format json|text]
#                           [--pair-growth N] [--package-lines N] [--file-lines N]
#   --base     default origin/<forge.yaml branches.staging, else staging> (the local branch when origin/ is absent)
#   --head     default origin/milestone/<slug> (the local branch when origin/ is absent)
#   --summary  the orchestrate FORGE:DRIFT summary JSON (bin/lean/drift.mjs); adds the PRs behind each import pair
#   thresholds default to the forge.yaml `orchestrate:` block (`drift:` keys pair_growth, package_lines, file_lines);
#   none set means `crossings: []`. A value crosses when it is greater than its threshold.
# Facts, from the fork point F = git merge-base base head to head:
#   pairs       import-pair growth per from->to (files_added - files_removed), one scripts/structure-delta.sh F head run
#   new_edges   workspace package dependency edges added (same run)
#   files       top-N files by line growth (added - removed), one `git diff --numstat F head`; linguist-generated /
#               linguist-vendored paths (.gitattributes at head) and forge.yaml `orchestrate.generated_globs`
#               (comma-separated shell patterns, `*` crosses `/`) are excluded and listed in `excluded`
#   packages    top-N workspace packages by line growth (longest package dir prefix); [] without workspaces
#   duplication jscpd statistics over the changed files when jscpd is installed and head is checked out, else null
# Output: one JSON object {milestone,base,head,fork_point,pairs,new_edges,files,packages,excluded,duplication,
#   thresholds,crossings[{kind:pair_growth|package_lines|file_lines,key,value,threshold,package_path}]}, or with
#   --format text a short report of the same facts.
# Exit: 0 ok | 2 usage or bad ref. bash 3.2 portable.
set -uo pipefail

die() { echo "milestone-drift: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SLUG="" BASE="" HEAD="" SUMMARY="" TOP=10 FORMAT=json PAIR_T="" PKG_T="" FILE_T=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD="${2:-}"; shift 2 ;;
    --summary) SUMMARY="${2:-}"; shift 2 ;;
    --top) TOP="${2:-}"; shift 2 ;;
    --format) FORMAT="${2:-}"; shift 2 ;;
    --pair-growth) PAIR_T="${2:-}"; shift 2 ;;
    --package-lines) PKG_T="${2:-}"; shift 2 ;;
    --file-lines) FILE_T="${2:-}"; shift 2 ;;
    -h|--help) sed -n '5,27p' "$0"; exit 0 ;;
    -*) die "unknown argument: $1" ;;
    *) [ -z "$SLUG" ] || die "one slug only"; SLUG="$1"; shift ;;
  esac
done
SLUG="${SLUG#milestone/}"
[ -n "$SLUG" ] || die "usage: milestone-drift.sh <slug> [--base <ref>] [--head <ref>] [--summary FILE] [--format json|text]"
case "$FORMAT" in json|text) ;; *) die "--format must be json or text" ;; esac
case "$TOP" in ''|*[!0-9]*) die "--top must be a positive integer" ;; esac

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
cd "$ROOT" || die "cannot cd to $ROOT"

# forge.yaml: key under a top-level block (any depth below it), block form only
yaml_key() { # block key
  [ -f forge.yaml ] || return 0
  awk -v b="$1" -v k="$2" '
    /^[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(#.*)?$/ { on = ($0 ~ "^" b ":"); next }
    /^[^[:space:]#]/ { on = 0 }
    on && $0 ~ "^[[:space:]]+" k ":" { sub("^[[:space:]]+" k ":[[:space:]]*", ""); sub("[[:space:]]*#.*$", ""); gsub(/["\047]/, ""); print; exit }
  ' forge.yaml
}
[ -n "$PAIR_T" ] || PAIR_T=$(yaml_key orchestrate pair_growth)
[ -n "$PKG_T" ] || PKG_T=$(yaml_key orchestrate package_lines)
[ -n "$FILE_T" ] || FILE_T=$(yaml_key orchestrate file_lines)
GLOBS=$(yaml_key orchestrate generated_globs)
for v in "$PAIR_T" "$PKG_T" "$FILE_T"; do case "$v" in ''|*[!0-9]*) [ -z "$v" ] || die "thresholds must be positive integers" ;; esac; done

ref_or_local() { # origin/<b> when it resolves, else <b>
  if git rev-parse --verify -q "origin/$1^{commit}" >/dev/null; then echo "origin/$1"; else echo "$1"; fi
}
if [ -z "$BASE" ]; then s=$(yaml_key branches staging); BASE=$(ref_or_local "${s:-staging}"); fi
[ -n "$HEAD" ] || HEAD=$(ref_or_local "milestone/$SLUG")
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "bad base ref: $BASE"
git rev-parse --verify -q "$HEAD^{commit}" >/dev/null || die "bad head ref: $HEAD"
HEAD_SHA=$(git rev-parse "$HEAD^{commit}")
FORK=$(git merge-base "$BASE" "$HEAD") || die "no merge base for $BASE and $HEAD"
if [ -n "$SUMMARY" ]; then jq -e 'type == "object"' "$SUMMARY" >/dev/null 2>&1 || die "--summary must be a JSON object"; fi

T=$(mktemp -d "${TMPDIR:-/tmp}/milestone-drift.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$T"' EXIT
TAB="$(printf '\t')"

# ---- pairs and edges: the existing structure delta from the fork point ----
SD=$("$SCRIPT_DIR/structure-delta.sh" "$FORK" "$HEAD_SHA" 2>/dev/null) || SD='{}'
printf '%s' "$SD" | jq -e 'type == "object"' >/dev/null 2>&1 || SD='{}'
printf '%s' "$SD" > "$T/sd.json"
if [ -n "$SUMMARY" ]; then cp "$SUMMARY" "$T/summary.json"; else echo '{}' > "$T/summary.json"; fi

# ---- workspace package dirs at head: "dir<TAB>name", longest dir first ----
{
  git show "$HEAD_SHA:package.json" 2>/dev/null | jq -r '(.workspaces // empty) | if type == "array" then .[] elif type == "object" then (.packages // [])[] else empty end | strings' 2>/dev/null
  git show "$HEAD_SHA:pnpm-workspace.yaml" 2>/dev/null | awk '
    /^packages:/ { on = 1; next }
    on && /^[^ \t#-]/ { on = 0 }
    on && /^[ \t]*-[ \t]*/ { sub(/^[ \t]*-[ \t]*/, ""); sub(/[ \t]+#.*$/, ""); gsub(/["\047]/, ""); sub(/[ \t]+$/, ""); if ($0 != "") print }'
} | sed 's#^\./##; s#/$##' | sort -u > "$T/globs"
to_re() { printf '%s' "$1" | sed 's/[.+^$()|{}[]/\\&/g; s/\*\*/%%/g; s/\*/[^\/]*/g; s/%%/.*/g; s/?/[^\/]/g'; }
: > "$T/inc"; : > "$T/exc"; : > "$T/dirs"
while IFS= read -r g; do
  case "$g" in \!*) echo "^$(to_re "${g#!}")\$" >> "$T/exc" ;; *) echo "^$(to_re "$g")\$" >> "$T/inc" ;; esac
done < "$T/globs"
if [ -s "$T/inc" ]; then
  git ls-tree -r --name-only "$HEAD_SHA" | grep -E '/package\.json$' | grep -vE '(^|/)node_modules/' | while IFS= read -r m; do
    d=${m%/package.json}
    printf '%s\n' "$d" | grep -qE -f "$T/inc" || continue
    if [ -s "$T/exc" ] && printf '%s\n' "$d" | grep -qE -f "$T/exc"; then continue; fi
    n=$(git show "$HEAD_SHA:$m" 2>/dev/null | jq -r '.name // empty | strings' 2>/dev/null)
    [ -n "$n" ] && printf '%s\t%s\t%s\n' "${#d}" "$d" "$n"
  done | sort -t "$TAB" -k1,1nr | cut -f2- > "$T/dirs"
fi

# ---- size growth: one numstat, generated/vendored excluded ----
git diff --numstat --no-renames "$FORK" "$HEAD_SHA" 2>/dev/null | awk -F'\t' 'NF >= 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/' > "$T/numstat"
cut -f3 "$T/numstat" > "$T/paths"
: > "$T/excluded"
if [ -s "$T/paths" ]; then
  # attributes as of head (--source); a git without it reads the working tree's .gitattributes
  { git check-attr --source="$HEAD_SHA" --stdin linguist-generated linguist-vendored < "$T/paths" 2>/dev/null \
      || git check-attr --stdin linguist-generated linguist-vendored < "$T/paths"; } \
    | awk -F': ' '$3 == "set" || $3 == "true" { print $1 }' >> "$T/excluded"
  if [ -n "$GLOBS" ]; then
    while IFS= read -r p; do
      oldifs=$IFS; IFS=,
      for g in $GLOBS; do
        g=$(printf '%s' "$g" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
        [ -n "$g" ] || continue
        # shellcheck disable=SC2254 # the glob is the pattern
        case "$p" in $g) echo "$p" >> "$T/excluded"; break ;; esac
      done
      IFS=$oldifs
    done < "$T/paths"
  fi
fi
sort -u "$T/excluded" -o "$T/excluded"
# kept rows: "path<TAB>added<TAB>removed<TAB>package-dir<TAB>package-name"
awk -F'\t' '
  FILENAME == ARGV[1] { ex[$0] = 1; next }
  FILENAME == ARGV[2] { nd++; dir[nd] = $1; nm[nd] = $2; next }
  ($3 in ex) { next }
  { d = ""; n = ""; for (i = 1; i <= nd; i++) if (index($3, dir[i] "/") == 1) { d = dir[i]; n = nm[i]; break }
    print $3 "\t" $1 "\t" $2 "\t" d "\t" n }
' "$T/excluded" "$T/dirs" "$T/numstat" > "$T/kept"

jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {path: .[0], added: (.[1] | tonumber), removed: (.[2] | tonumber), pkg_dir: .[3], pkg: .[4]})' "$T/kept" > "$T/kept.json"
jq -R -s -c 'split("\n") | map(select(length > 0))' "$T/excluded" > "$T/excluded.json"
jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {path: .[0], name: .[1]})' "$T/dirs" > "$T/dirs.json"

# ---- duplication: the repo's own jscpd, only when installed and head is the working tree ----
DUP=null
if command -v jscpd >/dev/null 2>&1 && [ "$(git rev-parse HEAD 2>/dev/null)" = "$HEAD_SHA" ] && [ -s "$T/kept" ]; then
  cut -f1 "$T/kept" | while IFS= read -r p; do [ -f "$p" ] && printf '%s\0' "$p"; done > "$T/dupfiles"
  if [ -s "$T/dupfiles" ]; then
    xargs -0 jscpd --silent --reporters json --output "$T/jscpd" < "$T/dupfiles" >/dev/null 2>&1
    if [ -f "$T/jscpd/jscpd-report.json" ]; then
      DUP=$(jq -c '(.statistics.total // {}) | {clones: (.clones // 0), duplicated_lines: (.duplicatedLines // 0), percentage: (.percentage // 0)}' "$T/jscpd/jscpd-report.json" 2>/dev/null) || DUP=null
      [ -n "$DUP" ] || DUP=null
    fi
  fi
fi

num_or_null() { if [ -n "$1" ]; then printf '%s' "$1"; else printf 'null'; fi; }
REPORT=$(jq -n -c \
  --arg milestone "$SLUG" --arg base "$BASE" --arg head "$HEAD" --arg fork "$FORK" --argjson top "$TOP" \
  --slurpfile sd "$T/sd.json" --slurpfile summary "$T/summary.json" --slurpfile kept "$T/kept.json" \
  --slurpfile excluded "$T/excluded.json" --slurpfile dirs "$T/dirs.json" --argjson dup "$DUP" \
  --argjson pt "$(num_or_null "$PAIR_T")" --argjson kt "$(num_or_null "$PKG_T")" --argjson ft "$(num_or_null "$FILE_T")" '
  ($sd[0]) as $sd | ($summary[0]) as $sum | ($kept[0]) as $kept | ($dirs[0]) as $dirs
  | ($dirs | map({key: .name, value: .path}) | from_entries) as $dirOf
  | [($sd.import_pairs // [])[]
      | {from, to, growth: ((.files_added // 0) - (.files_removed // 0)), files_added: (.files_added // 0),
         files_removed: (.files_removed // 0), files: (.files // []),
         prs: (($sum.pairs // {})["\(.from):\(.to)"].prs // [])}]
    | sort_by(-.growth, .from, .to) as $pairs
  | [$kept[] | {path, added, removed, growth: (.added - .removed), package: (if .pkg == "" then null else .pkg end)}]
    | sort_by(-.growth, .path) as $files
  | [$kept[] | select(.pkg != "")] | group_by(.pkg)
    | map({name: .[0].pkg, path: .[0].pkg_dir, added: (map(.added) | add), removed: (map(.removed) | add)} | .growth = (.added - .removed))
    | sort_by(-.growth, .name) as $packages
  | {milestone: $milestone, base: $base, head: $head, fork_point: $fork,
     pairs: $pairs, new_edges: ($sd.package_edges_added // []),
     files: $files[:$top], packages: $packages[:$top], excluded: $excluded[0], duplication: $dup,
     thresholds: {pair_growth: $pt, package_lines: $kt, file_lines: $ft},
     crossings: (
       (if $pt == null then [] else [$pairs[] | select(.growth > $pt)
          | {kind: "pair_growth", key: "\(.from)->\(.to)", value: .growth, threshold: $pt, package_path: ($dirOf[.from] // null)}] end)
       + (if $kt == null then [] else [$packages[] | select(.growth > $kt)
          | {kind: "package_lines", key: .name, value: .growth, threshold: $kt, package_path: .path}] end)
       + (if $ft == null then [] else [$files[] | select(.growth > $ft)
          | {kind: "file_lines", key: .path, value: .growth, threshold: $ft, package_path: (if .package == null then null else $dirOf[.package] end)}] end))}
') || die "report failed"

if [ "$FORMAT" = json ]; then printf '%s\n' "$REPORT"; exit 0; fi
printf '%s' "$REPORT" | jq -r '
  def line(f): if length == 0 then "  (none)" else map("  " + f) | join("\n") end;
  "milestone/\(.milestone) drift since \(.fork_point[:12]) (base \(.base), head \(.head))",
  "import pairs (net files):", (.pairs | line("\(.from) -> \(.to)  +\(.growth)\(if (.prs | length) > 0 then "  PRs " + (.prs | map("#\(.)") | join(", ")) else "" end)")),
  "new package edges:", (.new_edges | line("\(.from) -> \(.to)  (\(.kind), \(.manifest))")),
  "top files by growth:", (.files | line("\(.path)  +\(.added) -\(.removed)")),
  "top packages by growth:", (.packages | line("\(.name) (\(.path))  +\(.added) -\(.removed)")),
  "excluded (generated/vendored): \(.excluded | length)",
  (if .duplication == null then "duplication: n/a (jscpd not run)" else "duplication: \(.duplication.clones) clones, \(.duplication.duplicated_lines) lines (\(.duplication.percentage)%)" end),
  (if (.crossings | length) == 0 then "thresholds: none crossed" else "thresholds crossed:", (.crossings | line("\(.kind) \(.key): \(.value) > \(.threshold)")) end)'
