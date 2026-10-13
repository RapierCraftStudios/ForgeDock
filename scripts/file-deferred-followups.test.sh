#!/usr/bin/env bash
# file-deferred-followups.test.sh — stubbed-gh tests for scripts/file-deferred-followups.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/file-deferred-followups.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
export FORGE_DEFERRED_RETRY_SLEEP=0
export GH_LOG="$T/gh.log" SEARCH_JSON="$T/search.json" ISSUE_BODY="$T/issue.body" COMMENTS_JSON="$T/comments.json" T_DIR="$T"

cat > "$T/bin/gh" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "api -X") [ -n "${LOOKUP_FAIL:-}" ] && exit 1; cat "$SEARCH_JSON"; exit 0 ;;
  "api --paginate") [ -n "${CLAIM_FAIL:-}" ] && exit 1; cat "$COMMENTS_JSON"; exit 0 ;;
  "issue create") [ -n "${CREATE_FAIL:-}" ] && exit 1; echo "https://github.com/o/r/issues/901"; exit 0 ;;
  "issue comment") [ -n "${COMMENT_FAIL:-}" ] && exit 1; exit 0 ;;
  "issue reopen") [ -n "${REOPEN_FAIL:-}" ] && exit 1; exit 0 ;;
  "issue close") [ -n "${CLOSE_FAIL:-}" ] && exit 1; exit 0 ;;
  "issue edit")
    [ -n "${EDIT_FAIL:-}" ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$ISSUE_BODY.edited"; shift; done; exit 0 ;;
esac
if [ "$1" = api ]; then
  case "$*" in *--jq*) cat "$ISSUE_BODY"; exit 0 ;; esac
  n="${2##*/}"; [ -f "$T_DIR/issue.$n.json" ] && { cat "$T_DIR/issue.$n.json"; exit 0; }
  echo "HTTP 404: Not Found" >&2; exit 1
fi
exit 1
MOCK
chmod +x "$T/bin/gh"; export PATH="$T/bin:$PATH"

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
reset() { : > "$GH_LOG"; rm -f "$ISSUE_BODY.edited" "$T"/issue.*.json; unset LOOKUP_FAIL CREATE_FAIL EDIT_FAIL CLAIM_FAIL COMMENT_FAIL REOPEN_FAIL CLOSE_FAIL DRY_RUN
  echo '{"items":[]}' > "$SEARCH_JSON"; echo '[]' > "$COMMENTS_JSON"; }
# issue_json NUMBER STATE ASSOCIATION [PARENT]: REST view of a follow-up carrying the DEFERRED_FROM marker
issue_json() { printf '{"number":%s,"state":"%s","author_association":"%s","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #%s -->"}\n' "$1" "$2" "$3" "${4:-10}" > "$T/issue.$1.json"; }
# claim_json ASSOCIATION NUMBER...: parent comments carrying claim markers
claim_json() { local a="$1" out="" n; shift; for n in "$@"; do out="${out:+$out,}{\"author_association\":\"$a\",\"user\":{\"type\":\"User\"},\"body\":\"<!-- FORGE:DEFERRED_ISSUE: #$n -->\"}"; done; echo "[$out]" > "$COMMENTS_JSON"; }
printf 'a/x.sh\twhy a\t\nb/y.sh\twhy b\tknown-flaw\nc/z.sh\twhy c\t\n' > "$T/items.tsv"

# 1. N items -> exactly one create
reset
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" --folded 2); RC=$?
check "create: rc 0" "[ $RC -eq 0 ]"
check "create: one issue create for 3 items" "[ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ]"
check "create: rows share issue" "[ \$(printf '%s\n' \"\$OUT\" | grep -c '901\$') -ge 3 ]"
check "create: telemetry" "printf '%s' \"\$OUT\" | grep -q 'DEFERRED_TELEMETRY deferred_items=3 folded=2 batched_into=#901 filed=1'"

# 2. append to existing trusted open issue; exact path match
reset
printf '## Affected Files\n- `a/x.sh`\n\n- [ ] `a/x.sh.bak` — other\n<!-- FORGE:DEFERRED_FROM: #10 -->\n' > "$ISSUE_BODY"
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"; issue_json 77 open OWNER
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "append: rc 0, no create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG'"
check "append: telemetry batched into 77 filed=0" "printf '%s' \"\$OUT\" | grep -q 'batched_into=#77 filed=0'"
check "append: all three added (substring .bak does not dedup a/x.sh)" "[ \$(grep -c '^- \[ \] \`' '$ISSUE_BODY.edited') -eq 4 ]"
check "append: known-flaw flagged" "grep -q 'b/y.sh. \*\*known-flaw\*\*' '$ISSUE_BODY.edited'"

# 2b. empty why + known-flaw: the flag must survive (a whitespace IFS would collapse the empty field)
reset
printf 'd/w.sh\t\tknown-flaw\n' > "$T/emptywhy.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/emptywhy.tsv" >/dev/null; RC=$?
rm -f "$ISSUE_BODY.edited"; printf 'x\n' > "$ISSUE_BODY"
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"; issue_json 77 open OWNER
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/emptywhy.tsv"); RC=$?
check "empty-why: append keeps known-flaw flag" "[ $RC -eq 0 ] && grep -q 'd/w.sh. \*\*known-flaw\*\*' '$ISSUE_BODY.edited'"

# 2c. missing option value -> usage exit 2
bash "$S" --parent >/dev/null 2>&1; RC=$?
check "missing option value: rc 2" "[ $RC -eq 2 ]"

# 3. already-listed path is not duplicated; nothing to add -> no edit
reset
printf -- '- [ ] `a/x.sh` — w\n- [x] `b/y.sh`\n- [ ] `c/z.sh`\n' > "$ISSUE_BODY"
echo '{"items":[{"number":77,"author_association":"MEMBER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"; issue_json 77 open OWNER
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null; RC=$?
check "idempotent: no edit, no create on resume" "[ $RC -eq 0 ] && ! grep -qE '^issue (edit|create)' '$GH_LOG'"

# 4. untrusted match ignored -> new issue
reset
echo '{"items":[{"number":66,"author_association":"NONE","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"; issue_json 66 open NONE; issue_json 77 open OWNER
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv")
check "untrusted: ignored, create filed" "grep -q '^issue create' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'filed=1'"

# 5. lookup failure -> FAILED, nothing filed
reset; export LOOKUP_FAIL=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "lookup failure: rc 3, DEFERRED_LOOKUP=FAILED, no create" "[ $RC -eq 3 ] && printf '%s' \"\$OUT\" | grep -q DEFERRED_LOOKUP=FAILED && ! grep -q '^issue create' '$GH_LOG'"

# 6. create / edit failure not counted as success
reset; export CREATE_FAIL=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "create failure: rc 4, no telemetry" "[ $RC -eq 4 ] && ! printf '%s' \"\$OUT\" | grep -q DEFERRED_TELEMETRY"
reset; export EDIT_FAIL=1
printf 'x\n' > "$ISSUE_BODY"
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"; issue_json 77 open OWNER
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "edit failure: rc 4, no telemetry" "[ $RC -eq 4 ] && ! printf '%s' \"\$OUT\" | grep -q DEFERRED_TELEMETRY"

# 7. DRY_RUN
reset; export DRY_RUN=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" 2>/dev/null)
check "dry-run: no create" "! grep -q '^issue create' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'filed=1'"

# 8. empty items, usage errors
reset
OUT=$(printf '' | bash "$S" --parent 10 --repo o/r)
check "empty: no create, deferred_items=0" "! grep -q '^issue create' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'deferred_items=0'"
bash "$S" --repo o/r >/dev/null 2>&1; check "usage: missing parent rc 2" "[ $? -eq 2 ]"

# 9. e1: search index lags (returns nothing) but the claim marker on the parent finds the follow-up
reset
printf 'x\n' > "$ISSUE_BODY"; issue_json 77 open OWNER; claim_json OWNER 77
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "index-lag: claim found, no duplicate create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'batched_into=#77 filed=0'"
check "index-lag: search never needed" "! grep -q search/issues '$GH_LOG'"

# 10. e2: closed follow-up (found only by a state-all search) is reused and reopened
reset
printf 'x\n' > "$ISSUE_BODY"; issue_json 77 closed OWNER
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "closed: reused, reopened, no create" "[ $RC -eq 0 ] && grep -q '^issue reopen 77' '$GH_LOG' && ! grep -q '^issue create' '$GH_LOG'"
check "closed: search query covers all states" "grep -q 'is:issue' '$GH_LOG' && ! grep 'api -X' '$GH_LOG' | grep -q 'is:open'"
reset; export REOPEN_FAIL=1
printf 'x\n' > "$ISSUE_BODY"; issue_json 77 closed OWNER; claim_json OWNER 77
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null; RC=$?
check "closed: reopen failure is rc 4" "[ $RC -eq 4 ]"

# 11. create posts the claim marker on the parent
reset
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "claim: posted on parent after create" "[ $RC -eq 0 ] && grep -q '^issue comment 10 .*FORGE:DEFERRED_ISSUE: #901' '$GH_LOG'"
reset; export COMMENT_FAIL=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" 2>/dev/null); RC=$?
check "claim: post failure only warns" "[ $RC -eq 0 ] && printf '%s' \"\$OUT\" | grep -q 'batched_into=#901 filed=1'"

# 12. e3: a concurrent build filed #800 first; the first claim read (before our create) misses it, the post-create re-check sees it
race_setup() { # first comments read returns [] (the other build has not claimed yet), later reads return the real listing
  CALLS="$T/claim.calls"; : > "$CALLS"; export CALLS
  mv "$T/bin/gh" "$T/bin/gh.real"
  cat > "$T/bin/gh" <<'WRAP'
#!/usr/bin/env bash
if [ "$1 $2" = "api --paginate" ]; then
  echo x >> "$CALLS"
  if [ "$(wc -l < "$CALLS" | tr -d ' ')" -le 1 ]; then echo "$*" >> "$GH_LOG"; echo '[]'; exit 0; fi
fi
exec "$(dirname "$0")/gh.real" "$@"
WRAP
  chmod +x "$T/bin/gh"
}
race_teardown() { mv "$T/bin/gh.real" "$T/bin/gh"; }
reset
printf 'x\n' > "$ISSUE_BODY"; issue_json 800 open OWNER; claim_json OWNER 800
race_setup
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
race_teardown
check "race: newer duplicate closed, items moved to lowest" "[ $RC -eq 0 ] && grep -q '^issue close 901' '$GH_LOG' && grep -q '^issue edit 800' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'batched_into=#800 filed=1'"
check "race: rows point at canonical issue" "[ \$(printf '%s\n' \"\$OUT\" | grep -c '800\$') -ge 3 ]"
# e5: duplicate-close failure only warns
reset; export CLOSE_FAIL=1
printf 'x\n' > "$ISSUE_BODY"; issue_json 800 open OWNER; claim_json OWNER 800
race_setup
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" 2>/dev/null); RC=$?
race_teardown
check "race: duplicate-close failure still rc 0" "[ $RC -eq 0 ] && printf '%s' \"\$OUT\" | grep -q 'batched_into=#800'"

# 13. e4: claim listing failure is a failed lookup, never "none found"
reset; export CLAIM_FAIL=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "claim-failure: rc 3, no create" "[ $RC -eq 3 ] && printf '%s' \"\$OUT\" | grep -q DEFERRED_LOOKUP=FAILED && ! grep -q '^issue create' '$GH_LOG'"

# 15. e6: untrusted claim comment is ignored (falls through to create)
reset
issue_json 77 open OWNER; claim_json NONE 77
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" 2>/dev/null); RC=$?
check "untrusted-claim: ignored, create filed" "[ $RC -eq 0 ] && grep -q '^issue create' '$GH_LOG'"

# 16. e7: several claims, lowest valid wins; a claim to a missing issue falls through
reset
printf 'x\n' > "$ISSUE_BODY"; issue_json 80 open OWNER; issue_json 90 open OWNER; claim_json OWNER 70 90 80
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "multi-claim: lowest valid (80) wins, missing 70 skipped" "[ $RC -eq 0 ] && printf '%s' \"\$OUT\" | grep -q 'batched_into=#80 filed=0'"

# 17. DRY_RUN: no claim, reopen or close
reset; export DRY_RUN=1
printf 'x\n' > "$ISSUE_BODY"; issue_json 77 closed OWNER; claim_json OWNER 77
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null 2>&1
check "dry-run: no comment/reopen/close/edit" "! grep -qE '^issue (comment|reopen|close|edit|create)' '$GH_LOG'"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
