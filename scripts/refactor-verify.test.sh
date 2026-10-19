#!/usr/bin/env bash
# refactor-verify.test.sh — cases for scripts/refactor-verify.sh (forge#4209).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds a throwaway git repo (Python package + unittest suite) and checks baseline/verify on a pure move plus shim
# and on each failure kind.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RV="$HERE/refactor-verify.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/refactor-verify-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
eq() { if [ "$2" = "$3" ]; then ok; else bad "$1 (got: $2 want: $3)"; fi }
q() { printf '%s' "$OUT" | jq -c "$1"; }
run() { OUT="$("$@" 2>"$TMP/err")"; RC=$?; }
export PYTHONDONTWRITEBYTECODE=1

R="$TMP/repo"; B="$TMP/baseline.json"
TEST_CMD='python3 -m unittest discover -s tests -t .'
g() { git -C "$R" -c user.name=t -c user.email=t@example.invalid "$@"; }
commit() { g add -A && g commit -qm "$1"; }

# ---- fixture: pkg/big.py + 4 unittest tests (1 skipped) ----
mkdir -p "$R/pkg" "$R/tests"
git init -q "$R"
printf '__pycache__/\n' > "$R/.gitignore"
: > "$R/pkg/__init__.py"
: > "$R/tests/__init__.py"
cat > "$R/pkg/big.py" <<'EOF'
import os

LIMIT = 3


def _helper(x):
    return x * 2


def double(x):
    return _helper(x)


def env_name():
    return os.name


class Counter:
    def __init__(self):
        self.n = 0

    def bump(self):
        self.n += 1
        return self.n
EOF
cat > "$R/tests/test_big.py" <<'EOF'
import unittest

from pkg.big import LIMIT, Counter, double


class BigTest(unittest.TestCase):
    def test_double(self):
        self.assertEqual(double(2), 4)

    def test_limit(self):
        self.assertEqual(LIMIT, 3)

    def test_counter(self):
        c = Counter()
        c.bump()
        self.assertEqual(c.bump(), 2)

    @unittest.skip("not yet")
    def test_later(self):
        pass
EOF
commit base; g tag base

# ---- 1. baseline: counts, public symbols, cycles ----
run bash "$RV" baseline --root "$R" --target pkg/big.py --test-cmd "$TEST_CMD" --out "$B"
eq "baseline rc" "$RC" 0
OUT="$(cat "$B" 2>/dev/null)"
eq "baseline keys" "$(q 'keys')" '["cycles","index_dir","lang","root","symbols","target","test","test_cmd"]'
eq "baseline counts" "$(q '.test')" '{"exit":0,"passed":3,"skipped":1}'
eq "baseline public symbols" "$(q '[.symbols[]|"\(.module):\(.name)"]')" \
  '["pkg.big:Counter","pkg.big:Counter.__init__","pkg.big:Counter.bump","pkg.big:LIMIT","pkg.big:double","pkg.big:env_name"]'
eq "baseline excludes private" "$(q '[.symbols[]|select(.name=="_helper")]|length')" 0
eq "baseline cycles" "$(q '.cycles')" '[]'
eq "baseline lang" "$(q '.lang')" '"python"'

# pure move: symbols verbatim into pkg/big_parts/{core,counter}.py, pkg/big.py becomes an import-only shim.
pure_move() {
  mkdir -p "$R/pkg/big_parts"
  : > "$R/pkg/big_parts/__init__.py"
  cat > "$R/pkg/big_parts/core.py" <<'EOF'
import os

LIMIT = 3


def _helper(x):
    return x * 2


def double(x):
    return _helper(x)


def env_name():
    return os.name
EOF
  cat > "$R/pkg/big_parts/counter.py" <<'EOF'
class Counter:
    def __init__(self):
        self.n = 0

    def bump(self):
        self.n += 1
        return self.n
EOF
  cat > "$R/pkg/big.py" <<'EOF'
from pkg.big_parts.core import (
    LIMIT,
    _helper,
    double,
    env_name,
)
from pkg.big_parts.counter import Counter
EOF
}
case_branch() { g checkout -q -B "$1" base; }
verify() { run bash "$RV" verify --baseline "$B" --base base; }

# ---- 2. pure move plus shim passes ----
case_branch pure; pure_move; commit pure
verify
eq "pure move rc" "$RC" 0
eq "pure move ok" "$(q '.ok')" true
eq "pure move no failures" "$(q '.failures')" '[]'

# ---- 3. logic diff in a moved body ----
case_branch logic; pure_move
sed -i.bak 's/return _helper(x)/return _helper(x) + 0/' "$R/pkg/big_parts/core.py"; rm -f "$R/pkg/big_parts/core.py.bak"
commit logic
verify
eq "logic diff rc" "$RC" 1
eq "logic diff kinds" "$(q '[.failures[].kind]|unique')" '["logic-diff"]'
eq "logic diff location" "$(q '[.failures[]|select(.file=="pkg/big_parts/core.py")|.text]')" '["return _helper(x) + 0"]'

# ---- 4. a public symbol no longer resolves from its old path ----
case_branch missing; pure_move
printf 'from pkg.big_parts.core import LIMIT, double\nfrom pkg.big_parts.counter import Counter\n' > "$R/pkg/big.py"
commit missing
verify
eq "missing symbol rc" "$RC" 1
eq "missing symbol" "$(q '[.failures[]|select(.kind=="missing-symbol")|"\(.module):\(.name)"]')" '["pkg.big:env_name"]'
eq "missing symbol: shim stays import-only" "$(q '[.failures[]|select(.kind=="logic-diff")]|length')" 0

# ---- 5. changed pass/skip count ----
case_branch counts; pure_move
sed -i.bak 's/def test_limit/@unittest.skip("x")\n    def test_limit/' "$R/tests/test_big.py"; rm -f "$R/tests/test_big.py.bak"
commit counts
verify
eq "count change rc" "$RC" 1
eq "count change" "$(q '[.failures[]|select(.kind=="count-changed")|[.before.passed,.before.skipped,.after.passed,.after.skipped]]')" \
  '[[3,1,2,2]]'

# ---- 6. new import cycle (import lines only, so no logic diff) ----
case_branch cycle; pure_move
printf 'import pkg.big_parts.counter\n' | cat - "$R/pkg/big_parts/core.py" > "$TMP/core.py" && mv "$TMP/core.py" "$R/pkg/big_parts/core.py"
printf 'import pkg.big_parts.core\n' | cat - "$R/pkg/big_parts/counter.py" > "$TMP/counter.py" && mv "$TMP/counter.py" "$R/pkg/big_parts/counter.py"
commit cycle
verify
eq "new cycle rc" "$RC" 1
eq "new cycle kinds" "$(q '[.failures[].kind]|unique')" '["new-cycle"]'
eq "new cycle" "$(q '[.failures[].cycle]')" '[["pkg.big_parts.core","pkg.big_parts.counter"]]'

# ---- 7. summary parsers (pytest, TAP, node spec, jest) and unparseable output ----
g checkout -q base
counts_of() { run bash "$RV" baseline --root "$R" --target pkg/big.py --test-cmd "$1" --out "$TMP/c.json"; jq -c .test "$TMP/c.json"; }
eq "pytest summary" "$(counts_of "printf '===== 3 passed, 2 skipped in 0.05s =====\n'")" '{"exit":0,"passed":3,"skipped":2}'
eq "pytest -q summary" "$(counts_of "printf '7 passed, 1 skipped, 2 warnings in 1.20s\n'")" '{"exit":0,"passed":7,"skipped":1}'
eq "tap summary" "$(counts_of "printf 'ok 1 - a\n# tests 6\n# pass 5\n# skipped 1\n# fail 0\n'")" '{"exit":0,"passed":5,"skipped":1}'
eq "node spec summary" "$(counts_of "printf 'ℹ tests 4\nℹ pass 4\nℹ skipped 0\n'")" '{"exit":0,"passed":4,"skipped":0}'
eq "jest summary" "$(counts_of "printf 'Tests:       1 skipped, 4 passed, 5 total\n'")" '{"exit":0,"passed":4,"skipped":1}'
run bash "$RV" baseline --root "$R" --target pkg/big.py --test-cmd "echo nothing to see" --out "$TMP/u.json"
eq "unparseable counts rc" "$RC" 2
eq "unparseable counts writes nothing" "$([ -e "$TMP/u.json" ] && echo written || echo none)" none

# ---- 8. usage ----
bash "$RV" >/dev/null 2>&1; eq "no args" "$?" 2
bash "$RV" frobnicate >/dev/null 2>&1; eq "unknown subcommand" "$?" 2
bash "$RV" verify --baseline "$TMP/none.json" --base base >/dev/null 2>&1; eq "missing baseline" "$?" 2
bash "$RV" verify --baseline "$B" --base no-such-ref >/dev/null 2>&1; eq "unknown ref" "$?" 2
bash "$RV" baseline --root "$R" --target missing.py --test-cmd true --out "$TMP/x.json" >/dev/null 2>&1; eq "missing target" "$?" 2

# ---- 9. read-only on the target repo ----
eq "worktree clean after runs" "$(git -C "$R" status --porcelain)" ""

echo "refactor-verify.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
