#!/usr/bin/env bash
# repo-facts.test.sh — cases for scripts/repo-facts.sh (forge#4272).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/repo-facts.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repo-facts-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }

new_repo() {
  rm -rf "$TMP/$1"; mkdir -p "$TMP/$1"; cd "$TMP/$1" || exit 1
  git init -q -b main; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
}
commit() { git add -A; git commit -qm "$1"; }
lines() { i=0; : > "$1"; while [ $i -lt "$2" ]; do echo "l$i" >> "$1"; i=$((i+1)); done; }

# ---- 1. pins, slow suites, package edge, boundary config, hotspot ----
new_repo full
mkdir -p packages/a packages/b .github/workflows src
cat > package.json <<'EOF'
{"name":"root","private":true,"packageManager":"pnpm@9.1.0","workspaces":["packages/*"],
 "scripts":{"test":"vitest run","lint":"eslint .","test:e2e":"playwright test"}}
EOF
echo "20.11.1" > .nvmrc
echo '{"name":"@x/a","dependencies":{"@x/b":"workspace:*","left-pad":"1.0.0"}}' > packages/a/package.json
echo '{"name":"@x/b","scripts":{"test":"vitest run"}}' > packages/b/package.json
echo "module.exports = { rules: { 'boundaries/element-types': ['error'] } };" > .eslintrc.js
echo "module.exports = { rules: { semi: 'error' } };" > packages/b/.eslintrc.js
cat > .github/workflows/ci.yml <<'EOF'
on: push
jobs:
  db:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres
    steps:
      - run: pnpm run test
  long:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - run: make lint-all
  quick:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: make fmt
EOF
lines src/big.ts 2100; commit c1
echo x >> src/big.ts; lines src/small.ts 10; commit c2
OUT="$(bash "$S" --stdout)"; rc=$?
eq "rc" "$rc" 0
eq "version" "$(q '.version')" 1
eq "pm pin" "$(q '.toolchain.pm')" '{"name":"pnpm","version":"9.1.0","source":"package.json packageManager"}'
eq "node pin" "$(q '.toolchain.node')" '{"spec":"20.11.1","source":".nvmrc"}'
eq "packages" "$(q '.layer_rules.packages')" '[{"name":"@x/a","dir":"packages/a"},{"name":"@x/b","dir":"packages/b"}]'
eq "edge" "$(q '.layer_rules.edges')" '[{"from":"@x/a","to":"@x/b","kind":"dependencies","manifest":"packages/a/package.json"}]'
eq "boundary configs" "$(q '.layer_rules.boundary_configs')" '[".eslintrc.js"]'
eq "services job" "$(q '[.slow_suites[] | select(.command == "pnpm run test") | .why]')" '["CI job .github/workflows/ci.yml#jobs.db uses services"]'
eq "timeout job" "$(q '[.slow_suites[] | select(.command == "make lint-all") | .why]')" '["CI job .github/workflows/ci.yml#jobs.long sets timeout-minutes 45"]'
eq "quick job not slow" "$(q '[.slow_suites[] | select(.command == "make fmt")] | length')" 0
eq "hotspot" "$(q '.hotspots')" '[{"path":"src/big.ts","lines":2101,"commits_90d":2,"hotspot":4202}]'

# ---- 2. a cached test map is read: its e2e command is a slow suite ----
mkdir -p .forge
echo '{"version":1,"entries":[{"globs":["e2e/**"],"command":"pnpm exec playwright test","cwd":".","source":"package.json#scripts.test:e2e"}]}' > .forge/test-map.json
OUT="$(bash "$S" --stdout)"
eq "map e2e" "$(q '.slow_suites')" '[{"command":"pnpm exec playwright test","source":"package.json#scripts.test:e2e","why":"command names playwright"}]'

# ---- 3. default output file, rerun stable ----
P="$(bash "$S")"; eq "output path" "$P" ".forge/repo-facts.json"
cp .forge/repo-facts.json "$TMP/first.json"; bash "$S" >/dev/null
if cmp -s .forge/repo-facts.json "$TMP/first.json"; then ok; else bad "rerun not identical"; fi

# ---- 4. a repo with none of these: empty sections, exit 0 ----
new_repo bare
echo hi > README.md; commit init
OUT="$(bash "$S" --stdout)"; rc=$?
eq "bare rc" "$rc" 0
eq "bare" "$(q '[.toolchain.pm, .toolchain.node, .slow_suites, .layer_rules, .hotspots]')" '[null,null,[],{"packages":[],"edges":[],"boundary_configs":[]},[]]'
new_repo empty
OUT="$(bash "$S" --stdout)"; eq "no commits rc" "$?" 0
eq "no commits" "$(q '.hotspots')" '[]'

# ---- 4b. #4298: a big boundary config matching early (pipefail + grep -q SIGPIPE) and non-ASCII / spaced paths ----
new_repo paths
mkdir -p "packages/é b" "apps/ü"
echo '{"name":"root","private":true,"workspaces":["packages/*"]}' > package.json
echo '{"name":"@x/c"}' > "packages/é b/package.json"
{ echo "export default [{ rules: { 'boundaries/element-types': ['error'] } }];"; i=0; while [ $i -lt 20000 ]; do echo "// padding line $i to overflow the pipe buffer ......................................"; i=$((i+1)); done; } > "apps/ü/eslint.config.js"
commit init
OUT="$(bash "$S" --stdout)"; eq "paths rc" "$?" 0
eq "big boundary config in a non-ASCII dir" "$(q '.layer_rules.boundary_configs')" '["apps/ü/eslint.config.js"]'
eq "spaced non-ASCII package dir" "$(q '.layer_rules.packages')" '[{"name":"@x/c","dir":"packages/é b"}]'

# ---- 5. usage ----
bash "$S" --repo-path "$TMP/missing" >/dev/null 2>&1; eq "bad repo path" "$?" 2
bash "$S" --bogus >/dev/null 2>&1; eq "unknown option" "$?" 2

echo "repo-facts.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
