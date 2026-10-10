#!/usr/bin/env bash
# review-delta.test.sh — fixture cases for scripts/review-delta.sh (forge#3636).
# Real git repos (local bare origin), synthetic comment JSON, and the REAL scripts/trusted-comments.sh.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RD="$ROOT/scripts/review-delta.sh"
TC="$ROOT/scripts/trusted-comments.sh"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-delta.test.sh: jq missing, skipped"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "review-delta.test.sh: git missing, skipped"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# hermetic git: no user config, hooks or signing
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
g() { git -C "$W" -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
commit() { # file content msg
  mkdir -p "$W/$(dirname "$1")"; printf '%s\n' "$2" > "$W/$1"; g add -A >/dev/null; g commit -q -m "$3" >/dev/null
}

CASE=0
mkrepo() { # sets W; main has a.txt, origin/main fetched, branch feat checked out with one PR commit
  CASE=$((CASE+1)); local o="$TMP/o$CASE"; W="$TMP/w$CASE"
  git init -q --bare -b main "$o"
  git clone -q "$o" "$W" 2>/dev/null
  g checkout -q -b main 2>/dev/null
  commit a.txt "base" "base"
  g push -q origin main
  g checkout -q -b feat
  commit pr.txt "pr1" "pr1"
}
sha() { g rev-parse "$1"; }
base_advance() { # file content -> new commit on origin/main, fetched
  g checkout -q main; commit "$1" "$2" "base: $1"; g push -q origin main; g checkout -q feat; g fetch -q origin
}

# --- comment fixtures
body_agent() { printf '<!-- FORGE:REVIEW-AGENT:%s -->\nReviewed-SHA: %s\n\n<!-- REVIEW-FINDINGS-START -->\nNo findings.\n<!-- REVIEW-FINDINGS-END -->' "$1" "$2"; }
body_synth() { printf '<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\nReviewed-SHA: %s\n\nsynth' "$1"; }
body_summary() { printf '# PR Review Summary\n\n**Reviewed commit**: `%s` | **Current HEAD**: `%s` | **Status**: CURRENT\n**Domains**: x | **Agents**: %s (x)\n' "$1" "$1" "$2"; }
cm() { jq -n --arg b "$1" --arg t "${2:-Bot}" --arg a "${3:-NONE}" '{"body":$b,"author_association":$a,"user":{"type":$t,"login":"x"}}'; }
# comments <comment-json>... -> JSON array file path in $CF
comments() { CF="$TMP/c$CASE.json"; printf '%s\n' "$@" | jq -s '.' > "$CF"; }
panel() { # full proven panel for sha: 2 agents + synthesized body
  comments "$(cm "$(body_agent security "$1")")" "$(cm "$(body_agent api "$1")")" "$(cm "$(body_synth "$1")")"
}

run_rd() { # prints stdout; args after the fixed set are appended
  (cd "$W" && bash "$RD" --pr 1 --head "$HEAD" --base main --trusted-script "$TC" --comments-file "$CF" --labels "" "$@" 2>&1)
}
expect() { # name expected-line1 [expected-rounds]
  local out l1 l2; out=$(run_rd "${@:4}"); l1=$(printf '%s\n' "$out" | sed -n 1p); l2=$(printf '%s\n' "$out" | sed -n 2p)
  [ "$l1" = "$2" ] && ok || bad "$1: expected '$2', got '$l1'"
  if [ -n "${3-}" ]; then [ "$l2" = "FULL_ROUNDS=$3" ] && ok || bad "$1: expected FULL_ROUNDS=$3, got '$l2'"; fi
}

# 1. ancestor delta -> DELTA
mkrepo; R=$(sha HEAD); commit pr.txt "pr2" "pr2"; HEAD=$(sha HEAD); panel "$R"
expect "ancestor delta" "DELTA $R..$HEAD" 1

# 2. head == reviewed -> empty delta, documented as DELTA
mkrepo; R=$(sha HEAD); HEAD=$R; panel "$R"
expect "head == reviewed" "DELTA $R..$R" 1

# 3. force-push / rebase -> FULL
mkrepo; R=$(sha HEAD); panel "$R"; g reset -q --hard HEAD~1; commit pr.txt "rewritten" "rewritten"; HEAD=$(sha HEAD)
expect "force-push (reviewed not an ancestor)" "FULL" 1
mkrepo; R=$(sha HEAD); panel "$R"; base_advance b.txt "b1"; g rebase -q origin/main >/dev/null 2>&1; HEAD=$(sha HEAD)
expect "rebase onto new base" "FULL" 1

# 4. clean base merge -> BASE_SYNC_ONLY
mkrepo; R=$(sha HEAD); panel "$R"; base_advance b.txt "b1"; g merge -q --no-ff -m "merge main" origin/main >/dev/null 2>&1; HEAD=$(sha HEAD)
expect "clean base merge" "BASE_SYNC_ONLY $R" 1

# 5. base merge with a conflict-resolution edit -> not BASE_SYNC_ONLY
mkrepo; commit shared.txt "line" "shared"; g push -q origin feat; R=$(sha HEAD); panel "$R"
g checkout -q main; commit shared.txt "base side" "base edits shared"; g push -q origin main; g checkout -q feat; g fetch -q origin
commit shared.txt "feat side" "feat edits shared"; R=$(sha HEAD); panel "$R"
g merge -q --no-ff origin/main >/dev/null 2>&1; printf 'resolved\n' > "$W/shared.txt"; g add -A >/dev/null; g commit -q -m "merge main (resolved)" >/dev/null; HEAD=$(sha HEAD)
out=$(run_rd | sed -n 1p); case "$out" in BASE_SYNC_ONLY*) bad "conflict-resolution merge must not be BASE_SYNC_ONLY (got $out)" ;; *) ok ;; esac

# 6. mixed: base merge plus a regular commit -> DELTA
mkrepo; R=$(sha HEAD); panel "$R"; base_advance b.txt "b1"; g merge -q --no-ff -m "merge main" origin/main >/dev/null 2>&1; commit pr.txt "pr2" "pr2"; HEAD=$(sha HEAD)
expect "base merge plus regular commit" "DELTA $R..$HEAD" 1

# 6b. merge of a non-base branch -> DELTA
mkrepo; R=$(sha HEAD); panel "$R"; g checkout -q -b other; commit o.txt "o" "other"; g checkout -q feat; g merge -q --no-ff -m "merge other" other >/dev/null 2>&1; HEAD=$(sha HEAD)
expect "merge of a non-base branch" "DELTA $R..$HEAD" 1

# 6c. crafted base "merge" whose second parent is an OLD base commit, reverting a binary file or a mode to that
# old version. diff-tree --cc is empty (result equals the second parent) and the 3-dot diffs have identical +/-
# lines, so only the per-path shape (binary blob ids, modes) can tell the PR change moved.
crafted_merge() { # path-from-old-base -> HEAD = merge(R, old base) taking that one path from the old base
  local tree; g checkout -q "$OLD_B" -- "$1"; tree=$(g write-tree); HEAD=$(g commit-tree "$tree" -p "$R" -p "$OLD_B" -m "merge main")
  g reset -q --hard "$HEAD"
}
mkrepo; g checkout -q main; printf '\000\001v1' > "$W/img.bin"; g add -A >/dev/null; g commit -q -m "img v1" >/dev/null; OLD_B=$(sha HEAD)
printf '\000\001v2' > "$W/img.bin"; g add -A >/dev/null; g commit -q -m "img v2" >/dev/null; g push -q origin main; g fetch -q origin
g checkout -q feat; g merge -q --no-ff -m "sync" origin/main >/dev/null 2>&1; R=$(sha HEAD); panel "$R"
crafted_merge img.bin
expect "crafted merge reverting a binary file" "DELTA $R..$HEAD" 1
# binary the PR already changes, swapped for the old base's bytes: same path set and modes, only the blob id differs
mkrepo; g checkout -q main; printf '\000\001v1' > "$W/img.bin"; g add -A >/dev/null; g commit -q -m "img v1" >/dev/null; OLD_B=$(sha HEAD)
printf '\000\001v2' > "$W/img.bin"; g add -A >/dev/null; g commit -q -m "img v2" >/dev/null; g push -q origin main; g fetch -q origin
g checkout -q feat; g merge -q --no-ff -m "sync" origin/main >/dev/null 2>&1
printf '\000\001pr' > "$W/img.bin"; g add -A >/dev/null; g commit -q -m "pr img" >/dev/null; R=$(sha HEAD); panel "$R"
crafted_merge img.bin
expect "crafted merge swapping a PR-changed binary" "DELTA $R..$HEAD" 1
mkrepo; g checkout -q main; chmod +x "$W/a.txt"; g add -A >/dev/null; g commit -q -m "a 755" >/dev/null; OLD_B=$(sha HEAD)
chmod -x "$W/a.txt"; g add -A >/dev/null; g commit -q -m "a 644" >/dev/null; g push -q origin main; g fetch -q origin
g checkout -q feat; g merge -q --no-ff -m "sync" origin/main >/dev/null 2>&1; R=$(sha HEAD); panel "$R"
crafted_merge a.txt
expect "crafted merge reverting a file mode" "DELTA $R..$HEAD" 1

# 7. spec / config changes in the delta -> FULL
for f in forge.yaml commands/review-pr.md commands/review-pr-agents.md commands/review-pr-agents/x.md scripts/review-delta.sh scripts/trusted-comments.sh; do
  mkrepo; R=$(sha HEAD); panel "$R"; commit "$f" "changed" "touch $f"; HEAD=$(sha HEAD)
  expect "$f changed in delta" "FULL" 1
done

# 8. checkpoint trust and shape
mkrepo; R=$(sha HEAD); commit pr.txt "pr2" "pr2"; HEAD=$(sha HEAD)
comments "$(cm "$(body_agent security "$R")" User NONE)" "$(cm "$(body_agent api "$R")" User NONE)" "$(cm "$(body_synth "$R")" User NONE)"
expect "untrusted reviewer comments" "FULL" 0
comments "$(cm "$(body_agent security "$R")" User MEMBER)" "$(cm "$(body_synth "$R")" User MEMBER)"
expect "trusted by author_association" "DELTA $R..$HEAD" 1
comments "$(cm "<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=${R:0:7} -->")"
expect "7-char ROUTE sha is never a checkpoint" "FULL" 0
comments "$(cm "$(body_agent security "${R:0:7}")")" "$(cm "$(body_synth "${R:0:7}")")"
expect "7-char Reviewed-SHA is never a checkpoint" "FULL" 0
comments "$(cm "$(body_agent security "$R")")" "$(cm "$(body_agent api "$R")")"
expect "agent bodies without the post-guard proof (partial panel)" "FULL" 0
comments "$(cm "$(body_agent security "$R")")" "$(cm "$(body_summary "$R" 2)")"
expect "summary Agents count above distinct domains" "FULL" 0
comments "$(cm "$(body_agent security "$R")")" "$(cm "$(body_agent api "$R")")" "$(cm "$(body_summary "$R" 2)")"
expect "summary Agents count equal to distinct domains" "DELTA $R..$HEAD" 1
comments "$(cm "<!-- FORGE:REVIEW-AGENT:security -->
Reviewed-SHA: $R

no findings block")" "$(cm "$(body_synth "$R")")"
expect "agent body without REVIEW-FINDINGS-START" "FULL" 0
comments "$(cm "$(body_agent security "$R")")" "$(cm "$(body_synth "$R")")" "$(cm "<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->
panel degraded")"
expect "review-panel-integrity gate failure after the agents" "FULL" 0
comments "$(cm "<!-- FORGE:REVIEW_DEGRADED -->")" "$(cm "$(body_agent security "$R")")" "$(cm "$(body_synth "$R")")"
expect "degraded marker before the agents does not disqualify" "DELTA $R..$HEAD" 1
comments "$(cm "$(body_agent security "$R")")" "$(cm "$(body_synth "$R")")" "$(cm "<!-- FORGE:REVIEW_BLOCKED -->")"
expect "REVIEW_BLOCKED after the agents" "FULL" 0
panel "$R"
expect "review-degraded label" "FULL" 0 --labels "needs-human,review-degraded"
# --labels given twice: last wins in the parser, so use a fresh invocation without the fixed --labels
out=$(cd "$W" && bash "$RD" --pr 1 --head "$HEAD" --base main --trusted-script "$TC" --comments-file "$CF" --labels "bug,docs" 2>&1 | sed -n 1p)
[ "$out" = "DELTA $R..$HEAD" ] && ok || bad "unrelated labels must not force FULL (got $out)"

# 9. FULL_ROUNDS
mkrepo; R1=$(sha HEAD); commit pr.txt "pr2" "pr2"; R2=$(sha HEAD); commit pr.txt "pr3" "pr3"; HEAD=$(sha HEAD)
comments "$(cm "$(body_agent security "$R1")")" "$(cm "$(body_synth "$R1")")" \
         "$(cm "$(body_agent security "$R2")")" "$(cm "$(body_synth "$R2")")"
expect "two complete SHAs: newest is the checkpoint, FULL_ROUNDS=2" "DELTA $R2..$HEAD" 2
comments "$(cm "$(body_agent security "$R1")")" "$(cm "$(body_synth "$R1")")" "$(cm "$(body_agent api "$R1")")" \
         "$(cm "$(body_agent security "$R2")")" "$(cm "$(body_synth "$R2")")" "$(cm "$(body_synth "$R2")")"
expect "duplicate SHA counted once" "DELTA $R2..$HEAD" 2
comments "$(cm "$(body_agent security "$R1")")" "$(cm "$(body_synth "$R1")")" "$(cm "$(body_agent security "$R2")")"
expect "partial SHA ignored in FULL_ROUNDS" "DELTA $R1..$HEAD" 1

# 10. error paths all print FULL (+ FULL_ROUNDS line)
mkrepo; R=$(sha HEAD); commit pr.txt "pr2" "pr2"; HEAD=$(sha HEAD); panel "$R"
expect "relative --trusted-script" "FULL" "" --trusted-script "scripts/trusted-comments.sh"
out=$(run_rd --trusted-script "scripts/trusted-comments.sh" | sed -n 2p); case "$out" in FULL_ROUNDS=*) ok ;; *) bad "error path must print a FULL_ROUNDS line (got '$out')" ;; esac
expect "nonexistent --trusted-script" "FULL" "" --trusted-script "$TMP/nope.sh"
printf '#!/usr/bin/env bash\nexit 2\n' > "$TMP/tc-fail.sh"
expect "trust script exits 2" "FULL" 0 --trusted-script "$TMP/tc-fail.sh"
expect "unreadable comments file" "FULL" 0 --comments-file "$TMP/missing.json"
: > "$TMP/empty.json"
expect "empty comments file" "FULL" 0 --comments-file "$TMP/empty.json"
printf 'not json' > "$TMP/bad.json"
expect "malformed comments JSON" "FULL" 0 --comments-file "$TMP/bad.json"
BADHEAD=$HEAD; HEAD="${HEAD:0:7}"; expect "7-char --head" "FULL" ""; HEAD="ZZZ"; expect "malformed --head" "FULL" ""; HEAD=$BADHEAD
out=$(cd "$W" && bash "$RD" --pr x --head "$HEAD" --base main --trusted-script "$TC" --comments-file "$CF" --labels "" 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "non-numeric --pr (got $out)"
out=$(cd "$W" && bash "$RD" --pr 1 --head "$HEAD" --base "--evil" --trusted-script "$TC" --comments-file "$CF" --labels "" 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "option-like --base (got $out)"
out=$(cd "$W" && bash "$RD" --bogus 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "unknown flag (got $out)"
out=$(cd "$W" && bash "$RD" 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "no args (got $out)"
out=$(cd "$W" && bash "$RD" --pr 1 --head "$HEAD" --base main --trusted-script "$TC" --comments-file "$CF" 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "labels neither given nor fetchable (got $out)"
out=$(cd "$W" && bash "$RD" --pr 1 --head "$HEAD" --base nosuchbranch --trusted-script "$TC" --comments-file "$CF" --labels "" 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "missing origin/<base> (got $out)"
# unknown reviewed object: the checkpoint names a well-formed SHA that is not in the repo
GHOST=0123456789abcdef0123456789abcdef01234567; panel "$GHOST"
expect "unknown reviewed object" "FULL" 1
# not a git repo
panel "$R"; NOGIT="$TMP/nogit"; mkdir -p "$NOGIT"
out=$(bash "$RD" --pr 1 --head "$HEAD" --base main --trusted-script "$TC" --comments-file "$CF" --labels "" --repo-path "$NOGIT" 2>&1 | sed -n 1p); [ "$out" = FULL ] && ok || bad "not a git repo (got $out)"

# 11. pagination shape: two concatenated arrays
CF="$TMP/paged.json"; { printf '[%s]\n' "$(cm "$(body_agent security "$R")")"; printf '[%s]\n' "$(cm "$(body_synth "$R")")"; } > "$CF"
expect "concatenated pagination arrays" "DELTA $R..$HEAD" 1

# 12. 64-hex (sha256) checkpoints are accepted shape-wise
mkrepo; R=$(sha HEAD); commit pr.txt "pr2" "pr2"; HEAD=$(sha HEAD)
R64="${R}0123456789abcdef01234567"; R64=${R64:0:64}; panel "$R64"
expect "64-hex checkpoint not in repo -> FULL (validated, then unknown object)" "FULL" 1

# 13. trust script is never taken from the cwd: a planted copy must not change the verdict
mkrepo; R=$(sha HEAD); commit pr.txt "pr2" "pr2"; HEAD=$(sha HEAD)
comments "$(cm "$(body_agent security "$R")" User NONE)" "$(cm "$(body_synth "$R")" User NONE)"
mkdir -p "$W/scripts"; printf '#!/usr/bin/env bash\ncat >/dev/null; jq -c . <<< "\\"$1\\""\n' > "$W/scripts/trusted-comments.sh"
out=$(cd "$W" && bash "$RD" --pr 1 --head "$HEAD" --base main --trusted-script "$TC" --comments-file "$CF" --labels "" 2>&1 | sed -n 1p)
[ "$out" = FULL ] && ok || bad "planted cwd trust script must be ignored (got $out)"

echo "review-delta tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
