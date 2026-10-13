#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests for scripts/selfreview-plan.sh (build-time self-review plan, forge#3971). Run: bash scripts/selfreview-plan.test.sh
# (bash 3.2 compatible)
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
SCRIPT="$DIR/selfreview-plan.sh"
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/selfreview-plan.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
export FORGEDOCK_HOME="$ROOT"   # the resolver must not pick up an ambient install
unset FORGE_SELFREVIEW

PLAN=""; RC=0
# run <files, newline separated> <flags...>
run() {
  printf '%s\n' "$1" > "$WORK/files"; shift
  PLAN=$(bash "$SCRIPT" --files-file "$WORK/files" "$@" 2>/dev/null); RC=$?
}
field() { printf '%s\n' "$PLAN" | sed -n "s/^$1=//p"; }
expect() { # name key want
  local got; got=$(field "$2")
  if [ "$got" = "$3" ]; then ok; else bad "$1: $2='$got', want '$3'"; fi
}
has_agent() { case " $(field SELECTED_AGENTS) " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# e1: docs-only and empty diffs skip with a recorded reason
run "docs/GUIDE.md
README.md" --changed-lines 40
expect "docs-only skips" SELFREVIEW skip; expect "docs-only reason" SKIP_REASON docs-only
run "" --changed-lines 0
expect "empty diff skips" SELFREVIEW skip; expect "empty reason" SKIP_REASON empty-diff
run "commands/work-on/build.md" --changed-lines 40 --changed-files 1
expect "spec markdown is not docs" SELFREVIEW skip
if [ "$(field SKIP_REASON)" = "docs-only" ]; then bad "commands/*.md treated as docs"; else ok; fi

# e2: small tier, Security-only roster, no trigger: skipped; the same size with an auth path runs
run "scripts/foo.sh" --changed-lines 30 --changed-files 1
expect "small security-only skips" SELFREVIEW skip; expect "small reason" SKIP_REASON small-security-only; expect "small tier" TIER small
run "src/auth/session.py
src/util.py" --changed-lines 30 --changed-files 2
expect "small + auth path runs" SELFREVIEW run; expect "small + auth tier" TIER small
has_agent auth && ok || bad "auth path did not add auth"
has_agent security && ok || bad "security floor missing"
run "scripts/foo.sh
scripts/bar.sh" --changed-lines 30 --changed-files 2 --contract-flags "HIGH_RISK"
expect "small + HIGH_RISK runs" SELFREVIEW run; expect "HIGH_RISK lifts tier" TIER standard

# standard tier runs
run "scripts/foo.sh
scripts/bar.sh" --changed-lines 400 --changed-files 2
expect "standard runs" SELFREVIEW run; expect "standard tier" TIER standard; expect "standard no reason" SKIP_REASON ""
has_agent security && ok || bad "standard roster lacks security"

# EXTENDED depth lifts a small roster
run "scripts/foo.sh" --changed-lines 20 --changed-files 1 --review-depth EXTENDED
expect "extended depth runs" SELFREVIEW run; expect "extended tier" TIER standard

# e3: off switch, no Agent tool, unresolvable roster degrade to skip and exit 0
FORGE_SELFREVIEW=off run "scripts/a.sh
scripts/b.sh" --changed-lines 400
[ "$RC" = 0 ] && ok || bad "off exit code $RC"
expect "off skips" SELFREVIEW skip; expect "off reason" SKIP_REASON disabled
run "scripts/a.sh
scripts/b.sh" --changed-lines 400 --agent-available false
[ "$RC" = 0 ] && ok || bad "no-agent exit code $RC"
expect "no agent skips" SELFREVIEW skip; expect "no agent reason" SKIP_REASON no-agent-tool
FORGEDOCK_HOME=/nonexistent-forge-home run "scripts/a.sh
scripts/b.sh" --changed-lines 400
[ "$RC" = 0 ] && ok || bad "unresolvable exit code $RC"
expect "unresolvable roster skips" SELFREVIEW skip; expect "unresolvable reason" SKIP_REASON roster-unavailable

# e4: a tree that already has a completed self-review is not dispatched again
run "scripts/a.sh
scripts/b.sh" --changed-lines 400 --tree aaa --done-trees "bbb aaa"
expect "same tree skips" SELFREVIEW skip; expect "same tree reason" SKIP_REASON already-done
run "scripts/a.sh
scripts/b.sh" --changed-lines 400 --tree ccc --done-trees "bbb aaa"
expect "new tree runs" SELFREVIEW run

# usage: unknown flag exits 2
bash "$SCRIPT" --nope >/dev/null 2>&1; [ "$?" = 2 ] && ok || bad "unknown flag should exit 2"

echo "selfreview-plan: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
