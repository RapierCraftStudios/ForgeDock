#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Guards commands/review-pr.md against using $ARGUMENTS (the whole argument string) as a PR number,
# and exercises the Argument Parse block. Run: bash scripts/review-pr-arguments.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
SPEC="$ROOT/commands/review-pr.md"
STAGING="$ROOT/commands/review-pr-staging.md"
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# Test 1: lint - no gh / issues-path use of $ARGUMENTS
hits=$(grep -nE 'gh (pr|api)[^#]*\$"?ARGUMENTS|issues/\$ARGUMENTS' "$SPEC" || true)
if [ -z "$hits" ]; then ok; else bad "gh/issues use of \$ARGUMENTS in review-pr.md"; echo "$hits" | sed 's/^/    /'; fi

# Test 2: every other $ARGUMENTS use is on an allowlisted line (Input header, prose, parse block, staging pass-through)
others=$(grep -n 'ARGUMENTS' "$SPEC" | grep -vE '^[0-9]+:(\*\*Input\*\*|If `\$ARGUMENTS`|\*\*`\$ARGUMENTS`|ARGS_RAW="\$ARGUMENTS"|>>> INVOKE: Skill\(.*review-pr-staging)' || true)
if [ -z "$others" ]; then ok; else bad "unexpected \$ARGUMENTS use"; echo "$others" | sed 's/^/    /'; fi

# Test 3: parse block extracted from the spec
BLOCK=$(sed -n '/^# BEGIN review-pr-arg-parse/,/^# END review-pr-arg-parse/p' "$SPEC")
if [ -n "$BLOCK" ]; then ok; else bad "parse block markers missing"; fi
if printf '%s' "$BLOCK" | grep -qE '(^|[^a-z_])eval( |$)'; then bad "parse block uses eval"; else ok; fi

run_parse() { # run_parse <args> -> prints PR_NUMBER|REPO|MERGE_GH_FLAG|MERGE_ISSUE|MERGE_BASE|AUTO_MERGE|THOROUGH|MERGE_WORKTREE
  ARGUMENTS="$1" bash -c "gh() { return 1; }; $BLOCK"'
printf "%s|%s|%s|%s|%s|%s|%s|%s" "$PR_NUMBER" "$REPO" "$MERGE_GH_FLAG" "$MERGE_ISSUE" "$MERGE_BASE" "$AUTO_MERGE" "$THOROUGH" "$MERGE_WORKTREE"'
}
expect() { # expect <desc> <want> <args>
  got=$(run_parse "$3")
  if [ "$got" = "$2" ]; then ok; else bad "$1: got '$got' want '$2'"; fi
}
expect "bare number" "3401|||||false|false|" "3401"
expect "full flags quoted" "3401|o/r|-R o/r|3398|staging|true|false|/w/t" '3401 --auto-merge --issue 3398 --base staging --gh-flag "-R o/r" --worktree /w/t'
expect "full flags unquoted" "3401|o/r|-R o/r|3398|staging|true|false|/w/t" '3401 --auto-merge --issue 3398 --base staging --gh-flag -R o/r --worktree /w/t'
expect "single-quoted gh-flag" "3401|o/r|-R o/r|||false|false|" "3401 --gh-flag '-R o/r'"
expect "PR URL" "3401|||||false|false|" "https://github.com/o/r/pull/3401"
expect "thorough" "12|o/r|-R o/r|||false|true|" "12 --thorough --gh-flag -R o/r"
expect "keyword staging" "|||||false|false|" "staging"
expect "keyword open" "|||||false|false|" "open"
expect "thorough is not a PR ref" "|||||false|true|" "--thorough"
expect "flag-as-value swallow" "3401|||||true|false|" "3401 --auto-merge --issue --auto-merge"
expect "non-numeric issue" "3401|||||false|false|" "3401 --issue 1;touch"
expect "non-numeric issue shape" "3401|||||false|false|" "3401 --issue 12x"
expect "gh-flag swallows flag" "3401|||||true|false|" "3401 --gh-flag -R --auto-merge"
expect "bad repo shape" "3401|||||false|false|" "3401 --gh-flag -R a/b/c"
expect "base followed by flag" "3401|||||false|false|/w" "3401 --base --worktree /w"
expect "leading-dash worktree" "3401|||||false|false|" "3401 --worktree -x"
expect "duplicate flags last wins" "3401|||7||false|false|" "3401 --issue 5 --issue 7"

# Test 4: staging numeric test no longer needs the whole string to be numeric
if grep -q "grep -qE '^\[0-9\]+\$'" "$STAGING"; then bad "staging still tests the whole argument string"; else ok; fi

echo "review-pr-arguments: $pass passed, $fail failed"
[ "$fail" = 0 ]
