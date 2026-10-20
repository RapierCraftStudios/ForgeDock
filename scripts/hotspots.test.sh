#!/usr/bin/env bash
# hotspots.test.sh — cases for scripts/hotspots.sh (forge#4195).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hotspots.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/hotspots-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }
HAVE_YQ=1; yq -o=json '.' - <<<'a: 1' 2>/dev/null | grep -q '"a"' || HAVE_YQ=0

new_repo() {
  rm -rf "$TMP/w"; mkdir -p "$TMP/w"; cd "$TMP/w" || exit 1
  git init -q -b main; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
}
commit() { git add -A; git commit -qm "$1"; }
lines() { i=0; : > "$1"; while [ $i -lt "$2" ]; do echo "l$i" >> "$1"; i=$((i+1)); done; }

# ---- 1. exact lines, commits_90d, hotspot, over; old commits outside the window are not counted ----
new_repo
lines big.py 2100; GIT_COMMITTER_DATE="2000-01-01T00:00:00Z" GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" commit old
echo x >> big.py; commit c1
echo y >> big.py; lines small.py 10; commit c2
OUT="$(bash "$S" big.py ./small.py missing/gone.py)"; rc=$?
eq "rc" "$rc" 0
eq "defaults" "$(q '[.enabled,.file_lines,.growth_lines]')" '[true,2000,150]'
eq "big facts" "$(q '.files[0]')" '{"path":"big.py","lines":2102,"commits_90d":2,"hotspot":4204,"over":true,"excluded":false,"base_lines":null,"growth":null}'
eq "small facts (./ stripped)" "$(q '.files[1] | [.path,.lines,.commits_90d,.over]')" '["small.py",10,1,false]'
eq "missing file" "$(q '.files[2] | [.path,.lines,.commits_90d,.over]')" '["missing/gone.py",0,0,false]'
OUT="$(bash "$S")"; eq "no paths" "$(q '.files')" '[]'

# ---- 2. --base growth: merge-base side, new file counts from 0 ----
git checkout -q -b feat
lines extra 200; cat extra >> big.py; lines fresh.py 30; commit grow
OUT="$(bash "$S" --base main -- big.py fresh.py)"
eq "growth" "$(q '.files[0] | [.base_lines,.growth,.lines]')" '[2102,200,2302]'
eq "new file growth" "$(q '.files[1] | [.base_lines,.growth]')" '[0,30]'
bash "$S" --base no-such-ref big.py >/dev/null 2>&1; eq "bad ref exit" "$?" 2
bash "$S" --base >/dev/null 2>&1; eq "usage exit" "$?" 2
bash "$S" --bogus x >/dev/null 2>&1; eq "unknown option exit" "$?" 2

# ---- 3. exclusions: linguist-generated, linguist-vendored, forge.yaml globs ----
mkdir -p gen vendor/lib dist
lines gen/api.py 2500; lines vendor/lib/x.js 2500; lines dist/bundle.js 2500
printf 'gen/** linguist-generated\nvendor/** linguist-vendored=true\n' > .gitattributes
commit gen
OUT="$(bash "$S" gen/api.py vendor/lib/x.js dist/bundle.js big.py)"
eq "attr exclusions" "$(q '[.files[] | .excluded]')" '[true,true,false,false]'
if [ "$HAVE_YQ" = 1 ]; then
  printf 'maintenance:\n  hotspot:\n    file_lines: 100\n    growth_lines: 5\n    exclude_globs: ["dist/*", "*.lock"]\n' > forge.yaml
  OUT="$(bash "$S" dist/bundle.js small.py big.py)"
  eq "config thresholds" "$(q '[.file_lines,.growth_lines]')" '[100,5]'
  eq "glob exclusion" "$(q '[.files[] | .excluded]')" '[true,false,false]'
  eq "over uses configured file_lines" "$(q '[.files[] | .over]')" '[true,false,true]'
  printf 'maintenance:\n  hotspot:\n    enabled: false\n' > forge.yaml
  OUT="$(bash "$S" big.py)"
  eq "opt-out" "$(q '[.enabled,.files]')" '[false,[]]'
  printf 'maintenance:\n  hotspot:\n    file_lines: nope\n' > forge.yaml
  OUT="$(bash "$S" big.py)"; eq "bad value falls back" "$(q '.file_lines')" 2000
  rm -f forge.yaml
else
  echo "SKIP: forge.yaml cases need mikefarah yq v4"
fi
# yq missing: defaults, still exit 0
mkdir -p "$TMP/noyq"; printf '#!/bin/sh\nexit 1\n' > "$TMP/noyq/yq"; chmod +x "$TMP/noyq/yq"
printf 'maintenance:\n  hotspot:\n    file_lines: 100\n' > forge.yaml
OUT="$(PATH="$TMP/noyq:$PATH" bash "$S" big.py)"; eq "yq unusable: defaults" "$(q '.file_lines')" 2000
rm -f forge.yaml

# ---- 4. 30k-commit repo: exact counts under 1 s, no blob reads, no network ----
rm -rf "$TMP/big"; git init -q -b main "$TMP/big"; cd "$TMP/big" || exit 1
now=$(date +%s)
awk -v now="$now" 'BEGIN { for (i = 1; i <= 30000; i++) {
  ts = (i > 27000) ? now - (30000 - i) * 60 : now - 200 * 86400 - (27000 - i) * 600
  print "commit refs/heads/main"; print "mark :" i; print "committer t <t@e> " ts " +0000"; print "data 1"; print "x"
  if (i > 1) print "from :" (i - 1)
  f = (i % 10 == 0) ? "hot.py" : "other" (i % 50) ".txt"; c = "line " i
  print "M 644 inline " f; print "data " length(c) + 1; print c; print "" } }' | git fast-import --quiet
git checkout -q main
mkdir -p "$TMP/bin"
for t in gh curl wget npm npx pnpm yarn nc ssh; do printf '#!/bin/sh\necho "%s" >> "%s/net.log"\nexit 1\n' "$t" "$TMP" > "$TMP/bin/$t"; chmod +x "$TMP/bin/$t"; done
best=""
for _ in 1 2 3; do
  start=$(date +%s%N 2>/dev/null)
  OUT="$(PATH="$TMP/bin:$PATH" GIT_TRACE2_EVENT="$TMP/trace.json" bash "$S" hot.py other1.txt other2.txt other3.txt)"
  end=$(date +%s%N 2>/dev/null)
  case "$start$end" in *N*|"") best=0; break ;; esac
  ms=$(( (end - start) / 1000000 )); if [ -z "$best" ] || [ "$ms" -lt "$best" ]; then best=$ms; fi
done
eq "30k exact commits" "$(q '[.files[] | .commits_90d]')" '[300,60,60,60]'
eq "30k exact lines" "$(q '[.files[] | .lines]')" '[1,1,1,1]'
if [ "$best" -lt 1000 ]; then ok; else bad "30k-commit run took ${best} ms (limit 1000)"; fi
grep -q '"rev-list"' "$TMP/trace.json" && ok || bad "git trace not captured"
if grep -qE '"(cat-file|show)"' "$TMP/trace.json"; then bad "blob read without --base"; else ok; fi
if [ -e "$TMP/net.log" ]; then bad "network tool invoked: $(tr '\n' ' ' < "$TMP/net.log")"; else ok; fi

echo "hotspots.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
