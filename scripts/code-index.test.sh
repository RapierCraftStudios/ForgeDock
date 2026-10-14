#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests for scripts/code-index.sh: the index covers the tracked tree only — nested worktrees (.forge/worktrees,
# .claude/worktrees) and virtualenvs inside the checkout are never walked (forge#4126) — and the one-pass caller
# graph still maps callees to their callers. Run: bash scripts/code-index.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
SCRIPT="${CODE_INDEX_UNDER_TEST:-$ROOT/scripts/code-index.sh}"   # override to run the suite against another copy
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/code-index-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# mksrc <dir> — a small Python + JS source tree; helper_fn is defined in app.py and called from use.py.
mksrc() {
  mkdir -p "$1/src" "$1/web"
  printf 'def helper_fn():\n    return helper_fn()\n\nclass Widget:\n    pass\n' > "$1/src/app.py"
  printf 'from src.app import helper_fn\n\n\ndef run_it():\n    return helper_fn()\n' > "$1/src/use.py"
  printf "import x from './y'\nexport function renderPage() {}\n" > "$1/web/page.js"
}

# --- 1. git checkout with nested worktrees and a venv inside it ---
REPO="$WORK/repo"; mksrc "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A; git -C "$REPO" commit -qm init
git -C "$REPO" worktree add -q -b wt1 "$REPO/.claude/worktrees/one" 2>/dev/null
git -C "$REPO" worktree add -q -b wt2 "$REPO/.forge/worktrees/two" 2>/dev/null
printf 'def worktree_only_fn():\n    helper_fn()\n' > "$REPO/.claude/worktrees/one/src/wt_only.py"
printf 'def forge_wt_only_fn():\n    helper_fn()\n' > "$REPO/.forge/worktrees/two/src/fwt_only.py"
mkdir -p "$REPO/.venv/lib"; printf 'def venv_only_fn():\n    helper_fn()\n' > "$REPO/.venv/lib/site.py"

OUT="$WORK/out"
bash "$SCRIPT" --repo-path "$REPO" --output "$OUT" > "$WORK/log" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then ok; else bad "build exit $rc: $(head -c 400 "$WORK/log")"; fi
C=$(ls -d "$OUT"/*/ 2>/dev/null | head -n 1)
for f in symbols imports callers file_domain; do
  if [ -s "$C/$f.tsv" ]; then ok; else bad "$f.tsv is empty"; fi
  if grep -qE '\.claude/|\.forge/|\.venv/|worktree_only_fn|forge_wt_only_fn|venv_only_fn' "$C/$f.tsv" 2>/dev/null; then
    bad "$f.tsv indexed a nested worktree or venv: $(grep -E '\.claude/|\.forge/|\.venv/|_only_fn' "$C/$f.tsv" | head -n 3 | tr '\n' ' ')"
  else ok; fi
done
if grep -q '^helper_fn	src/app.py	1	' "$C/symbols.tsv"; then ok; else bad "helper_fn symbol missing or path not relative: $(cat "$C/symbols.tsv")"; fi
if grep -q '"files": 3' "$C/index.json"; then ok; else bad "file count should be the 3 tracked files: $(grep '"files":' "$C/index.json" | head -n 1)"; fi

# --- 2. one-pass caller graph ---
if grep -q '^helper_fn	src/use.py	5$' "$C/callers.tsv"; then ok; else bad "helper_fn caller src/use.py:5 missing: $(cat "$C/callers.tsv")"; fi
if grep -q '^helper_fn	src/app.py	' "$C/callers.tsv"; then bad "the defining file must not be listed as a caller"; else ok; fi
n=$(grep -c '^helper_fn	src/use.py	' "$C/callers.tsv")
if [ "$n" -eq 1 ]; then ok; else bad "one caller row per (symbol, file), got $n"; fi

# --- 3. cache hit on unchanged HEAD ---
bash "$SCRIPT" --repo-path "$REPO" --output "$OUT" > "$WORK/log2" 2>&1
if grep -q "Cache hit" "$WORK/log2"; then ok; else bad "second build should be a cache hit"; fi

# --- 4. outside git: pruned find fallback ---
PLAIN="$WORK/plain"; mksrc "$PLAIN"
mkdir -p "$PLAIN/.venv/lib" "$PLAIN/.claude/worktrees/x/src"
printf 'def venv_only_fn():\n    pass\n' > "$PLAIN/.venv/lib/site.py"
printf 'def worktree_only_fn():\n    pass\n' > "$PLAIN/.claude/worktrees/x/src/w.py"
bash "$SCRIPT" --repo-path "$PLAIN" --output "$WORK/out2" > "$WORK/log3" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then ok; else bad "non-git build exit $rc"; fi
C2=$(ls -d "$WORK"/out2/*/ 2>/dev/null | head -n 1)
if grep -q '^helper_fn	src/app.py	' "$C2/symbols.tsv" 2>/dev/null; then ok; else bad "non-git build missed helper_fn"; fi
if grep -qE 'venv_only_fn|worktree_only_fn' "$C2/symbols.tsv" 2>/dev/null; then bad "non-git build walked .venv/.claude"; else ok; fi

echo "code-index tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
