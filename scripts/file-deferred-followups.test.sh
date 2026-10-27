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
  "issue create") [ -n "${CREATE_FAIL:-}" ] && exit 1; N=$(( $(cat "$T_DIR/create.n" 2>/dev/null || echo 900) + 1 )); echo "$N" > "$T_DIR/create.n"; while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$T_DIR/created.$N.body"; shift; done; echo "https://github.com/o/r/issues/$N"; exit 0 ;;
  "label create") exit 0 ;;
  "issue comment") [ -n "${COMMENT_FAIL:-}" ] && exit 1; exit 0 ;;
  "issue reopen") [ -n "${REOPEN_FAIL:-}" ] && exit 1; exit 0 ;;
  "issue close") [ -n "${CLOSE_FAIL:-}" ] && exit 1; exit 0 ;;
  "issue edit")
    [ -n "${EDIT_FAIL:-}" ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$ISSUE_BODY.edited"; shift; done; exit 0 ;;
esac
if [ "$1" = api ]; then
  case "$*" in "api repos/o/r/milestones"*) cat "$T_DIR/milestones.json"; exit 0 ;; esac
  case "$*" in "api repos/o/r/issues/10 --jq"*) cat "$T_DIR/parent.milestone"; exit 0 ;; esac
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
reset() { : > "$GH_LOG"; rm -f "$ISSUE_BODY.edited" "$T"/issue.*.json "$T/create.n"; unset LOOKUP_FAIL CREATE_FAIL EDIT_FAIL CLAIM_FAIL COMMENT_FAIL REOPEN_FAIL CLOSE_FAIL DRY_RUN FORGE_FOLLOWUP_MILESTONE FORGE_FOLLOWUPS_DEFAULT_MILESTONE FORGE_EXTERNAL_PREREQ
  echo '[]' > "$T/milestones.json"; : > "$T/parent.milestone"
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

# 18. #4626: a post-deploy why's [check:<id>] token is kept verbatim in the checklist line
reset
printf 'x\n' > "$ISSUE_BODY"
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
printf '{"number":77,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:POSTDEPLOY_ROLLUP: default -->\\n<!-- FORGE:DEFERRED_FROM: #10 -->\\n### #10\\n<!-- FORGE:DEFERRED_CLASS: post-deploy -->"}\n' > "$T/issue.77.json"
printf -- '-\tpost-deploy: [check:login-smoke] after a day\t\t\tR3: soak\n' > "$T/check.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/check.tsv" >/dev/null 2>&1
check "check token kept in the checklist line" "grep -q 'post-deploy: \[check:login-smoke\] after a day' '$ISSUE_BODY.edited'"

# 19. #4664: milestone inheritance
MS='[{"title":"M1","state":"open","due_on":"2026-01-01T00:00:00Z"},{"title":"M0","state":"closed","due_on":"2025-06-01T00:00:00Z"},{"title":"M2","state":"open","due_on":"2026-06-01T00:00:00Z"},{"title":"Dflt","state":"open","due_on":null}]'
reset; echo "$MS" > "$T/milestones.json"; export FORGE_FOLLOWUP_MILESTONE=M1
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null 2>&1
check "milestone: open parent milestone inherited" "grep '^issue create' '$GH_LOG' | grep -q -- '--milestone M1'"
reset; echo "$MS" > "$T/milestones.json"; echo M1 > "$T/parent.milestone"
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null 2>&1
check "milestone: read from the parent when not passed" "grep '^issue create' '$GH_LOG' | grep -q -- '--milestone M1'"
reset; echo "$MS" > "$T/milestones.json"; export FORGE_FOLLOWUP_MILESTONE=M0
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null 2>&1
check "milestone: shipped (closed) one -> next open by due date" "grep '^issue create' '$GH_LOG' | grep -q -- '--milestone M1'"
reset; echo '[{"title":"M0","state":"closed","due_on":"2025-06-01T00:00:00Z"},{"title":"Dflt","state":"open","due_on":null}]' > "$T/milestones.json"
export FORGE_FOLLOWUP_MILESTONE=M0 FORGE_FOLLOWUPS_DEFAULT_MILESTONE=Dflt
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null 2>&1
check "milestone: shipped, no next -> followups.default_milestone" "grep '^issue create' '$GH_LOG' | grep -q -- '--milestone Dflt'"
reset; echo '[]' > "$T/milestones.json"
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null 2>&1
check "milestone: parent without one -> none passed" "grep -q '^issue create' '$GH_LOG' && ! grep '^issue create' '$GH_LOG' | grep -q -- '--milestone'"

# 20. #4664: one issue per class, class labels
printf 'a/x.sh\twhy a\t\nb/y.sh\tpost-deploy: [check:smoke] later\t\t\nc/z.sh\texternal: needs a real credential\t\t\nd/w.sh\tops drill\t\tops\n-\tdefer: plain\t\t\tR9: plain item\n' > "$T/classes.tsv"
reset
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/classes.tsv"); RC=$?
check "classes: rc 0, one create per class (4)" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 4 ]"
for c in engineering post-deploy external ops; do check "classes: label followup:$c applied" "grep '^issue create' '$GH_LOG' | grep -q -- '--label followup:$c'"; done
check "classes: external also labelled external-prerequisite" "grep '^issue create' '$GH_LOG' | grep -- 'followup:external' | grep -q -- '--label external-prerequisite'"
check "classes: engineering has the old title, others carry the class" "grep '^issue create' '$GH_LOG' | grep -q 'follow-up (ops): 1 deferred' && grep '^issue create' '$GH_LOG' | grep -q 'follow-up: 2 deferred'"
check "classes: telemetry lists every issue and class" "printf '%s' \"\$OUT\" | grep -q 'batched_into=#901,#902,#903,#904 filed=4 classes=engineering,external,ops,post-deploy'"
check "classes: rows point at their class issue (a/x.sh and the R9 item share one)" "printf '%s\n' \"\$OUT\" | grep -q '^c/z.sh	90[0-9]\$' && [ \$(printf '%s\n' \"\$OUT\" | grep -E '^(a/x.sh|R9: plain item)	' | cut -f2 | sort -u | wc -l) -eq 1 ]"
check "classes: claim markers carry the class" "grep '^issue comment 10' '$GH_LOG' | grep -q 'class=external'"
# an existing engineering follow-up is not reused for another class
reset
printf 'x\n' > "$ISSUE_BODY"; issue_json 77 open OWNER; claim_json OWNER 77
printf 'c/z.sh\texternal: needs a credential\t\n' > "$T/ext.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/ext.tsv"); RC=$?
check "classes: engineering follow-up #77 not reused for an external item" "[ $RC -eq 0 ] && grep -q '^issue create' '$GH_LOG' && ! grep -q '^issue edit 77' '$GH_LOG'"
# a labelled-class follow-up is reused for its class
reset
printf 'x\n' > "$ISSUE_BODY"
printf '{"number":78,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->\\n<!-- FORGE:DEFERRED_CLASS: external -->"}\n' > "$T/issue.78.json"; claim_json OWNER 78
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/ext.tsv"); RC=$?
check "classes: external follow-up #78 reused for external items" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && grep -q '^issue edit 78' '$GH_LOG'"

# 21. #4664: requirement-text rows are rejected, nothing filed
for row in 'R1: a saved mapping per entity\twhy\t' 'R1: R2: a saved mapping\twhy\t' 'add a saved mapping\twhy\t' 'a/x.sh\twhy\t\tbogus'; do
  reset; printf "$row\n" > "$T/bad.tsv"
  OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/bad.tsv" 2>/dev/null); RC=$?
  check "rejected row ($(printf "$row" | cut -c1-24)): rc 2, DEFERRED_TSV=INVALID, no gh call" "[ $RC -eq 2 ] && printf '%s' \"\$OUT\" | grep -q DEFERRED_TSV=INVALID && [ ! -s '$GH_LOG' ]"
done
reset; printf 'a/x.sh\twhy\t\nR2: nope\twhy\t\n' > "$T/bad.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/bad.tsv" >/dev/null 2>&1
check "one malformed row among valid ones files nothing" "[ $? -eq 2 ] && ! grep -q '^issue create' '$GH_LOG'"
# `-` + label is a valid requirement-level row; a doubled R-prefix in the label collapses; Affected Files lists only paths
reset; printf '%s\n' "$(printf -- '-\twhy\t\t\tR1: R2: a saved mapping')" "$(printf 'src/q.ts\twhy q\t')" > "$T/ok.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/ok.tsv"); RC=$?
check "label row accepted, prefix collapsed in stdout" "[ $RC -eq 0 ] && printf '%s\n' \"\$OUT\" | grep -q '^R1: a saved mapping	901'"

check "created body: Affected Files lists only paths, checklist keeps the collapsed label" "grep -q '^- \`src/q.ts\`\$' '$T/created.901.body' && ! grep -q '^- \`R1' '$T/created.901.body' && grep -q '^- \[ \] \`R1: a saved mapping\`' '$T/created.901.body' && ! grep -q 'R1: R2:' '$T/created.901.body'"
check "created body: DEFERRED_FROM and DEFERRED_CLASS markers" "grep -q 'FORGE:DEFERRED_FROM: #10 -->' '$T/created.901.body' && grep -q 'FORGE:DEFERRED_CLASS: engineering' '$T/created.901.body'"
# #4739: legal path characters (parentheses, space, =, #, :) are accepted; one such row no longer aborts the batch
reset; printf 'app/(marketing)/page.tsx\twhy\t\ndocs/My Notes.md\twhy\t\nsrc/a=b.ts\twhy\t\nsrc/#x.ts\twhy\t\nsrc/foo:bar.ts\twhy\t\n' > "$T/legal.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/legal.tsv" 2>/dev/null); RC=$?
check "legal paths with ( ) space = # : are accepted and filed" "[ $RC -eq 0 ] && ! printf '%s' \"\$OUT\" | grep -q DEFERRED_TSV=INVALID && grep -q '^issue create' '$GH_LOG' && grep -qF -- '- \`app/(marketing)/page.tsx\`' '$T/created.901.body' && grep -qF -- '- \`docs/My Notes.md\`' '$T/created.901.body' && grep -qF -- '- \`src/a=b.ts\`' '$T/created.901.body' && grep -qF -- '- \`src/#x.ts\`' '$T/created.901.body' && grep -qF -- '- \`src/foo:bar.ts\`' '$T/created.901.body'"
reset; printf -- '-\tpost-deploy: [check:login-smoke] soon\t\t\tR3: soak\n' > "$T/pd.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/pd.tsv" >/dev/null 2>&1
check "post-deploy rollup: created with the lane marker, [check:] kept, section for the parent" "grep -q 'FORGE:POSTDEPLOY_ROLLUP: default' '$T/created.901.body' && grep -q 'post-deploy: \[check:login-smoke\] soon' '$T/created.901.body' && grep -q '^### #10\$' '$T/created.901.body'"

# 23. #4724: N lanes -> ONE rollup; sections per parent; duplicates stored once; owner items never join it
reset
printf -- '-\tpost-deploy: [bucket:post-deploy] [check:a-smoke] first\t\t\tR1: the login page renders\n-\towner: [bucket:owner] rotate the key. why\t\t\tR2: rotate the credential\n' > "$T/l1.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/l1.tsv"); RC=$?
check "rollup: lane 1 creates one external follow-up (#901) and one rollup (#902)" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 2 ] && grep -q 'FORGE:POSTDEPLOY_ROLLUP: default' '$T/created.902.body' && grep -q 'FORGE:DEFERRED_CLASS: external' '$T/created.901.body'"
check "rollup: the owner item is not in the rollup" "! grep -q 'rotate the credential' '$T/created.902.body' && grep -q 'rotate the credential' '$T/created.901.body'"
check "rollup: telemetry has per-bucket counts" "printf '%s' \"\$OUT\" | grep -q 'buckets=owner:1,post-deploy:1'"
cp "$T/created.902.body" "$ISSUE_BODY"; : > "$GH_LOG"
echo '{"items":[{"number":902}]}' > "$SEARCH_JSON"
printf '{"number":902,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:POSTDEPLOY_ROLLUP: default -->"}\n' > "$T/issue.902.json"
printf -- '-\tpost-deploy: [bucket:post-deploy] [check:a-smoke] again\t\t\tR7: The Login page renders!\n-\tpost-deploy: [bucket:date] due:2026-12-01 from:2026-10-27 later\t\t\tR8: soak for a week\n' > "$T/l2.tsv"
OUT=$(bash "$S" --parent 11 --repo o/r --items "$T/l2.tsv"); RC=$?
check "rollup: lane 2 appends to #902, creates nothing" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && grep -q '^issue edit 902' '$GH_LOG'"
check "rollup: own section for #11, soak item added" "grep -q '^### #11\$' '$ISSUE_BODY.edited' && grep -q 'R8: soak for a week' '$ISSUE_BODY.edited' && grep -q 'FORGE:DEFERRED_FROM: #11' '$ISSUE_BODY.edited'"
check "rollup: duplicate text from another lane stored once" "[ \$(grep -ci 'login page' '$ISSUE_BODY.edited') -eq 1 ] && printf '%s\n' \"\$OUT\" | grep -q '^R7: The Login page renders!.902'"
# a chain: parent 20 is itself a follow-up of #10 -> the items go under the root #10, no new issue
reset
cp "$T/created.902.body" "$ISSUE_BODY" 2>/dev/null || true
echo '{"items":[{"number":901}]}' > "$SEARCH_JSON"
printf '{"number":901,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:POSTDEPLOY_ROLLUP: default -->"}\n' > "$T/issue.901.json"
printf '{"number":20,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}\n' > "$T/issue.20.json"
printf -- '-\tpost-deploy: [bucket:post-deploy] [check:b-smoke] chain\t\t\tR9: a chained check\n' > "$T/l3.tsv"
bash "$S" --parent 20 --repo o/r --items "$T/l3.tsv" >/dev/null 2>&1
check "rollup: a follow-up of a follow-up appends under its root parent, no new issue" "! grep -q '^issue create' '$GH_LOG' && grep -q 'a chained check' '$ISSUE_BODY.edited' && ! grep -q '^### #20' '$ISSUE_BODY.edited'"
# verify-now: its own per-parent follow-up, never the rollup
reset
printf -- '-\tpost-deploy: [bucket:verify-now] on default already\t\t\tR1: check it now\n' > "$T/vn.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/vn.tsv")
check "verify-now: separate per-parent issue, class verify-now, no rollup marker" "grep -q 'FORGE:DEFERRED_CLASS: verify-now' '$T/created.901.body' && ! grep -q POSTDEPLOY_ROLLUP '$T/created.901.body' && printf '%s' \"\$OUT\" | grep -q 'buckets=verify-now:1'"
# an owner bucket on a post-deploy class row is rerouted to external
reset
printf -- 'x/y.sh\towner: [bucket:owner] spend\t\tpost-deploy\n' > "$T/ow.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/ow.tsv" >/dev/null 2>&1
check "owner bucket never lands in post-deploy, even when the row says so" "grep -q 'FORGE:DEFERRED_CLASS: external' '$T/created.901.body' && ! grep -q POSTDEPLOY_ROLLUP '$T/created.901.body'"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
