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
export GH_LOG="$T/gh.log" SEARCH_JSON="$T/search.json" ISSUE_BODY="$T/issue.body"

cat > "$T/bin/gh" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "api -X") [ -n "${LOOKUP_FAIL:-}" ] && exit 1; cat "$SEARCH_JSON"; exit 0 ;;
  "issue create") [ -n "${CREATE_FAIL:-}" ] && exit 1; echo "https://github.com/o/r/issues/901"; exit 0 ;;
  "issue edit")
    [ -n "${EDIT_FAIL:-}" ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$ISSUE_BODY.edited"; shift; done; exit 0 ;;
esac
case "$1" in api) cat "$ISSUE_BODY"; exit 0 ;; esac
exit 1
MOCK
chmod +x "$T/bin/gh"; export PATH="$T/bin:$PATH"

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
reset() { : > "$GH_LOG"; rm -f "$ISSUE_BODY.edited"; unset LOOKUP_FAIL CREATE_FAIL EDIT_FAIL DRY_RUN; echo '{"items":[]}' > "$SEARCH_JSON"; }
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
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
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
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
OUT=$(bash "$S" --parent 10 --repo o/r --items "$T/emptywhy.tsv"); RC=$?
check "empty-why: append keeps known-flaw flag" "[ $RC -eq 0 ] && grep -q 'd/w.sh. \*\*known-flaw\*\*' '$ISSUE_BODY.edited'"

# 2c. missing option value -> usage exit 2
bash "$S" --parent >/dev/null 2>&1; RC=$?
check "missing option value: rc 2" "[ $RC -eq 2 ]"

# 3. already-listed path is not duplicated; nothing to add -> no edit
reset
printf -- '- [ ] `a/x.sh` — w\n- [x] `b/y.sh`\n- [ ] `c/z.sh`\n' > "$ISSUE_BODY"
echo '{"items":[{"number":77,"author_association":"MEMBER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
bash "$S" --parent 10 --repo o/r --items "$T/items.tsv" >/dev/null; RC=$?
check "idempotent: no edit, no create on resume" "[ $RC -eq 0 ] && ! grep -qE '^issue (edit|create)' '$GH_LOG'"

# 4. untrusted match ignored -> new issue
reset
echo '{"items":[{"number":66,"author_association":"NONE","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
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
echo '{"items":[{"number":77,"author_association":"OWNER","user":{"type":"User"},"body":"<!-- FORGE:DEFERRED_FROM: #10 -->"}]}' > "$SEARCH_JSON"
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

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
