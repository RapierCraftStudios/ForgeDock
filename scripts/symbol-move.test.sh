#!/usr/bin/env bash
# symbol-move.test.sh — cases for scripts/symbol-move.py (forge#4210).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds a throwaway git repo from scripts/fixtures/symbol-move/gen_big.py (~3k-line module + unittest suite), moves
# four symbol groups into pkg/big_parts/ and proves the move with scripts/refactor-verify.sh; then checks refusals and
# the --extend chain step (forge#4211).
# Interpreter with libcst: $SYMBOL_MOVE_PYTHON, else python3 if it has libcst, else `uv run --no-project --with libcst
# python`. Without one the libcst cases are skipped; SYMBOL_MOVE_REQUIRE_LIBCST=1 turns that skip into a failure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SM="$HERE/symbol-move.py"; RV="$HERE/refactor-verify.sh"; GEN="$HERE/fixtures/symbol-move/gen_big.py"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/symbol-move-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }
run() { OUT="$("$@" 2>"$TMP/err")"; RC=$?; }
export PYTHONDONTWRITEBYTECODE=1

PYCMD=""
if [ -n "${SYMBOL_MOVE_PYTHON:-}" ]; then
  PYCMD="$SYMBOL_MOVE_PYTHON"
elif python3 -c 'import libcst' >/dev/null 2>&1; then
  PYCMD="python3"
elif command -v uv >/dev/null 2>&1 && uv run --no-project --with libcst python -c 'import libcst' >/dev/null 2>&1; then
  PYCMD="uv run --no-project --with libcst python"
fi
# shellcheck disable=SC2086 # PYCMD is a command line
mover() { run $PYCMD "$SM" "$@"; }

R="$TMP/repo"; B="$TMP/baseline.json"; P="$TMP/plan.json"
TEST_CMD='python3 -m unittest discover -s tests -t .'
g() { git -C "$R" -c user.name=t -c user.email=t@example.invalid "$@"; }
mkdir -p "$R"; git init -q "$R"
printf '__pycache__/\n' > "$R/.gitignore"
python3 "$GEN" "$R" || bad "generator failed"
g add -A && g commit -qm base && g tag base
eq "fixture size >= 2500 lines" "$([ "$(wc -l < "$R/pkg/big.py")" -ge 2500 ] && echo yes || echo no)" yes
SHA0="$(git -C "$R" hash-object pkg/big.py)"

plan() { python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])))' "$1" > "$2"; }
FULL='{"consts":['"$(printf '"LIMIT_%02d",' $(seq 0 89))"'"_SEPARATOR"],
 "helpers":['"$(for i in $(seq -w 0 89); do printf '"_scale_%s","compute_%s",' "$i" "$i"; done)"'"join_parts"],
 "aio":['"$(printf '"fetch_%02d",' $(seq 0 28))"'"fetch_29"],
 "models":['"$(printf '"Item_%02d",' $(seq 0 28))"'"Item_29"]}'
plan "$FULL" "$P"

# refused <label>: rc 3, status refused, a reason, and nothing changed in the repo
refused() {
  eq "$1: rc" "$RC" 3
  eq "$1: status" "$(q '.status')" '"refused"'
  eq "$1: has reason" "$(q '.reason|length>0')" true
  eq "$1: tree untouched" "$(git -C "$R" status --porcelain)" ""
  eq "$1: shim untouched" "$(git -C "$R" hash-object pkg/big.py)" "$SHA0"
}

# ---- 1. no codemod tool: stdlib-only interpreter (no site-packages) refuses before touching anything ----
run python3 -I -S "$SM" --src "$R/pkg/big.py" --plan "$P"
refused "no codemod tool"
eq "no codemod tool: reason" "$(q '.reason|startswith("no codemod tool")')" true
eq "no codemod tool: one JSON object" "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" 1

# ---- 2. usage ----
python3 -I -S "$SM" >/dev/null 2>&1; eq "no args" "$?" 2
python3 -I -S "$SM" --src "$R/pkg/missing.py" --plan "$P" >/dev/null 2>&1; eq "missing src" "$?" 2

if [ -z "$PYCMD" ]; then
  echo "symbol-move.test.sh: libcst cases skipped (no python with libcst; set SYMBOL_MOVE_PYTHON)"
  [ "${SYMBOL_MOVE_REQUIRE_LIBCST:-}" = 1 ] && bad "libcst required (SYMBOL_MOVE_REQUIRE_LIBCST=1) but not available"
else
  # ---- 3. invalid plans refuse with no edits ----
  plan '{"a":["compute_00","no_such_symbol"]}' "$TMP/p1.json"
  mover --src "$R/pkg/big.py" --plan "$TMP/p1.json"; refused "unknown symbol"
  eq "unknown symbol: reason" "$(q '.reason|contains("no_such_symbol")')" true
  plan '{"a":["compute_00","LIMIT_00"],"b":["LIMIT_00"]}' "$TMP/p2.json"
  mover --src "$R/pkg/big.py" --plan "$TMP/p2.json"; refused "symbol twice"
  eq "symbol twice: reason" "$(q '.reason|contains("listed twice")')" true
  plan '{"helpers":["_scale_00","compute_00"]}' "$TMP/p3.json"
  mover --src "$R/pkg/big.py" --plan "$TMP/p3.json"; refused "depends on kept symbol"
  eq "depends on kept symbol: reason" "$(q '.reason|contains("LIMIT_00")')" true
  plan '{"a":["Item_00.label"]}' "$TMP/p4.json"
  mover --src "$R/pkg/big.py" --plan "$TMP/p4.json"; refused "method"
  plan '{"x":["Item_00","LIMIT_00","_SEPARATOR"],"y":["_scale_00","compute_00","join_parts"]}' "$TMP/p6.json"
  mover --src "$R/pkg/big.py" --plan "$TMP/p6.json"; refused "import cycle"
  eq "import cycle: reason" "$(q '.reason|contains("import cycle")')" true
  plan '{"consts":["LIMIT_00"],"helpers":["_scale_00","compute_00"],"back":["_SEPARATOR"]}' "$TMP/p5.json"
  mover --src "$R/pkg/big.py" --plan "$TMP/p5.json" --dry-run
  eq "independent subset moves in dry-run" "$RC" 0
  eq "dry-run writes nothing" "$(git -C "$R" status --porcelain)" ""
  mkdir -p "$R/pkg/big_parts"; : > "$R/pkg/big_parts/keep.txt"
  mover --src "$R/pkg/big.py" --plan "$P"
  eq "existing package: reason" "$(q '.reason|contains("already exists")')" true
  eq "existing package: rc" "$RC" 3
  eq "existing package: kept" "$(ls "$R/pkg/big_parts")" keep.txt
  rm -rf "$R/pkg/big_parts"
  refused "existing package"

  # ---- 4. full plan: package + import-only shim, proved by refactor-verify ----
  run bash "$RV" baseline --root "$R" --target pkg/big.py --test-cmd "$TEST_CMD" --out "$B"
  eq "baseline rc" "$RC" 0
  eq "baseline counts" "$(jq -c .test "$B")" '{"exit":0,"passed":10,"skipped":1}'

  mover --src "$R/pkg/big.py" --plan "$P" --dry-run
  eq "dry-run rc" "$RC" 0
  eq "dry-run touches nothing" "$(git -C "$R" status --porcelain)" ""

  mover --src "$R/pkg/big.py" --plan "$P"
  eq "move rc" "$RC" 0
  eq "move status" "$(q '.status')" '"ok"'
  eq "move package" "$(q '.package')" '"pkg.big_parts"'
  eq "move modules" "$(q '.modules|keys')" '["aio","consts","helpers","models"]'
  eq "move module sizes" "$(q '[.modules[]|length]')" '[30,91,181,30]'
  for f in __init__ consts helpers aio models; do
    eq "package file $f" "$([ -f "$R/pkg/big_parts/$f.py" ] && echo yes || echo no)" yes
  done
  eq "package __init__ empty" "$(wc -c < "$R/pkg/big_parts/__init__.py" | tr -d ' ')" 0
  g add -A && g commit -qm move
  eq "shim: added lines are imports only" \
    "$(git -C "$R" diff base HEAD -- pkg/big.py | grep '^+' | grep -v '^+++' | sed 's/^+//' \
       | grep -vE '^\s*$|^\s*(from \S+ import|import \S)|^\s+[A-Za-z_][A-Za-z_0-9]*,$|^\)$' | wc -l | tr -d ' ')" 0
  eq "shim keeps unmoved code" "$(grep -c '^def describe\|^VERSION = \|^DEFAULT_TOTAL = ' "$R/pkg/big.py")" 3
  eq "symbol moved verbatim" "$(git -C "$R" show base:pkg/big.py | sed -n '/^@functools.total_ordering$/,/^class Item_00:/p' | head -2 | tr '\n' '|')" \
    "$(sed -n '/^@functools.total_ordering$/,/^class Item_00:/p' "$R/pkg/big_parts/models.py" | head -2 | tr '\n' '|')"
  run bash "$RV" verify --baseline "$B" --base base
  eq "verify rc" "$RC" 0
  eq "verify ok" "$(q '.ok')" true
  eq "verify failures" "$(q '.failures')" '[]'
  (cd "$R" && $TEST_CMD >"$TMP/after.txt" 2>&1); eq "tests after move" "$?" 0
  eq "identical test result" "$(tail -1 "$TMP/after.txt")" "OK (skipped=1)"

  # ---- 5. --extend (forge#4211 chain step): a second PR adds modules to the package the first one created ----
  R2="$TMP/repo2"; B2="$TMP/baseline2.json"
  g2() { git -C "$R2" -c user.name=t -c user.email=t@example.invalid "$@"; }
  mkdir -p "$R2"; git init -q "$R2"; printf '__pycache__/\n' > "$R2/.gitignore"
  python3 "$GEN" "$R2" && g2 add -A && g2 commit -qm base
  plan '{"consts":['"$(printf '"LIMIT_%02d",' $(seq 0 89))"'"_SEPARATOR"]}' "$TMP/step1.json"
  mover --src "$R2/pkg/big.py" --plan "$TMP/step1.json"
  eq "chain step 1 rc" "$RC" 0
  g2 add -A && g2 commit -qm step1 && g2 tag step1
  plan '{"helpers":['"$(for i in $(seq -w 0 89); do printf '"_scale_%s","compute_%s",' "$i" "$i"; done)"'"join_parts"]}' "$TMP/step2.json"
  mover --src "$R2/pkg/big.py" --plan "$TMP/step2.json"
  eq "existing package without --extend: rc" "$RC" 3
  eq "existing package without --extend: reason" "$(q '.reason|contains("already exists")')" true
  eq "existing package without --extend: untouched" "$(git -C "$R2" status --porcelain)" ""
  jq -c '{consts: .helpers}' "$TMP/step2.json" > "$TMP/step2bad.json"
  mover --src "$R2/pkg/big.py" --plan "$TMP/step2bad.json" --extend
  eq "--extend colliding module: rc" "$RC" 3
  eq "--extend colliding module: reason" "$(q '.reason|contains("module already exists")')" true
  eq "--extend colliding module: untouched" "$(git -C "$R2" status --porcelain)" ""
  run bash "$RV" baseline --root "$R2" --target pkg/big.py --test-cmd "$TEST_CMD" --out "$B2"
  eq "chain baseline rc" "$RC" 0
  INIT_SHA="$(git -C "$R2" hash-object pkg/big_parts/__init__.py)"
  mover --src "$R2/pkg/big.py" --plan "$TMP/step2.json" --extend
  eq "--extend rc" "$RC" 0
  eq "--extend package" "$(q '.package')" '"pkg.big_parts"'
  eq "--extend modules" "$(q '.modules|keys')" '["helpers"]'
  eq "--extend keeps __init__" "$(git -C "$R2" hash-object pkg/big_parts/__init__.py)" "$INIT_SHA"
  eq "--extend keeps step-1 module" "$(git -C "$R2" status --porcelain pkg/big_parts/consts.py)" ""
  g2 add -A && g2 commit -qm step2
  run bash "$RV" verify --baseline "$B2" --base step1
  eq "--extend verify rc" "$RC" 0
  eq "--extend verify failures" "$(q '.failures')" '[]'
fi

echo "symbol-move.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
