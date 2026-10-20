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
#     install/setup lines skipped). The engine runs these commands before a PR, so a step is mapped only when its whole
#     command is an allowlisted check (forge#4300): `<pm> test`, `<pm> run <package.json check script>` (also `test:*`
#     style names, `pnpm -r`, `npm --prefix DIR`), `make <check target>`, `go test|vet|build`, `cargo test|clippy|check`,
#     gradle/maven with check tasks/goals only, `[bundle exec] rspec`, `python manage.py test`, `python -m unittest`,
#     `tox`/`nox` (not a publish/release/deploy/upload env), `deno|bun test`, `bash|sh <path>.test.sh` or a known
#     test/lint/typecheck tool (forge#4315); everything else is dropped, and job and step names are never consulted. One leading `cd DIR &&` / `pushd DIR &&` becomes the entry cwd; any other chaining,
#     substitution or `${{ }}` drops the step. Globs from the tool (python/go/shell/js, under the cwd), else the
#     workflow's `paths:` filter, else `DIR/**` for a cwd; a workflow entry never gets a bare `**`.
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
  # -z and quotepath=off (#4298): non-ASCII and spaced paths come out verbatim, never C-quoted
  git -c core.quotepath=off ls-files -z --cached --others --exclude-standard | tr '\0' '\n' > "$T/files"
else
  find . -type f -not -path './.git/*' | sed 's|^\./||' | sort > "$T/files"
fi
: > "$T/rows"
# row: source TAB cwd TAB command TAB globs separated by US (\037, #4298: a glob may contain spaces)
US="$(printf '\037')"
row() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$T/rows"; }
JS_EXT="js jsx ts tsx mjs cjs"
# check recognisers shared by package.json scripts / Makefile targets and the workflow allowlist (forge#4300)
PKG_SCRIPTS="test|lint|typecheck|type-check|check|tsc"
MAKE_TARGETS="test|lint|check|typecheck|vet"
# forge#4315: `test:unit`, `lint:css` ... are the same check under a sub-name
# (#4314: only a closed set of suffixes; fixers `lint:fix`, watchers, e2e/integration (need services), deploy-ish and
# snapshot-updating scripts never run pre-PR.) $2 (optional) is the script's command: `format` is a check only when
# that command is a check form.
PKG_DENY='fix|watch|write|update|dev|serve|start|e2e|integration|deploy|release|publish|snapshot|-u'
PKG_SUFFIXES="unit ci node types type ts js static check"
pkg_check_script() {
  [ -n "${1:-}" ] || return 1
  case "$1" in *[!A-Za-z0-9:_.-]*) return 1 ;; esac
  b=${1%%:*}
  case "|$PKG_SCRIPTS|" in *"|$b|"*) ;; *) return 1 ;; esac
  [ "$b" = "$1" ] && return 0
  printf '%s' "$1" | grep -qiE "$PKG_DENY" && return 1
  rest=${1#*:}; [ -n "$rest" ] || return 1
  oldifs=$IFS; IFS=:; set -f
  for seg in $rest; do
    ok=0
    case " $PKG_SUFFIXES " in *" $seg "*) [ -n "$seg" ] && ok=1 ;; esac
    if [ "$ok" = 0 ] && [ "$seg" = format ]; then
      case " ${2:-} " in *" --check "*|*" -c "*|*" --list-different "*|*" -l "*) ok=1 ;; esac
    fi
    [ "$ok" = 1 ] || { IFS=$oldifs; set +f; return 1; }
  done
  IFS=$oldifs; set +f
  return 0
}
make_check_target() { case "|$MAKE_TARGETS|" in *"|$1|"*) [ -n "$1" ] ;; *) return 1 ;; esac; }
safe_dir() { case "$1" in ""|/*|*[!A-Za-z0-9._/-]*|..|../*|*/..|*/../*) return 1 ;; esac; return 0; }
# globs for the extensions in $2 under dir $1 ("." = repo root)
ext_globs() {
  g=""; pre=""; [ "$1" = "." ] || pre="$1/"
  for e in $2; do g="$g$US${pre}**/*.$e"; done
  printf '%s' "${g#"$US"}"
}

# ---- package.json scripts ----
PM=npm
[ -f yarn.lock ] && PM=yarn
[ -f pnpm-lock.yaml ] && PM=pnpm
grep -E '(^|/)package\.json$' "$T/files" | grep -v -E '(^|/)node_modules/' | sort | while IFS= read -r pj; do
  [ -f "$pj" ] || continue
  d=$(dirname "$pj")
  globs="$(ext_globs "$d" "$JS_EXT")$US$pj"
  tag=""
  if [ -n "$(ls "$d"/vitest.config.* "$d"/jest.config.* 2>/dev/null)" ] || jq -e 'has("jest")' "$pj" >/dev/null 2>&1; then tag=" (vitest/jest config)"; fi
  jq -r '(.scripts // {}) | to_entries[] | select(.value | type == "string") | .key + "\t" + .value' "$pj" 2>/dev/null | while IFS="$(printf '\t')" read -r s sv; do
    case "$s" in
      test) row "$pj#scripts.$s$tag" "$d" "$PM run $s" "$globs" ;;
      *) pkg_check_script "$s" "$sv" && row "$pj#scripts.$s" "$d" "$PM run $s" "$globs" ;;
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
[ -n "$PY_SRC" ] && row "$PY_SRC" "." "${RUN}pytest" "**/*.py$US**/conftest.py"
RUFF_SRC=""
if [ -f pyproject.toml ] && grep -qE '^\[tool\.ruff' pyproject.toml; then RUFF_SRC="pyproject.toml#tool.ruff"
elif [ -f ruff.toml ]; then RUFF_SRC="ruff.toml"
elif [ -f .ruff.toml ]; then RUFF_SRC=".ruff.toml"; fi
[ -n "$RUFF_SRC" ] && row "$RUFF_SRC" "." "${RUN}ruff check ." "**/*.py"

# ---- go ----
grep -E '(^|/)go\.mod$' "$T/files" | grep -v -E '(^|/)vendor/' | sort | while IFS= read -r gm; do
  d=$(dirname "$gm"); pre=""; [ "$d" = "." ] || pre="$d/"
  globs="${pre}**/*.go$US${pre}go.mod$US${pre}go.sum"
  row "$gm" "$d" "go test ./..." "$globs"
  row "$gm" "$d" "go vet ./..." "$globs"
done

# ---- Makefile ----
for mf in Makefile GNUmakefile; do
  [ -f "$mf" ] || continue
  grep -oE "^($MAKE_TARGETS)[[:space:]]*:" "$mf" | sed -E 's/[[:space:]]*:$//' | sort -u | while IFS= read -r t; do
    row "$mf#$t" "." "make $t" "**"
  done
done

# ---- CI workflow run: steps ----
# Emits: job US command (US = \037), one per command line; and P TAB path for each `paths:` filter item
# before `jobs:`. A block ends at the first non-blank line not indented past the `run` key (sibling keys such as env:).
wf_extract() {
  awk '
    function indent(s) { match(s, /^ */); return RLENGTH }
    function unq(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); if (s ~ /^".*"$/ || s ~ /^\x27.*\x27$/) s = substr(s, 2, length(s) - 2); return s }
    function emit(c) { c = unq(c); if (c != "") print job "\037" c }
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
        # bind = the column of the `run` key: step keys after it (env:, shell:) sit there and end the block
        if (rest ~ /^[|>][-+0-9]*$/) { block = 1; pend = ""; fold = (rest ~ /^>/); bind = match(line, /run:/) - 1; next }
        emit(rest)
      }
    }
    END { if (block && pend != "") emit(pend) }
  ' "$1"
}
skip_cmd() {
  # shellcheck disable=SC2016 # literal $GITHUB_ patterns
  case "$1" in
    \#*|echo\ *|echo|cd\ *|export\ *|set\ *|if\ *|then|fi|else|for\ *|do|done|\}*|\{*|*'$GITHUB_'*|*'>> $GITHUB'*) return 0 ;;
    npm\ ci*|npm\ install*|npm\ i|npm\ i\ *|pnpm\ install*|pnpm\ i|yarn|yarn\ install*|pip\ install*|pip3\ install*|python*\ -m\ pip\ install*|uv\ sync*|uv\ pip\ install*|poetry\ install*|go\ mod\ download*|apt-get*|sudo\ *|corepack\ *|brew\ *) return 0 ;;
  esac
  return 1
}
# forge#4300: allowlist. 0 when the whole command $1 is a recognised check; sets CK_CWD (one leading `cd|pushd DIR &&`,
# else ".") and CK_CMD (the command without that prefix). Names never matter: a mutating command is dropped whatever its
# step is called, and a check is mapped whatever it is called.
check_cmd() {
  c=$1; CK_CWD=.; CK_CMD=
  # shellcheck disable=SC2016 # literal ${{ and $( patterns
  case "$c" in *'${{'*|*'`'*|*'$('*) return 1 ;; esac
  case "$c" in
    "cd "*" && "*|"pushd "*" && "*)
      d=${c#* }; d=${d%%" && "*}; c=${c#*" && "}
      case "$d" in ""|/*|*[!A-Za-z0-9._/-]*|..|../*|*/..|*/../*) return 1 ;; esac
      d=${d%/}; [ -n "$d" ] && [ "$d" != . ] && CK_CWD=$d ;;
  esac
  c=${c%" && popd"}
  case "$c" in *';'*|*'|'*|*'&'*) return 1 ;; esac
  CK_CMD=$c
  set -f
  # shellcheck disable=SC2086 # split into words on purpose; set -f stops glob expansion
  set -- $c
  set +f
  while [ $# -gt 0 ]; do case "$1" in [A-Za-z_]*=*) shift ;; *) break ;; esac; done
  case "${1:-} ${2:-}" in
    "uv run"|"poetry run"|"pnpm exec"|"yarn exec"|"python -m"|"python3 -m"|"bundle exec") shift 2 ;;
    "npx "*|"bunx "*) shift ;;
  esac
  case "${1:-}" in
    npm|pnpm|yarn|bun)
      pm=$1; shift
      case "$pm ${1:-}" in # forge#4315: pnpm -r test, npm --prefix DIR test
        "pnpm -r"|"pnpm --recursive") shift ;;
        "npm --prefix") [ $# -ge 2 ] && safe_dir "$2" || return 1; shift 2 ;;
      esac
      [ "${1:-}" = test ] && return 0
      [ "${1:-}" = run ] && pkg_check_script "${2:-}" && return 0
      case "$pm" in yarn|pnpm) pkg_check_script "${1:-}" && return 0 ;; esac
      return 1 ;;
    cargo) case "${2:-}" in test|clippy|check) return 0 ;; esac; return 1 ;;
    ./gradlew|gradlew|gradle|./mvnw|mvnw|mvn)
      # every non-flag word is a check task/goal (`:mod:test` qualified for gradle); publish/deploy/install never pass
      case "$1" in *mvn*) goals="test|verify|validate" ;; *) goals="test|check|lint" ;; esac
      shift; nt=0
      for w in "$@"; do
        case "$w" in -*) continue ;; esac
        t=${w##*:}
        case "|$goals|" in *"|$t|"*) [ -n "$t" ] && nt=$((nt+1)) ;; *) return 1 ;; esac
      done
      [ "$nt" -gt 0 ]; return ;;
    rspec|unittest) return 0 ;;
    python|python3) [ "${2:-}" = manage.py ] && [ "${3:-}" = test ]; return ;;
    tox|nox)
      shift; prev=""
      for w in "$@"; do
        case "$prev" in -e|-s|--env|--session|--sessions) case ",$w," in *publish*|*release*|*deploy*|*upload*) return 1 ;; esac ;; esac
        case "$w" in -e*|-s*) case "${w#-?}" in *publish*|*release*|*deploy*|*upload*) return 1 ;; esac ;; esac
        prev=$w
      done
      return 0 ;;
    deno) [ "${2:-}" = test ]; return ;;
    bash|sh) case "${2:-}" in *.test.sh) safe_dir "$2"; return ;; esac; return 1 ;;
    make) make_check_target "${2:-}"; return ;;
    go) case "${2:-}" in test|vet|build) return 0 ;; esac; return 1 ;;
    node) [ "${2:-}" = --test ]; return ;;
    eslint|tsc|prettier|vitest|jest|pytest|ruff|flake8|pylint|mypy|black|golangci-lint|gofmt|staticcheck|shellcheck) return 0 ;;
  esac
  return 1
}
tool_globs() {
  c=" $1 "
  case "$c" in
    *\ cargo\ *) printf '%s' "**/*.rs$US**/Cargo.toml${US}Cargo.lock"; return ;;
    *gradlew\ *|*\ gradle\ *|*mvnw\ *|*\ mvn\ *) printf '%s' "$(ext_globs . "java kt kts gradle groovy scala")$US**/pom.xml"; return ;;
    *[\ /]rspec\ *) printf '**/*.rb'; return ;;
    *\ manage.py\ test\ *|*\ unittest\ *|*\ tox\ *|*\ nox\ *) printf '**/*.py'; return ;;
    *\ npm\ --prefix\ *) d=${1#*--prefix }; d=${d%% *}; ext_globs "$d" "$JS_EXT"; return ;;
    *\ deno\ *|*\ bun\ *|*\ bunx\ *) ext_globs . "$JS_EXT"; return ;;
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
  paths=$(awk -F'\t' '$1 == "P" { printf "%s\037", $2 }' "$T/wf"); paths=${paths%"$US"}
  awk -F'\t' '$1 != "P"' "$T/wf" | while IFS="$US" read -r job cmd; do
    check_cmd "$cmd" || continue
    skip_cmd "$CK_CMD" && continue
    g=$(tool_globs "$CK_CMD")
    [ -n "$g" ] && [ "$CK_CWD" != . ] && g="$CK_CWD/${g//$US/$US$CK_CWD/}"
    [ -n "$g" ] || g="$paths"
    [ -n "$g" ] || { [ "$CK_CWD" != . ] && g="$CK_CWD/**"; }
    [ -n "$g" ] || continue
    row "$wf#jobs.$job" "$CK_CWD" "$CK_CMD" "$g"
  done
done

MAP=$(jq -R -s -c '
  [split("\n")[] | select(length > 0) | split("\t") | {source: .[0], cwd: .[1], command: .[2], globs: (.[3] | split("\u001f") | map(select(length > 0)))}]
  | sort_by(.source, .command)
  | reduce .[] as $e ({order: [], by: {}};
      ([$e.command, $e.cwd] | tojson) as $k
      | if .by[$k] then .by[$k].globs += ($e.globs - .by[$k].globs)
        else .order += [$k] | .by[$k] = {globs: $e.globs, command: $e.command, cwd: $e.cwd, source: $e.source} end)
  | {version: 1, entries: [.by[.order[]]]}' < "$T/rows") || die "jq failed"

if [ "$STDOUT" = 1 ]; then printf '%s\n' "$MAP"; exit 0; fi
[ -n "$OUT" ] || OUT=".forge/test-map.json"
mkdir -p "$(dirname "$OUT")" || die "cannot create $(dirname "$OUT")"
printf '%s\n' "$MAP" > "$OUT.tmp.$$" || die "cannot write $OUT"
mv "$OUT.tmp.$$" "$OUT" || die "cannot write $OUT"
echo "$OUT"
