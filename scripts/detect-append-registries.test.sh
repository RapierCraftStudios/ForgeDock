#!/usr/bin/env bash
# detect-append-registries.test.sh — fixture cases for scripts/detect-append-registries.sh (forge#3969).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DA="$ROOT/scripts/detect-append-registries.sh"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v git >/dev/null 2>&1 || { echo "detect-append-registries.test.sh: git missing, skipped"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
W="$TMP/w"
g() { git -C "$W" -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
git init -q "$W" 2>/dev/null; g checkout -q -b main 2>/dev/null
mkdir -p "$W/ci"
printf 'test-1\ntest-2\n' > "$W/ci/tests.list"; printf 'a: 1\n' > "$W/conf.yml"; printf 'x\n' > "$W/other.txt"
g add -A >/dev/null; g commit -q -m seed >/dev/null

# 1. two PRs appending to the same registry conflict without union and merge cleanly with it (ac-3 fixture)
g checkout -q -b pr1 main 2>/dev/null; printf 'test-pr1\n' >> "$W/ci/tests.list"; g add -A >/dev/null; g commit -q -m pr1 >/dev/null
g checkout -q -b pr2 main 2>/dev/null; printf 'test-pr2\n' >> "$W/ci/tests.list"; g add -A >/dev/null; g commit -q -m pr2 >/dev/null
g checkout -q pr1 2>/dev/null
if g merge -q --no-edit pr2 >/dev/null 2>&1; then bad "plain merge of two same-spot appends should conflict"; else ok; fi
g merge --abort >/dev/null 2>&1
printf 'ci/tests.list merge=union\n' > "$W/.git/info/attributes"
if g merge -q --no-edit pr2 >/dev/null 2>&1 && grep -qxF test-pr1 "$W/ci/tests.list" && grep -qxF test-pr2 "$W/ci/tests.list"; then ok; else bad "union merge of two same-spot appends should be clean with both lines"; fi
rm -f "$W/.git/info/attributes"

# 2. --check-union accepts a plain one-line-per-entry list, existing in the repo or not
out=$(bash "$DA" --check-union ci/tests.list --repo "$W" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "check-union ci/tests.list expected rc 0, got $rc ($out)"
out=$(bash "$DA" --check-union new/dir/registry.txt --repo "$W" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "check-union on a new path expected rc 0, got $rc ($out)"
# the probe never touches the caller's repo
[ -z "$(g status --porcelain)" ] && [ ! -e "$W/.git/info/attributes" ] && ok || bad "check-union modified the caller repo"

# 3. structured files are rejected
for f in conf.yml data.json pyproject.toml package-lock.json notes.md; do
  out=$(bash "$DA" --check-union "$f" --repo "$W" 2>&1); rc=$?
  [ "$rc" -eq 1 ] && ok || bad "check-union $f expected rc 1, got $rc"
done
# unsafe paths
out=$(bash "$DA" --check-union ../escape --repo "$W" 2>&1); rc=$?; [ "$rc" -eq 2 ] && ok || bad "parent path expected rc 2, got $rc"
out=$(bash "$DA" --check-union 'a b.txt' --repo "$W" 2>&1); rc=$?; [ "$rc" -eq 1 ] && ok || bad "whitespace path expected rc 1, got $rc"
out=$(bash "$DA" 2>&1); rc=$?; [ "$rc" -eq 2 ] && ok || bad "no mode expected rc 2, got $rc"

# 4. --detect ranks an add-only, high-churn file and ignores a file with deletions or low churn
i=0
while [ "$i" -lt 6 ]; do
  i=$((i+1)); printf 'line-%s\n' "$i" >> "$W/ci/tests.list"
  printf 'v%s\n' "$i" > "$W/other.txt"   # rewritten each time: add + delete
  g add -A >/dev/null; g commit -q -m "c$i" >/dev/null
done
out=$(bash "$DA" --detect --repo "$W" --min-commits 5 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "detect expected rc 0, got $rc"
printf '%s\n' "$out" | grep -qF ' ci/tests.list' && ok || bad "detect should list ci/tests.list (got: $out)"
printf '%s\n' "$out" | grep -qF ' other.txt' && bad "detect must not list a rewritten file (got: $out)" || ok
printf '%s\n' "$out" | grep -qF ' conf.yml' && bad "detect must not list a low-churn file (got: $out)" || ok

echo "detect-append-registries.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
