#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/check-test-wiring.sh. Run: bash scripts/check-test-wiring.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/check-test-wiring.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/check-test-wiring-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0

# check <want_rc> <want_substring|-> <unwanted_substring|-> <desc> <scripts_dir> <workflows_dir>
check() {
  want_rc="$1"; want="$2"; unwant="$3"; desc="$4"; sd="$5"; wd="$6"
  out=$(bash "$S" "$sd" "$wd" 2>&1); rc=$?
  ok=1
  if [ "$want" != "-" ]; then case "$out" in *"$want"*) ;; *) ok=0 ;; esac; fi
  if [ "$unwant" != "-" ]; then case "$out" in *"$unwant"*) ok=0 ;; esac; fi
  if [ "$rc" = "$want_rc" ] && [ "$ok" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (rc=$rc)"; printf '%s\n' "$out" | sed 's/^/    /'; fi
}

mk() { mkdir -p "$T/$1/scripts" "$T/$1/wf"; }

# 1. all wired -> pass
mk ok
for n in a b c; do : > "$T/ok/scripts/$n.test.sh"; done
printf 'steps:\n  - run: bash scripts/a.test.sh\n  - run: |\n      /bin/bash scripts/b.test.sh\n      bash scripts/c.test.sh\n' > "$T/ok/wf/x.yml"
check 0 "all 3 test script(s) wired" - "all wired passes" "$T/ok/scripts" "$T/ok/wf"

# 2. two+ unwired -> fail, both listed, wired one not listed
mk bad
for n in a b c d; do : > "$T/bad/scripts/$n.test.sh"; done
printf 'run: bash scripts/a.test.sh\n' > "$T/bad/wf/x.yml"
check 1 "UNWIRED: b.test.sh" "UNWIRED: a.test.sh" "unwired b reported, wired a not" "$T/bad/scripts" "$T/bad/wf"
check 1 "UNWIRED: c.test.sh" - "unwired c reported too" "$T/bad/scripts" "$T/bad/wf"
check 1 "UNWIRED: d.test.sh" - "unwired d reported too" "$T/bad/scripts" "$T/bad/wf"
check 1 "3 of 4" - "summary counts every offender" "$T/bad/scripts" "$T/bad/wf"

# 3. substring of a longer name does not satisfy the match
mk sub
: > "$T/sub/scripts/foo.test.sh"
printf 'run: bash scripts/barfoo.test.sh\nrun: bash scripts/foo.test.sh.bak\nrun: bash scripts/foo-test-sh\n' > "$T/sub/wf/x.yml"
check 1 "UNWIRED: foo.test.sh" - "longer-name substring is not a match" "$T/sub/scripts" "$T/sub/wf"

# 4. '.' is literal, not a regex wildcard
mk dot
: > "$T/dot/scripts/foo.test.sh"
printf 'run: bash scripts/fooXtestYsh\n' > "$T/dot/wf/x.yml"
check 1 "UNWIRED: foo.test.sh" - "dot is not a wildcard" "$T/dot/scripts" "$T/dot/wf"

# 5. reference in a second workflow file counts
mk multi
: > "$T/multi/scripts/a.test.sh"
printf 'name: one\n' > "$T/multi/wf/one.yml"
printf 'run: bash scripts/a.test.sh\n' > "$T/multi/wf/two.yaml"
check 0 "wired" - "reference in any workflow counts" "$T/multi/scripts" "$T/multi/wf"

# 6. empty / missing workflows dir fails
mk empty
: > "$T/empty/scripts/a.test.sh"
check 1 "no workflow files" - "empty workflows dir fails" "$T/empty/scripts" "$T/empty/wf"
check 1 "workflows dir not found" - "missing workflows dir fails" "$T/empty/scripts" "$T/empty/nope"

# 7. missing scripts dir is a usage error
check 2 "scripts dir not found" - "missing scripts dir fails" "$T/nope" "$T/empty/wf"

echo "check-test-wiring.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
