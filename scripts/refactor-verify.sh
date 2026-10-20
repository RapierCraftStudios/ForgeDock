#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# refactor-verify.sh: deterministic baseline-vs-after proof that a refactor:split only moved code (forge#4209, #4196).
# No LLM, no network. Never modifies the target repo, its index or its worktree.
#
# Usage:
#   refactor-verify.sh baseline --root <dir> --target <file|dir> --test-cmd '<cmd>' --out <file.json>
#   refactor-verify.sh verify --baseline <file.json> --base <ref> [--head <ref>]   (head defaults to HEAD)
#
# baseline: runs <cmd> via `bash -c` in --root and parses passed/skipped counts from its summary (pytest, unittest,
#   node TAP/spec, jest/vitest; several summaries are summed). Indexes --target with scripts/symbol-index.py (.py) or
#   scripts/symbol-index.mjs and records every public symbol as {module,name}: module = dotted path under --root for
#   Python (pkg/__init__.py -> pkg), the root-relative file path for JS/TS; name may be Class.method. Indexes the
#   target's package directory (the target if a dir, else its parent) and records its import cycles. Writes one
#   key-sorted JSON {test:{exit,passed,skipped},symbols,cycles,root,target,index_dir,lang,test_cmd} to --out.
# verify: run with --root's worktree checked out at --head. Re-runs test_cmd and the cycle index, resolves every
#   baseline symbol from its OLD module path at runtime (Python importlib + getattr chain, so re-export shims and a
#   module turned into a package resolve; JS/TS node import(); JS/TS interfaces and type aliases, erased at runtime,
#   statically: the old module still exports the name, following `export * from`), and reads
#   `git diff --color-moved=plain --no-renames <base> <head>`. Prints key-sorted JSON {ok,failures:[...]}, kinds:
#     logic-diff {file,line,text}   an added/removed line that is not moved, not blank and not an import line
#                                   (Python import/from-import incl. parenthesised continuations; JS/TS import,
#                                   export ... from, export * from, incl. braced continuations)
#     missing-symbol {module,name}  a baseline public symbol no longer resolves from its old path
#     count-changed {before,after}  passed or skipped changed, or the test exit went from 0 to non-zero
#     new-cycle {cycle}             an import cycle not present in the baseline (set difference)
# Exit: 0 ok | 1 verify found failures | 2 usage, missing file, unknown ref, unparseable counts or unsupported language.
# Requires git, jq, python3; node only for JS/TS targets. Bash 3.2 portable.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SI_PY="$HERE/symbol-index.py"; SI_MJS="$HERE/symbol-index.mjs"

usage() {
  echo "usage: refactor-verify.sh baseline --root <dir> --target <file|dir> --test-cmd '<cmd>' --out <file.json>" >&2
  echo "       refactor-verify.sh verify --baseline <file.json> --base <ref> [--head <ref>]" >&2
  exit 2
}
die() { echo "refactor-verify.sh: $*" >&2; exit 2; }

for tool in git jq python3; do command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"; done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/refactor-verify.XXXXXX")" || die "cannot create scratch dir"
trap 'rm -rf "$SCRATCH"' EXIT

# ---- passed/skipped counts from a test-run output file: prints "<passed> <skipped>" or exits 1 ----
parse_counts() {
  python3 -I - "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
text = re.sub(r"\x1b\[[0-9;]*m", "", text)
lines = text.splitlines()

def num(pat, s):
    m = re.search(pat, s)
    return int(m.group(1)) if m else 0

def result(p, s):
    print(p, s)
    sys.exit(0)

# jest ("Tests:       1 skipped, 3 passed, 4 total") / vitest ("      Tests  3 passed | 1 skipped (4)")
found, p, s = False, 0, 0
for ln in lines:
    if re.match(r"^\s*Tests:?\s+.*\d+ (passed|skipped|failed|todo)", ln):
        found = True
        p += num(r"(\d+) passed", ln); s += num(r"(\d+) skipped", ln) + num(r"(\d+) todo", ln)
if found: result(p, s)

# node --test TAP ("# pass 3", "# skipped 1" / "# skip 1") and spec reporter ("ℹ pass 3", "ℹ skipped 1")
found, p, s = False, 0, 0
for ln in lines:
    m = re.match(r"^\s*(?:#|ℹ) pass (\d+)\s*$", ln)
    if m: found = True; p += int(m.group(1)); continue
    m = re.match(r"^\s*(?:#|ℹ) skip(?:ped)? (\d+)\s*$", ln)
    if m: found = True; s += int(m.group(1))
if found: result(p, s)

# unittest: "Ran N tests" followed by "OK (skipped=M)" / "FAILED (failures=1, errors=2, skipped=3)"
found, p, s, ran = False, 0, 0, None
for ln in lines:
    m = re.match(r"^Ran (\d+) tests? in ", ln)
    if m: ran = int(m.group(1)); continue
    m = re.match(r"^(OK|FAILED)\b(?:\s*\((.*)\))?\s*$", ln)
    if m and ran is not None:
        det = m.group(2) or ""
        sk = num(r"skipped=(\d+)", det)
        bad = num(r"failures=(\d+)", det) + num(r"errors=(\d+)", det)
        found = True; p += ran - sk - bad; s += sk; ran = None
if found: result(p, s)

# pytest summary ("==== 3 passed, 1 skipped in 0.12s ====" or -q "3 passed, 1 skipped in 0.12s")
found, p, s = False, 0, 0
item = r"\d+ (?:passed|failed|skipped|errors?|deselected|xfailed|xpassed|warnings?)"
for ln in lines:
    if re.search(r"(?:^|[ =])" + item + r"(?:, " + item + r")* in [\d.]+s", ln):
        found = True
        p += num(r"(\d+) passed", ln); s += num(r"(\d+) skipped", ln)
if found: result(p, s)
sys.exit(1)
PY
}

# run_tests <root> <cmd>: sets T_EXIT T_PASSED T_SKIPPED, or dies when no summary can be parsed.
run_tests() {
  local out="$SCRATCH/test-output.txt" counts
  (cd "$1" && bash -c "$2") >"$out" 2>&1
  T_EXIT=$?
  counts="$(parse_counts "$out")" || { tail -n 20 "$out" >&2; die "could not parse pass/skip counts from: $2"; }
  T_PASSED="${counts% *}"; T_SKIPPED="${counts#* }"
}

# index <path> <lang>: symbol-index JSON on stdout; dies on unsupported output.
index() {
  local json
  if [ "$2" = "python" ]; then json="$(python3 -I "$SI_PY" "$1")"; else json="$(node "$SI_MJS" "$1")"; fi
  [ -n "$json" ] || die "symbol index failed for $1"
  if printf '%s' "$json" | jq -e 'has("unsupported")' >/dev/null; then
    die "unsupported: $(printf '%s' "$json" | jq -c .)"
  fi
  printf '%s\n' "$json"
}

lang_of() {
  local t="$1"
  if [ -d "$t" ]; then
    if [ -n "$(find "$t" -name '*.py' -not -path '*/node_modules/*' | head -n 1)" ]; then echo python; else echo js; fi
  else
    case "$t" in *.py) echo python ;; *) echo js ;; esac
  fi
}

cmd_baseline() {
  local root="" target="" test_cmd="" out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) root="${2-}"; shift 2 || usage ;;
      --target) target="${2-}"; shift 2 || usage ;;
      --test-cmd) test_cmd="${2-}"; shift 2 || usage ;;
      --out) out="${2-}"; shift 2 || usage ;;
      *) usage ;;
    esac
  done
  [ -n "$root" ] && [ -n "$target" ] && [ -n "$test_cmd" ] && [ -n "$out" ] || usage
  [ -d "$root" ] || die "root not found: $root"
  root="$(cd "$root" && pwd -P)"
  case "$target" in /*) ;; *) target="$root/$target" ;; esac
  [ -e "$target" ] || die "target not found: $target"
  local lang index_dir sym_json cyc_json
  lang="$(lang_of "$target")"
  if [ -d "$target" ]; then index_dir="$(cd "$target" && pwd -P)"; else index_dir="$(cd "$(dirname "$target")" && pwd -P)"; target="$index_dir/$(basename "$target")"; fi

  run_tests "$root" "$test_cmd"
  sym_json="$(index "$target" "$lang")" || exit 2
  cyc_json="$(index "$index_dir" "$lang")" || exit 2

  printf '%s' "$sym_json" > "$SCRATCH/symbols.json"
  local symbols
  symbols="$(python3 -I - "$SCRATCH/symbols.json" "$root" "$target" "$lang" <<'PY'
import json, os, sys
data = json.load(open(sys.argv[1])); root, target, lang = sys.argv[2], sys.argv[3], sys.argv[4]
def module(path):
    rel = os.path.relpath(os.path.realpath(path), root).replace(os.sep, "/")
    if lang != "python":
        return rel
    rel = rel[:-3] if rel.endswith(".py") else rel
    if rel.endswith("/__init__") or rel == "__init__":
        rel = rel[: -len("__init__")].rstrip("/")
    return rel.replace("/", ".")
# JS/TS interfaces and type aliases are erased at runtime: flagged "type" so verify resolves them statically (#4212).
erased = lambda s: lang != "python" and s.get("kind") in ("interface", "type")
out = sorted({(module(s.get("file", target)), s["name"], erased(s)) for s in data["symbols"] if s.get("public")})
print(json.dumps([dict({"module": m, "name": n}, **({"type": True} if t else {})) for m, n, t in out]))
PY
)" || die "cannot build symbol list"

  jq -nS --argjson exit "$T_EXIT" --argjson passed "$T_PASSED" --argjson skipped "$T_SKIPPED" \
    --argjson symbols "$symbols" --argjson cycles "$(printf '%s' "$cyc_json" | jq -c .cycles)" \
    --arg root "$root" --arg target "$target" --arg index_dir "$index_dir" --arg lang "$lang" --arg test_cmd "$test_cmd" \
    '{test:{exit:$exit,passed:$passed,skipped:$skipped},symbols:$symbols,cycles:$cycles,root:$root,target:$target,
      index_dir:$index_dir,lang:$lang,test_cmd:$test_cmd}' > "$out" || die "cannot write $out"
}

# resolve_symbols <baseline.json>: prints a JSON array of unresolved {module,name}.
resolve_symbols() {
  local root lang
  root="$(jq -r .root "$1")"; lang="$(jq -r .lang "$1")"
  jq -c .symbols "$1" > "$SCRATCH/want.json"
  if [ "$lang" = "python" ]; then
    (cd "$root" && python3 -I -B - "$SCRATCH/want.json" "$root" <<'PY'
import importlib, io, json, sys, contextlib
want = json.load(open(sys.argv[1])); sys.path.insert(0, sys.argv[2])
missing = []
for s in want:
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            obj = importlib.import_module(s["module"])
        for part in s["name"].split("."):
            obj = getattr(obj, part)
    except Exception:
        missing.append(s)
print(json.dumps(missing))
PY
    )
  else
    command -v node >/dev/null 2>&1 || die "node is required to resolve JS/TS symbols"
    (cd "$root" && node --input-type=module - "$SCRATCH/want.json" "$root" <<'JS'
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
const [want, root] = [JSON.parse(readFileSync(process.argv[2], "utf8")), process.argv[3]];
// Type-only names (interface/type alias, erased at runtime) resolve statically: the old module still exports the
// name by declaration, `export { ... }` list or `export ... from`, following `export * from` relative modules.
let ts = null;
for (const m of ["typescript", "ts-morph"]) {
  try { const r = createRequire(path.join(root, "noop.js"))(m); ts = m === "typescript" ? r : r.ts; if (typeof ts?.createSourceFile === "function") break; ts = null; } catch { /* next */ }
}
const exportsOf = (file, seen = new Set()) => {
  const names = new Set();
  if (!ts || seen.has(file) || !existsSync(file) || !statSync(file).isFile()) return names;
  seen.add(file);
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const exported = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;
  const resolve = (spec) => {
    const base = path.resolve(path.dirname(file), spec), stem = base.replace(/\.(m|c)?jsx?$/, "");
    for (const c of [base, ...[".ts", ".tsx", ".mts", ".cts", ".d.ts"].flatMap((x) => [stem + x, path.join(base, "index" + x)])]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
  };
  for (const st of src.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) names.add(el.name.text);
      else if (!st.exportClause && st.moduleSpecifier?.text?.startsWith(".")) { const f = resolve(st.moduleSpecifier.text); if (f) for (const n of exportsOf(f, seen)) names.add(n); }
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    } else if (st.name && ts.isIdentifier(st.name) && exported(st)) names.add(st.name.text);
  }
  return names;
};
const missing = [];
for (const s of want) {
  if (s.type) {
    if (!exportsOf(path.join(root, s.module)).has(s.name)) missing.push(s);
    continue;
  }
  try {
    let obj = await import(pathToFileURL(path.join(root, s.module)).href);
    for (const part of s.name.split(".")) {
      const next = obj?.[part] ?? obj?.prototype?.[part];
      if (next === undefined) throw new Error("unresolved");
      obj = next;
    }
  } catch { missing.push(s); }
}
process.stdout.write(JSON.stringify(missing) + "\n");
JS
    )
  fi
}

# logic_diff <root> <base> <head>: prints a JSON array of {file,line,text} for non-moved, non-import changed lines.
logic_diff() {
  local diff="$SCRATCH/diff.txt"
  git -C "$1" -c color.diff.old=red -c color.diff.new=green -c color.diff.oldMoved=magenta -c color.diff.newMoved=cyan \
    -c color.diff.oldMovedAlternative=magenta -c color.diff.newMovedAlternative=cyan \
    -c color.diff.whitespace=normal -c core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab \
    diff --color=always --color-moved=plain --no-renames --no-ext-diff "$2" "$3" -- > "$diff" \
    || die "git diff failed for $2..$3"
  python3 -I - "$diff" <<'PY'
import json, re, sys
ESC = re.compile(r"\x1b\[[0-9;]*m")
MOVED = ("\x1b[35m", "\x1b[36m")
PY_IMPORT = re.compile(r"^\s*(import\s+\S|from\s+\S+\s+import\b)")
JS_IMPORT = re.compile(r"^\s*(import\b|export\s+(type\s+)?(\*|\{).*\bfrom\b|export\s+\*)")
def opens_block(s):
    if re.match(r"^\s*from\s+\S+\s+import\s*\(", s) and ")" not in s:
        return ")"
    if re.match(r"^\s*(import|export)\s+(type\s+)?\{", s) and "}" not in s:
        return "}"
    return None
fails, path, old, in_hunk = [], None, None, False
lineno = {"-": 0, "+": 0}
block = {"-": None, "+": None}  # closing char of an open multi-line import, per side
for raw in open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n"):
    plain = ESC.sub("", raw)
    if plain.startswith("diff --git "):
        in_hunk, path, old = False, None, None; block = {"-": None, "+": None}; continue
    if not in_hunk and plain.startswith("--- "):
        old = plain[4:]; old = old[2:] if old.startswith("a/") else old; continue
    if not in_hunk and plain.startswith("+++ "):
        new = plain[4:]; path = old if new == "/dev/null" else (new[2:] if new.startswith("b/") else new); continue
    m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", plain)
    if m:
        in_hunk = True; lineno = {"-": int(m.group(1)), "+": int(m.group(2))}; continue
    if not in_hunk or not plain or plain.startswith("\\"):
        continue
    sign, body = plain[0], plain[1:]
    sides = ("-", "+") if sign == " " else (sign,)
    is_import = False
    for side in sides:
        if block[side]:
            is_import = True
            if block[side] in body:
                block[side] = None
        elif PY_IMPORT.match(body) or JS_IMPORT.match(body):
            is_import = True
            block[side] = opens_block(body)
    if sign in "+-":
        if not raw.startswith(MOVED) and body.strip() and not is_import:
            fails.append({"kind": "logic-diff", "file": path, "line": lineno[sign], "text": body.strip()[:200]})
    for side in sides:
        lineno[side] += 1
print(json.dumps(fails))
PY
}

cmd_verify() {
  local baseline="" base="" head="HEAD"
  while [ $# -gt 0 ]; do
    case "$1" in
      --baseline) baseline="${2-}"; shift 2 || usage ;;
      --base) base="${2-}"; shift 2 || usage ;;
      --head) head="${2-}"; shift 2 || usage ;;
      *) usage ;;
    esac
  done
  [ -n "$baseline" ] && [ -n "$base" ] || usage
  [ -f "$baseline" ] || die "baseline file not found: $baseline"
  jq -e '.test and .symbols and .cycles and .root and .index_dir and .lang and .test_cmd' "$baseline" >/dev/null 2>&1 \
    || die "not a refactor-verify baseline: $baseline"
  local root index_dir lang
  root="$(jq -r .root "$baseline")"; index_dir="$(jq -r .index_dir "$baseline")"; lang="$(jq -r .lang "$baseline")"
  [ -d "$root" ] || die "baseline root not found: $root"
  git -C "$root" rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "unknown ref: $base"
  git -C "$root" rev-parse --verify --quiet "$head^{commit}" >/dev/null || die "unknown ref: $head"

  local diff_fails missing cycles_after
  diff_fails="$(logic_diff "$root" "$base" "$head")" || exit 2
  run_tests "$root" "$(jq -r .test_cmd "$baseline")"
  missing="$(resolve_symbols "$baseline")" || die "symbol resolution failed"
  if [ -d "$index_dir" ]; then
    cycles_after="$(index "$index_dir" "$lang" | jq -c .cycles)" || exit 2
  else
    cycles_after='[]'
  fi

  jq -nS --slurpfile b "$baseline" --argjson diff "$diff_fails" --argjson missing "$missing" \
    --argjson cycles "$cycles_after" --argjson exit "$T_EXIT" --argjson passed "$T_PASSED" --argjson skipped "$T_SKIPPED" '
    ($b[0].test) as $before | {exit:$exit,passed:$passed,skipped:$skipped} as $after
    | ( $diff
      + [$missing[] | {kind:"missing-symbol",module,name}]
      + (if $before.passed != $after.passed or $before.skipped != $after.skipped or ($before.exit == 0 and $after.exit != 0)
         then [{kind:"count-changed",before:$before,after:$after}] else [] end)
      + [($cycles - $b[0].cycles)[] | {kind:"new-cycle",cycle:.}] ) as $f
    | {ok:($f|length == 0),failures:$f}' > "$SCRATCH/result.json" || die "cannot build result"
  cat "$SCRATCH/result.json"
  jq -e .ok "$SCRATCH/result.json" >/dev/null && return 0
  return 1
}

case "${1-}" in
  baseline) shift; cmd_baseline "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  *) usage ;;
esac
