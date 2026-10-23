#!/usr/bin/env bash
# review-staging-pre.test.sh — cases for scripts/review-staging-pre.sh (forge#4358): bundle PR set, open review-finding gate,
# 0B.1 scope. Since #4359 the script is the only copy of these blocks (the spec calls `forgedock review-staging`).
# gh is a PATH stub reading per-case fixtures; git runs against a throwaway repo with a local bare "origin".
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRE="$ROOT/scripts/review-staging-pre.sh"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-staging-pre.test.sh: jq missing, skipped"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "review-staging-pre.test.sh: git missing, skipped"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FORGEDOCK_HOME="$ROOT"   # resolve helpers from this checkout, not an ambient install

# (1) the blocks live only here: present in the script, absent from the spec
for b in bundle-pr-set bundle-pr-kind bundle-delta-credit bundle-scope-loop; do
  grep -qx "# BEGIN $b" "$PRE" && grep -qx "# END $b" "$PRE" && ok || bad "block $b missing from review-staging-pre.sh"
  grep -qx "# BEGIN $b" "$ROOT/commands/review-pr-staging.md" && bad "block $b still copied into commands/review-pr-staging.md" || ok
done

# (2) usage errors
bash "$PRE" bogus --repo o/r --pr 1 >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unknown subcommand must exit 2"
bash "$PRE" gate --repo o/r --pr x --prs-file /dev/null >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "non-numeric --pr must exit 2"
bash "$PRE" gate --repo o/r --pr 9 --prs-file "$TMP/none" >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unreadable --prs-file must exit 2 (never an empty bundle)"
bash "$PRE" scope --repo o/r --pr 9 --default main --staging staging --prs-file /dev/null --sd "$TMP/sd" --bogus 1 >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unknown flag must exit 2"

# gh stub: fixtures in $FIX; posted comment bodies are appended to $FIX/posted
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
F="$FIX"; a="$*"
# fail-labels / fail-issues: the degraded-label / review-finding read fails (rate limit, 5xx, expired auth)
case "$a" in "pr view"*"--json labels"*) [ -f "$F/fail-labels" ] && exit 1 ;; "issue list"*) [ -f "$F/fail-issues" ] && exit 1 ;; esac
case "$1 $2" in
  "pr comment") while [ $# -gt 0 ]; do [ "$1" = --body ] && { printf '%s\n@@\n' "$2" >> "$F/posted"; }; shift; done; exit 0 ;;
  "pr diff") [ -f "$F/files-$3" ] && { cat "$F/files-$3"; exit 0; }; exit 1 ;;
  "pr view")
    case "$a" in *"--json labels"*) [ -f "$F/degraded-$3" ] && echo true || echo false; exit 0 ;; esac
    [ -f "$F/pr-$3.json" ] && { cat "$F/pr-$3.json"; exit 0; }; exit 1 ;;
  "issue list")
    n=$(printf '%s' "$a" | sed -n 's/.*--search PR #\([0-9]*\).*/\1/p')
    [ -f "$F/findings-$n.json" ] && cat "$F/findings-$n.json" || echo '[]'; exit 0 ;;
esac
if [ "$1" = api ]; then
  case "$a" in
    *"/comments"*) n=$(printf '%s' "$a" | sed -n 's#.*issues/\([0-9]*\)/comments.*#\1#p'); [ -f "$F/comments-$n.json" ] && cat "$F/comments-$n.json" || echo '[]'; exit 0 ;;
    *"repos/o/r/issues/"*) n=$(printf '%s' "$a" | sed -n 's#.*repos/o/r/issues/\([0-9]*\).*#\1#p'); [ -f "$F/issue-$n" ] && echo issue || echo pr; exit 0 ;;
  esac
fi
echo "gh stub: unhandled: $a" >&2; exit 1
STUB
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
newfix() { FIX="$TMP/fix.$1"; rm -rf "$FIX"; mkdir -p "$FIX"; export FIX; }

# throwaway repo: main, then staging = merge of PR #5 (feature commit) + a direct commit citing issue #77
G() { git -C "$TMP/work" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"; }
git init -q --bare "$TMP/origin.git"
git init -q "$TMP/work"; G checkout -q -b main
echo base > "$TMP/work/base.txt"; G add -A; G commit -qm base; G remote add origin "$TMP/origin.git"; G push -q origin main
G checkout -q -b staging; G checkout -q -b feat
echo a > "$TMP/work/a.js"; G add -A; G commit -qm "feat: a"; FEAT=$(G rev-parse HEAD)
G checkout -q staging; G merge -q --no-ff feat -m "Merge pull request #5 from o/feat"; MERGE=$(G rev-parse HEAD)
mkdir -p "$TMP/work/.github/workflows"; echo b > "$TMP/work/b.js"; echo x > "$TMP/work/.github/workflows/ci.yml"
G add -A; G commit -qm "fix: thing (#77)"; DIRECT=$(G rev-parse HEAD); G push -q origin staging
run() { (cd "$TMP/work" && bash "$PRE" "$@"); }

# (3) bundle: the merge-subject PR is kept, the issue cited in a subject is skipped, the list is persisted
newfix bundle; : > "$FIX/issue-77"
OUT=$(run bundle --repo o/r --default main --staging staging --pr 9 --sd "$TMP/sd" 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok || bad "bundle must exit 0 (got $RC: $OUT)"
[ "$(cat "$TMP/sd/9_bundle-prs.txt" 2>/dev/null)" = 5 ] && ok || bad "bundle must persist exactly PR 5 (got '$(cat "$TMP/sd/9_bundle-prs.txt" 2>/dev/null)')"
case "$OUT" in *"skipped): 77"*) ok ;; *) bad "bundle must report the skipped issue 77 (got '$OUT')" ;; esac

# (4) gate
printf '5\n' > "$TMP/prs"
newfix clean; OUT=$(run gate --repo o/r --pr 9 --prs-file "$TMP/prs" 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok || bad "clean gate must exit 0 (got $RC)"
case "$OUT" in *"RESULT: PASS"*) ok ;; *) bad "clean gate must print RESULT: PASS" ;; esac
grep -qx '<!-- FORGE:GATE_PASS:TYPE=open-review-finding -->' "$FIX/posted" && head -1 "$FIX/posted" | grep -qx '<!-- FORGE:GATE_PASS -->' && ok || bad "clean gate must post the unchanged GATE_PASS body"
newfix degraded; : > "$FIX/degraded-5"
run gate --repo o/r --pr 9 --prs-file "$TMP/prs" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ] && grep -q 'FORGE:GATE_FAILURE:TYPE=review-panel-integrity' "$FIX/posted" && ok || bad "degraded panel must block with review-panel-integrity (rc $RC)"
newfix finding; jq -n '[{number:41,title:"bug (PR #5)",body:"x"}]' > "$FIX/findings-5.json"
OUT=$(run gate --repo o/r --pr 9 --prs-file "$TMP/prs" 2>&1); RC=$?
[ "$RC" -eq 1 ] && ok || bad "an open finding must block (rc $RC)"
case "$OUT" in *"RESULT: BLOCK DEPLOY"*) ok ;; *) bad "blocked gate must print RESULT: BLOCK DEPLOY" ;; esac
grep -q 'FORGE:GATE_FAILURE:TYPE=open-review-finding|FINDINGS=1' "$FIX/posted" && ok || bad "blocked gate must post the GATE_FAILURE marker with FINDINGS=1"
newfix unanchored; jq -n '[{number:41,title:"bug (PR #55)",body:"x"}]' > "$FIX/findings-5.json"
run gate --repo o/r --pr 9 --prs-file "$TMP/prs" >/dev/null 2>&1; [ $? -eq 0 ] && ok || bad "a finding for another PR (#55) must not block #5"
newfix override; jq -n '[{number:41,title:"bug (PR #5)",body:"x"}]' > "$FIX/findings-5.json"
jq -n '[{body:"OVERRIDE: shipping with open findings — known",author_association:"OWNER",user:{type:"User",login:"o"}}]' > "$FIX/comments-9.json"
OUT=$(run gate --repo o/r --pr 9 --prs-file "$TMP/prs" 2>&1); RC=$?
[ "$RC" -eq 0 ] && case "$OUT" in *"RESULT: PASS"*) true ;; *) false ;; esac && ok || bad "a trusted override must pass (rc $RC)"
newfix untrusted; jq -n '[{number:41,title:"bug (PR #5)",body:"x"}]' > "$FIX/findings-5.json"
jq -n '[{body:"OVERRIDE: shipping with open findings — x",author_association:"NONE",user:{type:"User",login:"z"}}]' > "$FIX/comments-9.json"
run gate --repo o/r --pr 9 --prs-file "$TMP/prs" >/dev/null 2>&1; [ $? -eq 1 ] && ok || bad "an untrusted override must not pass"
# forge#4470: the gate fails closed. A failed gh read or an empty bundle never posts GATE_PASS.
printf '101\n102\n' > "$TMP/prs2"
newfix ghfail; : > "$FIX/fail-labels"; : > "$FIX/fail-issues"
OUT=$(run gate --repo o/r --pr 9 --prs-file "$TMP/prs2" 2>&1); RC=$?
[ "$RC" -eq 1 ] && ok || bad "gh read failure blocks: gate must exit 1 when every gh read fails (rc $RC)"
case "$OUT" in *"RESULT: BLOCK DEPLOY"*) ok ;; *) bad "gh read failure blocks: must print RESULT: BLOCK DEPLOY (got '$OUT')" ;; esac
! grep -q 'FORGE:GATE_PASS' "$FIX/posted" 2>/dev/null && ok || bad "gh read failure blocks: must not post GATE_PASS"
grep -q 'FORGE:GATE_FAILURE:TYPE=gate-read-failure' "$FIX/posted" 2>/dev/null && ok || bad "gh read failure blocks: must post TYPE=gate-read-failure"
newfix issuefail; : > "$FIX/fail-issues"
run gate --repo o/r --pr 9 --prs-file "$TMP/prs" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ] && ! grep -q 'FORGE:GATE_PASS' "$FIX/posted" 2>/dev/null && ok || bad "a failed review-finding read alone must block without GATE_PASS (rc $RC)"
newfix labelfail; : > "$FIX/fail-labels"
run gate --repo o/r --pr 9 --prs-file "$TMP/prs" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ] && ! grep -q 'FORGE:GATE_PASS' "$FIX/posted" 2>/dev/null && ok || bad "a failed degraded-label read alone must block without GATE_PASS (rc $RC)"
newfix readfailoverride; : > "$FIX/fail-issues"
jq -n '[{body:"OVERRIDE: shipping with open findings — known",author_association:"OWNER",user:{type:"User",login:"o"}}]' > "$FIX/comments-9.json"
run gate --repo o/r --pr 9 --prs-file "$TMP/prs" >/dev/null 2>&1; [ $? -eq 1 ] && ok || bad "a trusted override must not waive a read failure"
newfix emptyprs; : > "$TMP/prs-empty"
OUT=$(run gate --repo o/r --pr 9 --prs-file "$TMP/prs-empty" 2>&1); RC=$?
[ "$RC" -eq 1 ] && ! grep -q 'FORGE:GATE_PASS' "$FIX/posted" 2>/dev/null && ok || bad "an empty prs-file must block without GATE_PASS (rc $RC: $OUT)"
newfix emptybundle
run bundle --repo o/r --default staging --staging staging --pr 8 --sd "$TMP/sd" >/dev/null 2>&1; RC=$?
[ "$RC" -ne 0 ] && ok || bad "an empty bundle PR set must exit non-zero"
newfix fetchfail
run bundle --repo o/r --default main --staging no-such-branch --pr 8 --sd "$TMP/sd" >/dev/null 2>&1; RC=$?
[ "$RC" -ne 0 ] && ok || bad "a failed git fetch must exit non-zero"

# (5) scope: PR 5 reviewed at its final head -> scoped; the direct commit and its files are unreviewed
newfix scope; H7=${FEAT:0:7}
jq -n --arg h "$FEAT" --arg m "$MERGE" '{headRefOid:$h,mergeCommit:{oid:$m},commits:[{oid:$h}],state:"MERGED",baseRefName:"staging",labels:[]}' > "$FIX/pr-5.json"
printf 'a.js\n' > "$FIX/files-5"
jq -n --arg r "<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=$H7 -->" \
  --arg g "$(printf '<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: %s\n\n<!-- REVIEW-FINDINGS-START -->\n<!-- REVIEW-FINDINGS-END -->' "$FEAT")" \
  '[{body:$r,author_association:"NONE",user:{type:"Bot",login:"b"}},{body:$g,author_association:"NONE",user:{type:"Bot",login:"b"}}]' > "$FIX/comments-5.json"
OUT=$(run scope --repo o/r --default main --staging staging --pr 9 --prs-file "$TMP/prs" --sd "$TMP/sd" 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok || bad "scope must exit 0 (got $RC: $OUT)"
J="$TMP/sd/9_scope.json"
[ "$(jq -r .scope_mode "$J" 2>/dev/null)" = scoped ] && ok || bad "a reviewed bundle must be scoped (got $(jq -c . "$J" 2>/dev/null); $OUT)"
[ "$(jq -r '.unreviewed_commits | join(" ")' "$J" 2>/dev/null)" = "$DIRECT" ] && ok || bad "only the direct commit is unreviewed (got $(jq -c .unreviewed_commits "$J" 2>/dev/null))"
jq -e '.unreviewed_files | index("b.js")' "$J" >/dev/null 2>&1 && ! jq -e '.unreviewed_files | index("a.js")' "$J" >/dev/null 2>&1 && ok || bad "unreviewed files must hold b.js and not a.js"
jq -e '.deploy_wiring_files | index(".github/workflows/ci.yml")' "$J" >/dev/null 2>&1 && ok || bad "workflow files are deploy wiring"
jq -e '.reviewed_pr_count == 1' "$J" >/dev/null 2>&1 && ok || bad "reviewed_pr_count must be 1"
grep -q '^SCOPE_MODE=scoped$' "$TMP/sd/9_scope.env" && grep -q '^5 a.js$' "$TMP/sd/9_bundle-pr-files.txt" && ok || bad "scope.env and bundle-pr-files.txt keep the spec's format"
case "$OUT" in *"SCOPE_MODE=scoped reviewed_prs=1"*) ok ;; *) bad "scope must print the one-line summary" ;; esac
newfix scopefail
run scope --repo o/r --default main --staging staging --pr 9 --prs-file "$TMP/prs" --sd "$TMP/sd" >/dev/null 2>&1
[ "$(jq -r .scope_mode "$TMP/sd/9_scope.json" 2>/dev/null)" = full ] && ok || bad "a failed gh pr view must widen scope to full"

echo "review-staging-pre.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
