#!/usr/bin/env bash
# structure-delta.test.sh — cases for scripts/structure-delta.sh (forge#4159).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/structure-delta.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/structure-delta-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }

new_repo() {
  rm -rf "$TMP/w"; mkdir -p "$TMP/w"; cd "$TMP/w" || exit 1
  git init -q; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
}
commit() { git add -A; git commit -qm "$1"; }
pj() { mkdir -p "$1"; printf '%s\n' "$2" > "$1/package.json"; }

# ---- 1. single-package repo: {} and exit 0 ----
new_repo
printf '{"name":"solo","dependencies":{"left-pad":"1"}}\n' > package.json
mkdir -p src; echo "import x from 'left-pad';" > src/a.ts; commit base
git checkout -q -b feat; echo "import y from 'solo/x';" >> src/a.ts; commit change
OUT="$(bash "$S" master...feat 2>/dev/null || bash "$S" main...feat)"; rc=$?
eq "single-package rc" "$rc" 0
eq "single-package empty JSON" "$OUT" "{}"
# workspaces declared but no package matches: still {}
printf '{"name":"solo","workspaces":["packages/*"]}\n' > package.json; commit ws
OUT="$(bash "$S" HEAD~1 HEAD)"; eq "workspaces with no packages" "$OUT" "{}"

# ---- 2. monorepo fixture ----
new_repo
printf '{"name":"root","private":true,"workspaces":["apps/*","packages/*"],"dependencies":{"@scope/db":"1"}}\n' > package.json
pj apps/web '{"name":"@scope/web","dependencies":{"@scope/db":"workspace:*","@scope/old":"workspace:*","react":"18"}}'
pj packages/db '{"name":"@scope/db","dependencies":{"pg":"8"}}'
pj packages/x '{"name":"@scope/x"}'
pj packages/old '{"name":"@scope/old"}'
pj packages/core '{"name":"@scope/core"}'
mkdir -p apps/web/src apps/web/test
echo "export const a = 1;" > apps/web/src/existing.ts
echo "import { db } from '@scope/old';" > apps/web/src/legacy.ts
commit base
BASE_SHA=$(git rev-parse HEAD)
git checkout -q -b feat
# edges: added (db -> core), dev-only (x -> db), removed (web -> old), non-workspace ignored (db -> zod), root ignored
pj packages/db '{"name":"@scope/db","dependencies":{"pg":"8","zod":"3","@scope/core":"workspace:*"}}'
pj packages/x '{"name":"@scope/x","devDependencies":{"@scope/db":"workspace:*"}}'
pj apps/web '{"name":"@scope/web","dependencies":{"@scope/db":"workspace:*","react":"18"}}'
# imports
cat > apps/web/src/value.ts <<'EOF'
import { db } from "@scope/db";
import type { Row } from '@scope/core';
EOF
echo 'const m = await import("@scope/x");' > apps/web/src/dyn.ts
echo "import { sub } from '@scope/x/sub';" > apps/web/src/sub.ts
echo "import { o } from '@scope-other/x';" > apps/web/src/other.ts
echo "export type { T } from '@scope/db';" > apps/web/src/typeonly.ts
echo "import { db } from '@scope/db';" > apps/web/test/db.ts
echo "import { db } from '@scope/db';" > apps/web/src/db.test.ts
echo "// mentions @scope/db without quotes" > apps/web/src/comment.ts
echo "import { db } from '@scope/db-extra';" > apps/web/src/prefix.ts
rm apps/web/src/legacy.ts
commit change
OUT="$(bash "$S" "$BASE_SHA...feat")"; rc=$?
eq "monorepo rc" "$rc" 0
eq "edges added" "$(q '.package_edges_added | sort_by(.from)')" '[{"from":"@scope/db","to":"@scope/core","kind":"dependencies","manifest":"packages/db/package.json"},{"from":"@scope/x","to":"@scope/db","kind":"devDependencies","manifest":"packages/x/package.json"}]'
eq "edges removed" "$(q '.package_edges_removed')" '[{"from":"@scope/web","to":"@scope/old","kind":"dependencies","manifest":"apps/web/package.json"}]'
eq "non-workspace dep ignored" "$(q '[.package_edges_added[] | select(.to == "zod" or .to == "pg")] | length')" 0
eq "import pairs" "$(q '.import_pairs | sort_by(.to)')" '[{"from":"@scope/web","to":"@scope/db","files_added":1,"files_removed":0},{"from":"@scope/web","to":"@scope/old","files_added":0,"files_removed":1},{"from":"@scope/web","to":"@scope/x","files_added":2,"files_removed":0}]'
eq "import type never counted" "$(q '[.import_pairs[] | select(.to == "@scope/core")] | length')" 0
eq "no boundary change" "$(q '.boundary_config_changed')" '{"changed":false,"files":[],"loosens":false,"tightens":false}'
# the two-arg form agrees
eq "two-arg form" "$(bash "$S" "$BASE_SHA" feat | jq -c '.package_edges_added | length')" 2

# moving an import within a file (- and + of the same target) is not growth
git checkout -q -b move feat
printf '// header\nimport { db } from "@scope/db";\nimport type { Row } from "@scope/core";\n' > apps/web/src/value.ts; commit move
OUT="$(bash "$S" feat...move)"; eq "moved import not counted" "$(q '.import_pairs')" '[]'

# ---- 3. boundary config: loosen, tighten ----
git checkout -q -b eslint-base feat
cat > eslint.config.mjs <<'EOF'
export default [{ rules: { "boundaries/element-types": [2, { default: "disallow", rules: [
  { from: ["app"], allow: ["core"] },
] }] } }];
EOF
commit eslint
git checkout -q -b loosen
awk '{ print } /allow: \["core"\]/ { print "  { from: [\"app\"], allow: [\"package\"] }," }' eslint.config.mjs > "$TMP/e" && cat "$TMP/e" > eslint.config.mjs; commit loosen
OUT="$(bash "$S" eslint-base...loosen)"
eq "loosen" "$(q '.boundary_config_changed')" '{"changed":true,"files":["eslint.config.mjs"],"loosens":true,"tightens":false}'
git checkout -q -b tighten eslint-base
grep -v 'allow: \["core"\]' eslint.config.mjs > "$TMP/e" && cat "$TMP/e" > eslint.config.mjs; commit tighten
OUT="$(bash "$S" eslint-base...tighten)"
eq "tighten" "$(q '.boundary_config_changed')" '{"changed":true,"files":["eslint.config.mjs"],"loosens":false,"tightens":true}'

# ---- 4. pnpm-workspace.yaml globs with a negation ----
new_repo
printf '{"name":"root","private":true}\n' > package.json
printf "packages:\n  - 'packages/**'\n  - \"!packages/ignored\"\n" > pnpm-workspace.yaml
pj packages/a '{"name":"a"}'
pj packages/nested/b '{"name":"b"}'
pj packages/ignored '{"name":"ignored"}'
commit base
git checkout -q -b feat
pj packages/a '{"name":"a","dependencies":{"b":"workspace:*","ignored":"workspace:*"}}'
commit edge
OUT="$(bash "$S" HEAD~1...HEAD)"
eq "pnpm globs, ** depth, negation" "$(q '[.package_edges_added[] | .to]')" '["b"]'

# ---- 5. bad ref and usage exit 2 ----
bash "$S" nope...HEAD >/dev/null 2>&1; eq "bad ref exit" "$?" 2
bash "$S" >/dev/null 2>&1; eq "usage exit" "$?" 2

# ---- 6. 300-file diff in under 2 s, no network tools invoked ----
new_repo
printf '{"name":"root","workspaces":["packages/*"]}\n' > package.json
for p in a b c d e f; do pj "packages/$p" "{\"name\":\"@s/$p\"}"; done
commit base
git checkout -q -b big
i=0; while [ $i -lt 300 ]; do printf "import { v } from '@s/b';\nexport const n$i = v;\n" > "packages/a/f$i.ts"; i=$((i+1)); done
commit big
mkdir -p "$TMP/bin"
for t in gh curl wget npm npx pnpm yarn nc ssh; do printf '#!/bin/sh\necho "%s" >> "%s/net.log"\nexit 1\n' "$t" "$TMP" > "$TMP/bin/$t"; chmod +x "$TMP/bin/$t"; done
start=$(date +%s%N 2>/dev/null)
OUT="$(PATH="$TMP/bin:$PATH" bash "$S" master...big 2>/dev/null || PATH="$TMP/bin:$PATH" bash "$S" main...big)"
end=$(date +%s%N 2>/dev/null)
eq "300-file count" "$(q '.import_pairs')" '[{"from":"@s/a","to":"@s/b","files_added":300,"files_removed":0}]'
case "$start$end" in *N*|"") ok ;; *) ms=$(( (end - start) / 1000000 )); if [ "$ms" -lt 2000 ]; then ok; else bad "300-file diff took ${ms} ms (limit 2000)"; fi ;; esac
if [ -e "$TMP/net.log" ]; then bad "network tool invoked: $(tr '\n' ' ' < "$TMP/net.log")"; else ok; fi

echo "structure-delta.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
