#!/usr/bin/env bash
# review-pr-delta-wiring.test.sh — wiring tests for the review-delta modes in commands/review-pr.md (forge#3637).
# Extracts the real spec fences (Phase 3C review mode, carry record, Phase 4 panel guard, Phase 6A finding read) and runs
# them against temp git repos, synthetic PR comments, a stubbed `gh` and the REAL scripts/review-delta.sh and
# scripts/trusted-comments.sh. No network. Covers: DELTA roster and the 2-round cap, BASE_SYNC_ONLY zero dispatch, a forged
# or untrusted carry record failing closed, resolver resolution from FORGE_ROOT (never the worktree), FULL fallbacks.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/commands/review-pr.md"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-pr-delta-wiring.test.sh: jq missing, skipped"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "review-pr-delta-wiring.test.sh: git missing, skipped"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
g() { git -C "$W" -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
commit() { mkdir -p "$W/$(dirname "$1")"; printf '%s\n' "$2" > "$W/$1"; g add -A >/dev/null; g commit -q -m "$3" >/dev/null; }
CASE=0
mkrepo() {
  CASE=$((CASE+1)); local o="$TMP/o$CASE"; W="$TMP/w$CASE"
  git init -q --bare -b main "$o"; git clone -q "$o" "$W" 2>/dev/null
  g checkout -q -b main 2>/dev/null; commit a.txt base base; g push -q origin main
  g checkout -q -b feat; commit pr.txt pr1 pr1
}
sha() { g rev-parse "$1"; }
base_merge() { g checkout -q main; commit "$1" "$2" "base $1"; g push -q origin main; g checkout -q feat; g fetch -q origin; g merge -q --no-ff -m "merge main" origin/main >/dev/null 2>&1; }

# ---- spec extraction -----------------------------------------------------------------------------------------------
# fence_with <fixed string>: print the first ```bash fence of the spec that contains the string
fence_with() {
  awk -v pat="$1" '
    /^```bash$/ { inb=1; buf=""; next }
    /^```$/ && inb { inb=0; if (index(buf, pat)) { printf "%s", buf; exit } ; next }
    inb { buf = buf $0 "\n" }' "$SPEC"
}
# marked_block <name>: the text between "# BEGIN <name>" and "# END <name>" (first copy)
marked_block() { awk -v b="# BEGIN $1" -v e="# END $1" '$0==b {on=1} on {print} $0==e {exit}' "$SPEC"; }
count_blocks() { grep -c "^# BEGIN $1\$" "$SPEC"; }

# ---- stubbed gh ----------------------------------------------------------------------------------------------------
STUB="$TMP/stub"; mkdir -p "$STUB"
cat > "$STUB/gh" <<'EOS'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"--json labels"*) printf '%s\n' "${FAKE_LABELS:-}" ;;
  *"--json baseRefName"*) printf 'main\n' ;;
  *"--json headRefOid"*) printf '%s\n' "$FAKE_HEAD" ;;
  api*"/comments"*) cat "$FAKE_COMMENTS" ;;
  *"pr comment"*) printf '%s\n' "$args" >> "${FAKE_POSTED:-/dev/null}"
                  [ -n "${FAKE_POST_APPENDS:-}" ] && cat "$FAKE_POST_APPENDS" > "$FAKE_COMMENTS" ;;
  *) : ;;
esac
exit 0
EOS
chmod +x "$STUB/gh"
export FAKE_COMMENTS="$TMP/comments.json"
mkdir -p "$TMP/home"

# ---- comment fixtures ----------------------------------------------------------------------------------------------
body_agent() { printf '<!-- FORGE:REVIEW-AGENT:%s -->\nReviewed-SHA: %s\n\n<!-- REVIEW-FINDINGS-START -->\n<!-- FINDING:%s -->\nbody\n<!-- REVIEW-FINDINGS-END -->' "$1" "$2" "${3:-none}"; }
body_synth() { printf '<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\nReviewed-SHA: %s\n\n<!-- FINDING:%s -->\nsynth' "$1" "${2:-none}"; }
body_carry() { printf '<!-- FORGE:REVIEW-CARRIED -->\nReviewed-SHA: %s\nCarried-From-SHA: %s\n\ncarried' "$1" "$2"; }
cm() { jq -n --arg b "$1" --arg t "${2:-Bot}" --arg a "${3:-NONE}" '{"body":$b,"author_association":$a,"user":{"type":$t,"login":"x"}}'; }
comments() { printf '%s\n' "$@" | jq -s '.' > "$FAKE_COMMENTS"; }
panel_items() { # sha [finding-id] -> two comment objects (agent + synthesized), trusted by association
  cm "$(body_agent security "$1" "${2:-none}")" User MEMBER; cm "$(body_synth "$1" "${2:-none}")" User MEMBER
}

# run_fence <name> <file> [extra env assignments...]: run an extracted fence in $W with the stub gh and the real FORGE_ROOT
run_fence() {
  local f="$1"; shift
  (cd "$W" && env PATH="$STUB:$PATH" HOME="$TMP/home" FORGE_ROOT="$ROOT" CLAUDE_CONFIG_DIR="" XDG_RUNTIME_DIR="$TMP/run" \
     FAKE_HEAD="$HEAD" "$@" bash "$f" 2>&1)
}
subst() { # file: fill the orchestrator placeholders ({NAME}, never the shell expansion ${NAME})
  sed -e "s|\([^\$]\){GH_REPO}|\1o/r|g" -e "s|\([^\$]\){PR_NUMBER}|\11|g" -e "s|\([^\$]\){REVIEW_SHA}|\1$HEAD|g" \
      -e "s|\([^\$]\){SELECTED_AGENTS}|\1${SEL-security auth billing}|g" -e "s|\([^\$]\){REVIEW_MODE}|\1${MODE:-FULL}|g" \
      -e "s|\([^\$]\){DELTA_FROM}|\1${DFROM:-}|g" -e "s|\([^\$]\){DISPATCH_TOOL}|\1Task|g" \
      -e "s|\([^\$]\){THOROUGH}|\1${THOROUGH:-false}|g" -e "s|\([^\$]\){IS_MILESTONE_TO_STAGING}|\1false|g" "$1"
}
mkdir -p "$TMP/run"; chmod 700 "$TMP/run"

fence_file() { # name pattern -> $TMP/<name>.sh (placeholders filled)
  fence_with "$2" > "$TMP/$1.raw"; [ -s "$TMP/$1.raw" ] || { bad "fence '$2' not found in the spec"; return 1; }
  subst "$TMP/$1.raw" > "$TMP/$1.sh"
}

# ---- 0. structure ---------------------------------------------------------------------------------------------------
n=$(count_blocks review-pr-delta-mode)
[ "$n" -ge 6 ] && ok || bad "expected the review-delta mode snippet in every consuming fence (3C mode, carry post, Phase 4, 5, 6A, 9), found $n"
distinct=$(awk '/^# BEGIN review-pr-delta-mode$/ {on=1; buf=""} on {buf = buf $0 "\n"} /^# END review-pr-delta-mode$/ && on {on=0; print buf "\0"}' "$SPEC" | tr -d '\n' | sed 's/\x0/\n/g' | sort -u | grep -c . || true)
[ "$distinct" = 1 ] && ok || bad "review-delta mode snippet copies differ ($distinct distinct)"
grep -qF 'scripts/review-delta.sh' "$SPEC" && ok || bad "spec does not name scripts/review-delta.sh"

# ---- 1. resolver block: trusted install only -------------------------------------------------------------------------
mkrepo; HEAD=$(sha HEAD)
awk '/^[ ]*# HELPER_SCRIPT resolver \(/ && index($0, "(REVIEW_DELTA_SCRIPT;") {inb=1} inb {print} inb && /^done <<< "\$_tc"$/ {exit}' "$SPEC" > "$TMP/rd_resolver.sh"
[ -s "$TMP/rd_resolver.sh" ] && ok || bad "no canonical REVIEW_DELTA_SCRIPT resolver block in the spec"
mkdir -p "$W/scripts"; printf '#!/usr/bin/env bash\necho "BASE_SYNC_ONLY %s"\necho FULL_ROUNDS=9\n' "$HEAD" > "$W/scripts/review-delta.sh"
got=$(cd "$W" && HOME="$TMP/home" FORGE_ROOT="$ROOT" CLAUDE_CONFIG_DIR="" bash -c "$(cat "$TMP/rd_resolver.sh"); printf %s \"\$REVIEW_DELTA_SCRIPT\"")
[ "$got" = "$ROOT/scripts/review-delta.sh" ] && ok || bad "resolver must pick the FORGE_ROOT script, never the worktree copy (got '$got')"
got=$(cd "$W" && HOME="$TMP/nohome" FORGE_ROOT="" FORGEDOCK_HOME="" FORGE_HOME="" CLAUDE_CONFIG_DIR="" bash -c "$(cat "$TMP/rd_resolver.sh"); printf %s \"\$REVIEW_DELTA_SCRIPT\"")
[ -z "$got" ] && ok || bad "with no trusted install the resolver must stay empty, not fall back to the worktree (got '$got')"
rm -f "$W/scripts/review-delta.sh"

# ---- 2. delta_roster ------------------------------------------------------------------------------------------------
marked_block review-pr-delta-roster > "$TMP/roster.sh"
[ -s "$TMP/roster.sh" ] && ok || bad "delta roster block missing"
roster() { bash -c "source '$TMP/roster.sh'; delta_roster \"\$@\"" _ "$@"; }
expect() { [ "$2" = "$3" ] && ok || bad "$1: want '$2', got '$3'"; }
expect "round 0/1 keeps the 3B roster" "security auth billing" "$(roster 1 'security auth billing' 'README.md')"
expect "no rounds data keeps the 3B roster" "security auth" "$(roster '' 'security auth' 'README.md')"
expect "round 2 narrows to security by default" "security" "$(roster 2 'security auth billing' 'README.md')"
expect "round 2 adds a path-triggered domain" "security auth" "$(roster 2 'security auth billing' $'README.md\nsrc/auth/login.py')"
expect "round 3 cap holds" "security" "$(roster 3 'security auth billing database' 'docs/notes.txt')"
expect "claim/lease paths trigger concurrency" "security concurrency" "$(roster 2 'security' 'engine/claim-lease.txt')"
export REPO_PATH="$ROOT"   # ForgeDock itself: the persona file exists
expect "commands/** triggers spec-cli" "security spec-cli" "$(roster 2 'security' 'commands/foo.md')"
expect "bin/** triggers spec-cli" "security spec-cli" "$(roster 2 'security' 'bin/foo.mjs')"
# consumer repo layout: no persona file, so no spec-cli
mkdir -p "$TMP/consumer/bin" "$TMP/consumer/commands"
export REPO_PATH="$TMP/consumer"
expect "consumer bin/ gets no spec-cli" "security" "$(roster 2 'security' 'bin/foo.mjs')"
expect "consumer commands/ gets no spec-cli" "security" "$(roster 2 'security' 'commands/foo.md')"
expect "consumer with another trigger keeps it, no spec-cli" "security auth" "$(roster 2 'security' $'bin/foo.mjs\nsrc/auth/login.py')"
unset REPO_PATH
expect "non-numeric rounds fail to the 3B roster" "security auth" "$(roster 'x' 'security auth' 'README.md')"

# ---- 3. mode resolution through the real fence ----------------------------------------------------------------------
# 3a. no checkpoint -> FULL
mkrepo; R=$(sha HEAD); commit pr.txt pr2 pr2; HEAD=$(sha HEAD)
comments "$(cm 'hello' User MEMBER)"
SEL="security auth billing"; MODE=FULL
fence_file mode "REVIEW_MODE: \${REVIEW_MODE}" || exit 1
run_mode() { subst "$TMP/mode.raw" > "$TMP/mode.sh"; run_fence "$TMP/mode.sh"; }
out=$(run_mode)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: FULL' && ok || bad "no checkpoint must be FULL: $out"
printf '%s\n' "$out" | grep -qx 'SELECTED_AGENTS: security auth billing' && ok || bad "FULL keeps the 3B roster: $out"

# 3b. one proven panel + a regular commit -> DELTA, roster unchanged below the cap
{ panel_items "$R"; } | jq -s '.' > "$FAKE_COMMENTS"
out=$(run_mode)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: DELTA' && ok || bad "one panel then a commit must be DELTA: $out"
printf '%s\n' "$out" | grep -qx "DELTA_FROM: $R" && ok || bad "DELTA_FROM must be the reviewed SHA: $out"
printf '%s\n' "$out" | grep -qx 'SELECTED_AGENTS: security auth billing' && ok || bad "FULL_ROUNDS<2 keeps the 3B roster under DELTA: $out"

# 3c. two proven panels -> cap: delta + security only
mkrepo; R1=$(sha HEAD); commit pr.txt pr2 pr2; R2=$(sha HEAD); commit src/auth/login.py x "auth change"; HEAD=$(sha HEAD)
{ panel_items "$R1"; panel_items "$R2"; } | jq -s '.' > "$FAKE_COMMENTS"
out=$(run_mode)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: DELTA' && ok || bad "two panels then a commit must be DELTA: $out"
printf '%s\n' "$out" | grep -qx 'FULL_ROUNDS: 2' && ok || bad "FULL_ROUNDS must be 2: $out"
printf '%s\n' "$out" | grep -qx 'SELECTED_AGENTS: security auth' && ok || bad "round 3 roster must be security + path-triggered auth: $out"
mkrepo; R1=$(sha HEAD); commit pr.txt pr2 pr2; R2=$(sha HEAD); commit notes.txt x "notes"; HEAD=$(sha HEAD)
{ panel_items "$R1"; panel_items "$R2"; } | jq -s '.' > "$FAKE_COMMENTS"
out=$(run_mode)
printf '%s\n' "$out" | grep -qx 'SELECTED_AGENTS: security' && ok || bad "round 3 with no triggered path must be security only: $out"

# 3d. THOROUGH forces FULL
out=$(THOROUGH=true run_mode)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: FULL' && ok || bad "--thorough must stay FULL: $out"

# 3e. a planted worktree resolver must not decide the mode
mkdir -p "$W/scripts"; printf '#!/usr/bin/env bash\necho "BASE_SYNC_ONLY %s"\necho FULL_ROUNDS=1\n' "$R2" > "$W/scripts/review-delta.sh"
out=$(run_mode)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: DELTA' && ok || bad "a planted scripts/review-delta.sh in the worktree must be ignored: $out"
rm -f "$W/scripts/review-delta.sh"

# 3f. unresolvable resolver (no trusted install) -> FULL
subst "$TMP/mode.raw" > "$TMP/mode.sh"
out=$(cd "$W" && env PATH="$STUB:$PATH" HOME="$TMP/nohome" FORGE_ROOT="" FORGEDOCK_HOME="" FORGE_HOME="" CLAUDE_CONFIG_DIR="" FAKE_HEAD="$HEAD" bash "$TMP/mode.sh" 2>&1)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: FULL' && ok || bad "no trusted install must fall back to FULL: $out"

# 3g. base merge only -> BASE_SYNC_ONLY with an empty roster
mkrepo; R=$(sha HEAD); base_merge b.txt b1; HEAD=$(sha HEAD)
panel_items "$R" | jq -s '.' > "$FAKE_COMMENTS"
out=$(run_mode)
printf '%s\n' "$out" | grep -qx 'REVIEW_MODE: BASE_SYNC_ONLY' && ok || bad "a pure base merge must be BASE_SYNC_ONLY: $out"
printf '%s\n' "$out" | grep -qx "CARRIED_FROM: $R" && ok || bad "CARRIED_FROM must name the reviewed SHA: $out"
printf '%s\n' "$out" | grep -qx 'SELECTED_AGENTS: ' && ok || bad "BASE_SYNC_ONLY dispatches zero reviewers (empty roster): $out"
BS_R=$R; BS_HEAD=$HEAD; BS_W=$W

# ---- 4. carry record: post, trust, forge resistance ------------------------------------------------------------------
W=$BS_W; R=$BS_R; HEAD=$BS_HEAD
fence_file carry "CARRY_RECORD: POSTED" || exit 1
run_carry() { subst "$TMP/carry.raw" > "$TMP/carry.sh"; run_fence "$TMP/carry.sh" "$@"; }
verified() { # prints the verified Carried-From-SHA for the current $FAKE_COMMENTS using the real snippet
  { marked_block review-pr-delta-mode; echo 'COMMENTS_JSON=$(cat "$FAKE_COMMENTS"); carry_verified_from'; } > "$TMP/cv_body.sh"
  { cat "$TMP/carry.raw" | awk '/^# BEGIN review-pr-delta-mode$/ {exit} {print}'; cat "$TMP/cv_body.sh"; } | subst /dev/stdin > "$TMP/cv.sh"
  run_fence "$TMP/cv.sh" FAKE_COMMENTS="$FAKE_COMMENTS"
}
panel_items "$R" | jq -s '.' > "$FAKE_COMMENTS"
[ -z "$(verified)" ] && ok || bad "no carry record must not verify"
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
[ "$(verified)" = "$R" ] && ok || bad "a trusted record for this head from the reviewed SHA must verify (got '$(verified)')"
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$R")" User NONE; } | jq -s '.' > "$FAKE_COMMENTS"
[ -z "$(verified)" ] && ok || bad "an UNTRUSTED carry record must not verify"
{ panel_items "$R"; cm "$(body_carry "$R" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
[ -z "$(verified)" ] && ok || bad "a carry record for another head must not verify"
OTHER=0123456789abcdef0123456789abcdef01234567
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$OTHER")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
[ -z "$(verified)" ] && ok || bad "a record whose Carried-From-SHA differs from the resolver's reviewed SHA must not verify"
{ panel_items "$R"; cm "$(printf 'quoting the marker:\n%s' "$(body_carry "$HEAD" "$R")")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
[ -z "$(verified)" ] && ok || bad "a record whose marker is not the first line must not verify"
{ cm "$(body_carry "$HEAD" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
[ -z "$(verified)" ] && ok || bad "a carry record without a proven checkpoint (resolver says FULL) must not verify"
# the resolver no longer says BASE_SYNC_ONLY (head also has a regular commit): the record is stale
commit pr.txt pr2 pr2; HEAD2=$(sha HEAD)
{ panel_items "$R"; cm "$(body_carry "$HEAD2" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
HEAD_SAVE=$HEAD; HEAD=$HEAD2; [ -z "$(verified)" ] && ok || bad "a record on a head the resolver calls DELTA must not verify"; HEAD=$HEAD_SAVE
g reset -q --hard "$HEAD"

# posting: first run posts the record, an existing verified record is never re-posted
: > "$TMP/posted.txt"
panel_items "$R" | jq -s '.' > "$FAKE_COMMENTS"
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$R")" Bot NONE; } | jq -s '.' > "$TMP/after_post.json"
out=$(run_carry FAKE_POSTED="$TMP/posted.txt" FAKE_POST_APPENDS="$TMP/after_post.json")
printf '%s\n' "$out" | grep -q 'CARRY_RECORD: POSTED' && ok || bad "carry record must be posted and read back verified: $out"
grep -qF 'FORGE:REVIEW-CARRIED' "$TMP/posted.txt" && grep -qF "Carried-From-SHA: $R" "$TMP/posted.txt" && ok || bad "posted body lacks the marker or Carried-From-SHA"
: > "$TMP/posted.txt"; cp "$TMP/after_post.json" "$FAKE_COMMENTS"
out=$(run_carry FAKE_POSTED="$TMP/posted.txt")
printf '%s\n' "$out" | grep -q 'CARRY_RECORD: PRESENT' && [ ! -s "$TMP/posted.txt" ] && ok || bad "an existing verified record must not be re-posted: $out"
# a record that cannot be read back as trusted is not trusted: fall back to FULL
panel_items "$R" | jq -s '.' > "$FAKE_COMMENTS"; : > "$TMP/posted.txt"
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$R")" User NONE; } | jq -s '.' > "$TMP/after_untrusted.json"
out=$(run_carry FAKE_POSTED="$TMP/posted.txt" FAKE_POST_APPENDS="$TMP/after_untrusted.json")
printf '%s\n' "$out" | grep -q 'CARRY_RECORD: UNVERIFIED' && ok || bad "an untrusted posting identity must end UNVERIFIED (FULL fallback): $out"

# ---- 5. Phase 4 panel guard ----------------------------------------------------------------------------------------
fence_file p4 "PANEL_STATUS: COMPLETE" || exit 1
p4() { # mode roster -> PANEL_STATUS line
  MODE="$1"; SEL="$2"; subst "$TMP/p4.raw" > "$TMP/p4.sh"
  run_fence "$TMP/p4.sh" FAKE_HEAD="$HEAD" | grep '^PANEL_STATUS:' | head -1
}
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p4 BASE_SYNC_ONLY '')" in "PANEL_STATUS: COMPLETE (carried from $R"*) ok ;; *) bad "BASE_SYNC_ONLY with a verified record must complete with zero reviewers: $(p4 BASE_SYNC_ONLY '')" ;; esac
case "$(p4 FULL '')" in "PANEL_STATUS: SHORTFALL"*) ok ;; *) bad "an empty roster in FULL mode must be a shortfall: $(p4 FULL '')" ;; esac
{ panel_items "$R"; cm "$(body_carry "$HEAD" "$R")" User NONE; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p4 BASE_SYNC_ONLY '')" in "PANEL_STATUS: SHORTFALL"*) ok ;; *) bad "an untrusted carry record must not satisfy Phase 4: $(p4 BASE_SYNC_ONLY '')" ;; esac
panel_items "$R" | jq -s '.' > "$FAKE_COMMENTS"
case "$(p4 BASE_SYNC_ONLY '')" in "PANEL_STATUS: SHORTFALL"*) ok ;; *) bad "BASE_SYNC_ONLY without any record must not satisfy Phase 4: $(p4 BASE_SYNC_ONLY '')" ;; esac
# a carry record never replaces reviewers on FULL / DELTA heads
{ cm "$(body_carry "$HEAD" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p4 FULL 'security auth')" in "PANEL_STATUS: SHORTFALL"*) ok ;; *) bad "a carry record must not stand in for the FULL roster: $(p4 FULL 'security auth')" ;; esac
# panel integrity unchanged for FULL: every selected reviewer needs a trusted current-SHA marker
{ cm "$(body_agent security "$HEAD")" User MEMBER; cm "$(body_agent auth "$HEAD")" User MEMBER; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p4 FULL 'security auth')" in "PANEL_STATUS: COMPLETE (2/2)") ok ;; *) bad "FULL panel with every marker must complete: $(p4 FULL 'security auth')" ;; esac
case "$(p4 DELTA 'security auth billing')" in "PANEL_STATUS: SHORTFALL"*) ok ;; *) bad "DELTA keeps panel integrity (billing never posted): $(p4 DELTA 'security auth billing')" ;; esac
{ cm "$(body_agent security "$HEAD")" User NONE; cm "$(body_agent auth "$HEAD")" User NONE; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p4 FULL 'security auth')" in "PANEL_STATUS: SHORTFALL"*) ok ;; *) bad "untrusted reviewer markers must not satisfy the panel: $(p4 FULL 'security auth')" ;; esac

# ---- 6. Phase 6A reads the carried / earlier head's findings -------------------------------------------------------
fence_file p6 'bodies_at()' || exit 1
p6() { # mode dfrom -> FINDINGS or the BLOCKED line
  MODE="$1"; DFROM="${2:-}"; subst "$TMP/p6.raw" > "$TMP/p6.sh"; printf '\necho "FINDINGS=$(printf %%s "$FINDINGS" | tr "\\n" " ")"\n' >> "$TMP/p6.sh"
  run_fence "$TMP/p6.sh" | grep -E '^(FINDINGS=|REVIEW_RESULT:)' | head -1
}
{ panel_items "$R" F-old; cm "$(body_carry "$HEAD" "$R")" Bot NONE; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p6 BASE_SYNC_ONLY)" in *F-old*) ok ;; *) bad "BASE_SYNC_ONLY must read the carried head's findings: $(p6 BASE_SYNC_ONLY)" ;; esac
{ panel_items "$R" F-old; cm "$(body_carry "$HEAD" "$R")" User NONE; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p6 BASE_SYNC_ONLY)" in REVIEW_RESULT:*BLOCKED*) ok ;; *) bad "an unverified carry must block reading findings (fail closed): $(p6 BASE_SYNC_ONLY)" ;; esac
case "$(p6 FULL)" in REVIEW_RESULT:*BLOCKED*) ok ;; *) bad "FULL reads only current-head bodies; none posted must block: $(p6 FULL)" ;; esac
{ panel_items "$R" F-old; panel_items "$HEAD" F-new; } | jq -s '.' > "$FAKE_COMMENTS"
case "$(p6 FULL)" in *F-new*) case "$(p6 FULL)" in *F-old*) bad "FULL must not read earlier-head findings" ;; *) ok ;; esac ;; *) bad "FULL must read current-head findings" ;; esac
case "$(p6 DELTA "$R")" in *F-new*F-old*|*F-old*F-new*) ok ;; *) bad "DELTA must read the current and the earlier reviewed head's findings: $(p6 DELTA "$R")" ;; esac

echo "review-pr-delta-wiring tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
