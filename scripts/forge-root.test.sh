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
extract() { awk '/# FORGE_ROOT bootstrap/{f=1} f{sub(/^[ ]+/,""); print} f&&/^[ ]*fi$/{exit}' "$ROOT/$1"; }
extract commands/work-on.md > "$T/canon"
[ -s "$T/canon" ] && ok || bad "canonical bootstrap not found in work-on.md"
for f in $SITES; do
  extract "$f" > "$T/s"
  cmp -s "$T/canon" "$T/s" && ok || bad "bootstrap in $f differs from canonical"
done

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
# plugin install: no env vars at all
mkdir -p "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0/scripts"; : > "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0/scripts/verify-phase-trail.sh"
expect "plugin cache resolves with no env" "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0" "$(run "$T/h1")"
expect "CLAUDE_PLUGIN_ROOT resolves" "$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT="$T/h1/.claude/plugins/cache/mk/forgedock/1.0.0")"
# nothing installed: empty (never the consumer repo, never a relative path)
expect "unresolvable stays empty" "" "$(run "$T/empty")"
expect "relative FORGE_HOME ignored" "" "$(run "$T/empty" FORGE_HOME=.)"
# explicit FORGEDOCK_HOME is authoritative, even if bogus (caller then fails closed)
expect "FORGEDOCK_HOME authoritative" "$T/nowhere" "$(run "$T/h1" FORGEDOCK_HOME="$T/nowhere")"
# symlink install (install.sh): ~/.claude/commands/work-on.md -> <clone>/commands/work-on.md
mkdir -p "$T/clone/commands" "$T/clone/scripts" "$T/h2/.claude/commands"; : > "$T/clone/scripts/verify-phase-trail.sh"; : > "$T/clone/commands/work-on.md"
ln -s "$T/clone/commands/work-on.md" "$T/h2/.claude/commands/work-on.md"
expect "install.sh symlink resolves" "$(cd "$T/clone" && pwd -P)" "$(cd "$(run "$T/h2")" && pwd -P)"
expect "FORGE_HOME without scripts falls through" "$(cd "$T/clone" && pwd -P)" "$(cd "$(run "$T/h2" FORGE_HOME="$T/h2/.claude")" && pwd -P)"

echo "forge-root tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
