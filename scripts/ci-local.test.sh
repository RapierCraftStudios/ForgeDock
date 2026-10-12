#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/ci-local.sh. Run: bash scripts/ci-local.test.sh (bash 3.2 compatible).
# Every case builds a throwaway git repo from scripts/fixtures/ci-local/<name> (base commit on `main`, change on `feat`)
# and asserts the plan or the run result. No GitHub access, no real docker (a shim on PATH stands in).

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
S="$DIR/ci-local.sh"
FX="$DIR/fixtures/ci-local"

for tool in node git jq yq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: ci-local.test.sh needs $tool"; exit 0; }
done
yq -o=json '.' - <<<'a: 1' 2>/dev/null | grep -q '"a"' || { echo "SKIP: ci-local.test.sh needs mikefarah yq v4"; exit 0; }

T=$(mktemp -d "${TMPDIR:-/tmp}/ci-local-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
export FORGE_TELEMETRY=off
export FORGE_CI_LOCAL_HOME="$T/home"
export FORGE_CI_LOCAL_SLOTS=4
unset FORGE_CI_LOCAL_SERVICES FORGE_CI_LOCAL_NO_YQ FORGE_CI_LOCAL_BUDGET_SECONDS FORGE_CI_LOCAL_JOB_TIMEOUT FORGE_CI_LOCAL_NO_CACHE
HOST=$(uname -s)

pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); echo "FAIL: $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/    /' | head -30; }
eq()   { [ "$2" = "$3" ] && ok || bad "$1 (want '$2', got '$3')"; }
has()  { case "$2" in *"$3"*) ok ;; *) bad "$1 (missing '$3')" "$2" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1 (unexpected '$3')" "$2" ;; *) ok ;; esac; }

g() { git -C "$1" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "${@:2}" >/dev/null 2>&1; }

# mkrepo <fixture> -> prints the repo path; base commit on main, checked out on branch feat
mkrepo() {
  local r; r=$(mktemp -d "$T/r.XXXXXX")
  cp -R "$FX/$1/." "$r/"
  git -C "$r" init -q -b main >/dev/null 2>&1 || { git -C "$r" init -q; g "$r" checkout -q -b main; }
  g "$r" add -A; g "$r" commit -q -m base
  g "$r" checkout -q -b feat
  printf '%s' "$r"
}
# blank <name> -> empty repo (inline cases)
blank() {
  local r; r=$(mktemp -d "$T/r.XXXXXX")
  git -C "$r" init -q -b main >/dev/null 2>&1 || { git -C "$r" init -q; g "$r" checkout -q -b main; }
  printf '%s' "$r"
}
commit_base() { g "$1" add -A; g "$1" commit -q -m base; g "$1" checkout -q -b feat; }

plan()  { bash "$S" plan --repo "$1" --base main --base-branch main --head-branch feat --json --no-cache "${@:2}" 2>/dev/null; }
run_()  { OUT=$(bash "$S" run --repo "$1" --base main --base-branch main --head-branch feat "${@:2}" 2>&1); RC=$?; }
state() { printf '%s' "$1" | jq -r --arg id "$2" '[.jobs[] | select(.id == $id)][0] | if . == null then "missing" elif .not_applicable then "not-applicable" elif .deferred_reason then "deferred" else "runnable" end'; }
reason() { printf '%s' "$1" | jq -r --arg id "$2" '[.jobs[] | select(.id == $id)][0] | (.deferred_reason // .not_applicable // "")'; }
step_field() { printf '%s' "$1" | jq -r --arg id "$2" --argjson n "$3" "[.jobs[] | select(.id == \$id)][0].steps | map(select(.noop | not))[\$n] | $4"; }

# ------------------------------------------------------------------------------------------------ CLI contract
OUT=$(bash "$S" run 2>&1); RC=$?
eq "run without --repo is a usage error (exit 2)" 2 "$RC"
has "usage error prints a DEGRADED result line" "$OUT" "CI_LOCAL_RESULT: DEGRADED"
OUT=$(bash "$S" bogus 2>&1); RC=$?; eq "unknown subcommand exits 2" 2 "$RC"
r=$(mkrepo gha-basic); echo x >> "$r/src/greet.sh"
OUT=$(FORGE_CI_LOCAL_NO_YQ=1 bash "$S" run --repo "$r" --base main 2>&1); RC=$?
eq "missing yq degrades (exit 2), never passes" 2 "$RC"
has "missing yq names the cause" "$OUT" "yq not found"

# ------------------------------------------------------------------------------------------------ GitHub Actions: classification
r=$(mkrepo gha-basic); echo 'greet2() { :; }' >> "$r/src/greet.sh"
P=$(plan "$r")
eq "unit job is runnable on a src change" runnable "$(state "$P" gha:ci:unit)"
eq "src change selects the reached test only (selected)" 1 "$(step_field "$P" gha:ci:unit 0 '.scope.selected')"
eq "the matrix job runs once on the host" runnable "$(state "$P" gha:ci:matrix)"
case "$HOST" in
  Linux) has "macOS/Windows matrix variants are deferred" "$(reason "$P" gha:ci:matrix:variants)" "macos-14" ;;
  Darwin) has "Windows matrix variant is deferred" "$(reason "$P" gha:ci:matrix:variants)" "windows-latest" ;;
esac
eq "service job is runnable when services are enabled" runnable "$(state "$P" gha:ci:withservice)"
eq "service job lists its container" postgres "$(printf '%s' "$P" | jq -r '.jobs[] | select(.id == "gha:ci:withservice") | .services[0].name')"
eq "secret-referencing job is deferred" deferred "$(state "$P" gha:ci:needsecret)"
has "secret job reason" "$(reason "$P" gha:ci:needsecret)" "secrets"
eq "unknown action job is deferred, never guessed" deferred "$(state "$P" gha:ci:unknownaction)"
has "unknown action reason names the action" "$(reason "$P" gha:ci:unknownaction)" "some-org/mystery-action"
eq "environment (deploy) job is deferred" deferred "$(state "$P" gha:ci:deployprod)"
eq "push-only job (if: false) is not applicable" not-applicable "$(state "$P" gha:ci:conditional)"
eq "docs workflow path filter excludes a src change" not-applicable "$(state "$P" gha:docs)"
eq "schedule/dispatch-only workflow is not a PR gate" not-applicable "$(state "$P" gha:nightly)"
P2=$(FORGE_CI_LOCAL_SERVICES=off plan "$r")
eq "services: off defers the service job" deferred "$(state "$P2" gha:ci:withservice)"

r=$(mkrepo gha-basic); echo more >> "$r/docs/index.md"
P=$(plan "$r")
eq "ci workflow path filter excludes a docs-only change" not-applicable "$(state "$P" gha:ci)"
eq "docs workflow selects a docs change" runnable "$(state "$P" gha:docs:docs)"

# trust: workflow definitions come from the base ref, plus the PR's own edits
r=$(mkrepo gha-basic)
cat > "$r/.github/workflows/ci.yml" <<'YML'
name: CI
on:
  pull_request:
jobs:
  added:
    runs-on: ubuntu-latest
    steps:
      - run: echo added-by-pr
YML
P=$(plan "$r")
eq "a job the PR adds is included" runnable "$(state "$P" gha:ci:added)"
eq "a job the PR deletes still runs (base is trusted)" runnable "$(state "$P" gha:ci:unit)"

# ------------------------------------------------------------------------------------------------ dorny/paths-filter (AlterLab-shaped)
r=$(mkrepo gha-dorny); echo '# x' >> "$r/backend/app.py"
P=$(plan "$r")
eq "paths-filter: backend change selects the backend job" runnable "$(state "$P" gha:ci:backend)"
eq "paths-filter: frontend job is not applicable" not-applicable "$(state "$P" gha:ci:frontend)"
eq "paths-filter: the changes job is resolved locally" not-applicable "$(state "$P" gha:ci:changes)"
eq "paths-filter: backend service container is planned" redis "$(printf '%s' "$P" | jq -r '.jobs[] | select(.id == "gha:ci:backend") | .services[0].name')"
eq "paths-filter: secret job is deferred" deferred "$(state "$P" gha:ci:integration)"
eq "paths-filter: deploy job is deferred" deferred "$(state "$P" gha:ci:deploy-staging)"
r=$(mkrepo gha-dorny); echo '// x' >> "$r/frontend/app.js"
P=$(plan "$r")
eq "paths-filter: frontend change selects frontend" runnable "$(state "$P" gha:ci:frontend)"
eq "paths-filter: backend job not applicable for a frontend change" not-applicable "$(state "$P" gha:ci:backend)"
eq "paths-filter: integration not applicable for a frontend change" not-applicable "$(state "$P" gha:ci:integration)"
r=$(mkrepo gha-dorny); echo '# x' >> "$r/docs/a.md"
P=$(plan "$r")
eq "paths-filter: a docs-only change selects neither job" not-applicable "$(state "$P" gha:ci:backend)"

# ------------------------------------------------------------------------------------------------ exact scoping: large monorepo
r=$(blank); mkdir -p "$r/.github/workflows" "$r/.forge-scratch"
cat > "$r/.github/workflows/ci.yml" <<'YML'
name: CI
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: node --test "packages/*/tests/*.test.mjs"
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: shellcheck -S error packages/*/bin/*.sh
YML
i=1
while [ "$i" -le 30 ]; do
  d="$r/packages/pkg$i"; mkdir -p "$d/src" "$d/tests" "$d/bin"
  printf 'export const v%s = %s;\n' "$i" "$i" > "$d/src/mod$i.mjs"
  printf "import test from 'node:test';\nimport { v%s } from '../src/mod%s.mjs';\ntest('t%s', () => { if (v%s !== %s) throw new Error('bad'); });\n" "$i" "$i" "$i" "$i" "$i" > "$d/tests/mod$i.test.mjs"
  printf '#!/usr/bin/env bash\necho %s\n' "$i" > "$d/bin/run$i.sh"
  i=$((i+1))
done
commit_base "$r"
echo '// touched' >> "$r/packages/pkg7/src/mod7.mjs"
P=$(plan "$r")
eq "one-file change selects exactly the reaching test (of 30)" "1" "$(step_field "$P" gha:ci:test 0 '.scope.selected')"
eq "total tests counted" "30" "$(step_field "$P" gha:ci:test 0 '.scope.total')"
has "selected test is the one importing the file" "$(step_field "$P" gha:ci:test 0 '.command')" "packages/pkg7/tests/mod7.test.mjs"
hasnt "other packages' tests are not run" "$(step_field "$P" gha:ci:test 0 '.command')" "pkg8"
eq "shellcheck is skipped when no shell file changed (per-file scope 0 of 30)" "0" "$(step_field "$P" gha:ci:lint 0 '.scope.selected')"
eq "shellcheck step is skipped for the unchanged inputs" "true" "$(step_field "$P" gha:ci:lint 0 '.skip != null')"
echo '# touched' >> "$r/packages/pkg9/bin/run9.sh"
P=$(plan "$r")
eq "per-file lint runs on the one changed shell file" "1" "$(step_field "$P" gha:ci:lint 0 '.scope.selected')"
eq "per-file lint total" "30" "$(step_field "$P" gha:ci:lint 0 '.scope.total')"
has "per-file lint command names only that file" "$(step_field "$P" gha:ci:lint 0 '.command')" "packages/pkg9/bin/run9.sh"
hasnt "per-file lint command omits siblings" "$(step_field "$P" gha:ci:lint 0 '.command')" "run10.sh"
# fail-safe widening
g "$r" add -A; g "$r" commit -q -m wip
echo '{}' > "$r/package-lock.json"
P=$(plan "$r")
has "lockfile change widens and reports why" "$(step_field "$P" gha:ci:test 0 '.scope.widen_reason')" "lockfile"
eq "widened test step runs the full command (30 of 30)" "30" "$(step_field "$P" gha:ci:test 0 '.scope.selected')"
rm -f "$r/package-lock.json"
echo '{}' > "$r/tsconfig.json"
P=$(plan "$r")
has "build-config change widens" "$(step_field "$P" gha:ci:lint 0 '.scope.widen_reason')" "build-config"
rm -f "$r/tsconfig.json"; mkdir -p "$r/.github/workflows"; echo '# c' >> "$r/.github/workflows/ci.yml"
P=$(plan "$r")
has "CI definition change widens" "$(step_field "$P" gha:ci:test 0 '.scope.widen_reason')" "ci-config"
g "$r" checkout -q -- .github/workflows/ci.yml
mkdir -p "$r/packages/pkg3/data"; echo 'x,y' > "$r/packages/pkg3/data/rows.csv"
P=$(plan "$r")
has "unknown file type widens (unknown language)" "$(step_field "$P" gha:ci:test 0 '.scope.widen_reason')" "unknown-language"
rm -rf "$r/packages/pkg3/data"
mkdir -p "$r/packages/pkg4/fixtures"; echo '{}' > "$r/packages/pkg4/fixtures/shared.json"
P=$(plan "$r")
has "an unreferenced shared fixture widens" "$(step_field "$P" gha:ci:test 0 '.scope.widen_reason')" "unreferenced-fixture"
rm -rf "$r/packages/pkg4/fixtures"

# ------------------------------------------------------------------------------------------------ other CI systems
r=$(mkrepo gitlab); echo more >> "$r/src/a.txt"
P=$(plan "$r")
eq "gitlab: rules:changes + MR source selects lint" runnable "$(state "$P" gitlab:lint)"
eq "gitlab: extends + only: merge_requests selects unit" runnable "$(state "$P" gitlab:unit)"
has "gitlab: extended script is inherited" "$(step_field "$P" gitlab:unit 0 '.command')" "echo template"
eq "gitlab: service containers are deferred" deferred "$(state "$P" gitlab:withdb)"
eq "gitlab: manual job is deferred" deferred "$(state "$P" gitlab:manualjob)"
eq "gitlab: environment (deploy) job is deferred" deferred "$(state "$P" gitlab:release)"
eq "gitlab: docs-only rule is not applicable to a src change" not-applicable "$(state "$P" gitlab:docsonly)"
eq "gitlab: stage ordering makes unit wait for earlier stages only" "[]" "$(printf '%s' "$P" | jq -c '[.jobs[] | select(.id == "gitlab:lint") | .needs[]]')"

r=$(mkrepo no-ci); echo '// t' >> "$r/src/a.js"
P=$(plan "$r")
eq "no-CI repo falls back to task runners" task-runners "$(printf '%s' "$P" | jq -r '.sources | index("task-runners") | if . == null then "no" else "task-runners" end')"
eq "no-CI: npm test job" runnable "$(state "$P" task:npm:test)"
eq "no-CI: npm lint job" runnable "$(state "$P" task:npm:lint)"
eq "no-CI: make test job" runnable "$(state "$P" task:make:test)"
eq "no-CI: make build is never planned" missing "$(state "$P" task:make:build)"
eq "no-CI: node --test is narrowed to the reaching test" "1" "$(step_field "$P" task:npm:test 1 '.scope.selected')"
has "no-CI: selected test is a.test.js" "$(step_field "$P" task:npm:test 1 '.command')" "tests/a.test.js"

r=$(mkrepo circleci); echo x > "$r/f.txt"
P=$(plan "$r")
eq "circleci: plain job runs" runnable "$(state "$P" circleci:main:test)"
eq "circleci: context (secrets) job deferred" deferred "$(state "$P" circleci:main:secured)"
eq "circleci: deploy job deferred" deferred "$(state "$P" circleci:main:deploy-prod)"

r=$(mkrepo azure); echo x > "$r/f.txt"
P=$(plan "$r")
eq "azure: an unknown task defers the job" deferred "$(state "$P" azure:build)"
has "azure: reason names the task" "$(reason "$P" azure:build)" "SomeUnknownTask@1"
r=$(blank); cat > "$r/azure-pipelines.yml" <<'YML'
pool:
  vmImage: ubuntu-latest
variables:
  greeting: hi
steps:
  - script: echo "$(greeting) azure"
YML
commit_base "$r"; echo x > "$r/f.txt"
P=$(plan "$r")
eq "azure: a script job runs" runnable "$(state "$P" azure:build)"
has "azure: \$(var) macros are expanded from declared variables" "$(step_field "$P" azure:build 0 '.command')" "hi azure"

r=$(mkrepo bitbucket); echo x > "$r/f.txt"
P=$(plan "$r")
eq "bitbucket: step runs" runnable "$(state "$P" "bitbucket:default:1:Build-and-test")"
eq "bitbucket: deployment step deferred" deferred "$(state "$P" "bitbucket:default:2:Deploy")"

r=$(mkrepo buildkite); echo x > "$r/f.txt"
P=$(plan "$r")
eq "buildkite: command step runs" runnable "$(printf '%s' "$P" | jq -r '[.jobs[] | select(.source == "buildkite" and (.name | test("test"))) | if .deferred_reason then "deferred" else "runnable" end][0]')"
eq "buildkite: plugin step deferred" deferred "$(printf '%s' "$P" | jq -r '[.jobs[] | select(.source == "buildkite" and (.name | test("docker"))) | if .deferred_reason then "deferred" else "runnable" end][0]')"
eq "buildkite: block step deferred" deferred "$(printf '%s' "$P" | jq -r '[.jobs[] | select(.source == "buildkite" and (.name | test("release"))) | if .deferred_reason then "deferred" else "runnable" end][0]')"

# explicit config: verification.ci_local.extra_commands + include/exclude
r=$(mkrepo gha-basic); echo x >> "$r/src/greet.sh"
cat > "$r/forge.yaml" <<'YML'
verification:
  ci_local:
    extra_commands:
      - echo extra-one
    exclude_jobs:
      - gha:ci:matrix
YML
P=$(plan "$r")
eq "extra_commands become explicit jobs" runnable "$(state "$P" explicit:1)"
eq "exclude_jobs removes a job from the plan" not-applicable "$(state "$P" gha:ci:matrix)"

# ------------------------------------------------------------------------------------------------ portability (always runs)
r=$(blank)
mkdir -p "$r/.github/workflows" "$r/scripts"
cat > "$r/.github/workflows/ci.yml" <<'YML'
on: pull_request
jobs:
  win:
    runs-on: windows-latest
    steps:
      - run: echo win
YML
printf 'seed\n' > "$r/README.md"
commit_base "$r"
printf '#!/usr/bin/env bash\necho ok\n' > "$r/scripts/clean.sh"
P=$(plan "$r")
eq "portability job is always planned" runnable "$(state "$P" portability:builtin)"
eq "windows-only CI job is deferred on a non-windows host" deferred "$(state "$P" gha:ci:win)"
run_ "$r"
eq "clean change passes the portability checks" 0 "$RC"
bad_sh="$r/scripts/bad.sh"
MF="map""file"; RL="read""link"
{ printf '#!/usr/bin/env bash\n'; printf '%s -t lines < in.txt\n' "$MF"; printf 'p=$(%s -f "$0")\n' "$RL"; printf 'echo hi\r\n'; } > "$bad_sh"
printf 'x' > "$r/a:b.txt"; printf 'x' > "$r/Readme.md"
run_ "$r"
eq "portability violations fail the run" 1 "$RC"
has "bash 4 construct detected" "$OUT" "bash-3.2"
has "GNU-only flag detected" "$OUT" "gnu-only"
has "Windows-invalid filename detected" "$OUT" "windows-filename"
has "case collision detected" "$OUT" "case-collision"
has "CRLF detected" "$OUT" "crlf"
has "failing result line" "$OUT" "CI_LOCAL_RESULT: FAIL"
# an allowlisted line is not flagged
rm -f "$bad_sh" "$r/a:b.txt" "$r/Readme.md"
printf '#!/usr/bin/env bash\nx=$(%s -f "$0") # allowlist: reviewed\n' "$RL" > "$r/scripts/ok.sh"
run_ "$r"
eq "an allowlisted line passes" 0 "$RC"

# ------------------------------------------------------------------------------------------------ runner
r=$(mkrepo gha-run); echo x >> "$r/src/x.txt"
run_ "$r"
eq "run exits 1 when a runnable job fails" 1 "$RC"
has "passing job reported" "$OUT" "CI_LOCAL_JOB: pass gha:ci:first"
has "GITHUB_ENV is carried to later steps" "$OUT" "CI_LOCAL_JOB: pass gha:ci:first"
has "needs ordering: second runs after first" "$OUT" "CI_LOCAL_JOB: pass gha:ci:second"
has "failing job is named" "$OUT" "CI_LOCAL_FAIL: gha:ci:failing"
has "failing job shows its log tail" "$OUT" "about to fail"
has "a job whose dependency failed is skipped" "$OUT" "CI_LOCAL_JOB: skipped gha:ci:skippedbyneed"
has "a failed dependency install defers instead of failing" "$OUT" "CI_LOCAL_JOB: deferred gha:ci:broken-install"
has "deferred jobs are listed" "$OUT" "CI_LOCAL_DEFERRED: gha:ci:broken-install"
has "result line carries the counts" "$OUT" "jobs_failed=1"
has "result line is FAIL" "$OUT" "CI_LOCAL_RESULT: FAIL"
hasnt "no GitHub Actions workflow is triggered" "$OUT" "gh workflow"

# passing run: exit 0, deferred jobs listed
r=$(mkrepo gha-basic); echo x >> "$r/src/greet.sh"
FORGE_CI_LOCAL_SERVICES=off run_ "$r"
eq "all runnable jobs pass -> exit 0" 0 "$RC"
has "PASS result" "$OUT" "CI_LOCAL_RESULT: PASS"
has "unknown action job is listed as deferred" "$OUT" "CI_LOCAL_DEFERRED: gha:ci:unknownaction"
has "secret job is listed as deferred" "$OUT" "CI_LOCAL_DEFERRED: gha:ci:needsecret"

# result cache: identical inputs are hits on the second iteration and across repos on the same base
r=$(mkrepo monorepo); echo '# c' >> "$r/packages/a/src/a.sh"
run_ "$r"; eq "first run passes" 0 "$RC"; has "first run misses the cache" "$OUT" "cache_hits=0"
run_ "$r"; eq "second run passes" 0 "$RC"
has "second iteration hits the cache" "$OUT" "CI_LOCAL_JOB: pass gha:ci:lint"
hits=$(printf '%s\n' "$OUT" | sed -n 's/.*cache_hits=\([0-9]*\).*/\1/p' | tail -n 1)
[ "${hits:-0}" -ge 1 ] && ok || bad "second iteration should have cache hits (got '${hits:-}')" "$OUT"
r2=$(mkrepo monorepo); echo '# c' >> "$r2/packages/a/src/a.sh"
run_ "$r2"
hits=$(printf '%s\n' "$OUT" | sed -n 's/.*cache_hits=\([0-9]*\).*/\1/p' | tail -n 1)
[ "${hits:-0}" -ge 1 ] && ok || bad "a second issue with identical per-file inputs should hit the shared cache (got '${hits:-}')" "$OUT"
echo '# changed' >> "$r/packages/a/src/a.sh"
run_ "$r"
has "changed inputs miss the cache" "$OUT" "CI_LOCAL_RESULT: PASS"

# parallelism, machine-wide semaphore, stale slots, timeout, budget
mk_pair() {
  local p; p=$(blank); mkdir -p "$p/.github/workflows"
  cat > "$p/.github/workflows/ci.yml" <<'YML'
on: pull_request
jobs:
  ja:
    runs-on: ubuntu-latest
    steps:
      - run: |
          touch a.started
          i=0; while [ "$i" -lt 60 ]; do [ -f b.started ] && exit 0; i=$((i+1)); sleep 0.1; done; exit 1
  jb:
    runs-on: ubuntu-latest
    steps:
      - run: |
          touch b.started
          i=0; while [ "$i" -lt 60 ]; do [ -f a.started ] && exit 0; i=$((i+1)); sleep 0.1; done; exit 1
YML
  echo seed > "$p/seed.txt"; commit_base "$p"; echo x >> "$p/seed.txt"; printf '%s' "$p"
}
export FORGE_CI_LOCAL_NO_CACHE=1
r=$(mk_pair); run_ "$r" --max-parallel 2
eq "independent jobs run in parallel (each waits for the other)" 0 "$RC"
rm -f "$r/a.started" "$r/b.started"
run_ "$r" --max-parallel 1
eq "max-parallel 1 serialises jobs (the rendezvous cannot happen)" 1 "$RC"
rm -f "$r/a.started" "$r/b.started"
OUT=$(FORGE_CI_LOCAL_SLOTS=1 bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat --max-parallel 2 2>&1); RC=$?
eq "a one-slot machine-wide semaphore serialises jobs across the pool" 1 "$RC"
rm -f "$r/a.started" "$r/b.started"
mkdir -p "$FORGE_CI_LOCAL_HOME/ci-local.lock/slot-0"
printf '999999 1 stale\n' > "$FORGE_CI_LOCAL_HOME/ci-local.lock/slot-0/owner"
OUT=$(FORGE_CI_LOCAL_SLOTS=2 bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat --max-parallel 2 2>&1); RC=$?
eq "a stale slot (dead pid) is reclaimed" 0 "$RC"
[ ! -d "$FORGE_CI_LOCAL_HOME/ci-local.lock/slot-0" ] && ok || bad "slots are released after the run"

r=$(blank); mkdir -p "$r/.github/workflows"
cat > "$r/.github/workflows/ci.yml" <<'YML'
on: pull_request
jobs:
  hang:
    runs-on: ubuntu-latest
    steps:
      - run: sleep 30
  quick:
    runs-on: ubuntu-latest
    steps:
      - run: echo quick
YML
echo s > "$r/s.txt"; commit_base "$r"; echo x >> "$r/s.txt"
OUT=$(FORGE_CI_LOCAL_JOB_TIMEOUT=2 bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat 2>&1); RC=$?
eq "a job past its timeout fails" 1 "$RC"
has "timeout is reported" "$OUT" "timed out after 2s"
has "other jobs still pass" "$OUT" "CI_LOCAL_JOB: pass gha:ci:quick"
OUT=$(FORGE_CI_LOCAL_BUDGET_SECONDS=2 FORGE_CI_LOCAL_JOB_TIMEOUT=600 bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat 2>&1); RC=$?
eq "an exhausted budget defers the unfinished job instead of failing" 0 "$RC"
has "budget exhaustion is reported" "$OUT" "budget exhausted"
has "the unfinished job is deferred" "$OUT" "CI_LOCAL_DEFERRED: gha:ci:hang"

# ------------------------------------------------------------------------------------------------ services (docker shim)
r=$(blank); mkdir -p "$r/.github/workflows" "$T/bin"
cat > "$r/.github/workflows/ci.yml" <<'YML'
on: pull_request
jobs:
  db:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: example
        ports:
          - 54329:5432
        options: --health-cmd pg_isready --health-interval 5s --privileged
    steps:
      - run: echo with-db
YML
echo s > "$r/s.txt"; commit_base "$r"; echo x >> "$r/s.txt"
cat > "$T/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  info) exit "${FAKE_DOCKER_INFO_RC:-0}" ;;
  run) echo fakeid ;;
  inspect) echo "true|healthy" ;;
  *) : ;;
esac
SHIM
chmod +x "$T/bin/docker"
export FAKE_DOCKER_LOG="$T/docker.log"
: > "$FAKE_DOCKER_LOG"
OUT=$(PATH="$T/bin:$PATH" bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat 2>&1); RC=$?
eq "a service job runs when docker is available" 0 "$RC"
LOG=$(cat "$FAKE_DOCKER_LOG")
has "container is started with the same image" "$LOG" "postgres:16"
has "container publishes the declared port" "$LOG" "-p 127.0.0.1:54329:5432"
has "container gets the declared env" "$LOG" "-e POSTGRES_PASSWORD=example"
has "health options are passed through" "$LOG" "--health-cmd"
hasnt "options off the safe list are dropped" "$LOG" "--privileged"
has "container is named per run" "$LOG" "forge-ci-"
has "container is torn down" "$LOG" "rm -f"
: > "$FAKE_DOCKER_LOG"
OUT=$(FAKE_DOCKER_INFO_RC=1 PATH="$T/bin:$PATH" bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat 2>&1); RC=$?
eq "docker absent defers the service job (exit 0)" 0 "$RC"
has "the deferral says why" "$OUT" "docker is not available"
hasnt "no container is started without docker" "$(cat "$FAKE_DOCKER_LOG")" "run -d"

# ------------------------------------------------------------------------------------------------ telemetry + no remote triggers
r=$(mkrepo gha-basic); echo x >> "$r/src/greet.sh"
OUT=$(FORGE_CI_LOCAL_SERVICES=off FORGE_TELEMETRY=on FORGE_REPO=o/r FORGE_ISSUE=1 FORGE_TELEMETRY_GH=/bin/false bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat --iteration 1 2>&1); RC=$?
eq "telemetry never changes the exit code" 0 "$RC"
if grep -nE 'gh run|gh workflow|workflow_dispatch' "$S" >/dev/null 2>&1; then bad "ci-local.sh must not trigger or watch GitHub Actions"; else ok; fi
if grep -rnE "spawn(Sync)?\(['\"]gh['\"]|run\(['\"]gh['\"]|execSync\(['\"]gh " "$DIR/ci-local" >/dev/null 2>&1; then bad "ci-local modules must not invoke the gh CLI"; else ok; fi

# ------------------------------------------------------------------------------------------------ environment hygiene, expressions
r=$(blank); mkdir -p "$r/.github/workflows"
cat > "$r/.github/workflows/ci.yml" <<'YML'
on: pull_request
jobs:
  env:
    runs-on: ubuntu-latest
    env:
      LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}
      BASE: ${{ github.base_ref }}
    steps:
      - run: |
          test -z "${LEAKED_SECRET_TOKEN:-}" || { echo "credential leaked"; exit 1; }
          test -z "${FORGEDOCK_HOME:-}" || { echo "ambient install root leaked"; exit 1; }
          test -z "${GIT_INDEX_FILE:-}" || { echo "git hook variable leaked"; exit 1; }
          test "${CUSTOM_PASS:-}" = 1 || { echo "passthrough missing"; exit 1; }
          test "$CI" = true || { echo "CI not set"; exit 1; }
          test -z "$LABELS" || { echo "labels should be empty locally"; exit 1; }
          test "$BASE" = main || { echo "base_ref not substituted"; exit 1; }
YML
echo s > "$r/s.txt"; commit_base "$r"; echo x >> "$r/s.txt"
OUT=$(LEAKED_SECRET_TOKEN=x FORGEDOCK_HOME=/nonexistent GIT_INDEX_FILE=/nonexistent CUSTOM_PASS=1 FORGE_CI_LOCAL_PASSTHROUGH=CUSTOM_PASS bash "$S" run --repo "$r" --base main --base-branch main --head-branch feat 2>&1); RC=$?
eq "jobs run in a clean runner-like environment (no credentials, no ambient install root, allowlisted passthrough)" 0 "$RC"
hasnt "no leak reported" "$OUT" "leaked"
# native selectors: another language's source does not widen, a data file does
r=$(blank); mkdir -p "$r/lib" "$r/src"
printf '{ "name": "js", "version": "1.0.0", "scripts": { "test": "jest" } }\n' > "$r/package.json"
echo 'module.exports = 1' > "$r/src/a.js"; echo 'x = 1' > "$r/lib/x.py"; echo '{}' > "$r/lib/data.json"
commit_base "$r"
echo '# y' >> "$r/lib/x.py"
P=$(plan "$r")
eq "jest: a Python-only change selects no JS tests" skip "$(step_field "$P" task:npm:test 1 '.scope.mode')"
echo '// z' >> "$r/src/a.js"; P=$(plan "$r")
eq "jest: a JS change uses --findRelatedTests" jest-related "$(step_field "$P" task:npm:test 1 '.scope.selector')"
echo '{"a":1}' > "$r/lib/data.json"; P=$(plan "$r")
has "jest: a changed data file widens (not reachable through imports)" "$(step_field "$P" task:npm:test 1 '.scope.widen_reason')" "unknown-language"

# ------------------------------------------------------------------------------------------------ ForgeDock's own workflows
P=$(bash "$S" plan --repo "$ROOT" --base HEAD --base-branch staging --head-branch feat/spec-change --files "commands/work-on/build.md" --json --no-cache 2>/dev/null)
if [ -z "$P" ]; then bad "plan on ForgeDock's own workflows produced no output"; else
  eq "ForgeDock: a spec change selects a check-commands job" runnable "$(state "$P" gha:check-commands:check-native-conflicts)"
  eq "ForgeDock: a spec change selects the ci unit-tests job" runnable "$(state "$P" gha:ci:unit-tests)"
  eq "ForgeDock: a spec change selects the ci shell-tests job" runnable "$(state "$P" gha:ci:shell-tests)"
  eq "ForgeDock: a spec change selects the shellcheck job" runnable "$(state "$P" gha:shell-compat:shellcheck)"
  eq "ForgeDock: the Windows job is deferred" deferred "$(state "$P" gha:shell-compat:windows-fixture-smoke)"
  eq "ForgeDock: the macOS portability job is deferred" deferred "$(state "$P" gha:shell-compat:macos-portability)"
  eq "ForgeDock: portability checks run" runnable "$(state "$P" portability:builtin)"
  eq "ForgeDock: the unit-test step is narrowed by the reference graph" scoped "$(printf '%s' "$P" | jq -r '[.jobs[] | select(.id == "gha:ci:unit-tests") | .steps[] | select(.scope.selector == "refgraph-nodetest") | .scope.mode][0]')"
fi

echo "ci-local.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
