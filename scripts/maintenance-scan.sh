#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# maintenance-scan.sh — deterministic health signals → maintenance issue candidates (forge#4197). No LLM: git, jq,
# wc and awk, plus the repo's own dead-code tools when installed. Run from inside the repo.
#
# Usage: maintenance-scan.sh [--repo owner/repo] [--file-lines N] [--commits-days D] [--doc-kb K]
#                            [--open-issues FILE] [--out-dir DIR] [--print-issue-args]
# Findings (one candidate each, labels `maintenance` + the kind):
#   refactor:split  tracked file over --file-lines lines (default forge.yaml maintenance.file_lines, else 2000) with
#                   commits in the last D days (default 90); linguist-generated/-vendored and vendored dirs excluded
#   refactor        a workspace package dependency both ways (A->B and B->A), from scripts/structure-delta.sh
#   dead-code       vulture / knip / ts-prune on PATH (and relevant to the repo) reporting findings, one per tool
#   docs            tracked *.md over --doc-kb KB (default forge.yaml maintenance.doc_kb, else 64)
# Dedup: a candidate is dropped when an open issue body carries its `<!-- FORGE:MAINT:<kind>:<key> -->` marker, or its
# title is a near-duplicate (scripts/issue-dedup.sh) of an open issue naming the same key. --open-issues FILE (JSON array
# of {number,title,body}) replaces the one `gh issue list` call; it then matches markers and exact titles only.
# Output: a JSON array of {kind,key,title,labels,body_file,marker,numbers}, `[]` when everything is under threshold.
# Body files (with one FORGE:BODY-INTEGRITY marker, per /issue's programmatic contract) go to --out-dir (default a
# mktemp dir under $TMPDIR). --print-issue-args prints one `/issue --title ... --body-file ... --label ...` line per
# candidate instead, for `Skill(skill="{FORGE_SKILL_PREFIX}issue", args=<line>)`.
# Exit: 0 ok | 2 usage, not a git repo, or open issues unreadable. bash 3.2 portable.
set -uo pipefail

die() { echo "maintenance-scan: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO="" FILE_LINES="" DAYS=90 DOC_KB="" OPEN_FILE="" OUT_DIR="" PRINT_ARGS=false
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --file-lines) FILE_LINES="${2:-}"; shift 2 ;;
    --commits-days) DAYS="${2:-}"; shift 2 ;;
    --doc-kb) DOC_KB="${2:-}"; shift 2 ;;
    --open-issues) OPEN_FILE="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --print-issue-args) PRINT_ARGS=true; shift ;;
    -h|--help) sed -n '5,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
cd "$ROOT" || die "cannot cd to $ROOT"

# forge.yaml `maintenance:` block (block form only, like bin/forge-utils.mjs parseForgeYaml): direct children only, so
# a sub-map's keys (`  hotspot:` → `    file_lines:`, forge#4195) never stand in for the section's own
yaml_maint() {
  [ -f forge.yaml ] || return 0
  awk -v k="$1" '
    /^[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(#.*)?$/ { on = ($0 ~ /^maintenance:/); ci = -1; next }
    /^[^[:space:]#]/ { on = 0 }
    on && /^[[:space:]]*(#|$)/ { next }
    on { match($0, /^[[:space:]]*/); if (ci >= 0 && RLENGTH > ci) next; ci = RLENGTH }
    on && $0 ~ "^[[:space:]]+" k ":" { sub("^[[:space:]]+" k ":[[:space:]]*", ""); sub("[[:space:]]*#.*$", ""); gsub(/"/, ""); print; exit }
  ' forge.yaml
}
[ -n "$FILE_LINES" ] || FILE_LINES=$(yaml_maint file_lines)
[ -n "$DOC_KB" ] || DOC_KB=$(yaml_maint doc_kb)
FILE_LINES=${FILE_LINES:-2000} DOC_KB=${DOC_KB:-64}
for v in "$FILE_LINES" "$DAYS" "$DOC_KB"; do case "$v" in ''|*[!0-9]*) die "thresholds must be positive integers" ;; esac; done

T=$(mktemp -d "${TMPDIR:-/tmp}/maintenance-scan.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$T"' EXIT
if [ -z "$OUT_DIR" ]; then OUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/maintenance-scan-out.XXXXXX") || die "mktemp failed"; fi
mkdir -p "$OUT_DIR" || die "cannot create $OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)

# ---- open issues, once ----
if [ -n "$OPEN_FILE" ]; then
  jq -e 'type == "array"' "$OPEN_FILE" >/dev/null 2>&1 || die "--open-issues must be a JSON array"
  cp "$OPEN_FILE" "$T/open.json"
else
  gh issue list ${REPO:+-R "$REPO"} --state open --limit 1000 --json number,title,body > "$T/open.json" 2>/dev/null || die "cannot list open issues (gh)"
fi

# ---- tracked files, minus generated/vendored ----
git ls-files > "$T/all"
git check-attr --stdin linguist-generated linguist-vendored < "$T/all" \
  | awk -F': ' '$3 == "set" || $3 == "true" { print $1 }' | sort -u > "$T/excluded"
grep -vE '(^|/)(node_modules|vendor|third_party|dist|build)/' "$T/all" | sort | comm -23 - "$T/excluded" > "$T/files"

# candidates: "kind<TAB>key<TAB>title<TAB>numbers-json<TAB>evidence"
: > "$T/cands"
add() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$T/cands"; }

# ---- hotspots: over-threshold files with commits in the window ----
git log --since="$DAYS days ago" --format= --name-only 2>/dev/null | awk 'NF' | sort | uniq -c \
  | awk '{ n = $1; sub(/^ *[0-9]+ /, ""); print $0 "\t" n }' > "$T/churn"
tr '\n' '\0' < "$T/files" | xargs -0 wc -l 2>/dev/null \
  | awk -v max="$FILE_LINES" '{ n = $1; p = $0; sub(/^ *[0-9]+ /, "", p); if (n > max && p != "total") print p "\t" n }' > "$T/big"
while IFS="$(printf '\t')" read -r path lines; do
  [ -f "$path" ] || continue
  grep -Iq . "$path" 2>/dev/null || continue # binary
  commits=$(awk -F'\t' -v p="$path" '$1 == p { print $2; exit }' "$T/churn")
  [ -n "$commits" ] && [ "$commits" -gt 0 ] || continue
  add "refactor:split" "$path" "split $path ($lines loc, $commits commits/${DAYS}d)" \
    "{\"lines\":$lines,\"commits\":$commits,\"days\":$DAYS,\"threshold\":$FILE_LINES}" \
    "\`$path\` has $lines lines (budget $FILE_LINES) and $commits commits in the last $DAYS days."
done < "$T/big"

# ---- backwards edges: workspace packages depending on each other both ways ----
if git show HEAD:package.json 2>/dev/null | jq -e '.workspaces' >/dev/null 2>&1 || git cat-file -e HEAD:pnpm-workspace.yaml 2>/dev/null; then
  first=$(git rev-list --max-parents=0 HEAD | tail -1)
  if sd=$("$SCRIPT_DIR/structure-delta.sh" "$first" HEAD 2>/dev/null); then
    printf '%s' "$sd" | jq -r '[(.package_edges_added // [])[] | [.from, .to]] | unique as $e
      | $e[] | . as $p | select($p[0] < $p[1] and ($e | index([[$p[1], $p[0]]])) != null) | "\($p[0])\t\($p[1])"' 2>/dev/null \
      | while IFS="$(printf '\t')" read -r a b; do
          add "refactor" "$a->$b" "untangle $a <-> $b (pkg cycle)" "{\"edges\":2}" \
            "Workspace package \`$a\` depends on \`$b\` and \`$b\` depends on \`$a\`."
        done
  fi
fi

# ---- dead code: the repo's own tools, only when installed and relevant ----
count_lines() { awk 'NF' | wc -l | tr -d ' '; }
dead() { # tool, count
  [ "$2" -gt 0 ] 2>/dev/null || return 0
  add "dead-code" "$1" "remove $2 unused ($1)" "{\"findings\":$2}" "\`$1\` reports $2 unused items."
}
if command -v vulture >/dev/null 2>&1 && grep -q '\.py$' "$T/files"; then
  dead vulture "$(grep '\.py$' "$T/files" | tr '\n' '\0' | xargs -0 vulture 2>/dev/null | count_lines)"
fi
if [ -f package.json ]; then
  command -v knip >/dev/null 2>&1 && dead knip "$(knip --no-progress --reporter compact 2>/dev/null | count_lines)"
  command -v ts-prune >/dev/null 2>&1 && dead ts-prune "$(ts-prune 2>/dev/null | grep -v '(used in module)' | count_lines)"
fi

# ---- oversized docs ----
grep -E '\.md$' "$T/files" | tr '\n' '\0' | xargs -0 wc -c 2>/dev/null \
  | awk -v max="$((DOC_KB * 1024))" '{ n = $1; p = $0; sub(/^ *[0-9]+ /, "", p); if (n > max && p != "total") print p "\t" n }' \
  | while IFS="$(printf '\t')" read -r path bytes; do
      kb=$(( (bytes + 1023) / 1024 ))
      add "docs" "$path" "trim $path ($kb KB > $DOC_KB KB)" "{\"kb\":$kb,\"threshold_kb\":$DOC_KB}" \
        "\`$path\` is $kb KB; agents load docs under $DOC_KB KB whole."
    done

# ---- dedup, body files, output ----
slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80; }
title_dup() { # title, key: an open near-duplicate title that names the same key
  if [ -n "$OPEN_FILE" ]; then
    jq -e --arg t "$1" 'any(.[]; .title == $t)' "$T/open.json" >/dev/null
  else
    local hit
    hit=$("$SCRIPT_DIR/issue-dedup.sh" "$1" ${REPO:+-R "$REPO"} 2>/dev/null) && return 1
    case "$hit" in *"$2"*) return 0 ;; *) return 1 ;; esac
  fi
}
: > "$T/out.jsonl"
sort -t "$(printf '\t')" -k1,1 -k2,2 -u "$T/cands" | while IFS="$(printf '\t')" read -r kind key title numbers evidence; do
  marker="FORGE:MAINT:$kind:$key"
  jq -e --arg m "<!-- $marker -->" 'any(.[]; (.body // "") | contains($m))' "$T/open.json" >/dev/null && continue
  title_dup "$title" "$key" && continue
  id="maint_$(slug "$kind")_$(printf '%s' "$kind:$key" | cksum | awk '{print $1}')"
  body="$OUT_DIR/${id}_$(slug "${key%.md}").md"
  cat > "$body" <<EOF
## Problem

$evidence Found by \`scripts/maintenance-scan.sh\`; it is dispatched within the maintenance budget (forge.yaml \`maintenance.share\`).

## Evidence

\`\`\`json
$numbers
\`\`\`

## Acceptance Criteria

- [ ] \`scripts/maintenance-scan.sh\` no longer reports \`$kind\` for \`$key\`
- [ ] Behaviour is unchanged (existing tests pass)

<!-- $marker -->
<!-- FORGE:BODY-INTEGRITY:$id -->
EOF
  jq -n -c --arg kind "$kind" --arg key "$key" --arg title "$title" --arg body "$body" --arg marker "$marker" --argjson numbers "$numbers" \
    '{kind: $kind, key: $key, title: $title, labels: ["maintenance", $kind], body_file: $body, marker: $marker, numbers: $numbers}' >> "$T/out.jsonl"
done

if [ "$PRINT_ARGS" = true ]; then
  jq -r '"/issue --title \"" + (.title | gsub("\""; "\\\"")) + "\" --body-file \"" + .body_file + "\" --label maintenance --label " + .kind' "$T/out.jsonl"
else
  jq -s -c '.' "$T/out.jsonl"
fi
