#!/usr/bin/env bash
# symbol-move-ts.test.sh — cases for scripts/symbol-move.mjs, the ts-morph mover (forge#4212).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds a throwaway git repo from scripts/fixtures/symbol-move-ts/gen_big.mjs (~700-line src/big.ts + node:test
# suite), moves four symbol groups into src/big_parts/ and proves the move with scripts/refactor-verify.sh; then
# checks the refusals, the --extend chain step and the no-ts-morph refusal (no partial edits).
# ts-morph: SYMBOL_MOVE_TS_NODE_MODULES=<node_modules holding ts-morph> (put on NODE_PATH for the mover, the symbol
# index and refactor-verify). Without it the ts-morph cases are skipped; SYMBOL_MOVE_REQUIRE_TS_MORPH=1 turns that
# skip into a failure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SM="$HERE/symbol-move.mjs"; RV="$HERE/refactor-verify.sh"; GEN="$HERE/fixtures/symbol-move-ts/gen_big.mjs"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/symbol-move-ts-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
has() { if grep -qF -- "$2" "$3"; then ok; else bad "$1 (no '$2' in $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }
TSM="${SYMBOL_MOVE_TS_NODE_MODULES:-}"
[ -n "$TSM" ] && [ -d "$TSM/ts-morph" ] || TSM=""
# without: no NODE_PATH and a HOME holding no node_modules, so ts-morph cannot resolve from anywhere
without() { OUT="$(cd "$R" && env -u NODE_PATH HOME="$TMP/home" node "$SM" "$@" 2>"$TMP/err")"; RC=$?; }
mover() { OUT="$(cd "$R" && NODE_PATH="$TSM" node "$SM" "$@" 2>"$TMP/err")"; RC=$?; }
mkdir -p "$TMP/home"

R="$TMP/repo"; B="$TMP/baseline.json"; P="$TMP/plan.json"
TEST_CMD='node --test test/big.test.ts'
g() { git -C "$R" -c user.name=t -c user.email=t@example.invalid "$@"; }
mkdir -p "$R"; git init -q "$R"
node "$GEN" "$R" || bad "generator failed"
g add -A && g commit -qm base && g tag base
eq "fixture size >= 600 lines" "$([ "$(wc -l < "$R/src/big.ts")" -ge 600 ] && echo yes || echo no)" yes
SHA0="$(git -C "$R" hash-object src/big.ts)"
reset() { g reset -q --hard base; g clean -fdq; }

seqp() { local f="$1" s=""; for i in $(seq -w 0 19); do s="$s\"$(printf "$f" "$i")\","; done; printf '%s' "${s%,}"; }
plan() { printf '%s' "$1" | jq -c . > "$2" || bad "bad plan json"; }
CONSTS="[$(seqp 'LIMIT_%s')]"
HELPERS="[$(for i in $(seq -w 0 19); do printf '"_scale_%s","compute_%s",' "$i" "$i"; done | sed 's/,$//')]"
MODELS="[$(seqp 'Item_%s'),$(seqp 'Store_%s')]"
AIO="[$(seqp 'fetch_%s')]"
FULL="{\"consts\":$CONSTS,\"helpers\":$HELPERS,\"models\":$MODELS,\"aio\":$AIO}"
plan "$FULL" "$P"

# refused <label>: rc 3, status refused, a reason, and nothing changed in the repo
refused() {
  eq "$1: rc" "$RC" 3
  eq "$1: status" "$(q '.status')" '"refused"'
  eq "$1: has reason" "$(q '.reason|length>0')" true
  eq "$1: tree untouched" "$(git -C "$R" status --porcelain)" ""
  eq "$1: barrel untouched" "$(git -C "$R" hash-object src/big.ts)" "$SHA0"
}

# ---- 1. no codemod tool: ts-morph unresolvable -> clean refusal before anything is read or written ----
without --src src/big.ts --plan "$P"
refused "no ts-morph"
eq "no ts-morph: reason" "$(q '.reason|startswith("no codemod tool for ts: ts-morph is not resolvable")')" true
without --probe --src src/big.ts
eq "no ts-morph probe: rc" "$RC" 3
eq "no ts-morph probe: reason" "$(q '.reason|startswith("no codemod tool for ts:")')" true
eq "no ts-morph: no package dir" "$([ -e "$R/src/big_parts" ] && echo yes || echo no)" no

# ---- 2. usage ----
OUT="$(node "$SM" --plan "$P" 2>/dev/null)"; eq "usage: rc" "$?" 2
OUT="$(node "$SM" --src "$R/src/nope.ts" --plan "$P" 2>/dev/null)"; eq "missing src: rc" "$?" 2

if [ -z "$TSM" ]; then
  if [ "${SYMBOL_MOVE_REQUIRE_TS_MORPH:-0}" = "1" ]; then bad "ts-morph required (SYMBOL_MOVE_REQUIRE_TS_MORPH=1) but SYMBOL_MOVE_TS_NODE_MODULES has no ts-morph"; fi
  echo "symbol-move-ts.test.sh: ts-morph cases skipped (set SYMBOL_MOVE_TS_NODE_MODULES)"
  echo "symbol-move-ts.test.sh: $PASS passed, $FAILN failed"
  [ "$FAILN" -eq 0 ]; exit
fi
export NODE_PATH="$TSM"

# ---- 3. probe and dry run ----
mover --probe --src src/big.ts
eq "probe: rc" "$RC" 0
eq "probe: tool" "$(q '.tool')" '"ts-morph"'
mover --src src/big.ts --plan "$P" --dry-run
eq "dry-run: rc" "$RC" 0
eq "dry-run: tree untouched" "$(git -C "$R" status --porcelain)" ""

# ---- 4. the move: four groups into src/big_parts/, barrel at the old path, refactor-verify ok ----
bash "$RV" baseline --root "$R" --target src/big.ts --test-cmd "$TEST_CMD" --out "$B" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; bad "baseline failed"; }
eq "baseline counts" "$(jq -c .test "$B")" '{"exit":0,"passed":5,"skipped":1}'
eq "baseline flags erased types" "$(jq -c '[.symbols[]|select(.type)]|length' "$B")" 20
mover --src src/big.ts --plan "$P"
eq "move: rc" "$RC" 0
eq "move: status" "$(q '.status')" '"ok"'
eq "move: package" "$(q '.package')" '"src/big_parts"'
eq "move: modules" "$(q '.modules|keys')" '["aio","consts","helpers","models"]'
for m in consts helpers models aio; do
  eq "module $m exists" "$([ -f "$R/src/big_parts/$m.ts" ] && echo yes || echo no)" yes
  has "barrel re-exports $m" "} from \"./big_parts/$m.ts\";" "$R/src/big.ts"
done
has "barrel re-exports types with type" 'export { type Item_00, Store_00,' "$R/src/big.ts"
has "barrel imports names kept code uses" 'import { compute_00 } from "./big_parts/helpers.ts";' "$R/src/big.ts"
has "barrel keeps unmoved code" 'function _shared(x: number): number {' "$R/src/big.ts"
has "barrel keeps the header" '// SPDX-License-Identifier: MIT' "$R/src/big.ts"
has "relative import re-based" 'import { clamp } from "../util.ts";' "$R/src/big_parts/helpers.ts"
has "type import pruned and re-based" 'import { type Unit } from "../util.ts";' "$R/src/big_parts/models.ts"
has "sibling import" 'import { compute_00, compute_01,' "$R/src/big_parts/models.ts"
has "private helper moved verbatim" 'function _scale_07(x: number): number {' "$R/src/big_parts/helpers.ts"
has "doc comment moved" '/** compute 7: scaled and clamped. */' "$R/src/big_parts/helpers.ts"
eq "no moved declaration left" "$(grep -c '^export function compute_\|^function _scale_\|^export class Store_\|^export interface Item_' "$R/src/big.ts")" 0
g add -A && g commit -qm move
OUT="$(bash "$RV" verify --baseline "$B" --base base 2>"$TMP/err")"; RC=$?
eq "verify: rc" "$RC" 0
eq "verify: ok" "$(q '.ok')" true
# a dropped type re-export is caught statically
sed -i.bak 's/export { type Item_00, Store_00, /export { Store_00, /' "$R/src/big.ts"; rm -f "$R/src/big.ts.bak"
g commit -qam drop-type
OUT="$(bash "$RV" verify --baseline "$B" --base base 2>"$TMP/err")"; RC=$?
eq "dropped type: rc" "$RC" 1
eq "dropped type: missing" "$(q '[.failures[]|select(.kind=="missing-symbol")|.name]')" '["Item_00"]'
reset

# ---- 5. refusals: nothing touched ----
plan '{"a":["nope"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "unknown symbol"
plan '{"a":["LIMIT_00"],"b":["LIMIT_00"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "listed twice"
plan '{"a":["Store_00.add"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "method"
plan '{"index":["LIMIT_00"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "bad module name"
plan '{"a":["compute_00"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "needs a kept name"
eq "needs a kept name: reason" "$(q '.reason|test("needs \"_scale_00\", which stays")')" true
plan '{"a":["_shared"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "private used by kept code"
eq "private used by kept code: reason" "$(q '.reason|test("not exported but kept code uses it")')" true
plan '{"a":["_scale_00","LIMIT_00"],"b":["compute_00"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "private used by a sibling"
eq "private used by a sibling: reason" "$(q '.reason|test("not exported")')" true
plan '{"a":["ping"],"b":["pong"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "cycle"
eq "cycle: reason" "$(q '.reason|test("import cycle")')" true
mkdir -p "$R/src/big_parts"; plan "{\"consts\":$CONSTS}" "$P"; mover --src src/big.ts --plan "$P"
eq "existing package: rc" "$RC" 3
eq "existing package: reason" "$(q '.reason|test("already exists")')" true
rmdir "$R/src/big_parts"
printf 'export default function main(): number {\n  return 1;\n}\n' >> "$R/src/big.ts"; g commit -qam default; SHA0="$(git -C "$R" hash-object src/big.ts)"
plan '{"a":["main"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "export default"
printf 'export const HERE = import.meta.url;\n' >> "$R/src/big.ts"; g commit -qam meta; SHA0="$(git -C "$R" hash-object src/big.ts)"
plan '{"a":["HERE"]}' "$P"; mover --src src/big.ts --plan "$P"; refused "import.meta"
reset; SHA0="$(git -C "$R" hash-object src/big.ts)"

# ---- 6. chain: a second step adds modules to the existing package with --extend ----
plan "{\"consts\":$CONSTS,\"helpers\":$HELPERS}" "$P"; mover --src src/big.ts --plan "$P"
eq "chain step 1: rc" "$RC" 0
g add -A && g commit -qm step1
plan "{\"models\":$MODELS}" "$P"; mover --src src/big.ts --plan "$P" --package big_parts
eq "chain without --extend: rc" "$RC" 3
plan "{\"models\":$MODELS}" "$P"; mover --src src/big.ts --plan "$P" --package big_parts --extend
eq "chain step 2: rc" "$RC" 0
has "chain step 2: barrel" '} from "./big_parts/models.ts";' "$R/src/big.ts"
has "chain step 2: earlier module imported in-package" '} from "./helpers.ts";' "$R/src/big_parts/models.ts"
g add -A && g commit -qm step2
OUT="$(bash "$RV" verify --baseline "$B" --base base 2>"$TMP/err")"; RC=$?
eq "chain verify: ok" "$(q '.ok')" true
plan "{\"models\":[\"fetch_00\"]}" "$P"; mover --src src/big.ts --plan "$P" --package big_parts --extend
eq "chain existing module: rc" "$RC" 3
eq "chain existing module: reason" "$(q '.reason|test("module already exists")')" true

echo "symbol-move-ts.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
