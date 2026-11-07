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
  "issue create") [ -n "${CREATE_FAIL:-}" ] && exit 1; [ -n "${CREATE_HOOK:-}" ] && eval "$CREATE_HOOK"; N=$(( $(cat "$T_DIR/create.n" 2>/dev/null || echo 900) + 1 )); echo "$N" > "$T_DIR/create.n"; while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$T_DIR/created.$N.body"; shift; done; echo "https://github.com/o/r/issues/$N"; exit 0 ;;
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
  case "$2" in repos/o/r/issues/*/comments*) c="${2#repos/o/r/issues/}"; c="$T_DIR/comments.${c%%/*}.json"; if [ -f "$c" ]; then cat "$c"; else echo '[]'; fi; exit 0 ;; esac
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
reset() { : > "$GH_LOG"; rm -f "$ISSUE_BODY.edited" "$T"/issue.*.json "$T"/comments.*.json "$T/create.n"; unset LOOKUP_FAIL CREATE_FAIL EDIT_FAIL CLAIM_FAIL COMMENT_FAIL REOPEN_FAIL CLOSE_FAIL DRY_RUN FORGE_FOLLOWUP_MILESTONE FORGE_FOLLOWUPS_DEFAULT_MILESTONE FORGE_EXTERNAL_PREREQ
  echo '[]' > "$T/milestones.json"; : > "$T/parent.milestone"
  echo '{"items":[]}' > "$SEARCH_JSON"; echo '[]' > "$COMMENTS_JSON"; }
# issue_json NUMBER STATE ASSOCIATION [PARENT] [STATE_REASON]: REST view of a follow-up carrying the DEFERRED_FROM marker
# (no sed -i: BSD sed on macOS reads the script as the backup suffix, so state_reason was never written there)
issue_json() { printf '{"number":%s,"state":"%s",%s"author_association":"%s","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #%s -->"}\n' "$1" "$2" "${5:+\"state_reason\":\"$5\",}" "$3" "${4:-10}" > "$T/issue.$1.json"; }
# claim_json ASSOCIATION NUMBER...: parent comments carrying claim markers
claim_json() { local a="$1" out="" n; shift; for n in "$@"; do out="${out:+$out,}{\"author_association\":\"$a\",\"user\":{\"type\":\"User\"},\"body\":\"<!-- FORGE:DEFERRED_ISSUE: #$n -->\"}"; done; echo "[$out]" > "$COMMENTS_JSON"; }
# #5207: every item goes to an aggregate; the default fixture is three external items of one parent.
printf 'a/x.sh\texternal: why a\t\nb/y.sh\texternal: why b\tknown-flaw\nc/z.sh\texternal: why c\t\n' > "$T/items.tsv"
agg_json() { printf '{"number":%s,"state":"%s","author_association":"%s","user":{"type":"User"},"body":"%s"}\n' "$1" "$2" "$3" "$4" > "$T/issue.$1.json"; }

# 1. N items -> exactly one aggregate create (the batch external aggregate)
reset
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" --folded 2); RC=$?
check "create: rc 0" "[ $RC -eq 0 ]"
check "create: one issue create for 3 items" "[ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ]"
check "create: rows share issue" "[ \$(printf '%s\n' \"\$OUT\" | grep -c '901\$') -ge 3 ]"
check "create: telemetry" "printf '%s' \"\$OUT\" | grep -q 'DEFERRED_TELEMETRY deferred_items=3 folded=2 batched_into=#901 filed=1 classes=external'"
check "create: the external aggregate marker and labels" "grep -q 'FORGE:EXTERNAL_BATCH: adhoc' '$T/created.901.body' && grep '^issue create' '$GH_LOG' | grep -q -- '--label needs-human' && grep -q 'b/y.sh. \*\*known-flaw\*\*' '$T/created.901.body'"
check "create: claim marker posted on the parent" "grep -q '^issue comment 10 .*FORGE:DEFERRED_ISSUE: #901 class=external' '$GH_LOG'"

# 2. append to the open trusted aggregate; dedup on normalized text
reset
echo '{"items":[{"number":77}]}' > "$SEARCH_JSON"; agg_json 77 open OWNER '<!-- FORGE:EXTERNAL_BATCH: adhoc -->'
printf '## Acceptance Criteria\n\n### #9\n- [ ] `a/x.sh.bak` — old\n<!-- FORGE:EXTERNAL_BATCH: adhoc -->\n' > "$ISSUE_BODY"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "append: rc 0, no create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG'"
check "append: telemetry batched into 77 filed=0" "printf '%s' \"\$OUT\" | grep -q 'batched_into=#77 filed=0'"
check "append: all three added under the parent heading" "[ \$(grep -c '^- \[ \] \`' '$ISSUE_BODY.edited') -eq 4 ] && grep -q '^### #10\$' '$ISSUE_BODY.edited'"
check "append: known-flaw flagged" "grep -q 'b/y.sh. \*\*known-flaw\*\*' '$ISSUE_BODY.edited'"
# 3. nothing new -> no edit
cp "$ISSUE_BODY.edited" "$ISSUE_BODY"; : > "$GH_LOG"; rm -f "$ISSUE_BODY.edited"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "idempotent: no edit, no create on resume" "[ $RC -eq 0 ] && ! grep -qE '^issue (edit|create)' '$GH_LOG'"
# 4. an untrusted or closed aggregate is not reused
reset
echo '{"items":[{"number":66},{"number":67}]}' > "$SEARCH_JSON"; agg_json 66 open NONE '<!-- FORGE:EXTERNAL_BATCH: adhoc -->'; agg_json 67 closed OWNER '<!-- FORGE:EXTERNAL_BATCH: adhoc -->'
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "untrusted/closed aggregate: ignored, create filed" "grep -q '^issue create' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'filed=1' && ! grep -qE '^issue (edit|reopen) 6[67]' '$GH_LOG'"
# 5. lookup failure -> FAILED, nothing filed
reset; export LOOKUP_FAIL=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "lookup failure: rc 3, DEFERRED_LOOKUP=FAILED, no create" "[ $RC -eq 3 ] && printf '%s' \"\$OUT\" | grep -q DEFERRED_LOOKUP=FAILED && ! grep -q '^issue create' '$GH_LOG'"
# 6. create / edit failure not counted as success
reset; export CREATE_FAIL=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "create failure: rc 4, no telemetry" "[ $RC -eq 4 ] && ! printf '%s' \"\$OUT\" | grep -q DEFERRED_TELEMETRY"
reset; export EDIT_FAIL=1
echo '{"items":[{"number":77}]}' > "$SEARCH_JSON"; agg_json 77 open OWNER '<!-- FORGE:EXTERNAL_BATCH: adhoc -->'; printf 'x\n' > "$ISSUE_BODY"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "edit failure: rc 4, no telemetry" "[ $RC -eq 4 ] && ! printf '%s' \"\$OUT\" | grep -q DEFERRED_TELEMETRY"
# 7. DRY_RUN: no create, comment, close or edit
reset; export DRY_RUN=1
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" 2>/dev/null); RC=$?
check "dry-run: no create/comment/close/edit, filed=1" "[ $RC -eq 0 ] && ! grep -qE '^issue (comment|reopen|close|edit|create)' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'filed=1'"
# 8. empty items, usage errors
reset
OUT=$(printf '' | bash "$S" --parent 10 --repo o/r); RC=$?
check "empty: no create, deferred_items=0" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'deferred_items=0'"
bash "$S" --parent >/dev/null 2>&1; RC=$?
check "missing option value: rc 2" "[ $RC -eq 2 ]"
bash "$S" --parent x --repo o/r </dev/null >/dev/null 2>&1; RC=$?
check "non-numeric parent: rc 2" "[ $RC -eq 2 ]"
# 9. a concurrent lane created a lower aggregate between our lookup and our create: ours is closed, items move there
reset
printf 'x\n' > "$ISSUE_BODY"
export CREATE_HOOK="echo '{\"items\":[{\"number\":800}]}' > \"\$SEARCH_JSON\"; printf '%s\n' '{\"number\":800,\"state\":\"open\",\"author_association\":\"OWNER\",\"user\":{\"type\":\"User\"},\"body\":\"<!-- FORGE:EXTERNAL_BATCH: adhoc -->\"}' > \"\$T_DIR/issue.800.json\""
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
unset CREATE_HOOK
check "race: newer duplicate closed, items moved to lowest" "[ $RC -eq 0 ] && grep -q '^issue close 901' '$GH_LOG' && grep -q '^issue edit 800' '$GH_LOG' && printf '%s' \"\$OUT\" | grep -q 'batched_into=#800 filed=1'"
check "race: rows point at canonical issue" "[ \$(printf '%s\n' \"\$OUT\" | grep -c '800\$') -ge 3 ]"

# 10. #5207 R1/R10: an engineering deferral is rejected before any gh call; nothing is filed
for row in 'a/x.sh\twhy a\t' '-\tdefer: wire it\t\t\tR7: wire the report' '-\tdefer: [bucket:new-issue] later\t\t\tR8: later' '-\tpost-deploy: [bucket:new-issue] later\t\t\tR8: later' 'a/x.sh\twhy\t\tengineering' 'a/x.sh\twhy\t\tbacklog'; do
  reset; printf "$row\n" > "$T/eng.tsv"
  OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/eng.tsv" 2>"$T/eng.err"); RC=$?
  check "#5207 engineering row ($(printf "$row" | cut -c1-30)): rc 2, DEFERRED_TSV=INVALID, no gh call" "[ $RC -eq 2 ] && printf '%s' \"\$OUT\" | grep -qx DEFERRED_TSV=INVALID && grep -q 'engineering deferral: build it in-lane (#5207)' '$T/eng.err' && [ ! -s '$GH_LOG' ]"
done
reset; printf 'a/x.sh\texternal: ok\t\n-\tdefer: parser first\t\t\tR1: add the parser\n' > "$T/eng.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/eng.tsv" >/dev/null 2>&1; RC=$?
check "#5207 one engineering row among valid ones files nothing" "[ $RC -eq 2 ] && [ ! -s '$GH_LOG' ]"
# 11. #5207 R4: an existing per-parent follow-up of an older run is never read, edited, reopened or closed
reset
issue_json 77 open OWNER; claim_json OWNER 77
echo '{"items":[]}' > "$SEARCH_JSON" # a search for the aggregate marker never matches a per-parent follow-up
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/items.tsv"); RC=$?
check "#5207 per-parent follow-up #77 untouched: aggregate created, #77 never fetched or changed" "[ $RC -eq 0 ] && grep -q '^issue create' '$GH_LOG' && ! grep -qE 'issues/77|^issue (edit|reopen|close|comment) 77' '$GH_LOG' && ! grep -q 'FORGE:DEFERRED_FROM' '$GH_LOG' && ! grep -q -- '--paginate' '$GH_LOG'"
check "#5207 no title 'follow-up: N deferred item(s)'" "! grep -q 'deferred item(s)' '$GH_LOG'"
# 12. #5207 R2/R8/R9: classes -> the three aggregates (ops shares the external one), never a per-parent issue
reset; export FORGE_BATCH_ID=b7
printf 'a/x.sh\tpost-deploy: [check:smoke] later\t\t\nc/z.sh\texternal: needs a real credential\t\t\nd/w.sh\tops drill\t\tops\n-\thost: [bucket:host] run the obs-psql report\t\t\tR6: report rows\n-\tpost-deploy: [bucket:verify-now] on default already\t\t\tR1: check it now\n' > "$T/classes.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/classes.tsv"); RC=$?
unset FORGE_BATCH_ID
check "aggregates: rc 0, one create per aggregate (3)" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 3 ]"
check "aggregates: telemetry lists every issue and class" "printf '%s' \"\$OUT\" | grep -q 'batched_into=#901,#902,#903 filed=3 classes=external,host,ops,post-deploy'"
check "aggregates: ops joins the external batch aggregate" "grep -q 'FORGE:EXTERNAL_BATCH: b7' '$T/created.901.body' && grep -q 'd/w.sh' '$T/created.901.body' && grep -q 'c/z.sh' '$T/created.901.body' && printf '%s\n' \"\$OUT\" | grep -q '^d/w.sh	901\$'"
check "aggregates: host batch aggregate, labelled followup:host + host-task, never needs-human" "grep -q 'FORGE:HOST_BATCH: b7' '$T/created.902.body' && grep -q 'report rows' '$T/created.902.body' && grep '^issue create' '$GH_LOG' | grep 'host: tasks of batch b7' | grep -- '--label followup:host' | grep -- '--label host-task' | grep -qv needs-human"
check "aggregates: verify-now joins the release rollup" "grep -q 'FORGE:POSTDEPLOY_ROLLUP: default' '$T/created.903.body' && grep -q 'check it now' '$T/created.903.body' && grep -q 'a/x.sh' '$T/created.903.body'"
check "aggregates: no per-parent follow-up title" "! grep '^issue create' '$GH_LOG' | grep -q 'follow-up'"
# a second lane of the batch appends to the host aggregate
reset; export FORGE_BATCH_ID=b7
echo '{"items":[{"number":902}]}' > "$SEARCH_JSON"; agg_json 902 open OWNER '<!-- FORGE:HOST_BATCH: b7 -->'; cp "$T/created.902.body" "$ISSUE_BODY"
printf -- '-\thost: [bucket:host] capture the page in a browser on the host before promotion\t\t\tR2: browser capture\n' > "$T/hb.tsv"
OUT=$(bash "$S" --parent 11 --repo o/r --items "$T/hb.tsv"); RC=$?
unset FORGE_BATCH_ID
check "host aggregate: second lane appends under its parent, no create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && grep -q '^issue edit 902' '$GH_LOG' && grep -q '^### #11\$' '$ISSUE_BODY.edited' && grep -q 'browser capture' '$ISSUE_BODY.edited'"

# 13. #4664: milestone inheritance
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
reset; printf '%s\n' "$(printf -- '-\texternal: why\t\t\tR1: R2: a saved mapping')" "$(printf 'src/q.ts\texternal: why q\t')" > "$T/ok.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/ok.tsv"); RC=$?
check "label row accepted, prefix collapsed in stdout" "[ $RC -eq 0 ] && printf '%s\n' \"\$OUT\" | grep -q '^R1: a saved mapping	901'"

check "created body: the checklist keeps the collapsed label and the path" "grep -q '^- \[ \] \`src/q.ts\`' '$T/created.901.body' && grep -q '^- \[ \] \`R1: a saved mapping\`' '$T/created.901.body' && ! grep -q 'R1: R2:' '$T/created.901.body'"
check "created body: parent section and DEFERRED_CLASS markers" "grep -q 'FORGE:DEFERRED_FROM: #10 -->' '$T/created.901.body' && grep -q 'FORGE:DEFERRED_CLASS: external' '$T/created.901.body'"
# #4739: legal path characters (parentheses, space, =, #, :) are accepted; one such row no longer aborts the batch
reset; printf 'app/(marketing)/page.tsx\texternal: why\t\ndocs/My Notes.md\texternal: why\t\nsrc/a=b.ts\texternal: why\t\nsrc/#x.ts\texternal: why\t\nsrc/foo:bar.ts\texternal: why\t\n' > "$T/legal.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/legal.tsv" 2>/dev/null); RC=$?
check "legal paths with ( ) space = # : are accepted and filed" "[ $RC -eq 0 ] && ! printf '%s' \"\$OUT\" | grep -q DEFERRED_TSV=INVALID && grep -q '^issue create' '$GH_LOG' && grep -qF -- '\`app/(marketing)/page.tsx\`' '$T/created.901.body' && grep -qF -- '\`docs/My Notes.md\`' '$T/created.901.body' && grep -qF -- '\`src/a=b.ts\`' '$T/created.901.body' && grep -qF -- '\`src/#x.ts\`' '$T/created.901.body' && grep -qF -- '\`src/foo:bar.ts\`' '$T/created.901.body'"
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
# #5207: verify-now joins the release rollup, never a per-parent issue
reset
printf -- '-\tpost-deploy: [bucket:verify-now] on default already\t\t\tR1: check it now\n' > "$T/vn.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/vn.tsv")
check "verify-now: the rollup, class post-deploy" "grep -q 'FORGE:DEFERRED_CLASS: post-deploy' '$T/created.901.body' && grep -q 'POSTDEPLOY_ROLLUP' '$T/created.901.body' && printf '%s' \"\$OUT\" | grep -q 'buckets=verify-now:1'"
# an owner bucket on a post-deploy class row is rerouted to external
reset
printf -- 'x/y.sh\towner: [bucket:owner] spend\t\tpost-deploy\n' > "$T/ow.tsv"
bash "$S" --parent 10 --repo o/r --items "$T/ow.tsv" >/dev/null 2>&1
check "owner bucket never lands in post-deploy, even when the row says so" "grep -q 'FORGE:DEFERRED_CLASS: external' '$T/created.901.body' && ! grep -q POSTDEPLOY_ROLLUP '$T/created.901.body'"

# a parent that is itself an open follow-up and is the issue the lane closes: a NEW follow-up links it, its body is never edited
reset
printf '{"number":20,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"## Acceptance Criteria\\n\\n- [ ] `R1: old`\\n<!-- FORGE:DEFERRED_FROM: #10 -->"}\n' > "$T/issue.20.json"
printf -- '-\texternal: later\t\t\tR2: wire `pd.py` in\n' > "$T/fu.tsv"
OUT=$(bash "$S" --parent 20 --repo o/r --items "$T/fu.tsv"); RC=$?
check "follow-up parent: aggregate filed under the root parent, parent body unchanged" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ] && ! grep -q '^issue edit 20' '$GH_LOG' && [ ! -e '$ISSUE_BODY.edited' ] && grep -q '^### #10\$' '$T/created.901.body' && printf '%s\n' \"\$OUT\" | grep -q '^R2: wire pd.py in.901\$'"

# 24. #5078: routing by kind
# post-promotion owner deferral appends to the open rollup, creates no issue
reset
printf '{"number":902,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:POSTDEPLOY_ROLLUP: default -->"}\n' > "$T/issue.902.json"
echo '{"items":[{"number":902}]}' > "$SEARCH_JSON"; printf '<!-- FORGE:POSTDEPLOY_ROLLUP: default -->\n' > "$ISSUE_BODY"
printf -- '-\towner: orchestrator. [bucket:owner] post-deploy action with no registered check\t\t\tR1: verify the banner in prod\n-\towner: promote:new-nav. [bucket:owner] flip the flag\t\t\tR2: promote the new nav\n-\towner: ops. [bucket:owner] purge the CDN after release\t\t\tR3: purge the cdn\n' > "$T/pp.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/pp.tsv"); RC=$?
check "routing: post-promotion owner items append to the rollup, no issue create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && grep -q '^issue edit 902' '$GH_LOG' && [ \$(grep -c '^- \[ \] ' '$ISSUE_BODY.edited') -eq 3 ] && printf '%s' \"\$OUT\" | grep -q 'classes=post-deploy '"
# a configured-label rollup (forge.yaml followups.rollup_issue_label) is used when no marked rollup is open
reset
printf '{"number":950,"state":"open","author_association":"OWNER","user":{"type":"User"},"labels":[{"name":"post-deploy"}],"body":"release checklist"}\n' > "$T/issue.950.json"
echo '{"items":[{"number":950}]}' > "$SEARCH_JSON"; printf 'release checklist\n' > "$ISSUE_BODY"
printf -- '-\tpost-deploy: [bucket:post-deploy] [check:smoke] check it\t\t\tR4: smoke the login\n' > "$T/lab.tsv"
OUT=$(FORGE_ROLLUP_LABEL=post-deploy bash "$S" --parent 10 --repo o/r --items "$T/lab.tsv"); RC=$?
check "routing: labelled rollup #950 appended, no issue create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && grep -q '^issue edit 950' '$GH_LOG' && grep -q 'smoke the login' '$ISSUE_BODY.edited' && printf '%s\n' \"\$OUT\" | grep -q '^R4: smoke the login.950\$'"
reset
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/lab.tsv"); RC=$?
check "routing: without the label setting an unmarked labelled issue is not the rollup" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ]"
# read-only production data -> host follow-up, host-task, never needs-human / external-prerequisite
reset
printf -- '-\towner: obs-psql. [bucket:owner] capture the read-only production query counts\t\t\tR5: capture prod counts\n' > "$T/host.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/host.tsv"); RC=$?
check "routing: read-only prod owner item -> the host aggregate labelled host-task" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ] && grep '^issue create' '$GH_LOG' | grep -q -- '--label followup:host' && grep '^issue create' '$GH_LOG' | grep -q -- '--label host-task' && grep -q 'FORGE:DEFERRED_CLASS: host' '$T/created.901.body' && grep -q 'FORGE:HOST_BATCH: adhoc' '$T/created.901.body'"
check "routing: host follow-up carries no needs-human or external-prerequisite" "! grep '^issue create' '$GH_LOG' | grep -qE 'needs-human|external-prerequisite'"
reset
printf -- '-\t[bucket:host] host: run the obs-psql report\t\t\tR6: report rows\n-\tdefer: wire it\t\t\tR7: wire the report\n' > "$T/join.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/join.tsv" 2>/dev/null); RC=$?
check "#5207 routing: a host item next to an engineering row files nothing (the engineering row is rejected)" "[ $RC -eq 2 ] && [ ! -s '$GH_LOG' ]"
# #5186: host + post-promotion text joins the rollup; the same text from two parents is listed once; pre-promotion stays host
reset
printf '{"number":902,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:POSTDEPLOY_ROLLUP: default -->"}\n' > "$T/issue.902.json"
echo '{"items":[{"number":902}]}' > "$SEARCH_JSON"; printf '<!-- FORGE:POSTDEPLOY_ROLLUP: default -->\n' > "$ISSUE_BODY"
printf -- '-\thost: [bucket:host] billed margin from billing rows in production after promotion\t\t\tR1: billed margin check\n' > "$T/hp.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/hp.tsv"); RC=$?
check "routing: host post-promotion item appends to the rollup, no issue create" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && grep -q '^issue edit 902' '$GH_LOG' && grep -q 'billed margin check' '$ISSUE_BODY.edited' && printf '%s' \"\$OUT\" | grep -q 'classes=post-deploy '"
cp "$ISSUE_BODY.edited" "$ISSUE_BODY"; : > "$GH_LOG"
OUT=$(bash "$S" --parent 11 --repo o/r --items "$T/hp.tsv"); RC=$?
check "routing: the same host item from a second parent is listed once" "[ $RC -eq 0 ] && ! grep -q '^issue create' '$GH_LOG' && [ \$(grep -c 'billed margin check' '$ISSUE_BODY') -eq 1 ] && { [ ! -f '$ISSUE_BODY.edited' ] || [ \$(grep -c 'billed margin check' '$ISSUE_BODY.edited') -eq 1 ]; }"
reset
printf -- '-\thost: [bucket:host] capture the page in a browser on the host before promotion\t\t\tR2: browser capture\n' > "$T/hb.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/hb.tsv"); RC=$?
check "routing: pre-promotion host item still files the host aggregate" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ] && grep '^issue create' '$GH_LOG' | grep -q -- '--label followup:host'"
# N external deferrals in one batch -> ONE aggregated issue carrying needs-human
reset
export FORGE_BATCH_ID=b42
printf -- '-\towner: stripe. [bucket:owner] needs live Stripe credentials\t\t\tR8: charge a real card\n' > "$T/e1.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/e1.tsv"); RC=$?
check "external batch: first parent creates the aggregate with needs-human" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ] && grep -q 'FORGE:EXTERNAL_BATCH: b42' '$T/created.901.body' && grep -q '^### #10\$' '$T/created.901.body' && grep '^issue create' '$GH_LOG' | grep -q -- '--label needs-human' && grep '^issue create' '$GH_LOG' | grep -q -- '--label external-prerequisite'"
printf '{"number":901,"state":"open","author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:EXTERNAL_BATCH: b42 -->"}\n' > "$T/issue.901.json"
echo '{"items":[{"number":901}]}' > "$SEARCH_JSON"; cp "$T/created.901.body" "$ISSUE_BODY"
printf -- '-\texternal: [bucket:owner] buy the domain (spend)\t\t\tR1: register the domain\n' > "$T/e2.tsv"
OUT2=$(bash "$S" --parent 11 --repo o/r --items "$T/e2.tsv"); cp "$ISSUE_BODY.edited" "$ISSUE_BODY"
printf -- '-\texternal: customer sign-off\t\t\tR2: customer signs the DPA\n-\texternal: dup\t\t\tR9: Charge a real card!\n' > "$T/e3.tsv"
OUT3=$(bash "$S" --parent 12 --repo o/r --items "$T/e3.tsv"); RC=$?
check "external batch: three parents, exactly one issue create, later lanes append to it" "[ $RC -eq 0 ] && [ \$(grep -c '^issue create' '$GH_LOG') -eq 1 ] && [ \$(grep -c '^issue edit 901' '$GH_LOG') -eq 2 ] && printf '%s\n' \"\$OUT3\" | grep -q '^R2: customer signs the DPA.901\$'"
check "external batch: per-parent headings, duplicate text stored once" "grep -q '^### #11\$' '$ISSUE_BODY.edited' && grep -q '^### #12\$' '$ISSUE_BODY.edited' && [ \$(grep -ci 'charge a real card' '$ISSUE_BODY.edited') -eq 1 ]"
unset FORGE_BATCH_ID
# #5207: engineering deferrals (dependent items or new-issue backlog items) are never filed, per parent or per batch
reset; export FORGE_BATCH_ID=b1
printf -- '-\tdefer: parser first\t\t\tR1: add the parser\n-\tdefer: [bucket:new-issue] later\t\t\tR2: wire the report\n' > "$T/eng.tsv"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/eng.tsv" 2>"$T/eng.err"); RC=$?
unset FORGE_BATCH_ID
check "engineering/backlog: rejected (rc 2), no issue, no BACKLOG_BATCH" "[ $RC -eq 2 ] && [ ! -s '$GH_LOG' ] && [ \$(grep -c 'engineering deferral: build it in-lane (#5207)' '$T/eng.err') -eq 2 ] && ! grep -rq BACKLOG_BATCH '$T'/created.*.body 2>/dev/null"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
