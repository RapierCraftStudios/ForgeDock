#!/usr/bin/env bash
# symbol-index.test.sh — cases for scripts/symbol-index.{py,mjs} (forge#4208).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Optional: SYMBOL_INDEX_TS_NODE_MODULES=<node_modules holding typescript@5> also runs the TS-parser cases.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/symbol-index.py"; MJS="$HERE/symbol-index.mjs"; FX="$HERE/fixtures/symbol-index"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/symbol-index-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }
run() { OUT="$("$@" 2>"$TMP/err")"; RC=$?; }

# ---- 1. Python file: schema, symbols, spans, public flags ----
run python3 "$PY" "$FX/py/sample.py"
eq "py file rc" "$RC" 0
eq "py top-level keys" "$(q 'keys')" '["cycles","edges","imports","symbols"]'
eq "symbol keys" "$(q '[.symbols[]|keys]|unique')" '[["end","kind","lines","name","public","start"]]'
eq "symbol names" "$(q '[.symbols[].name]')" \
  '["__all__","LIMIT","_cache","_normalise","greet","fetch","helper","Greeter","Greeter.__init__","Greeter.text","Greeter._shout","Greeter.shout"]'
eq "kinds" "$(q '[.symbols[]|select(.name=="LIMIT" or .name=="greet" or .name=="fetch" or .name=="Greeter" or .name=="Greeter.shout")|.kind]')" \
  '["const","function","async_function","class","method"]'
eq "greet span" "$(q '.symbols[]|select(.name=="greet")|[.start,.end,.lines]')" '[15,16,2]'
eq "class span" "$(q '.symbols[]|select(.name=="Greeter")|[.start,.end,.lines]')" '[27,41,15]'
eq "decorator in span" "$(q '.symbols[]|select(.name=="Greeter.text")|[.start,.end,.lines]')" '[33,35,3]'
eq "public set" "$(q '[.symbols[]|select(.public)|.name]')" \
  '["LIMIT","greet","fetch","Greeter","Greeter.__init__","Greeter.text","Greeter.shout"]'
eq "helper not in __all__" "$(q '.symbols[]|select(.name=="helper")|.public')" 'false'

# ---- 2. edges and imports ----
eq "edges" "$(q '[.edges[]|"\(.from)>\(.to)"]')" \
  '["Greeter._shout>Greeter.text","Greeter.shout>Greeter._shout","Greeter.text>greet","fetch>LIMIT","fetch>_cache","greet>_normalise"]'
eq "imports" "$(q '.imports')" \
  '[{"line":2,"module":"os","names":[]},{"line":3,"module":"collections","names":["OrderedDict"]}]'
eq "single file has no cycles" "$(q '.cycles')" '[]'

# ---- 3. never includes file bodies ----
for needle in SECRET_DOCSTRING_MARKER SECRET_CLASS_DOC_MARKER 'hi ' 'strip()' 'getcwd' 'return'; do
  case "$OUT" in *"$needle"*) bad "output leaks source text: $needle" ;; *) ok ;; esac
done

# ---- 4. import cycles across modules ----
run python3 "$PY" "$FX/py/pkg"
eq "pkg rc" "$RC" 0
eq "pkg cycles (TYPE_CHECKING + function-local imports ignored)" "$(q '.cycles')" '[["pkg.a","pkg.b"]]'
eq "pkg relative import resolved" "$(q '[.imports[]|select(.file|endswith("b.py"))|.module]')" '["typing","pkg","pkg.a"]'
eq "pkg cross-module edges" "$(q '[.edges[]|"\(.from)>\(.to)"]')" '["pkg.a:run>pkg.b:step","pkg.b:step>pkg.c:value"]'
eq "pkg symbols carry file" "$(q '[.symbols[]|has("file")]|unique')" '[true]'
BEFORE="$(q '.cycles')"
cp -R "$FX/py/pkg" "$TMP/pkg"
printf 'from . import a\n' > "$TMP/pkg/d.py"
printf 'from . import d\n' >> "$TMP/pkg/c.py"
run python3 "$PY" "$TMP/pkg"
AFTER="$(q '.cycles')"
eq "after: cycle set grows" "$AFTER" '[["pkg.a","pkg.b","pkg.c","pkg.d"]]'
eq "before/after diff finds the new cycle" \
  "$(jq -nc --argjson b "$BEFORE" --argjson a "$AFTER" '$a - $b')" '[["pkg.a","pkg.b","pkg.c","pkg.d"]]'
printf 'import pkg.e\n' > "$TMP/pkg/e.py"
run python3 "$PY" "$TMP/pkg"
eq "self-import is a cycle" "$(q '.cycles|map(select(.==["pkg.e"]))|length')" '1'

# ---- 5. deterministic ----
A1="$(python3 "$PY" "$FX/py/pkg")"; A2="$(python3 "$PY" "$FX/py/pkg")"
eq "byte-identical reruns" "$([ "$A1" = "$A2" ] && echo same)" same

# ---- 6. unsupported: exit 0, only {unsupported, reason} ----
for t in "$FX/other/sample.rb" "$FX/ts/sample.ts"; do
  run python3 "$PY" "$t"
  eq "py unsupported rc $(basename "$t")" "$RC" 0
  eq "py unsupported keys $(basename "$t")" "$(q 'keys')" '["reason","unsupported"]'
done
eq "py unsupported lang" "$(python3 "$PY" "$FX/other/sample.rb" | jq -r .unsupported)" ruby
run python3 "$PY" "$FX/py/sample.py" "$FX/other/sample.rb"
eq "mixed input: no partial output" "$(q 'keys')" '["reason","unsupported"]'
mkdir -p "$TMP/empty"; run python3 "$PY" "$TMP/empty"
eq "dir without .py" "$(q '.')" '{"reason":"no-python-files","unsupported":"unknown"}'
mkdir -p "$TMP/broken"; printf 'def ok():\n    return 1\n' > "$TMP/broken/good.py"; printf 'def broken(:\n' > "$TMP/broken/bad.py"
run python3 "$PY" "$TMP/broken"
eq "parse error rc" "$RC" 0
eq "parse error: no partial symbols" "$(q 'keys')" '["reason","unsupported"]'
eq "parse error reason" "$(q '.reason|startswith("parse-error: ")')" 'true'

run node "$MJS" "$FX/other/sample.rb"
eq "mjs ruby rc" "$RC" 0
eq "mjs ruby" "$(q '.')" '{"reason":"unknown-language","unsupported":"ruby"}'
mkdir -p "$TMP/ts"; cp "$FX/ts/sample.ts" "$TMP/ts/"
run node "$MJS" "$TMP/ts/sample.ts"
eq "mjs ts without parser rc" "$RC" 0
eq "mjs ts without parser" "$(q '.')" '{"reason":"no-parser","unsupported":"ts"}'
run node "$MJS" "$FX/py/sample.py"
eq "mjs delegates .py" "$(q '.symbols|length')" '12'

# ---- 7. usage ----
python3 "$PY" >/dev/null 2>&1; eq "py no args" "$?" 2
python3 "$PY" "$TMP/missing.py" >/dev/null 2>&1; eq "py missing path" "$?" 2
node "$MJS" >/dev/null 2>&1; eq "mjs no args" "$?" 2

# ---- 8. optional: TS parser path ----
if [ -n "${SYMBOL_INDEX_TS_NODE_MODULES:-}" ] && [ -d "$SYMBOL_INDEX_TS_NODE_MODULES/typescript" ]; then
  ln -s "$SYMBOL_INDEX_TS_NODE_MODULES" "$TMP/ts/node_modules"
  run node "$MJS" "$TMP/ts/sample.ts"
  eq "ts symbols" "$(q '[.symbols[]|"\(.kind):\(.name):\(.start)-\(.end):\(.public)"]')" \
    '["const:LIMIT:3-3:true","function:load:5-7:true","class:Loader:9-13:true","method:Loader.read:10-12:true"]'
  eq "ts edges" "$(q '[.edges[]|"\(.from)>\(.to)"]')" '["Loader.read>load","load>LIMIT"]'
  mkdir -p "$TMP/ts/lib"
  printf 'import { b } from "./b";\nimport type { T } from "./c";\nexport function a(): number { return b(); }\n' > "$TMP/ts/lib/a.ts"
  printf 'import * as A from "./a.js";\nexport const b = () => 2;\nexport function useA() { return A.a(); }\n' > "$TMP/ts/lib/b.ts"
  printf 'import { a } from "./a";\nexport type T = number;\n' > "$TMP/ts/lib/c.ts"
  run node "$MJS" "$TMP/ts/lib"
  eq "ts cycles (import type ignored)" "$(q '.cycles')" '[["a","b"]]'
else
  echo "symbol-index.test.sh: TS-parser cases skipped (set SYMBOL_INDEX_TS_NODE_MODULES)"
fi

echo "symbol-index.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
