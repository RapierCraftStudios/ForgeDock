#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests for scripts/check-test-tmp-cleanup.sh (passing and failing fixtures, plus the real tree).
# Run: bash scripts/check-test-tmp-cleanup.test.sh   (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LINT="$DIR/check-test-tmp-cleanup.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/check-test-tmp-cleanup-test.XXXXXX")
trap 'rm -rf "$T"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

# run_case NAME EXPECT_RC EXPECT_OUT_SUBSTR  (fixture tree = $T/$NAME)
run_case() {
  local name="$1" want_rc="$2" want_out="$3" out rc
  out=$(bash "$LINT" "$T/$name" 2>&1); rc=$?
  [ "$rc" -eq "$want_rc" ] && ok "$name: exit $want_rc" || bad "$name: exit $rc, wanted $want_rc ($out)"
  case "$out" in *"$want_out"*) ok "$name: output mentions '$want_out'" ;; *) bad "$name: output lacks '$want_out' ($out)" ;; esac
}

mk() { mkdir -p "$T/$1/bin/tests" "$T/$1/scripts"; }

mk pass_node
printf 'import { tmpDir } from "./_tmp.mjs";\nconst d = tmpDir("fd-x-");\n' > "$T/pass_node/bin/tests/a.test.mjs"
run_case pass_node 0 "OK"

mk pass_node_nested
mkdir -p "$T/pass_node_nested/bin/stats"
printf 'import { tmpDir } from "../tests/_tmp.mjs";\nconst d = tmpDir("fd-x-");\n' > "$T/pass_node_nested/bin/stats/a.test.mjs"
run_case pass_node_nested 0 "OK"

mk fail_node
printf 'import { mkdtempSync } from "node:fs";\nconst d = mkdtempSync("/tmp/fd-x-");\n' > "$T/fail_node/bin/tests/b.test.mjs"
run_case fail_node 1 "b.test.mjs"

mk fail_node_multiline_import
printf 'import {\n  mkdtempSync,\n  rmSync,\n} from "node:fs";\n' > "$T/fail_node_multiline_import/bin/tests/c.test.mjs"
run_case fail_node_multiline_import 1 "c.test.mjs"

mk pass_sh
printf '#!/usr/bin/env bash\nT=$(mktemp -d)\ntrap '"'"'rm -rf "$T"'"'"' EXIT\n' > "$T/pass_sh/scripts/a.test.sh"
run_case pass_sh 0 "OK"

mk fail_sh
printf '#!/usr/bin/env bash\nT=$(mktemp -d)\necho hi\n' > "$T/fail_sh/scripts/b.test.sh"
run_case fail_sh 1 "b.test.sh"

mk fail_sh_trap_not_exit
printf '#!/usr/bin/env bash\nT=$(mktemp)\ntrap '"'"'echo x'"'"' INT\n' > "$T/fail_sh_trap_not_exit/scripts/c.test.sh"
run_case fail_sh_trap_not_exit 1 "c.test.sh"

mk pass_no_temp
printf 'const x = 1;\n' > "$T/pass_no_temp/bin/tests/d.test.mjs"
printf '#!/usr/bin/env bash\n# mktemp is only mentioned in a comment\n' > "$T/pass_no_temp/scripts/d.test.sh"
run_case pass_no_temp 0 "OK"

out=$(bash "$LINT" "$T/does-not-exist" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "bad ROOT exits 2" || bad "bad ROOT exit $rc ($out)"

out=$(bash "$LINT" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "lint is clean on the real repo tree" || bad "real tree has offenders: $out"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
