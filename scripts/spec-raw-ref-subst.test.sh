#!/usr/bin/env bash
# spec-raw-ref-subst.test.sh — PR ref names (head/base branch) are attacker-chosen: git accepts `$(...)`,
# backticks, spaces and quotes in a ref. A bash fence in a spec must never receive one by textual
# `{PLACEHOLDER}` substitution (the agent pastes the value before bash parses the line). Fences read refs
# as data (jq on the context file, `gh ... --jq`) behind a fail-closed charset guard and quote every use.
# Usage: bash scripts/spec-raw-ref-subst.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$HERE/.."
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

# Print "file:line:text" for every line inside a bash fence that substitutes a ref placeholder (comments and
# Skill()/prompt= argument lines are not shell text and are skipped).
fence_hits() {
  awk -v F="$1" '
    /^[[:space:]]*```/ { f = !f; next }
    f && !/^[[:space:]]*#/ && !/Skill\(/ && !/prompt=/ && /(^|[^$])\{(HEAD|BASE|HEAD_BRANCH|PR_BASE)\}/ { print F ":" NR ":" $0 }
  ' "$ROOT/$1"
}
SPECS="commands/review-pr.md commands/work-on/remediate.md commands/work-on/close.md"
for f in $SPECS; do
  h=$(fence_hits "$f")
  [ -z "$h" ] && ok || bad "$f substitutes a raw ref into a bash fence: $h"
done

# Quoted-assignment form anywhere in the swept specs (ac-1, ac-2, ac-5).
h=$(cd "$ROOT" && grep -nE '="\{(HEAD|BASE|HEAD_BRANCH|PR_BASE)\}"' $SPECS || true)
[ -z "$h" ] && ok || bad "quoted raw-ref assignment: $h"
# Unquoted git operand (ac-4).
h=$(cd "$ROOT" && grep -nE '(checkout|worktree add|reset --hard|fetch origin|rev-list)[^"]* \{HEAD_BRANCH\}' commands/work-on/remediate.md || true)
[ -z "$h" ] && ok || bad "unquoted {HEAD_BRANCH} git operand: $h"

# review-pr reads both refs from the context file (ac-3).
grep -qF ".pr.head_ref" "$ROOT/commands/review-pr.md" && grep -qF ".pr.base_ref" "$ROOT/commands/review-pr.md" && ok || bad "review-pr.md does not read refs from the context file"

# Every remediate fence that uses $HEAD_BRANCH/$PR_BASE in git must derive and guard them in the same fence.
n=$(awk '/^[[:space:]]*```/{if(f&&u&&!g)c++; f=!f; u=0; g=0; next} f&&/\$(HEAD_BRANCH|PR_BASE)/&&!/^[[:space:]]*#/{u=1} f&&/grep -qvE .\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/-\]\*\$./{g=1} END{print c+0}' "$ROOT/commands/work-on/remediate.md")
{ [ "$n" -eq 0 ] && ok; } || bad "$n remediate fence(s) use a ref without the fail-closed guard (M0 fence excluded only when it guards)"

# Behavioral tests (e1-e4). The guard accepts conventional refs and rejects injection shapes; reading an
# attacker ref as data never executes it.
guard() { printf '%s\n%s\n' "$1" "$2" | grep -qvE '^[A-Za-z0-9][A-Za-z0-9._/-]*$' && echo reject || echo accept; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

test_e6_close_and_remediate_do_not_forward_or_assign_raw_base() {
  grep -qF 'PR_BASE="{PR_BASE}"' "$ROOT/commands/work-on/close.md" && bad "close.md assigns PR_BASE from raw placeholder" || ok
  grep -nE 'work-on:close", args=.*--base' "$ROOT/commands/work-on/remediate.md" >/dev/null && bad "remediate.md forwards a raw --base to close" || ok
  grep -qF 'PR_BASE="${PR_BASE:-' "$ROOT/commands/work-on/remediate.md" && bad "M0 honors caller --base over the guarded PR base" || ok
}
test_e7_park_fence_aborts_merge_before_ref_guard() {
  local a g; a=$(grep -n 'git merge --abort; fi' "$ROOT/commands/work-on/remediate.md" | sed -n 1p | cut -d: -f1)
  g=$(awk -v a="$a" 'NR>a && /grep -qvE/ {print NR; exit}' "$ROOT/commands/work-on/remediate.md")
  [ -n "$a" ] && [ -n "$g" ] && ok || bad "park fence abort/guard not found"
  sed -n "$((a+1)),$((a+5))p" "$ROOT/commands/work-on/remediate.md" | grep -q 'exit 1' && bad "park fence exits before posting the park trail" || ok
}
test_e1_ref_read_as_data_never_executes() {
  printf '%s' '{"pr":{"head_ref":"fix/x$(touch '"$T"'/pwned)y","base_ref":"main"}}' > "$T/ctx.json"
  local h; h=$(jq -r '.pr.head_ref // ""' "$T/ctx.json")
  [ ! -e "$T/pwned" ] && ok || bad "reading the ref executed it"
  [ "$(guard main "$h")" = reject ] && ok || bad "command-substitution ref not rejected"
  local evil; for evil in 'a`id`b' 'a;b' 'a b' 'a"b'; do
    [ "$(guard "$evil" main)" = reject ] && ok || bad "head ref '$evil' not rejected"
    [ "$(guard main "$evil")" = reject ] && ok || bad "base ref '$evil' not rejected"
  done
}
test_e2_legitimate_refs_pass_guard() {
  [ "$(guard 'fix/issue-3990' 'staging')" = accept ] && ok || bad "legit refs rejected"
  [ "$(guard 'release/1.2.3' 'milestone/x_y')" = accept ] && ok || bad "legit refs with dots/underscores rejected"
}
test_e3_leading_dash_ref_rejected() {
  local evil; for evil in '-x' '--upload-pack=x'; do
    [ "$(guard "$evil" main)" = reject ] && ok || bad "ref '$evil' not rejected"
  done
}
test_e4_null_or_empty_ref_rejected() {
  printf '%s' '{"pr":{"head_ref":null}}' > "$T/null.json"
  local h; h=$(jq -r '.pr.head_ref // ""' "$T/null.json")
  [ "$(guard main "$h")" = reject ] && ok || bad "null head_ref not rejected"
  [ "$(guard '' main)" = reject ] && ok || bad "empty ref not rejected"
}
test_e5_every_remediate_fence_rederives_refs() {
  [ "$n" -eq 0 ] && ok || bad "$n remediate fence(s) lack the guard"
}
test_e1_ref_read_as_data_never_executes; test_e2_legitimate_refs_pass_guard; test_e3_leading_dash_ref_rejected
test_e4_null_or_empty_ref_rejected; test_e6_close_and_remediate_do_not_forward_or_assign_raw_base; test_e7_park_fence_aborts_merge_before_ref_guard; test_e5_every_remediate_fence_rederives_refs

echo "spec-raw-ref-subst tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
