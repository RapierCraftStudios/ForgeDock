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

TAIL='
printf "%s|%s|%s|%s|%s|%s|%s|%s" "$PR_NUMBER" "$REPO" "$MERGE_GH_FLAG" "$MERGE_ISSUE" "$MERGE_BASE" "$AUTO_MERGE" "$THOROUGH" "$MERGE_WORKTREE"'
# Run with the interpreter executing this test (system bash 3.2 on the macOS step), never a PATH bash.
run_parse() { # run_parse <args> -> prints PR_NUMBER|REPO|MERGE_GH_FLAG|MERGE_ISSUE|MERGE_BASE|AUTO_MERGE|THOROUGH|MERGE_WORKTREE
  ARGUMENTS="$1" "${BASH:-bash}" -c "gh() { return 1; }; $BLOCK$TAIL"
}
SUBST_TMP=""
trap '[ -n "$SUBST_TMP" ] && rm -f "$SUBST_TMP"' EXIT
# Textual-substitution runner: the spec loader replaces $ARGUMENTS in the text BEFORE bash parses it, so a
# value containing double quotes is spliced into the ARGS_RAW="..." assignment. Rebuild the block line-wise
# (no sed/regex on user data, so quotes, backslashes, & and / survive verbatim) and run it as a script file.
run_parse_subst() { # run_parse_subst <args> -> same 8-field line as run_parse
  SUBST_TMP=$(mktemp "${TMPDIR:-/tmp}/review-pr-subst.XXXXXX")
  {
    printf '%s\n' 'gh() { return 1; }'
    while IFS= read -r line; do
      if [ "$line" = 'ARGS_RAW="$ARGUMENTS"' ]; then printf 'ARGS_RAW="%s"\n' "$1"; else printf '%s\n' "$line"; fi
    done <<EOB
$BLOCK
EOB
    printf '%s\n' "$TAIL"
  } > "$SUBST_TMP"
  # sanity: the literal args were spliced in and the placeholder is gone
  grep -qF "ARGS_RAW=\"$1\"" "$SUBST_TMP" && ! grep -qF 'ARGS_RAW="$ARGUMENTS"' "$SUBST_TMP" || echo "SUBST-GENERATION-FAILED"
  "${BASH:-bash}" "$SUBST_TMP"
  rm -f "$SUBST_TMP"; SUBST_TMP=""
}
expect() { # expect <desc> <want> <args>
  got=$(run_parse "$3")
  if [ "$got" = "$2" ]; then ok; else bad "$1: got '$got' want '$2'"; fi
}
expect_subst() { # expect_subst <desc> <want> <args> -- textual substitution of the args into the block source
  got=$(run_parse_subst "$3")
  if [ "$got" = "$2" ]; then ok; else bad "substitution $1: got '$got' want '$2'"; fi
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

# Textual-substitution cases (loader fidelity)
expect_subst "bare number" "3401|||||false|false|" "3401"
expect_subst "unquoted flags" "3401|o/r|-R o/r|3398|staging|true|false|/w/t" '3401 --auto-merge --issue 3398 --base staging --gh-flag -R o/r --worktree /w/t'
expect_subst "single-quoted gh-flag" "3401|o/r|-R o/r|||false|false|" "3401 --gh-flag '-R o/r'"
# Known loader-quoting gap: a double-quoted value is spliced into ARGS_RAW="..." and closes the string early,
# so the block aborts and binds nothing. Pinned here so the divergence stays visible (spec change tracked separately);
# if the spec is hardened (e.g. a quoted heredoc), update this to the quoted-form result used by run_parse.
expect_subst "double-quoted gh-flag breaks out of ARGS_RAW (known gap)" "|||||false|false|" '3401 --auto-merge --issue 3398 --base staging --gh-flag "-R o/r" --worktree /w/t' 2>/dev/null

# Test 4: staging numeric test no longer needs the whole string to be numeric
if grep -q "grep -qE '^\[0-9\]+\$'" "$STAGING"; then bad "staging still tests the whole argument string"; else ok; fi

echo "review-pr-arguments: $pass passed, $fail failed"
[ "$fail" = 0 ]
