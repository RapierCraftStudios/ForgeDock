#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fixtures for lint-dispatch-prompt.sh (forge#3062). Run: bash scripts/lint-dispatch-prompt.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LINT="$HERE/lint-dispatch-prompt.sh"
SPEC="$HERE/../commands/orchestrate/phase-4-execution.md"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAILN=0
check() { # name expected_rc file
  bash "$LINT" "$3" >"$T/out" 2>&1; rc=$?
  if [ "$rc" -eq "$2" ]; then PASS=$((PASS+1)); else FAILN=$((FAILN+1)); echo "FAIL: $1 (rc=$rc want $2)"; cat "$T/out"; fi
}

# Extract the real Step 4A template (stops at the first bare ")" line; inner ```bash fences are kept).
awk '/Copy this template. Fill in variables/{f=1} f&&/^Agent\($/{g=1} g{print} g&&/^\)$/{exit}' "$SPEC" > "$T/tpl"
[ -s "$T/tpl" ] || { echo "FAIL: could not extract 4A template"; exit 1; }
sed -e '/^Agent($/d' -e '/^  subagent_type/d;/^  model=/d;/^  description=/d;/^  run_in_background/d' \
    -e 's/^  prompt="//' -e '/^)$/d' "$T/tpl" > "$T/base"
sed -i -e '$ { /^"$/ d }' "$T/base"
sed -i -e '/^{GIST_CONTEXT}$/d' -e '/^{SOURCE_PR_HINT_CONTEXT}$/d' -e '/DISPATCH_CONTEXT:END/d' "$T/base"
sed -i -e '/DISPATCH_CONTEXT:BEGIN/d' "$T/base"

render() { # context-body-file -> prompt
  cat "$T/base"; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; cat "$1" 2>/dev/null; echo '<!-- DISPATCH_CONTEXT:END -->'
}
: > "$T/empty"

# 1. Verbatim template, no context: PASS
render "$T/empty" > "$T/p1"; check "verbatim template" 0 "$T/p1"

# 2. Legitimate context: claims board, same-file brief (what changed), source-PR hint, gist context
cat > "$T/ctx_ok" <<'X'
**RECONCILED CONTEXT (orchestrate Phase 2.5 synthesis brief)**: use this as cross-investigation context.
**SAME-FILE STATE BRIEF**: PR #34100 changed `app/billing.py` (renamed `refund()` to `refund_intent()`); it is merged to staging.
Claims board issue URL: https://github.com/o/r/issues/1
**SOURCE PR HINT**: source PR #5 merged; triage hint: likely-moot candidate, agent must verify itself.
X
render "$T/ctx_ok" > "$T/p2"; check "legit context blocks" 0 "$T/p2"

# 3. The #34180-style brief: pre-written diagnosis and fix design inside context -> FAIL
cat > "$T/ctx_bad" <<'X'
The fix is to make the fraud branch terminal: refund, release promo, cancel intent, return.
X
render "$T/ctx_bad" > "$T/p3"; check "pre-written fix design in context" 1 "$T/p3"

# 4. LIKELY ALREADY RESOLVED instruction -> FAIL
printf 'LIKELY ALREADY RESOLVED — verify and close.\n' > "$T/ctx_moot"
render "$T/ctx_moot" > "$T/p4"; check "likely already resolved" 1 "$T/p4"

# 5. Custom brief appended after the context block -> FAIL
{ render "$T/empty"; echo 'Diagnosis: the root cause is a missing return in handle_fraud().'; } > "$T/p5"; check "custom text after block" 1 "$T/p5"

# 6. Free-text resume prompt -> FAIL (missing anchors)
echo "Resume #3062 — continue from where you left off and finish the uncommitted work." > "$T/p6"; check "free-text resume prompt" 1 "$T/p6"

# 7. Custom text injected into the template body -> FAIL
{ sed '0,/^\*\*LANE\*\*/s//Root cause: handle_fraud never returns.\n**LANE**/' "$T/base"; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; echo '<!-- DISPATCH_CONTEXT:END -->'; } > "$T/p7"; check "injected root-cause line in template" 1 "$T/p7"

# 8. Text between title and context block -> FAIL
{ cat "$T/base"; echo 'Just read and edit the file.'; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; echo '<!-- DISPATCH_CONTEXT:END -->'; } > "$T/p8"; check "text between title and block" 1 "$T/p8"

# 9. Unreadable / empty input -> rc 2
bash "$LINT" "$T/does-not-exist" >/dev/null 2>&1; [ $? -eq 2 ] && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: missing file rc"; }

# 11. Large prompt (>1MB) must not SIGPIPE-fail the anchor checks (forge#3071)
{ cat "$T/base"; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; for _ in $(seq 1 30000); do echo 'Claims board entry: issue 1 holds file scripts/example.sh for the current batch run.'; done; echo '<!-- DISPATCH_CONTEXT:END -->'; } > "$T/p11"; check "large prompt passes" 0 "$T/p11"

# 12. Context quoting a prior investigation ("the root cause is ...") is legitimate -> PASS
printf 'Prior investigation excerpt: "the root cause is a stale cache; the fix is described in #12".\n' > "$T/ctx_quote"
render "$T/ctx_quote" > "$T/p12"; check "quoted investigation in context" 0 "$T/p12"

# 13. Trailing quote/paren-only junk after the block is not silently ignored -> FAIL
{ render "$T/empty"; echo '")'; } > "$T/p13"; check "trailing paren junk after block" 1 "$T/p13"

# 14. Directive on the Issue title line must not be exempt (forge#3072) -> FAIL
{ sed 's/^\*\*Issue title\*\*:.*/**Issue title**: fix X (likely already resolved - verify and close)/' "$T/base"; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; echo '<!-- DISPATCH_CONTEXT:END -->'; } > "$T/p14"; check "directive in title line" 1 "$T/p14"

# 15. Rephrased custom line inside the template body evades the denylist but not the allowlist -> FAIL
{ sed '0,/^\*\*LANE\*\*/s//Please begin by editing handle_fraud to return early.\n**LANE**/' "$T/base"; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; echo '<!-- DISPATCH_CONTEXT:END -->'; } > "$T/p15"; check "rephrased line not in template" 1 "$T/p15"

# 16. Placeholders substituted with real values still PASS
{ sed -e 's/{NUMBER}/3072/g' -e 's/{PROJECT_NAME}/ForgeDock/g' -e 's/{ISSUE_TITLE}/fix(scripts): a normal title/' "$T/base"; echo '<!-- DISPATCH_CONTEXT:BEGIN -->'; echo '<!-- DISPATCH_CONTEXT:END -->'; } > "$T/p16"; check "substituted template" 0 "$T/p16"

# 10. Spec snippet enforcement (forge#3070): extract the lint gate from the spec and run it in a loop.
awk '/^LINT_SCRIPT=/{f=1} f{print} f&&/^fi$/{n++} f&&n==2{exit}' "$SPEC" > "$T/gate"
[ -s "$T/gate" ] || { FAILN=$((FAILN+1)); echo "FAIL: could not extract spec lint gate"; }
gate_refused() { # prompt-file home -> prints refusal entries or LAUNCHED
  ( LINT_REFUSED_ISSUES=(); RENDERED_PROMPT="$(cat "$1")"; FORGEDOCK_HOME="$2"; unset FORGE_HOME; REPO_PATH=/nonexistent
    for _i in 1; do
      eval "$(sed 's/{NUMBER}/42/g' "$T/gate")"
      echo LAUNCHED; exit 0
    done
    echo "REFUSED ${LINT_REFUSED_ISSUES[*]}" ) 2>"$T/gate_err" | tail -1
}
expect() { [ "$2" = "$3" ] && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: $1 (got '$3' want '$2')"; }; }
expect "gate launches clean prompt" "LAUNCHED" "$(gate_refused "$T/p1" "$HERE/..")"
expect "gate refuses lint failure" "REFUSED 42:lint-rc-1" "$(gate_refused "$T/p3" "$HERE/..")"
expect "gate fails closed when script missing" "REFUSED 42:lint-script-not-found" "$(gate_refused "$T/p1" "$T/nowhere")"
grep -q 'lint script not found' "$T/gate_err" && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: missing-script message not distinct"; }
# Exemption is stated in the spec so the scope matches the script.
grep -q 'Exempt (not Step 4A-template prompts' "$SPEC" && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: spec exemption missing"; }

echo "lint-dispatch-prompt tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
