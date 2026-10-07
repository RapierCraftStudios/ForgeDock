#!/usr/bin/env bash
# forge-root.test.sh — guards the canonical FORGE_ROOT bootstrap (forge#3098).
# Plugin installs set neither FORGEDOCK_HOME nor FORGE_HOME; the specs must resolve ForgeDock's OWN
# install root (never the consumer repo) and fail closed when it cannot be found.
# Usage: bash scripts/forge-root.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$HERE/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
expect() { [ "$2" = "$3" ] && ok || bad "$1 (got '$3' want '$2')"; }

SITES="commands/work-on.md commands/work-on/review.md commands/review-pr.md commands/orchestrate/phase-4-execution.md"

# extract the bootstrap block (comment line .. closing top-level fi), indentation stripped
# Block ends at the first line (after the marker) that starts with `fi` at the marker's own indentation.
# extract <file> <n> prints the n-th (1-based) bootstrap copy in the file.
extract() { awk -v want="$2" '/# FORGE_ROOT bootstrap/{c++; if(c==want){f=1; match($0,/^[ ]*/); ind=RLENGTH}} f{l=$0; sub(/^[ ]+/,"",l); print l} f&&match($0,/^[ ]*fi$/)&&RLENGTH-2==ind{exit}' "$ROOT/$1"; }
count_copies() { grep -c '# FORGE_ROOT bootstrap' "$ROOT/$1"; }
extract commands/work-on.md 1 > "$T/canon"
[ -s "$T/canon" ] && ok || bad "canonical bootstrap not found in work-on.md"
for f in $SITES; do
  n=$(count_copies "$f"); [ "$n" -ge 1 ] && ok || bad "no bootstrap copy in $f"
  i=1
  while [ "$i" -le "$n" ]; do   # compare EVERY copy (phase-4 has two)
    extract "$f" "$i" > "$T/s"
    cmp -s "$T/canon" "$T/s" && ok || bad "bootstrap copy $i in $f differs from canonical"
    i=$((i+1))
  done
done
# the canonical block must not contain the stale lexical glob / unfiltered marketplaces glob
grep -q 'sort -rV' "$T/canon" && ok || bad "canonical bootstrap lacks version sort"
grep -qF 'marketplaces/*; do' "$T/canon" && bad "canonical bootstrap globs all marketplaces" || ok
# review.md must hard-exit on an unreadable trail
grep -qE 'TRAIL_RC.* -ge 2 .*exit 1' "$ROOT/commands/work-on/review.md" && ok || bad "work-on/review.md lacks hard exit guard for TRAIL_RC>=2"

# no consumer-repo fallback / fail-open remains in the gates
for f in $SITES; do
  grep -nE 'FORGE_HOME:-\$?\{?\{?REPO_PATH\}*/scripts' "$ROOT/$f" >/dev/null && bad "repo-path fallback in $f" || ok
done
for f in commands/review-pr.md commands/work-on/review.md; do
  grep -nE '^[[:space:]]*TRAIL_RC=0[[:space:]]*$' "$ROOT/$f" >/dev/null && bad "fail-open TRAIL_RC=0 in $f" || ok
done

run() { # run <home> [env assignments...] -> prints FORGE_ROOT
  local h="$1"; shift
  ( cd "$T/consumer" && env -i PATH="$PATH" HOME="$h" "$@" bash -c "$(cat "$T/canon"); printf %s \"\$FORGE_ROOT\"" )
}
mkdir -p "$T/consumer/scripts"; : > "$T/consumer/scripts/verify-phase-trail.sh"   # hostile/lookalike consumer repo
mkscripts() { mkdir -p "$1/scripts"; : > "$1/scripts/verify-phase-trail.sh"; : > "$1/scripts/lint-dispatch-prompt.sh"; }
# plugin install: no env vars at all
mkscripts "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0"
expect "plugin cache resolves with no env" "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0" "$(run "$T/h1")"
expect "CLAUDE_PLUGIN_ROOT resolves" "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT="$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0")"
# nothing installed: empty (never the consumer repo, never a relative path)
expect "unresolvable stays empty" "" "$(run "$T/empty")"
expect "relative FORGE_HOME ignored" "" "$(run "$T/empty" FORGE_HOME=.)"
# explicit FORGEDOCK_HOME is authoritative, even if bogus (caller then fails closed)
expect "FORGEDOCK_HOME authoritative" "$T/nowhere" "$(run "$T/h1" FORGEDOCK_HOME="$T/nowhere")"
# symlink install (install.sh): ~/.claude/commands/work-on.md -> <clone>/commands/work-on.md
mkdir -p "$T/clone/commands" "$T/h2/.claude/commands"; mkscripts "$T/clone"; : > "$T/clone/commands/work-on.md"
ln -s "$T/clone/commands/work-on.md" "$T/h2/.claude/commands/work-on.md"
expect "install.sh symlink resolves" "$(cd "$T/clone" && pwd -P)" "$(cd "$(run "$T/h2")" && pwd -P)"
expect "FORGE_HOME without scripts falls through" "$(cd "$T/clone" && pwd -P)" "$(cd "$(run "$T/h2" FORGE_HOME="$T/h2/.claude")" && pwd -P)"

# newest cached version wins (1.10.0 must beat 1.9.0)
for v in 1.9.0 1.10.0 1.2.0; do mkscripts "$T/h3/.claude/plugins/cache/mk/forgedock/$v"; done
expect "newest cached version wins" "$T/h3/.claude/plugins/cache/mk/forgedock/1.10.0" "$(run "$T/h3")"
# HOME containing a space still resolves
mkscripts "$T/sp ace/.claude/plugins/cache/mk/forgedock/2.0.0"
expect "space in HOME resolves" "$T/sp ace/.claude/plugins/cache/mk/forgedock/2.0.0" "$(run "$T/sp ace")"
# relative FORGEDOCK_HOME / CLAUDE_PLUGIN_ROOT rejected (fail closed => empty)
expect "relative FORGEDOCK_HOME rejected" "" "$(run "$T/h1" FORGEDOCK_HOME=scripts/..)"
expect "relative CLAUDE_PLUGIN_ROOT ignored" "" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT=../consumer)"
# a candidate with only one of the two needed scripts is rejected
mkdir -p "$T/h4/.claude/plugins/cache/mk/forgedock/1.0.0/scripts"; : > "$T/h4/.claude/plugins/cache/mk/forgedock/1.0.0/scripts/verify-phase-trail.sh"
expect "partial install (missing lint script) rejected" "" "$(run "$T/h4")"
# non-ForgeDock marketplace dirs are ignored; ForgeDock-named ones resolve
mkscripts "$T/h5/.claude/plugins/marketplaces/other-tool"
expect "non-ForgeDock marketplace ignored" "" "$(run "$T/h5")"
mkscripts "$T/h6/.claude/plugins/marketplaces/forgedock"
expect "forgedock marketplace resolves" "$T/h6/.claude/plugins/marketplaces/forgedock" "$(run "$T/h6")"

echo "forge-root tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
