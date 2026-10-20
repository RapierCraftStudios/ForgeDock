#!/usr/bin/env bash
# maintenance-scan.test.sh — cases for scripts/maintenance-scan.sh (forge#4197). Throwaway repos under $TMPDIR, no network.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN="$SCRIPT_DIR/maintenance-scan.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/maintenance-scan-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
PASS=0 FAILN=0
ok() { PASS=$((PASS + 1)); }
fail() { FAILN=$((FAILN + 1)); echo "FAIL: $*"; }
check() { if [ "$2" = "$3" ]; then ok; else fail "$1: expected [$3] got [$2]"; fi; }

# A PATH without any dead-code tool (a host install must not leak into the cases).
BIN="$TMP/bin"; mkdir -p "$BIN"
for t in git jq awk sed tr wc sort comm uniq cut grep cksum mktemp xargs cat cp mkdir rm dirname head tail env bash; do
  p=$(command -v "$t") && ln -sf "$p" "$BIN/$t"
done
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
NONE="$TMP/none.json"; echo '[]' > "$NONE"
scan() { PATH="$BIN" bash "$SCAN" --open-issues "${OPEN:-$NONE}" --out-dir "$TMP/out" "$@"; }

R="$TMP/repo"; mkdir -p "$R"; cd "$R" || exit 1
git init -q . && echo "# r" > README.md && git add . && git commit -qm init

# ---- 1. below thresholds: [] ----
seq 1 50 > small.py; git add . && git commit -qm small
check "below thresholds" "$(scan --file-lines 100)" "[]"

# ---- 2. one over-threshold file: one refactor:split candidate with numbers ----
seq 1 300 > big.py; git add . && git commit -qm big1; echo x >> big.py; git commit -qam big2
seq 1 400 > gen.py; echo "gen.py linguist-generated" > .gitattributes; git add . && git commit -qm gen
out=$(scan --file-lines 100)
check "one hotspot" "$(printf '%s' "$out" | jq -c '[.[] | [.kind, .key]]')" '[["refactor:split","big.py"]]'
check "title numbers" "$(printf '%s' "$out" | jq -r '.[0].title')" "split big.py (301 loc, 2 commits/90d)"
check "numbers" "$(printf '%s' "$out" | jq -c '.[0].numbers')" '{"lines":301,"commits":2,"days":90,"threshold":100}'
check "labels" "$(printf '%s' "$out" | jq -c '.[0].labels')" '["maintenance","refactor:split"]'
bf=$(printf '%s' "$out" | jq -r '.[0].body_file')
check "body marker" "$(grep -c 'FORGE:MAINT:refactor:split:big.py' "$bf")" "1"
check "integrity marker" "$(grep -cE '<!-- FORGE:BODY-INTEGRITY:[^>]+ -->' "$bf")" "1"
# thresholds from forge.yaml (block form)
printf 'maintenance:\n  enabled: true\n  file_lines: 100\n' > forge.yaml; git add . && git commit -qm cfg
check "forge.yaml threshold" "$(scan | jq -c '[.[].key]')" '["big.py"]'
# a sub-map's key (maintenance.hotspot.file_lines, forge#4195) is not the section's own threshold
printf 'maintenance:\n  enabled: true\n  hotspot:\n    file_lines: 5000\n  file_lines: 100\n' > forge.yaml; git add . && git commit -qm cfg2
check "sub-map key ignored" "$(scan | jq -c '[.[].key]')" '["big.py"]'

# ---- 3. dedup: an open issue carrying the marker, or the exact title ----
jq -n --arg b "x <!-- FORGE:MAINT:refactor:split:big.py --> y" '[{number: 1, title: "other", body: $b}]' > "$TMP/open1.json"
check "dedup by marker" "$(OPEN="$TMP/open1.json" scan)" "[]"
jq -n '[{number: 2, title: "split big.py (301 loc, 2 commits/90d)", body: ""}]' > "$TMP/open2.json"
check "dedup by title" "$(OPEN="$TMP/open2.json" scan)" "[]"

# ---- 4. oversized doc ----
awk 'BEGIN { for (i = 0; i < 3000; i++) print "doc line padding padding padding" }' > ARCH.md; git add . && git commit -qm doc
check "doc candidate" "$(scan --doc-kb 64 | jq -c '[.[] | select(.kind == "docs") | [.key, .numbers.kb]]')" '[["ARCH.md",97]]'
check "doc under budget" "$(scan --doc-kb 200 | jq -c '[.[] | select(.kind == "docs")]')" "[]"

# ---- 5. dead code from a stubbed knip (only when package.json exists) ----
printf '#!/usr/bin/env bash\nprintf "a.ts: x\\nb.ts: y\\nc.ts: z\\n"\n' > "$BIN/knip"; chmod +x "$BIN/knip"
check "knip needs package.json" "$(scan | jq -c '[.[] | select(.kind == "dead-code")]')" "[]"
echo '{"name":"r"}' > package.json; git add . && git commit -qm pkg
check "knip candidate" "$(scan | jq -c '[.[] | select(.kind == "dead-code") | [.key, .numbers.findings, .title]]')" '[["knip",3,"remove 3 unused (knip)"]]'
rm -f "$BIN/knip"

# ---- 6. determinism and /issue argument lines ----
a=$(scan); b=$(scan)
check "deterministic" "$a" "$b"
args=$(scan --print-issue-args)
check "issue-arg lines" "$(printf '%s\n' "$args" | grep -c '^/issue --title ".*" --body-file ".*" --label maintenance --label ')" "$(printf '%s' "$a" | jq length)"

# ---- 7. a workspace package cycle ----
W="$TMP/ws"; mkdir -p "$W"; cd "$W" || exit 1
git init -q . && echo "# w" > README.md && git add . && git commit -qm init
echo '{"name":"root","private":true,"workspaces":["packages/*"]}' > package.json
mkdir -p packages/a packages/b packages/c
echo '{"name":"@s/a","dependencies":{"@s/b":"*"}}' > packages/a/package.json
echo '{"name":"@s/b","dependencies":{"@s/a":"*"}}' > packages/b/package.json
echo '{"name":"@s/c","dependencies":{"@s/a":"*"}}' > packages/c/package.json
git add . && git commit -qm ws
check "package cycle" "$(scan | jq -c '[.[] | select(.kind == "refactor") | [.key, .title]]')" '[["@s/a->@s/b","untangle @s/a <-> @s/b (pkg cycle)"]]'

# ---- 8. usage and no model call ----
PATH="$BIN" bash "$SCAN" --bogus >/dev/null 2>&1; check "usage exit" "$?" "2"
check "no LLM invocation" "$(grep -nEi '\b(claude|codex|anthropic|openai|ollama)\b' "$SCAN" | grep -v '^[0-9]*:#' || true)" ""

echo "maintenance-scan.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
