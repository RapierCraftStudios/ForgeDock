#!/usr/bin/env bash
# test-map.test.sh — cases for scripts/test-map.sh over the node, python and go fixtures (forge#4272).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/test-map.sh"
SEL="$HERE/../bin/lean/testmap.mjs"
FIX="$HERE/fixtures/test-map"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-map-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }

# copy a fixture into a fresh git repo and build its map
setup() {
  rm -rf "$TMP/$1"; cp -R "$FIX/$1" "$TMP/$1"; cd "$TMP/$1" || exit 1
  git init -q -b main; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
  git add -A; git commit -qm init
  OUTP="$(bash "$S")"; RC=$?
}
# selected commands for changed files, sorted, joined by |
sel() { node "$SEL" --map .forge/test-map.json --select "$@" | LC_ALL=C sort | paste -sd'|' -; }

# ---- 1. node: root scripts for root files, workspace scripts for package files ----
setup node
eq "node rc" "$RC" 0
eq "node output path" "$OUTP" ".forge/test-map.json"
eq "schema" "$(jq -c '[.version, (.entries | length > 0), (.entries | all(has("globs") and has("command") and has("cwd") and has("source")))]' .forge/test-map.json)" '[1,true,true]'
eq "non-check script ignored" "$(jq '[.entries[] | select(.command | test("build"))] | length' .forge/test-map.json)" 0
eq "root file" "$(sel src/a.ts)" "pnpm run lint|pnpm run test"
eq "package file" "$(sel packages/ui/src/button.tsx)" "cd packages/ui && pnpm run test|cd packages/ui && pnpm run typecheck|pnpm run lint|pnpm run test"
eq "vitest config noted" "$(jq -r '.entries[] | select(.cwd == "." and .command == "pnpm run test") | .source' .forge/test-map.json)" "package.json#scripts.test (vitest/jest config)"
eq "unrelated file" "$(sel README.md)" ""

# ---- 2. python: pytest + ruff through uv ----
setup python
eq "python rc" "$RC" 0
eq "python file" "$(sel pkg/mod.py)" "uv run pytest|uv run ruff check ."
eq "python test file" "$(sel tests/test_mod.py)" "uv run pytest|uv run ruff check ."
eq "python non-py" "$(sel uv.lock)" ""

# ---- 3. go: go.mod, Makefile and CI workflow steps; CI-only lint step; install lines skipped ----
setup go
eq "go rc" "$RC" 0
eq "go file" "$(sel main.go)" "./scripts/check-docs|go test ./...|go vet ./...|golangci-lint run ./...|make test"
eq "nested go file" "$(sel internal/util/util.go)" "./scripts/check-docs|go test ./...|go vet ./...|golangci-lint run ./...|make test"
eq "ci-only lint source" "$(jq -r '.entries[] | select(.command == "golangci-lint run ./...") | .source' .forge/test-map.json)" ".github/workflows/ci.yml#jobs.lint"
eq "install line skipped" "$(jq '[.entries[] | select(.command | test("mod download"))] | length' .forge/test-map.json)" 0
eq "paths filter fallback" "$(jq -c '.entries[] | select(.command == "./scripts/check-docs") | .globs' .forge/test-map.json)" '["**.go","go.mod"]'
eq "docs file" "$(sel README.md)" "make test"
eq "go.sum" "$(sel go.sum)" "go test ./...|go vet ./...|make test"

# ---- 4. regenerable: a rerun is byte-identical; --stdout writes nothing; --output ----
cp .forge/test-map.json "$TMP/first.json"
bash "$S" >/dev/null
if cmp -s .forge/test-map.json "$TMP/first.json"; then ok; else bad "rerun not byte-identical"; fi
rm -rf .forge; OUTS="$(bash "$S" --stdout)"
eq "stdout same map" "$OUTS" "$(cat "$TMP/first.json")"
eq "stdout writes nothing" "$([ -e .forge ] && echo yes || echo no)" no
bash "$S" --repo-path "$TMP/go" --output "$TMP/out/map.json" >/dev/null
if cmp -s "$TMP/out/map.json" "$TMP/first.json"; then ok; else bad "--output differs"; fi

# ---- 5. block runs, continuation lines, setup lines, workflow without paths ----
mkdir -p "$TMP/wf/.github/workflows"; cd "$TMP/wf" || exit 1
git init -q -b main
cat > .github/workflows/lint.yaml <<'EOF'
on: push
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: "shellcheck scripts/*.sh"
      - run: >-
          ruff check
          --fix
      - run: |
          echo hi
          bash scripts/verify.sh \
            --strict
          ./custom-check
EOF
git add -A
OUTS="$(bash "$S" --stdout)"
eq "wf commands" "$(printf '%s' "$OUTS" | jq -r '[.entries[].command] | sort | join("|")')" "./custom-check|bash scripts/verify.sh --strict|ruff check --fix|shellcheck scripts/*.sh"
eq "wf globs" "$(printf '%s' "$OUTS" | jq -c '[.entries[] | {(.command): .globs}] | add')" '{"./custom-check":["**"],"bash scripts/verify.sh --strict":["**/*.sh"],"ruff check --fix":["**/*.py"],"shellcheck scripts/*.sh":["**/*.sh"]}'

# ---- 6. usage ----
bash "$S" --repo-path "$TMP/missing" >/dev/null 2>&1; eq "bad repo path" "$?" 2
bash "$S" --nope >/dev/null 2>&1; eq "unknown option" "$?" 2

echo "test-map.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
