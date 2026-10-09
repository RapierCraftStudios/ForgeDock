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
others=$(grep -n 'ARGUMENTS' "$SPEC" | grep -vE '^[0-9]+:(\*\*Input\*\*|If `\$ARGUMENTS`|\*\*`\$ARGUMENTS`|\$ARGUMENTS$|\*\*Argument injection hardening|>>> INVOKE: Skill\(.*review-pr-staging)' || true)
if [ -z "$others" ]; then ok; else bad "unexpected \$ARGUMENTS use"; echo "$others" | sed 's/^/    /'; fi

# Test 2b: inside bash fences of either spec, the loader placeholder may appear only as the standalone heredoc
# body line - a mention in a comment is substituted too, and a newline in the arguments ends the comment
for f in "$SPEC" "$STAGING"; do
  fenced=$(awk '/^```/{in_f=!in_f; next} in_f && /ARGUMENTS/ && $0 != "$ARGUMENTS" {print FILENAME": "NR": "$0}' "$f")
  if [ -z "$fenced" ]; then ok; else bad "placeholder inside a bash fence outside the heredoc body"; echo "$fenced" | sed 's/^/    /'; fi
  # ...and the standalone heredoc body line appears exactly once (a second bare line would be a second splice)
  bare=$(awk '/^```/{in_f=!in_f; next} in_f && $0 == "$ARGUMENTS" {n++} END{print n+0}' "$f")
  if [ "$bare" = 1 ]; then ok; else bad "$(basename "$f"): expected exactly 1 bare placeholder line in bash fences, found $bare"; fi
done

# Test 3: parse block extracted from the spec
BLOCK=$(sed -n '/^# BEGIN review-pr-arg-parse/,/^# END review-pr-arg-parse/p' "$SPEC")
if [ -n "$BLOCK" ]; then ok; else bad "parse block markers missing"; fi
if printf '%s' "$BLOCK" | grep -qE '(^|[^a-z_])eval( |$)'; then bad "parse block uses eval"; else ok; fi

TAIL='
printf "%s|%s|%s|%s|%s|%s|%s|%s" "$PR_NUMBER" "$REPO" "$MERGE_GH_FLAG" "$MERGE_ISSUE" "$MERGE_BASE" "$AUTO_MERGE" "$THOROUGH" "$MERGE_WORKTREE"'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/review-pr-args.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
SENTINEL="$WORK/sentinel"
ERR="$WORK/stderr"
# Textual-substitution runner: the spec loader replaces the standalone $ARGUMENTS line in the text BEFORE bash
# parses it. Rebuild the source line-wise (no sed/regex on user data, so quotes, backslashes, & and / survive
# verbatim) and run it as a script file, exactly as the loader's output would run. stderr goes to $ERR.
# gen_script <source> <args> <outfile> [tail]
gen_script() {
  # Mimic the executor's NONCE rule: a fresh random delimiter per run, unknown to the caller.
  NONCE_VAL="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"; [ -n "$NONCE_VAL" ] || NONCE_VAL="r$$$RANDOM$RANDOM"
  {
    printf '%s\n' 'gh() { return 1; }'
    while IFS= read -r line; do
      if [ "$line" = '$ARGUMENTS' ]; then printf '%s\n' "$2"
      else case "$line" in
        # The loader substitutes EVERY occurrence, comments included; mimic that so a stray mention is caught.
        *'$ARGUMENTS'*) printf '%s\n' "${line//'$ARGUMENTS'/$2}" ;;
        *FORGE_ARGS_EOF_NONCE*) printf '%s\n' "${line//NONCE/$NONCE_VAL}" ;;
        *) printf '%s\n' "$line" ;; esac; fi
    done <<EOB
$1
EOB
    printf '%s\n' "${4:-}"
  } > "$3"
  return 0
}
# Run with the interpreter executing this test (system bash 3.2 on the macOS step), never a PATH bash.
run_parse() { # run_parse <args> -> prints PR_NUMBER|REPO|MERGE_GH_FLAG|MERGE_ISSUE|MERGE_BASE|AUTO_MERGE|THOROUGH|MERGE_WORKTREE
  gen_script "$BLOCK" "$1" "$WORK/run.sh" "$TAIL"
  : > "$ERR"
  (cd "$WORK" && "${BASH:-bash}" "$WORK/run.sh" 2>"$ERR")
}
expect() { # expect <desc> <want> <args>
  got=$(run_parse "$3")
  if [ "$got" = "$2" ]; then ok; else bad "$1: got '$got' want '$2'"; fi
}
# expect_rejected <desc> <args>: injection guard. The sentinel file must NOT exist (the injected command did not
# run), the block must fail closed with an explicit message, and nothing (esp. --auto-merge) may be bound.
expect_rejected() {
  rm -f "$SENTINEL"
  got=$(run_parse "$2")
  if [ -e "$SENTINEL" ]; then bad "$1: injected command ran (sentinel created)"; rm -f "$SENTINEL"; return; fi
  if [ "$got" != "|||||false|false|" ]; then bad "$1: rejected string bound values: '$got'"; return; fi
  if grep -q 'rejected argument string' "$ERR"; then ok; else bad "$1: no explicit rejection message"; fi
}
expect "bare number" "3401|||||false|false|" "3401"
expect "full flags unquoted" "3401|o/r|-R o/r|3398|staging|true|false|/w/t" '3401 --auto-merge --issue 3398 --base staging --gh-flag -R o/r --worktree /w/t'
expect "single-quoted gh-flag" "3401|o/r|-R o/r|||false|false|" "3401 --gh-flag '-R o/r'"
expect "PR URL" "3401|||||false|false|" "https://github.com/o/r/pull/3401"
expect "thorough" "12|o/r|-R o/r|||false|true|" "12 --thorough --gh-flag -R o/r"
expect "keyword staging" "|||||false|false|" "staging"
expect "keyword open" "|||||false|false|" "open"
expect "empty args" "|||||false|false|" ""
expect "thorough is not a PR ref" "|||||false|true|" "--thorough"
expect "flag-as-value swallow" "3401|||||true|false|" "3401 --auto-merge --issue --auto-merge"
expect "non-numeric issue" "3401|||||false|false|" "3401 --issue 12x"
expect "gh-flag swallows flag" "3401|||||true|false|" "3401 --gh-flag -R --auto-merge"
expect "bad repo shape" "3401|||||false|false|" "3401 --gh-flag -R a/b/c"
expect "base followed by flag" "3401|||||false|false|/w" "3401 --base --worktree /w"
expect "leading-dash worktree" "3401|||||false|false|" "3401 --worktree -x"
expect "duplicate flags last wins" "3401|||7||false|false|" "3401 --issue 5 --issue 7"
# Shape checks for the values later substituted into --body text and worktree cleanup commands
expect "valid base kept" "3401||||feat/x_1.2-y|false|false|" "3401 --base feat/x_1.2-y"
expect "base with metachar cleared" "3401|||||false|false|" "3401 --base x;y"
expect "relative worktree cleared" "3401|||||false|false|" "3401 --worktree rel/path"
expect "worktree with metachar cleared" "3401|||||false|false|" "3401 --worktree /w/t;rm"
expect "worktree with parens cleared" "3401|||||false|false|" "3401 --worktree /w/(t)"

# Injection guards under textual substitution: sentinel file must stay absent, rejection must be explicit
expect_rejected "double-quote breakout" "\"; touch $SENTINEL; \""
expect_rejected "command substitution" "\$(touch $SENTINEL)"
expect_rejected "backtick substitution" "\`touch $SENTINEL\`"
expect_rejected "breakout after valid prefix" "3401 --auto-merge --issue 3398 \"; touch $SENTINEL; \""
expect_rejected "substitution in --base value" "3401 --auto-merge --issue 3398 --base x\$(touch $SENTINEL)"
expect_rejected "backslash" '3401 --auto-merge --issue 3398 --base x\y'
expect_rejected "double-quoted gh-flag" '3401 --auto-merge --issue 3398 --base staging --gh-flag "-R o/r" --worktree /w/t'
expect_rejected "delimiter collision (placeholder)" "3401
FORGE_ARGS_EOF_NONCE
touch $SENTINEL"
expect_rejected "delimiter collision (previous static token)" "3401
FORGE_ARGS_EOF_7f3a91c4d2b84e60a5c1
touch $SENTINEL"
expect_rejected "embedded newline" "3401 --auto-merge --issue 3398
--base staging"

# Test 4: staging numeric test no longer needs the whole string to be numeric
if grep -q "grep -qE '^\[0-9\]+\$'" "$STAGING"; then bad "staging still tests the whole argument string"; else ok; fi

# Test 5: no quoted splice of the loader-substituted string remains in either spec
if grep -qF 'PR_ARG="${ARGUMENTS' "$STAGING"; then bad "staging splices ARGUMENTS into a double-quoted expansion"; else ok; fi
if grep -qF 'ARGS_RAW="$ARGUMENTS"' "$SPEC"; then bad "review-pr splices ARGUMENTS into a double-quoted assignment"; else ok; fi
if grep -qE '^[A-Za-z_]+="[^"]*\$\{?ARGUMENTS' "$SPEC" "$STAGING"; then bad "quoted \$ARGUMENTS assignment in a spec"; else ok; fi

# Test 6: staging block, extracted and run under textual substitution
# Whole fence up to PR_ARG=, comments included, so a placeholder mention above the heredoc is exercised too
STAGING_BLOCK=$(awk '/^```bash/{buf=""; in_f=1; next} in_f{buf=buf $0 "\n"} in_f && /^PR_ARG=/{if (buf ~ /STAGING_ARGS_RAW/) {printf "%s", buf; exit}} /^```$/{in_f=0}' "$STAGING")
if [ -n "$STAGING_BLOCK" ]; then ok; else bad "staging parse block not found"; fi
STAGING_TAIL='printf "%s|%s" "$PR_ARG" "$STAGING_ARGS_REJECTED"'
run_staging() { gen_script "$STAGING_BLOCK" "$1" "$WORK/stg.sh" "$STAGING_TAIL"; : > "$ERR"; (cd "$WORK" && "${BASH:-bash}" "$WORK/stg.sh" 2>"$ERR"); }
got=$(run_staging "3401 --auto-merge"); if [ "$got" = "3401|false" ]; then ok; else bad "staging first token: '$got'"; fi
got=$(run_staging "staging:feature"); if [ "$got" = "staging:feature|false" ]; then ok; else bad "staging keyword: '$got'"; fi
for inj in "\"; touch $SENTINEL; \"" "\$(touch $SENTINEL)" "\`touch $SENTINEL\`" "3401
touch $SENTINEL" "3401
FORGE_ARGS_EOF_NONCE
touch $SENTINEL"; do
  rm -f "$SENTINEL"; got=$(run_staging "$inj")
  if [ -e "$SENTINEL" ]; then bad "staging: injected command ran"; rm -f "$SENTINEL"
  elif [ "$got" = "|true" ] && grep -q 'rejected argument string' "$ERR"; then ok
  else bad "staging injection not rejected: '$got'"; fi
done

# Test 7: Phase -1 stops on an empty PR_NUMBER before any `gh pr view` (gh falls back to the current-branch PR)
GUARD=$(awk '/^  if \[ -z "\$PR_NUMBER" \]; then$/{p=1} p{print} p && /^  fi$/{exit}' "$SPEC")
if [ -n "$GUARD" ]; then ok; else bad "Phase -1 empty-PR_NUMBER guard not found"; fi
g_line=$(grep -n '^  if \[ -z "\$PR_NUMBER" \]; then$' "$SPEC" | head -1 | cut -d: -f1)
v_line=$(grep -n '^  PR_ROUTE_INFO=\$(gh pr view' "$SPEC" | head -1 | cut -d: -f1)
if [ -n "$g_line" ] && [ -n "$v_line" ] && [ "$g_line" -lt "$v_line" ]; then ok; else bad "guard does not precede the Phase -1 gh pr view"; fi
run_route() { gen_script "$BLOCK"$'\n'"$GUARD" "$1" "$WORK/route.sh" 'echo REACHED'; : > "$ERR"; (cd "$WORK" && "${BASH:-bash}" "$WORK/route.sh" 2>"$ERR"); }
for a in "\"; touch $SENTINEL; \"" "--thorough" ""; do
  rm -f "$SENTINEL"; got=$(run_route "$a"); rc=$?
  if [ -e "$SENTINEL" ]; then bad "route: injected command ran"; rm -f "$SENTINEL"
  elif [ "$rc" -ne 0 ] && [ -z "$got" ] && grep -q 'no PR number resolved' "$ERR"; then ok
  else bad "route did not stop for '$a': rc=$rc out='$got'"; fi
done
got=$(run_route "3401 --auto-merge --issue 3398"); if [ "$got" = REACHED ]; then ok; else bad "route stopped a valid PR number: '$got'"; fi

# Test 8: the whole staging fence stops (non-zero, no REVIEW_ROUTE post) on a rejected string
STAGING_FENCE=$(awk '/^```bash/{buf=""; in_f=1; next} /^```$/{if (in_f && buf ~ /STAGING_ARGS_RAW/) {printf "%s", buf; exit}; in_f=0; next} in_f{buf=buf $0 "\n"}' "$STAGING")
if [ -n "$STAGING_FENCE" ]; then ok; else bad "staging fence not found"; fi
run_stg_fence() { gen_script "$STAGING_FENCE" "$1" "$WORK/stgf.sh" 'echo REACHED'; : > "$ERR"; (cd "$WORK" && "${BASH:-bash}" "$WORK/stgf.sh" 2>"$ERR"); }
got=$(run_stg_fence "\$(touch $SENTINEL)"); rc=$?
if [ ! -e "$SENTINEL" ] && [ "$rc" -ne 0 ] && [ -z "$got" ] && grep -q 'stopping' "$ERR"; then ok; else bad "staging fence did not stop on rejection: rc=$rc out='$got'"; rm -f "$SENTINEL"; fi
got=$(run_stg_fence "3401"); if printf '%s' "$got" | grep -q REACHED; then ok; else bad "staging fence stopped a valid PR number: '$got'"; fi
got=$(run_staging "3401	--auto-merge"); if [ "$got" = "|true" ]; then ok; else bad "staging tab not rejected: '$got'"; fi
expect_rejected "tab separator" "3401	--auto-merge	--issue	3398"

echo "review-pr-arguments: $pass passed, $fail failed"
[ "$fail" = 0 ]
