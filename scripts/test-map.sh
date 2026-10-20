#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# test-map.sh — deterministic `file glob → check command` map for a repo (forge#4272). No LLM, no network, runs none of
# the repo's commands: git + jq + awk only (no yq). Codebase-agnostic: node, python, go, make and CI workflow steps.
#
# Usage: test-map.sh [--repo-path DIR] [--output FILE | --stdout]
#   default output <repo>/.forge/test-map.json, rewritten on every run (a regenerable cache; deleting it restores the
#   pre-PR step's `learned.test_commands` behaviour).
# Output: {"version":1,"entries":[{"globs":[...],"command","cwd","source"}]}, sorted by source then command; entries
#   with the same (command, cwd) are merged (globs unioned, first source kept).
# Sources:
#   package.json (root + every tracked one outside node_modules): scripts test/lint/typecheck/type-check/check →
#     `<pm> run <script>` in the package dir (pm from the root lockfile), JS/TS globs under that dir
#   pytest (pyproject [tool.pytest*], pytest.ini, setup.cfg [tool:pytest], conftest.py) and ruff config → `pytest`,
#     `ruff check .` (through `uv run` / `poetry run` when that lockfile exists), `**/*.py`
#   go.mod (dir D) → `go test ./...`, `go vet ./...` in D, `D/**/*.go`, `D/go.mod`, `D/go.sum`
#   Makefile / GNUmakefile targets test/lint/check/typecheck/vet → `make <target>`, `**`
#   .github/workflows/*.yml|*.yaml `run:` steps (one command per line of a `|` block, a `>` block is one command;
#     install/setup lines skipped): globs
#     from the tool (python/go/shell/js), else the workflow's `paths:` filter, else `**`
# Exit: 0 ok | 2 usage or bad repo path. bash 3.2 portable.
set -uo pipefail

die() { echo "test-map: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"
REPO="."; OUT=""; STDOUT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) [ $# -ge 2 ] && [ -n "$2" ] || die "usage: test-map.sh [--repo-path DIR] [--output FILE | --stdout]"; REPO="$2"; shift 2 ;;
    --output) [ $# -ge 2 ] && [ -n "$2" ] || die "usage: test-map.sh [--repo-path DIR] [--output FILE | --stdout]"; OUT="$2"; shift 2 ;;
    --stdout) STDOUT=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -d "$REPO" ] || die "repo path not found: $REPO"
case "$OUT" in ""|/*) ;; *) OUT="$PWD/$OUT" ;; esac
cd "$REPO" || die "cannot enter $REPO"

T=$(mktemp -d "${TMPDIR:-/tmp}/test-map.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$T"' EXIT
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files --cached --others --exclude-standard > "$T/files"
else
  find . -type f -not -path './.git/*' | sed 's|^\./||' | sort > "$T/files"
fi
: > "$T/rows"
# row: source TAB cwd TAB command TAB space-separated globs
row() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$T/rows"; }
JS_EXT="js jsx ts tsx mjs cjs"
# globs for the extensions in $2 under dir $1 ("." = repo root)
ext_globs() {
  g=""; pre=""; [ "$1" = "." ] || pre="$1/"
  for e in $2; do g="$g ${pre}**/*.$e"; done
  printf '%s' "${g# }"
}

# ---- package.json scripts ----
PM=npm
[ -f yarn.lock ] && PM=yarn
[ -f pnpm-lock.yaml ] && PM=pnpm
grep -E '(^|/)package\.json$' "$T/files" | grep -v -E '(^|/)node_modules/' | sort | while IFS= read -r pj; do
  [ -f "$pj" ] || continue
  d=$(dirname "$pj")
  globs="$(ext_globs "$d" "$JS_EXT") $pj"
  tag=""
  if [ -n "$(ls "$d"/vitest.config.* "$d"/jest.config.* 2>/dev/null)" ] || jq -e 'has("jest")' "$pj" >/dev/null 2>&1; then tag=" (vitest/jest config)"; fi
  jq -r '(.scripts // {}) | to_entries[] | select(.value | type == "string") | .key' "$pj" 2>/dev/null | while IFS= read -r s; do
    case "$s" in
      test) row "$pj#scripts.$s$tag" "$d" "$PM run $s" "$globs" ;;
      lint|typecheck|type-check|check) row "$pj#scripts.$s" "$d" "$PM run $s" "$globs" ;;
    esac
  done
done

# ---- python ----
RUN=""
[ -f poetry.lock ] && RUN="poetry run "
[ -f uv.lock ] && RUN="uv run "
PY_SRC=""
if [ -f pyproject.toml ] && grep -qE '^\[tool\.pytest' pyproject.toml; then PY_SRC="pyproject.toml#tool.pytest"
elif [ -f pytest.ini ]; then PY_SRC="pytest.ini"
elif [ -f setup.cfg ] && grep -qE '^\[tool:pytest\]' setup.cfg; then PY_SRC="setup.cfg#tool:pytest"
elif grep -qE '(^|/)conftest\.py$' "$T/files"; then PY_SRC="conftest.py"; fi
[ -n "$PY_SRC" ] && row "$PY_SRC" "." "${RUN}pytest" "**/*.py **/conftest.py"
RUFF_SRC=""
if [ -f pyproject.toml ] && grep -qE '^\[tool\.ruff' pyproject.toml; then RUFF_SRC="pyproject.toml#tool.ruff"
elif [ -f ruff.toml ]; then RUFF_SRC="ruff.toml"
elif [ -f .ruff.toml ]; then RUFF_SRC=".ruff.toml"; fi
[ -n "$RUFF_SRC" ] && row "$RUFF_SRC" "." "${RUN}ruff check ." "**/*.py"

# ---- go ----
grep -E '(^|/)go\.mod$' "$T/files" | grep -v -E '(^|/)vendor/' | sort | while IFS= read -r gm; do
  d=$(dirname "$gm"); pre=""; [ "$d" = "." ] || pre="$d/"
  globs="${pre}**/*.go ${pre}go.mod ${pre}go.sum"
  row "$gm" "$d" "go test ./..." "$globs"
  row "$gm" "$d" "go vet ./..." "$globs"
done

# ---- Makefile ----
for mf in Makefile GNUmakefile; do
  [ -f "$mf" ] || continue
  grep -oE '^(test|lint|check|typecheck|vet)[[:space:]]*:' "$mf" | sed -E 's/[[:space:]]*:$//' | sort -u | while IFS= read -r t; do
    row "$mf#$t" "." "make $t" "**"
  done
done

# ---- CI workflow run: steps ----
# Emits: job TAB command, one per command line; and P TAB path for each `paths:` filter item before `jobs:`.
wf_extract() {
  awk '
    function indent(s) { match(s, /^ */); return RLENGTH }
    function unq(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); if (s ~ /^".*"$/ || s ~ /^\x27.*\x27$/) s = substr(s, 2, length(s) - 2); return s }
    function emit(c) { c = unq(c); if (c != "") print job "\t" c }
    BEGIN { injobs = 0; jind = -1; block = 0; inpaths = 0; job = "" }
    {
      line = $0; sub(/\r$/, "", line)
      if (block) {
        if (line ~ /^[ \t]*$/) next
        if (indent(line) > bind) {
          l = line; sub(/^ +/, "", l)
          if (fold) { pend = (pend == "" ? l : pend " " l); next }
          if (pend != "") { l = pend " " l; pend = "" }
          if (l ~ /\\$/) { pend = substr(l, 1, length(l) - 1); sub(/[ \t]+$/, "", pend); next }
          emit(l); next
        }
        if (pend != "") { emit(pend); pend = "" }
        block = 0
      }
      if (line ~ /^jobs:[ \t]*$/) { injobs = 1; inpaths = 0; next }
      if (!injobs) {
        if (line ~ /^[ \t]*paths:[ \t]*$/) { inpaths = 1; pind = indent(line); next }
        if (inpaths) {
          if (line ~ /^[ \t]*-[ \t]/ && indent(line) >= pind) { p = line; sub(/^[ \t]*-[ \t]*/, "", p); sub(/[ \t]+#.*$/, "", p); print "P\t" unq(p); next }
          if (line !~ /^[ \t]*$/ && line !~ /^[ \t]*#/) inpaths = 0
        }
        next
      }
      if (line ~ /^[^ \t#]/) { injobs = 0; next }
      if (line ~ /^ +[A-Za-z0-9_-]+:[ \t]*$/ && (jind < 0 || indent(line) == jind)) { jind = indent(line); job = line; sub(/^ +/, "", job); sub(/:.*$/, "", job); next }
      if (line ~ /^[ \t]*(-[ \t]+)?run:/) {
        rest = line; sub(/^[ \t]*(-[ \t]+)?run:[ \t]*/, "", rest); sub(/[ \t]+#.*$/, "", rest)
        if (rest ~ /^[|>][-+0-9]*$/) { block = 1; pend = ""; fold = (rest ~ /^>/); bind = indent(line); if (line ~ /^[ \t]*-[ \t]/) bind = bind + 1; next }
        emit(rest)
      }
    }
    END { if (block && pend != "") emit(pend) }
  ' "$1"
}
skip_cmd() {
  case "$1" in
    \#*|echo\ *|echo|cd\ *|export\ *|set\ *|if\ *|then|fi|else|for\ *|do|done|\}*|\{*|*'$GITHUB_'*|*'>> $GITHUB'*) return 0 ;;
    npm\ ci*|npm\ install*|npm\ i|npm\ i\ *|pnpm\ install*|pnpm\ i|yarn|yarn\ install*|pip\ install*|pip3\ install*|python*\ -m\ pip\ install*|uv\ sync*|uv\ pip\ install*|poetry\ install*|go\ mod\ download*|apt-get*|sudo\ *|corepack\ *|brew\ *) return 0 ;;
  esac
  return 1
}
tool_globs() {
  c=" $1 "
  case "$c" in
    *[\ /]ruff\ *|*[\ /]flake8\ *|*[\ /]pylint\ *|*[\ /]mypy\ *|*[\ /]black\ *|*[\ /]pytest\ *) printf '**/*.py'; return ;;
    *[\ /]golangci-lint\ *|*[\ /]gofmt\ *|*[\ /]staticcheck\ *|*\ go\ *) printf '**/*.go'; return ;;
    *[\ /]shellcheck\ *|*\ bash\ *.sh\ *|*\ sh\ *.sh\ *) printf '**/*.sh'; return ;;
    *[\ /]eslint\ *|*[\ /]tsc\ *|*[\ /]prettier\ *|*[\ /]vitest\ *|*[\ /]jest\ *|*\ node\ --test*|*\ npm\ *|*\ pnpm\ *|*\ yarn\ *|*\ npx\ *) ext_globs . "$JS_EXT"; return ;;
  esac
  printf ''
}
grep -E '^\.github/workflows/[^/]+\.(yml|yaml)$' "$T/files" | sort | while IFS= read -r wf; do
  [ -f "$wf" ] || continue
  wf_extract "$wf" > "$T/wf"
  paths=$(awk -F'\t' '$1 == "P" { printf "%s ", $2 }' "$T/wf"); paths=${paths% }
  awk -F'\t' '$1 != "P"' "$T/wf" | while IFS="$(printf '\t')" read -r job cmd; do
    skip_cmd "$cmd" && continue
    g=$(tool_globs "$cmd")
    [ -n "$g" ] || g="$paths"
    [ -n "$g" ] || g="**"
    row "$wf#jobs.$job" "." "$cmd" "$g"
  done
done

MAP=$(jq -R -s -c '
  [split("\n")[] | select(length > 0) | split("\t") | {source: .[0], cwd: .[1], command: .[2], globs: (.[3] | split(" ") | map(select(length > 0)))}]
  | sort_by(.source, .command)
  | reduce .[] as $e ({order: [], by: {}};
      ([$e.command, $e.cwd] | tojson) as $k
      | if .by[$k] then .by[$k].globs += ($e.globs - .by[$k].globs)
        else .order += [$k] | .by[$k] = {globs: $e.globs, command: $e.command, cwd: $e.cwd, source: $e.source} end)
  | {version: 1, entries: [.by[.order[]]]}' < "$T/rows") || die "jq failed"

if [ "$STDOUT" = 1 ]; then printf '%s\n' "$MAP"; exit 0; fi
[ -n "$OUT" ] || OUT=".forge/test-map.json"
mkdir -p "$(dirname "$OUT")" || die "cannot create $(dirname "$OUT")"
printf '%s\n' "$MAP" > "$OUT.tmp.$$" && mv "$OUT.tmp.$$" "$OUT" || die "cannot write $OUT"
echo "$OUT"
