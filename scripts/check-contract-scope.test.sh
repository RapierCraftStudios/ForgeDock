#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/check-contract-scope.sh (typed `### Out of Scope` grammar).
# Run: bash scripts/check-contract-scope.test.sh   (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/check-contract-scope.sh"
pass=0; fail=0
TAB=$(printf '\t')

mk() { printf '## Builder Contract\n\n### Deliverables\n\n| a | b |\n\n### Out of Scope\n\n%s\n\n> Pipeline powered by [ForgeDock](https://example.invalid)\n' "$1"; }

# check <valid|invalid> <description> <section-text>
check() {
  want="$1"; desc="$2"; body=$(mk "$3")
  printf '%s\n' "$body" | bash "$S" validate >/dev/null 2>&1; got=$?
  if { [ "$want" = valid ] && [ "$got" = 0 ]; } || { [ "$want" = invalid ] && [ "$got" = 1 ]; }; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (want $want, exit $got)"; fi
}
# list_is <description> <section-text> <expected TSV (printf-style, \t and \n)>
list_is() {
  desc="$1"; body=$(mk "$2"); want=$(printf "$3")
  got=$(printf '%s\n' "$body" | bash "$S" list 2>/dev/null)
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc"; echo "  want: $want"; echo "  got:  $got"; fi
}

check valid   "None. accepted"                      'None.'
check valid   "deferred with issue"                 '- `scripts/a.sh` — deferred → #12: tracked there'
check valid   "not-affected with evidence"          '- `bin/engine/` — not-affected: no reader found by grep'
check valid   "accepted-risk with reason"           '- `pkg/types.js` — accepted-risk: body-only format'
check valid   "ASCII arrow accepted"                '- `a.sh` — deferred -> #7: later'
check valid   "no-space arrow accepted"             '- `a.sh` — deferred→#7: later'
check valid   "three mixed items"                   '- `a/` — not-affected: x
- `b.js` — accepted-risk: y
- `c.md` — deferred → #3446: z'
check valid   "continuation line joins item"        '- `a.sh` — deferred → #5:
  because of reasons'
check invalid "untyped bullet rejected"             '- `a.sh` — out of scope for now'
check invalid "deferred without number rejected"    '- `a.sh` — deferred: later'
check invalid "deferred arrow without number"       '- `a.sh` — deferred → TBD: later'
check invalid "no backticked path rejected"         '- the sync script — deferred → #9: later'
check invalid "bare prose rejected"                 'Nothing relevant.'
check invalid "one bad item among good ones"        '- `a` — not-affected: ok
- `b` — nope'
check invalid "empty section rejected"              ''

# Missing section
printf '## Builder Contract\n\n### Deliverables\n\nx\n' | bash "$S" validate >/dev/null 2>&1; got=$?
if [ "$got" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: missing section (want exit 1, got $got)"; fi

list_is "list rows for three forms" '- `a/` — not-affected: x
- `b.js` — accepted-risk: y
- `c.md` — deferred → #3446: z' "not-affected${TAB}a${TAB}\naccepted-risk${TAB}b.js${TAB}\ndeferred${TAB}c.md${TAB}3446"
list_is "multi-path item emits one row per path" '- `x.sh`, `y.sh` — deferred → #8: both' "deferred${TAB}x.sh${TAB}8\ndeferred${TAB}y.sh${TAB}8"
list_is "why-text with other keywords does not change disposition" '- `a` — accepted-risk: not-affected elsewhere, deferred → #1 is separate' "accepted-risk${TAB}a${TAB}"
list_is "None. lists nothing" 'None.' ""
list_is "invalid section lists nothing" '- `a` — untyped' ""

# Section ends at the next ### heading
printf '### Out of Scope\n\n- `a` — not-affected: x\n\n### Quality\n\n- plain bullet\n' | bash "$S" validate >/dev/null 2>&1; got=$?
if [ "$got" = 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: section must end at next ### (exit $got)"; fi

# Live-shaped contract (mixed items, trailing attribution line)
LIVE=$(mk '- `bin/engine/` — not-affected: no engine module reads the contract Out of Scope section (grep in investigation).
- `packages/protocol/src/types.js` — accepted-risk: CONTRACT requiredFields stays [Task type].
- `commands/work-on/build/architect.md` — deferred → #3446: blast-radius manifest is tracked there.')
got=$(printf '%s\n' "$LIVE" | bash "$S" list 2>/dev/null | wc -l | tr -d ' ')
if [ "$got" = 3 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: live-shaped contract rows (want 3, got $got)"; fi

# File argument and usage errors
TMPF=$(mktemp "${TMPDIR:-/tmp}/ccs.XXXXXX"); printf '%s\n' "$LIVE" > "$TMPF"
bash "$S" validate "$TMPF" >/dev/null 2>&1; got=$?
if [ "$got" = 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: file argument (exit $got)"; fi
rm -f "$TMPF"
bash "$S" validate /nonexistent/x >/dev/null 2>&1; got=$?
if [ "$got" = 2 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: unreadable file (want 2, got $got)"; fi
bash "$S" bogus </dev/null >/dev/null 2>&1; got=$?
if [ "$got" = 2 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: bad mode (want 2, got $got)"; fi

echo "check-contract-scope.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
