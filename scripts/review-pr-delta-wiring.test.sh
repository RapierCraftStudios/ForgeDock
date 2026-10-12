#!/usr/bin/env bash
# review-pr-delta-wiring.test.sh — wiring tests for the review-delta modes in commands/review-pr.md (forge#3637).
# Extracts the real spec fences (the 3C pre-dispatch carry record, the Phase 4 panel guard) and the delta_roster function of
# scripts/review-prepare.sh (which owns the 3C review-mode decision and the 6A finding read moved to review-finalize.sh extract;
# scripts/review-prepare.test.sh and scripts/review-finalize.test.sh cover those) and runs them against temp git repos,
# synthetic PR comments, a stubbed `gh` and the REAL scripts/review-delta.sh and scripts/trusted-comments.sh. No network.
# Covers: the DELTA roster and the 2-round cap, BASE_SYNC_ONLY zero dispatch, a forged or untrusted carry record failing
# closed, resolver resolution from FORGE_ROOT (never the worktree), FULL fallbacks.
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
# The mode functions live in ONE sourced helper (scripts/lib/review-delta-mode.sh); every consuming fence sources it through forge_resolve
# with a FULL-only fallback, so an unresolved helper can only mean a full review.
HELPER="$ROOT/scripts/lib/review-delta-mode.sh"
[ -f "$HELPER" ] && ok || bad "scripts/lib/review-delta-mode.sh must exist"
n=$(grep -c '^_dm=$(forge_resolve lib/review-delta-mode.sh)' "$SPEC")
[ "$n" -ge 2 ] && ok || bad "expected the review-delta helper source line in every consuming fence (3C pre-dispatch, Phase 4; the mode decision lives in scripts/review-prepare.sh, the 6A read and Phase 9 in scripts/review-finalize.sh), found $n"
for sc in review-prepare review-finalize; do
  grep -q 'forge_resolve lib/review-delta-mode.sh' "$ROOT/scripts/$sc.sh" && grep -q 'review_delta_mode() { echo "FULL - 0"; }' "$ROOT/scripts/$sc.sh" && ok || bad "scripts/$sc.sh must source the helper through forge_resolve with a FULL-only fallback"
done
distinct=$(grep '^_dm=$(forge_resolve lib/review-delta-mode.sh)' "$SPEC" | sort -u | grep -c . || true)
[ "$distinct" = 1 ] && ok || bad "review-delta helper source lines differ ($distinct distinct)"
[ "$(count_blocks review-pr-delta-mode)" = 0 ] && ok || bad "inline review-delta mode copies must not remain in the spec"
grep -q '^_dm=.*review_delta_mode() { echo "FULL - 0"; }' "$SPEC" && ok || bad "the helper source line must carry a FULL-only fallback"
# every source line is preceded by a locator in the same fence (a fresh shell has no forge_resolve)
miss=$(awk '/^```/{loc=0} /^type forge_resolve >\/dev\/null/{loc=1} /^_dm=\$\(forge_resolve lib\/review-delta-mode.sh\)/&&!loc{b++} END{print b+0}' "$SPEC")
[ "$miss" = 0 ] && ok || bad "$miss helper source line(s) lack a forge_resolve locator in the same fence"
# unresolved helper: the fallback answers FULL and carries nothing
fb=$(grep -m1 '^_dm=.*review_delta_mode() { echo "FULL - 0"; }' "$SPEC")
got=$(bash -c "forge_resolve() { :; }; $fb; review_delta_mode; printf 'carry=[%s]' \"\$(carry_verified_from)\"")
[ "$got" = "FULL - 0
carry=[]" ] && ok || bad "an unresolved helper must fall back to FULL (got '$got')"
# resolved helper: the real functions load
got=$(bash -c "forge_resolve() { echo '$HELPER'; }; $fb; type -t is_sha")
[ "$got" = "function" ] && ok || bad "a resolved helper must define the mode functions (got '$got')"
grep -qF 'scripts/review-delta.sh' "$SPEC" && ok || bad "spec does not name scripts/review-delta.sh"

# ---- 1. resolver block: trusted install only -------------------------------------------------------------------------
mkrepo; HEAD=$(sha HEAD)
fence_with 'REVIEW_DELTA_SCRIPT=$(forge_resolve review-delta.sh)' | grep -E '^type forge_resolve >/dev/null|^REVIEW_DELTA_SCRIPT=\$\(forge_resolve ' > "$TMP/rd_resolver.sh"
[ -s "$TMP/rd_resolver.sh" ] && ok || bad "no canonical REVIEW_DELTA_SCRIPT resolver block in the spec"
mkdir -p "$W/scripts"; printf '#!/usr/bin/env bash\necho "BASE_SYNC_ONLY %s"\necho FULL_ROUNDS=9\n' "$HEAD" > "$W/scripts/review-delta.sh"
got=$(cd "$W" && HOME="$TMP/home" FORGE_ROOT="$ROOT" CLAUDE_CONFIG_DIR="" bash -c "$(cat "$TMP/rd_resolver.sh"); printf %s \"\$REVIEW_DELTA_SCRIPT\"")
[ "$got" = "$ROOT/scripts/review-delta.sh" ] && ok || bad "resolver must pick the FORGE_ROOT script, never the worktree copy (got '$got')"
got=$(cd "$W" && HOME="$TMP/nohome" FORGE_ROOT="" FORGEDOCK_HOME="" FORGE_HOME="" CLAUDE_CONFIG_DIR="" bash -c "$(cat "$TMP/rd_resolver.sh"); printf %s \"\$REVIEW_DELTA_SCRIPT\"")
[ -z "$got" ] && ok || bad "with no trusted install the resolver must stay empty, not fall back to the worktree (got '$got')"
rm -f "$W/scripts/review-delta.sh"

# ---- 2. delta_roster ------------------------------------------------------------------------------------------------
# delta_roster lives in scripts/review-prepare.sh (the 3C review-mode decision moved there): extract the real function.
awk '/^delta_roster\(\) \{/ {on=1} on {print} on && /^\}$/ {exit}' "$ROOT/scripts/review-prepare.sh" > "$TMP/roster.sh"
[ -s "$TMP/roster.sh" ] && ok || bad "delta_roster missing from scripts/review-prepare.sh"
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

# ---- 3. mode resolution -------------------------------------------------------------------------------------------
# The FULL / DELTA / BASE_SYNC_ONLY decision is made by scripts/review-prepare.sh (covered by scripts/review-prepare.test.sh, including the
# round cap, THOROUGH forcing FULL, an unvalidated SHA and a junk resolver answer). This test keeps the repos the carry and panel tests need.
# base merge only: a BASE_SYNC_ONLY head (the repo the carry-record and panel tests below run in)
mkrepo; R=$(sha HEAD); base_merge b.txt b1; HEAD=$(sha HEAD)
panel_items "$R" | jq -s '.' > "$FAKE_COMMENTS"
BS_R=$R; BS_HEAD=$HEAD; BS_W=$W

# ---- 4. carry record: post, trust, forge resistance ------------------------------------------------------------------
W=$BS_W; R=$BS_R; HEAD=$BS_HEAD
MODE=BASE_SYNC_ONLY; fence_file carry "CARRY_RECORD: POSTED" || exit 1
run_carry() { subst "$TMP/carry.raw" > "$TMP/carry.sh"; run_fence "$TMP/carry.sh" "$@"; }
verified() { # prints the verified Carried-From-SHA for the current $FAKE_COMMENTS using the real snippet
  { cat "$HELPER"; echo 'COMMENTS_JSON=$(cat "$FAKE_COMMENTS"); carry_verified_from'; } > "$TMP/cv_body.sh"
  { cat "$TMP/carry.raw" | awk '/^_dm=\$\(forge_resolve lib\/review-delta-mode\.sh\)/ {exit} {print}'; cat "$TMP/cv_body.sh"; } | subst /dev/stdin > "$TMP/cv.sh"
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

# ---- 6. The 6A read of the carried / earlier head's findings is scripts/review-finalize.sh extract (covered by scripts/review-finalize.test.sh).

echo "review-pr-delta-wiring tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
