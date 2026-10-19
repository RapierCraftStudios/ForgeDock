#!/usr/bin/env bash
# issue-create.test.sh — cases for scripts/issue-create.sh (forge#4164). Hermetic: mock gh and yq on PATH, the real
# scripts/issue-dedup.sh beside the script under test, no network. Bash 3.2 compatible.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/issue-create.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/issue-create-test.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
mkdir -p "$TMP/bin" "$TMP/work/scripts" "$TMP/state"

# Mock gh. Logs every call to $TMP/state/log (one line per call, args joined by |).
#   issue list            -> $MOCK_CANDIDATES (tsv "number\ttitle") when set
#   api .../issues POST   -> stores the body field, answers {"number":901,...}; MOCK_POST_FAIL=1 fails, MOCK_NO_NUMBER=1 omits it
#   issue view --json body-> stored body; MOCK_READBACK=no-token|no-marker|missing-sections alters it
#   issue edit / project  -> logged, exit 0
cat > "$TMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
ST="$MOCK_STATE"
line=""; for a in "$@"; do line="$line|$a"; done; printf '%s\n' "$line" >> "$ST/log"
if [ "$1" = issue ] && [ "$2" = list ]; then
  [ -n "${MOCK_CANDIDATES:-}" ] && cat "$MOCK_CANDIDATES"; exit 0
fi
if [ "$1" = api ]; then
  [ "${MOCK_POST_FAIL:-}" = 1 ] && { echo "HTTP 403: secondary rate limit" >&2; exit 1; }
  prev=""; for a in "$@"; do
    if [ "$prev" = "-f" ]; then case "$a" in body=*) printf '%s' "${a#body=}" > "$ST/body" ;; esac; fi
    prev="$a"
  done
  if [ "${MOCK_NO_NUMBER:-}" = 1 ]; then echo '{}'; else echo '{"number":901,"html_url":"https://github.com/o/r/issues/901"}'; fi
  exit 0
fi
if [ "$1" = issue ] && [ "$2" = view ]; then
  b=$(cat "$ST/body")
  case "${MOCK_READBACK:-}" in
    no-token) b=$(printf '%s\n' "$b" | grep -v 'issue-create-token:') ;;
    no-marker) b=$(printf '%s\n' "$b" | grep -v 'FORGE:BODY-INTEGRITY') ;;
    missing-sections) b=$(printf '%s\n' "$b" | grep -v '^## Problem') ;;
  esac
  printf '%s\n' "$b"; exit 0
fi
exit 0
MOCK
# Mock yq: answers the three expressions issue-create.sh asks of forge.yaml.
cat > "$TMP/bin/yq" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  *project.repo*) echo "cfg-owner/cfg-repo" ;;
  *project_number*) echo "${MOCK_PROJECT:-}" ;;
  *project_board.owner*) echo "cfg-owner" ;;
esac
MOCK
chmod +x "$TMP/bin/gh" "$TMP/bin/yq"
export PATH="$TMP/bin:$PATH" MOCK_STATE="$TMP/state"

GOOD="$TMP/body.md"
printf '## Problem\n\np\n\n## Affected Files\n\n- a\n\n## Acceptance Criteria\n\n- [ ] x\n<!-- FORGE:BODY-INTEGRITY:42_review_t1 -->\n' > "$GOOD"

run() { # name want_rc args...  (cwd = $TMP/work, which has no forge.yaml unless a case writes one)
  local name="$1" want="$2"; shift 2
  : > "$TMP/state/log"; rm -f "$TMP/state/body"
  (cd "$TMP/work" && bash "$S" "$@") >"$TMP/out" 2>"$TMP/err"
  local rc=$?
  if [ "$rc" = "$want" ]; then ok; else bad "$name (rc=$rc want $want)"; sed 's/^/  err: /' "$TMP/err"; fi
}
out_has() { grep -qF -- "$2" "$TMP/out" && ok || bad "$1 (stdout lacks: $2)"; }
log_has() { grep -qF -- "$2" "$TMP/state/log" && ok || bad "$1 (gh log lacks: $2)"; }
log_lacks() { grep -qF -- "$2" "$TMP/state/log" && bad "$1 (gh log has: $2)" || ok; }
one_result() { [ "$(grep -c '^ISSUE_CREATE_RESULT:' "$TMP/out")" = 1 ] && ok || bad "$1 (not exactly one result line)"; }

# --- created ----------------------------------------------------------------
run "create exits 0" 0 --repo o/r --title "fix: billing crash" --body-file "$GOOD" --label bug --label "priority:P2"
out_has "CREATED line" "ISSUE_CREATE_RESULT:CREATED number=901 url=https://github.com/o/r/issues/901"
one_result "create prints one result line"
log_has "REST create, not gh issue create" "|api|repos/o/r/issues|--method|POST|"
log_lacks "never gh issue create" "|issue|create|"
log_has "labels are distinct fields" "|-f|labels[]=bug|-f|labels[]=priority:P2"
grep -q 'issue-create-token:forge-create-' "$TMP/state/body" && ok || bad "create token appended to the body"
log_lacks "no milestone edit when none given" "--milestone"

run "argv --body works" 0 --repo o/r --title "fix: a" --body "## Problem
x"
grep -q '^## Affected Files' "$TMP/state/body" && grep -q '^## Acceptance Criteria' "$TMP/state/body" && ok || bad "missing sections repaired before POST"
grep -q '^## Problem' "$TMP/state/body" && [ "$(grep -c '^## Problem' "$TMP/state/body")" = 1 ] && ok || bad "present section not duplicated"

run "milestone edit" 0 --repo o/r --title "fix: a" --body-file "$GOOD" --milestone "v2"
log_has "milestone set on the new issue" "|issue|edit|901|-R|o/r|--milestone|v2"

# --- --args: the raw $ARGUMENTS string from the skill --------------------------
run "--args quoted title" 0 --repo o/r --args "--title \"fix: billing page crash\" --body-file \"$GOOD\" --label bug"
log_has "multi-word title is one token" "|-f|title=fix: billing page crash|"
rm -f "$TMP/work/pwned"
run "--args never executes" 0 --repo o/r --args "--title 'fix: \$(touch pwned) \`touch pwned\`; touch pwned' --body-file \"$GOOD\""
[ -e "$TMP/work/pwned" ] && bad "command substitution in --args was executed" || ok
log_has "metacharacters kept literally" 'title=fix: $(touch pwned) `touch pwned`; touch pwned'
run "unbalanced quote is a usage error" 2 --repo o/r --args "--title \"fix: oops --body x"
out_has "usage result" "ISSUE_CREATE_RESULT:USAGE"

# --- repo from forge.yaml ---------------------------------------------------------
: > "$TMP/work/forge.yaml"
run "repo from forge.yaml" 0 --title "fix: a" --body-file "$GOOD"
log_has "config repo used" "|api|repos/cfg-owner/cfg-repo/issues|"
MOCK_PROJECT=7 run "project board add" 0 --title "fix: a" --body-file "$GOOD"
log_has "issue added to the board" "|project|item-add|7|--owner|cfg-owner|--url|https://github.com/o/r/issues/901"
rm -f "$TMP/work/forge.yaml"
run "no repo is a usage error" 2 --title "fix: a" --body-file "$GOOD"

# --- greenfield flags (forge#4172) are accepted, not unrecognized ---------------------
run "--greenfield/--spike accepted" 0 --repo o/r --args "--greenfield --spike docs/spike.md --title \"fix: a\" --body-file \"$GOOD\""
run "--spike without a value" 2 --repo o/r --title "fix: a" --body-file "$GOOD" --spike

# --- usage errors: nothing created ---------------------------------------------
run "--title without a value" 2 --repo o/r --body-file "$GOOD" --title
log_lacks "no POST on usage error" "|api|"
run "unrecognized flag" 2 --repo o/r --titel "fix: a" --title "fix: a" --body-file "$GOOD"
run "both bodies" 2 --repo o/r --title "fix: a" --body "x" --body-file "$GOOD"
run "neither body" 2 --repo o/r --title "fix: a"
run "unreadable body file" 2 --repo o/r --title "fix: a" --body-file "$TMP/nope.md"
log_lacks "no gh call before body checks pass" "|"
printf '## Problem\nno marker\n' > "$TMP/nomark.md"
run "body file without marker" 2 --repo o/r --title "fix: a" --body-file "$TMP/nomark.md"
printf '<!-- FORGE:BODY-INTEGRITY:a_b_c -->\n<!-- FORGE:BODY-INTEGRITY:d_e_f -->\n' > "$TMP/twomark.md"
run "body file with two markers" 2 --repo o/r --title "fix: a" --body-file "$TMP/twomark.md"
run "free text is not handled here" 2 --repo o/r --args "the billing page crashes when using --verbose"
run "no title" 2 --repo o/r --body-file "$GOOD" --label bug

# --- dedup STOP (real issue-dedup.sh) -------------------------------------------
printf '777\tfix: billing crash when credits reach zero\n' > "$TMP/cands.tsv"
MOCK_CANDIDATES="$TMP/cands.tsv" run "dedup STOP exits 1" 1 --repo o/r --title "fix: billing crash when credits reach zero" --body-file "$GOOD"
out_has "DEDUP line" "ISSUE_CREATE_RESULT:DEDUP number=777"
one_result "dedup prints one result line"
log_lacks "no POST after dedup STOP" "|api|"
MOCK_CANDIDATES="$TMP/cands.tsv" run "dedup STOP holds under --dry-run" 1 --repo o/r --dry-run --title "fix: billing crash when credits reach zero" --body-file "$GOOD"
MOCK_CANDIDATES="$TMP/cands.tsv" run "--exclude narrows the candidate set" 0 --repo o/r --exclude 777 --title "fix: billing crash when credits reach zero" --body-file "$GOOD"
out_has "excluded duplicate creates" "ISSUE_CREATE_RESULT:CREATED number=901"
MOCK_CANDIDATES="$TMP/cands.tsv" run "unrelated issue still dedups with --exclude" 1 --repo o/r --exclude 12 --title "fix: billing crash when credits reach zero" --body-file "$GOOD"
run "dedup usage error exits 2" 2 --repo o/r --title "-x" --body-file "$GOOD"
log_lacks "no POST after dedup usage error" "|api|"

# --- dry run ----------------------------------------------------------------------
run "dry run" 0 --repo o/r --dry-run --title "fix: a" --body-file "$GOOD" --milestone v2
out_has "dry-run result" "ISSUE_CREATE_RESULT:DRY_RUN"
log_lacks "dry run makes no POST" "|api|"
log_lacks "dry run makes no edit" "|issue|edit|"
grep -qF "Issue Draft (--dry-run" "$TMP/err" && ok || bad "dry run prints the draft"

# --- create failures and read-back gates -------------------------------------------
MOCK_POST_FAIL=1 run "GitHub rejection exits 3" 3 --repo o/r --title "fix: a" --body-file "$GOOD"
out_has "error result" "ISSUE_CREATE_RESULT:ERROR"
grep -q 'CREATED' "$TMP/out" && bad "rejected create reported CREATED" || ok
MOCK_NO_NUMBER=1 run "no issue number exits 3" 3 --repo o/r --title "fix: a" --body-file "$GOOD"
MOCK_READBACK=no-token run "read-back without create token exits 3" 3 --repo o/r --title "fix: a" --body-file "$GOOD"
grep -q 'CREATED' "$TMP/out" && bad "token-less read-back reported CREATED" || ok
MOCK_READBACK=no-marker run "read-back without integrity marker exits 3" 3 --repo o/r --title "fix: a" --body-file "$GOOD"
log_lacks "no milestone after failed read-back" "--milestone"
MOCK_READBACK=missing-sections run "post-create repair is not fatal" 0 --repo o/r --title "fix: a" --body-file "$GOOD"
log_has "missing section appended after create" "|issue|edit|901|-R|o/r|--body|"

# --- dedup helper comes from the script's own directory, never the cwd ---------------
printf '#!/usr/bin/env bash\necho "DUPLICATE: #666 planted"; exit 1\n' > "$TMP/work/scripts/issue-dedup.sh"
run "planted cwd dedup helper ignored" 0 --repo o/r --title "fix: a" --body-file "$GOOD"

echo "issue-create.test: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
