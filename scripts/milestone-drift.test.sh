#!/usr/bin/env bash
# milestone-drift.test.sh — cases for scripts/milestone-drift.sh (forge#4161).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/milestone-drift.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/milestone-drift-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }

new_repo() {
  rm -rf "$TMP/w"; mkdir -p "$TMP/w"; cd "$TMP/w" || exit 1
  git init -q -b staging; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
}
commit() { git add -A; git commit -qm "$1"; }
pj() { mkdir -p "$1"; printf '%s\n' "$2" > "$1/package.json"; }
lines() { i=0; while [ "$i" -lt "$2" ]; do echo "export const v$i = $i;"; i=$((i+1)); done >> "$1"; }

# ---- fixture milestone: two packages, an app, generated files ----
new_repo
printf '{"name":"root","private":true,"workspaces":["apps/*","packages/*"]}\n' > package.json
pj apps/web '{"name":"@s/web","dependencies":{"@s/db":"workspace:*"}}'
pj packages/db '{"name":"@s/db"}'
pj packages/core '{"name":"@s/core"}'
mkdir -p apps/web/src packages/db/src packages/core/src
echo "export const a = 1;" > apps/web/src/a.ts
echo "export const d = 1;" > packages/db/src/d.ts
echo "export const c = 1;" > packages/core/src/c.ts
printf 'packages/db/src/schema.gen.ts linguist-generated\n' > .gitattributes
commit base
FORK_SHA=$(git rev-parse HEAD)
git checkout -q -b milestone/m1
# lane 1: two app files import the db package, db grows a lot
echo "import { d } from '@s/db';" > apps/web/src/one.ts
echo "import { d } from '@s/db';" > apps/web/src/two.ts
lines packages/db/src/big.ts 40
commit "lane 1"
# lane 2: a new package edge web -> core, a third db import, generated and globbed files grow
pj apps/web '{"name":"@s/web","dependencies":{"@s/db":"workspace:*","@s/core":"workspace:*"}}'
echo "import { d } from '@s/db';" > apps/web/src/three.ts
echo "import { c } from '@s/core';" > apps/web/src/four.ts
lines packages/db/src/schema.gen.ts 500
mkdir -p data; lines data/fixtures.json 300
lines apps/web/src/a.ts 5
commit "lane 2"
# staging moves on after the fork: never part of the milestone's drift
git checkout -q staging; lines packages/core/src/c.ts 900; commit "staging only"; git checkout -q milestone/m1

OUT="$(bash "$S" m1)"; rc=$?
eq "rc" "$rc" 0
eq "fork point" "$(printf '%s' "$OUT" | jq -r '.fork_point')" "$FORK_SHA"
eq "refs default to the local staging and milestone branches" "$(q '[.base, .head]')" '["staging","milestone/m1"]'
eq "pair growth" "$(q '[.pairs[] | {from, to, growth}]')" '[{"from":"@s/web","to":"@s/db","growth":3},{"from":"@s/web","to":"@s/core","growth":1}]'
eq "pair files" "$(q '.pairs[0].files')" '["apps/web/src/one.ts","apps/web/src/three.ts","apps/web/src/two.ts"]'
eq "new package edges" "$(q '[.new_edges[] | [.from, .to, .kind]]')" '[["@s/web","@s/core","dependencies"]]'
eq "top files (generated excluded, staging-only change absent)" "$(q '[.files[] | [.path, .growth]] | .[:2]')" '[["data/fixtures.json",300],["packages/db/src/big.ts",40]]'
eq "generated file excluded" "$(q '.excluded')" '["packages/db/src/schema.gen.ts"]'
eq "packages by growth" "$(q '[.packages[] | [.name, .path, .growth]]')" '[["@s/db","packages/db",40],["@s/web","apps/web",9]]'
eq "file outside packages has no package" "$(q '.files[0].package')" 'null'
eq "no thresholds, no crossings" "$(q '[.crossings, .thresholds]')" '[[],{"pair_growth":null,"package_lines":null,"file_lines":null}]'
eq "no jscpd, no duplication" "$(PATH="/usr/bin:/bin" bash "$S" m1 | jq -c '.duplication')" 'null'

# forge.yaml glob exclusion and thresholds from the orchestrate.drift block
cat > forge.yaml <<'EOF'
branches:
  staging: staging
orchestrate:
  drift:
    pair_growth: 2
    package_lines: 30
    file_lines: 250
    generated_globs: data/*, *.lock
EOF
OUT="$(bash "$S" m1)"
eq "glob excluded" "$(q '.excluded')" '["data/fixtures.json","packages/db/src/schema.gen.ts"]'
eq "thresholds read from forge.yaml" "$(q '.thresholds')" '{"pair_growth":2,"package_lines":30,"file_lines":250}'
eq "crossings" "$(q '[.crossings[] | [.kind, .key, .value, .threshold, .package_path]]')" '[["pair_growth","@s/web->@s/db",3,2,"apps/web"],["package_lines","@s/db",40,30,"packages/db"]]'
# flags override forge.yaml; below every threshold nothing crosses
OUT="$(bash "$S" m1 --pair-growth 3 --package-lines 40 --file-lines 40)"
eq "at the threshold is not a crossing" "$(q '.crossings')" '[]'
rm forge.yaml

# --summary attributes PRs to pairs
printf '{"v":1,"pairs":{"@s/web:@s/db":{"files_added":3,"files_removed":0,"prs":[11,12]}}}\n' > "$TMP/summary.json"
OUT="$(bash "$S" m1 --summary "$TMP/summary.json")"
eq "pair PRs from the summary" "$(q '.pairs[0].prs')" '[11,12]'

# text format
TXT="$(bash "$S" milestone/m1 --format text --file-lines 100)"
case "$TXT" in *"@s/web -> @s/db  +3"*"file_lines data/fixtures.json: 300 > 100"*) ok ;; *) bad "text report: $TXT" ;; esac

# optional jscpd: used only when on PATH and head is the working tree
mkdir -p "$TMP/bin"
cat > "$TMP/bin/jscpd" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --output) mkdir -p "$2"; printf '{"statistics":{"total":{"clones":2,"duplicatedLines":14,"percentage":3.5}}}' > "$2/jscpd-report.json"; shift 2 ;; *) shift ;; esac; done
EOF
chmod +x "$TMP/bin/jscpd"
eq "jscpd statistics" "$(PATH="$TMP/bin:$PATH" bash "$S" m1 | jq -c '.duplication')" '{"clones":2,"duplicated_lines":14,"percentage":3.5}'
git checkout -q staging
eq "jscpd skipped when head is not checked out" "$(PATH="$TMP/bin:$PATH" bash "$S" m1 | jq -c '.duplication')" 'null'

# ---- repo without workspaces: no packages, pairs empty ----
new_repo
echo "x" > a.txt; commit base
git checkout -q -b milestone/plain; lines a.txt 3; commit change
OUT="$(bash "$S" plain)"
eq "plain repo" "$(q '[.pairs, .new_edges, .packages, [.files[] | .path]]')" '[[],[],[],["a.txt"]]'

# ---- usage errors exit 2 ----
bash "$S" >/dev/null 2>&1; eq "no slug" "$?" 2
bash "$S" nope >/dev/null 2>&1; eq "missing milestone branch" "$?" 2
bash "$S" plain --pair-growth x >/dev/null 2>&1; eq "bad threshold" "$?" 2
bash "$S" plain --format yaml >/dev/null 2>&1; eq "bad format" "$?" 2

echo "milestone-drift: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
