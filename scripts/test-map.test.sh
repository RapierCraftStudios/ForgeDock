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
  rm -rf "${TMP:?}/$1"; cp -R "$FIX/$1" "$TMP/$1"; cd "$TMP/$1" || exit 1
  git init -q -b main; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
  git add -A; git commit -qm init
  OUTP="$(bash "$S")"; RC=$?
}
# forge#4300: workflow-derived entries of the map JSON in $2 carry no bare `**` glob
nostar() { eq "$1 no bare ** on workflow entries" "$(printf '%s' "$2" | jq '[.entries[] | select(.source | startswith(".github/workflows/")) | .globs[] | select(. == "**")] | length')" 0; }
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
eq "go file" "$(sel main.go)" "go test ./...|go vet ./...|golangci-lint run ./...|make test|make vet"
eq "nested go file" "$(sel internal/util/util.go)" "go test ./...|go vet ./...|golangci-lint run ./...|make test|make vet"
eq "unrecognised ci script dropped" "$(jq '[.entries[] | select(.command | test("check-docs"))] | length' .forge/test-map.json)" 0
eq "ci-only lint source" "$(jq -r '.entries[] | select(.command == "golangci-lint run ./...") | .source' .forge/test-map.json)" ".github/workflows/ci.yml#jobs.lint"
eq "install line skipped" "$(jq '[.entries[] | select(.command | test("mod download"))] | length' .forge/test-map.json)" 0
eq "paths filter fallback" "$(jq -c '.entries[] | select(.command == "make vet") | .globs' .forge/test-map.json)" '["**.go","go.mod"]'
eq "docs file" "$(sel README.md)" "make test"
eq "go.sum" "$(sel go.sum)" "go test ./...|go vet ./...|make test"
nostar go "$(cat .forge/test-map.json)"

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
# forge#4300: ./custom-check and `bash scripts/verify.sh` are not allowlisted checks, so they are dropped
eq "wf commands" "$(printf '%s' "$OUTS" | jq -r '[.entries[].command] | sort | join("|")')" "ruff check --fix|shellcheck scripts/*.sh"
eq "wf globs" "$(printf '%s' "$OUTS" | jq -c '[.entries[] | {(.command): .globs}] | add')" '{"ruff check --fix":["**/*.py"],"shellcheck scripts/*.sh":["**/*.sh"]}'
nostar wf "$OUTS"

# ---- 5b. forge#4297: `- run: |` then env:/shell: ends the block; deploy/publish/release/push/secret steps dropped ----
mkdir -p "$TMP/wf2/.github/workflows"; cd "$TMP/wf2" || exit 1
git init -q -b main
cat > .github/workflows/ci.yml <<'EOF'
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          npm test
        env:
          CI: true
        shell: bash
      - name: Lint
        run: |
          npm run lint
        working-directory: .
      - name: Publish to npm
        run: npm run ship
      - run: ./scripts/release.sh
      - run: git push origin HEAD
      - run: curl -H "token ${{ secrets.TOKEN }}" https://x
      - run: >-
          tsc
          --noEmit
        shell: bash
  deploy:
    name: Ship it
    runs-on: ubuntu-latest
    steps:
      - run: ./ship.sh
  site:
    name: Deploy site
    runs-on: ubuntu-latest
    steps:
      - run: ./build-site.sh
EOF
git add -A
OUTS="$(bash "$S" --stdout)"
eq "wf2 commands" "$(printf '%s' "$OUTS" | jq -r '[.entries[].command] | sort | join("|")')" "npm run lint|npm test|tsc --noEmit"
nostar wf2 "$OUTS"

# ---- 5d. forge#4300: allowlist, not a name/substring denylist; names never decide; cd/pushd prefix becomes the cwd ----
mkdir -p "$TMP/wf3/.github/workflows"; cd "$TMP/wf3" || exit 1
git init -q -b main
cat > .github/workflows/ci.yml <<'EOF'
on: pull_request
jobs:
  release-tests:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: pytest tests/test_release.py
      - run: pushd sub && make test
      - run: npm run lint
        name: Deploy
      - name: Run tests
        uses: some/action@v1
        with:
          name: release
      - name: Typecheck
        with:
          name: release
        run: npm run typecheck
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: twine upload dist/*
      - run: terraform apply -auto-approve
      - run: kubectl apply -f k8s/
      - run: ./deploy.sh
        name: test
      - name: Tests
        with:
          name: test
        run: ./publish.sh
      - run: pytest && twine upload dist/*
      - run: cd ../other && make test
      - run: npm run build
      - run: npm test -- --token=${{ secrets.NPM_TOKEN }}
EOF
git add -A
OUTS="$(bash "$S" --stdout)"
eq "wf3 commands" "$(printf '%s' "$OUTS" | jq -r '[.entries[].command] | sort | join("|")')" "make test|npm run lint|npm run typecheck|npm test|pytest tests/test_release.py"
eq "wf3 release-tests job kept" "$(printf '%s' "$OUTS" | jq -r '[.entries[].source] | unique | join("|")')" ".github/workflows/ci.yml#jobs.release-tests"
eq "wf3 pushd cwd + globs" "$(printf '%s' "$OUTS" | jq -c '[.entries[] | select(.command == "make test") | {cwd, globs}]')" '[{"cwd":"sub","globs":["sub/**"]}]'
eq "wf3 no mutating command" "$(printf '%s' "$OUTS" | jq '[.entries[] | select(.command | test("twine|terraform|kubectl|deploy|publish|build|secrets"))] | length')" 0
nostar wf3 "$OUTS"
printf '%s' "$OUTS" > "$TMP/wf3-map.json"
eq "wf3 pushd entry runs in its dir" "$(node "$SEL" --map "$TMP/wf3-map.json" --select sub/Makefile)" "cd sub && make test"

# ---- 5c. forge#4298: a package dir with a space and a non-ASCII name keeps whole globs; workflow paths with spaces ----
mkdir -p "$TMP/sp/web app" "$TMP/sp/pkg/ü/src" "$TMP/sp/.github/workflows"; cd "$TMP/sp" || exit 1
git init -q -b main
echo '{"name":"root","private":true}' > package.json
echo '{"name":"web","scripts":{"test":"vitest run"}}' > "web app/package.json"
echo '{"name":"u","scripts":{"lint":"eslint ."}}' > "pkg/ü/package.json"
echo 'x' > "pkg/ü/src/a.ts"
cat > .github/workflows/ci.yml <<'EOF'
on:
  push:
    paths:
      - "docs site/**"
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - run: ./build-docs.sh
      - run: make check
EOF
git add -A
OUTS="$(bash "$S" --stdout)"
eq "spaced package globs" "$(printf '%s' "$OUTS" | jq -c '[.entries[] | select(.cwd == "web app") | .globs[]] | map(select(endswith("package.json") or endswith(".js")))')" '["web app/**/*.js","web app/package.json"]'
eq "non-ASCII package dir" "$(printf '%s' "$OUTS" | jq -r '[.entries[] | select(.command == "npm run lint") | .cwd] | join("|")')" "pkg/ü"
eq "spaced workflow path filter" "$(printf '%s' "$OUTS" | jq -c '[.entries[] | select(.command == "make check") | .globs]')" '[["docs site/**"]]'
nostar sp "$OUTS"
eq "unrecognised docs script dropped" "$(printf '%s' "$OUTS" | jq '[.entries[] | select(.command == "./build-docs.sh")] | length')" 0
printf '%s' "$OUTS" > "$TMP/sp-map.json"
eq "spaced changed file selects its package test" "$(node "$SEL" --map "$TMP/sp-map.json" --select "web app/src/x.js")" "cd 'web app' && npm run test"

# ---- 5e. forge#4315: real runners per ecosystem are mapped with their globs; mutating siblings stay dropped ----
# wf_case NAME: the step commands on stdin become .github/workflows/ci.yml of a fresh repo; OUTS = its map
wf_case() {
  mkdir -p "$TMP/$1/.github/workflows"; cd "$TMP/$1" || exit 1
  git init -q -b main
  { printf 'on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n'; sed 's/^/      - run: /'; } > .github/workflows/ci.yml
  git add -A
  OUTS="$(bash "$S" --stdout)"
  nostar "$1" "$OUTS"
}
cmds() { printf '%s' "$OUTS" | jq -r '[.entries[].command] | sort | join("|")'; }
globs_of() { printf '%s' "$OUTS" | jq -r --arg c "$1" '[.entries[] | select(.command == $c) | .globs[]] | join(",")'; }

wf_case rust <<'WF'
cargo test --workspace
cargo clippy -- -D warnings
cargo publish
cargo build --release
WF
eq "rust commands" "$(cmds)" "cargo clippy -- -D warnings|cargo test --workspace"
eq "rust globs" "$(globs_of "cargo test --workspace")" "**/*.rs,**/Cargo.toml,Cargo.lock"

wf_case jvm <<'WF'
./gradlew test
./gradlew :app:check --no-daemon
mvn -B test
./gradlew publish
./gradlew test publish
mvn deploy
mvn install
WF
eq "jvm commands" "$(cmds)" "./gradlew :app:check --no-daemon|./gradlew test|mvn -B test"
eq "jvm globs" "$(globs_of "mvn -B test")" "**/*.java,**/*.kt,**/*.kts,**/*.gradle,**/*.groovy,**/*.scala,**/pom.xml"

wf_case ruby <<'WF'
bundle exec rspec
rspec spec/models
bundle exec rake release
WF
eq "ruby commands" "$(cmds)" "bundle exec rspec|rspec spec/models"
eq "ruby globs" "$(globs_of "bundle exec rspec")" "**/*.rb"

wf_case pyrun <<'WF'
python manage.py test
python -m unittest discover
tox
nox -s lint
tox -e publish
nox -s release
python manage.py migrate
WF
eq "python runner commands" "$(cmds)" "nox -s lint|python -m unittest discover|python manage.py test|tox"
eq "python runner globs" "$(globs_of "tox")" "**/*.py"

wf_case js <<'WF'
deno test
bun test
pnpm -r test
npm --prefix web test
npm run test:unit
deno deploy
npm run deploy:prod
npm --prefix ../x test
WF
eq "js runner commands" "$(cmds)" "bun test|deno test|npm --prefix web test|npm run test:unit|pnpm -r test"
eq "bun globs" "$(globs_of "bun test")" "**/*.js,**/*.jsx,**/*.ts,**/*.tsx,**/*.mjs,**/*.cjs"
eq "npm --prefix globs" "$(globs_of "npm --prefix web test")" "web/**/*.js,web/**/*.jsx,web/**/*.ts,web/**/*.tsx,web/**/*.mjs,web/**/*.cjs"

# ---- 5f. forge#4314: package.json script suffix allowlist (fixers/watchers/e2e/deploy never run pre-PR) ----
mkdir -p "$TMP/sfx"; cd "$TMP/sfx" || exit 1
git init -q -b main
cat > package.json <<'JSON'
{"name":"s","scripts":{"test":"x","test:unit":"x","test:ci":"x","test:node":"x","test:types":"x","lint:ts":"x","lint:js":"x","check:static":"x","check:types":"x","tsc":"tsc --noEmit","typecheck":"tsc","lint:check":"x","test:unit:ci":"x","lint:format":"prettier --check .","check:format":"prettier --write .",
"lint:fix":"eslint --fix .","check:fix":"x","test:watch":"x","test:e2e":"x","test:integration":"x","test:deploy":"x","test:update":"x","test:snapshot":"x","lint:css":"x","test:unit:watch":"x","test:-u":"x","lint:write":"x","test:dev":"x","check:release":"x"}}
JSON
git add -A
SFX="$(bash "$S" --stdout | jq -r '[.entries[].source | sub("^package.json#scripts\\.";"")] | sort | join("|")')"
eq "script suffix allowlist" "$SFX" "check:static|check:types|lint:check|lint:format|lint:js|lint:ts|test|test:ci|test:node|test:types|test:unit|test:unit:ci|tsc|typecheck"

wf_case sfxwf <<'WF'
npm run lint:fix
npm run check:fix
pnpm test:watch
yarn test:e2e
bun run test:integration
npm run test:deploy
pnpm run lint:fix
npm run test:unit
pnpm lint:ts
yarn check:types
bun run test:ci
WF
eq "workflow suffix commands" "$(cmds)" "bun run test:ci|npm run test:unit|pnpm lint:ts|yarn check:types"

wf_case shell <<'WF'
bash scripts/a.test.sh
sh tests/b.test.sh
bash scripts/deploy.sh
bash scripts/verify.sh
WF
eq "shell commands" "$(cmds)" "bash scripts/a.test.sh|sh tests/b.test.sh"
eq "shell globs" "$(globs_of "bash scripts/a.test.sh")" "**/*.sh"

# ---- 6. usage ----
bash "$S" --repo-path "$TMP/missing" >/dev/null 2>&1; eq "bad repo path" "$?" 2
bash "$S" --nope >/dev/null 2>&1; eq "unknown option" "$?" 2

echo "test-map.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
