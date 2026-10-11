#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/classify-finding.sh (review-pr §6B.5 note disposition).
# Run: bash scripts/classify-finding.test.sh   (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/classify-finding.sh"
pass=0; fail=0

expect() { # expect <ISSUE|NOTE> <description> -- args...
  want="$1"; desc="$2"; shift 3
  got=$(bash "$S" "$@" 2>/dev/null | cut -d' ' -f1)
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (want $want, got '${got}')"; fi
}
expect_exit() { # expect_exit <code> <description> -- args...
  want="$1"; desc="$2"; shift 3
  bash "$S" "$@" >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (want exit $want, got $got)"; fi
}

# --- Rule 1: high severity and unparseable severity always file ---
expect ISSUE "CRITICAL files"                 -- --severity CRITICAL --confidence POSSIBLE
expect ISSUE "HIGH POSSIBLE files"            -- --severity HIGH --confidence POSSIBLE
expect ISSUE "HIGH on lineage files"          -- --severity HIGH --confidence LIKELY --lineage review-finding
expect ISSUE "missing severity files"         -- --severity "" --confidence LIKELY
expect ISSUE "unknown severity files"         -- --severity INFO
expect ISSUE "lowercase high files"           -- --severity high

# --- Rule 4: non-lineage ---
expect ISSUE "MEDIUM CONFIRMED files"         -- --severity MEDIUM --confidence CONFIRMED --text "loop exits early"
expect ISSUE "MEDIUM LIKELY files"            -- --severity MEDIUM --confidence LIKELY --text "loop exits early"
expect NOTE  "MEDIUM POSSIBLE no-safety note" -- --severity MEDIUM --confidence POSSIBLE --text "loop exits early"
expect NOTE  "LOW CONFIRMED no-safety note"   -- --severity LOW --confidence CONFIRMED --text "stale comment wording"
expect NOTE  "LOW from Security agent, no keyword, is a NOTE (audit fix)" -- --severity LOW --confidence CONFIRMED --agent "Security" --text "comment wording drifted"
expect NOTE  "LOW from General Security & Quality, no keyword" -- --severity LOW --confidence LIKELY --agent "General Security & Quality" --text "duplicated predicate in NOTE count"

# --- Safety exemption (content-based) ---
expect NOTE  "LOW POSSIBLE injection keyword is a NOTE" -- --severity LOW --confidence POSSIBLE --text "shell injection via unquoted var"
expect NOTE  "LOW LIKELY auth_service path is a NOTE" -- --severity LOW --confidence LIKELY --text "src/auth_service.py:12 missing check"
expect NOTE  "LOW LIKELY Secrets (case) is a NOTE" -- --severity LOW --confidence LIKELY --text "Secrets leak to log"
expect NOTE  "LOW LIKELY permission-check is a NOTE" -- --severity LOW --confidence LIKELY --text "permission-check skipped"
expect NOTE  "'author' is not 'auth'"         -- --severity LOW --confidence LIKELY --text "author field unused"
expect NOTE  "'tokenizer' is not 'token'"     -- --severity LOW --confidence LIKELY --text "tokenizer splits oddly"
expect NOTE  "LOW CONFIRMED from Auth domain agent is a NOTE (no LOW rescue)" -- --severity LOW --confidence CONFIRMED --agent "Auth" --text "nit"
expect ISSUE "MEDIUM POSSIBLE from Billing agent"  -- --severity MEDIUM --confidence POSSIBLE --agent "billing" --text "nit"
expect NOTE  "LOW LIKELY from Auth domain agent is a NOTE" -- --severity LOW --confidence LIKELY --agent "Auth" --text "nit"
expect NOTE  "LOW POSSIBLE from Database agent is a NOTE"  -- --severity LOW --confidence POSSIBLE --agent "Database" --text "nit"
expect NOTE  "LOW POSSIBLE Concurrency reviewer is a NOTE (AlterLab #34671)" -- --severity LOW --confidence POSSIBLE --agent "Concurrency reviewer" --text "lock edge cases"
expect NOTE  "LOW CONFIRMED Concurrency reviewer is a NOTE" -- --severity LOW --confidence CONFIRMED --agent "Concurrency reviewer" --text "lock edge cases"
expect NOTE  "LOW POSSIBLE domain agent + keyword is a NOTE" -- --severity LOW --confidence POSSIBLE --agent "Database" --text "sql injection"
# --- LOW needs keyword AND CONFIRMED; domain agents rescue MEDIUM only (#3639) ---
expect NOTE  "LOW LIKELY + keyword is a NOTE"        -- --severity LOW --confidence LIKELY --text "shell injection via unquoted var"
expect ISSUE "LOW CONFIRMED + keyword files"         -- --severity LOW --confidence CONFIRMED --text "shell injection via unquoted var"
expect NOTE  "LOW CONFIRMED Auth agent, no keyword"  -- --severity LOW --confidence CONFIRMED --agent Auth --text "nit"
expect ISSUE "MEDIUM POSSIBLE + keyword still files" -- --severity MEDIUM --confidence POSSIBLE --text "sql injection"
expect ISSUE "MEDIUM POSSIBLE Billing agent still files" -- --severity MEDIUM --confidence POSSIBLE --agent Billing --text "nit"
expect ISSUE "HIGH POSSIBLE files"                   -- --severity HIGH --confidence POSSIBLE


# --- Rule 3: review-finding lineage (fix for a finding) ---
expect NOTE  "lineage LOW CONFIRMED note"     -- --severity LOW --confidence CONFIRMED --lineage review-finding --text "nit"
expect NOTE  "lineage LOW security keyword still note" -- --severity LOW --confidence CONFIRMED --lineage review-finding --text "injection nit"
expect ISSUE "lineage MEDIUM CONFIRMED files" -- --severity MEDIUM --confidence CONFIRMED --lineage review-finding --text "logic bug"
expect NOTE  "lineage MEDIUM LIKELY no-safety note" -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "logic bug"
expect ISSUE "lineage MEDIUM LIKELY with keyword files" -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "token leaks"
expect NOTE  "lineage MEDIUM POSSIBLE with keyword note" -- --severity MEDIUM --confidence POSSIBLE --lineage review-finding --text "token leaks"

# --- Fix-efficacy exemption (#3693): #3683 SEC-1 shape ---
SEC1="enqueue_breaker_decision helper never declared in the fences that call it; fresh shell never queues the breaker decision"
LN=(--severity MEDIUM --confidence LIKELY --lineage review-finding --agent Security --text "$SEC1")
expect NOTE  "SEC-1 untagged stays damped"            -- "${LN[@]}"
expect ISSUE "SEC-1 --fix-efficacy fails"             -- "${LN[@]}" --fix-efficacy fails --fixes-issue 3621
expect ISSUE "SEC-1 --fix-efficacy regresses"         -- "${LN[@]}" --fix-efficacy regresses
expect ISSUE "SEC-1 POSSIBLE with fix-efficacy"       -- --severity MEDIUM --confidence POSSIBLE --lineage review-finding --text "x" --fix-efficacy fails
expect ISSUE "text tag FIX_EFFICACY fallback"         -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "$(printf 'helper missing.\nFIX_EFFICACY: fails')"
expect ISSUE "bold Fix efficacy line fallback"        -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "**Fix efficacy**: regresses"
expect NOTE  "mid-line FIX_EFFICACY token stays NOTE"  -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "helper missing. FIX_EFFICACY: fails"
expect NOTE  "#N + still-fails phrase no longer opts in" -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "this still fails to fix #3621 in a fresh shell" --fixes-issue 3621
expect NOTE  "regression test for #N stays NOTE"       -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "Missing regression test for #3621" --fixes-issue 3621
expect NOTE  "no regression #N stays NOTE"             -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "no regression #3621, but wording is off" --fixes-issue 3621
expect NOTE  "reintroduce-style phrase stays NOTE"     -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "could reintroduce #3621 naming" --fixes-issue 3621
expect NOTE  "LOW + fix-efficacy stays NOTE"          -- --severity LOW --confidence CONFIRMED --lineage review-finding --text "x" --fix-efficacy fails
expect ISSUE "non-lineage MEDIUM POSSIBLE + efficacy" -- --severity MEDIUM --confidence POSSIBLE --text "x" --fix-efficacy fails
expect ISSUE "HIGH unchanged"                         -- --severity HIGH --confidence LIKELY --lineage review-finding --fix-efficacy fails
expect_exit 2 "bad --fix-efficacy value"              -- --severity MEDIUM --fix-efficacy broken
FX_DIFF=$(mktemp "${TMPDIR:-/tmp}/classify-finding-fx.XXXXXX"); printf 'src/a.sh\n' > "$FX_DIFF"
expect INPR_FIX "CONFIRMED in-PR efficacy stays INPR_FIX" -- --severity MEDIUM --confidence CONFIRMED --lineage review-finding --fix-efficacy fails --inpr-diff "$FX_DIFF" --file src/a.sh
rm -f "$FX_DIFF"
FX_SCOPE=$(mktemp "${TMPDIR:-/tmp}/classify-finding-fxs.XXXXXX"); FX_OPEN=$(mktemp "${TMPDIR:-/tmp}/classify-finding-fxo.XXXXXX")
printf 'deferred\tsrc/b.sh\t3446\n' > "$FX_SCOPE"; printf '3446\n' > "$FX_OPEN"
expect NOTE  "contract-deferred untagged demotes"     -- --severity MEDIUM --confidence LIKELY --text "x" --file src/b.sh --contract-scope "$FX_SCOPE" --contract-open "$FX_OPEN"
expect ISSUE "contract-deferred + efficacy files"     -- --severity MEDIUM --confidence LIKELY --text "x" --file src/b.sh --contract-scope "$FX_SCOPE" --contract-open "$FX_OPEN" --fix-efficacy fails
rm -f "$FX_SCOPE" "$FX_OPEN"
_a=$(bash "$S" --severity MEDIUM --lineage review-finding --text "x" --fix-efficacy fails --fixes-issue 5); _b=$(bash "$S" --severity MEDIUM --lineage review-finding --text "x" --fix-efficacy fails --merge-issue 5)
if [ "$_a" = "$_b" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: --fixes-issue/--merge-issue equivalence"; fi

# --- text-file input ---
TMPF=$(mktemp "${TMPDIR:-/tmp}/classify-finding-test.XXXXXX")
printf 'Title: unchecked xss sink\n' > "$TMPF"
expect NOTE  "text-file keyword, LOW LIKELY, is a NOTE"           -- --severity LOW --confidence LIKELY --text-file "$TMPF"
rm -f "$TMPF"

# --- In-PR fix gate (#3387, narrowed): MEDIUM CONFIRMED in the PR diff ---
DIFF=$(mktemp "${TMPDIR:-/tmp}/classify-finding-diff.XXXXXX")
printf 'src/api/jobs.py\ncommands/review-pr.md\n' > "$DIFF"
expect INPR_FIX "MEDIUM CONFIRMED in diff"            -- --severity MEDIUM --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/jobs.py
expect INPR_FIX "file:line form matches"              -- --severity MEDIUM --confidence CONFIRMED --inpr-diff "$DIFF" --file "src/api/jobs.py:142"
expect INPR_FIX "./ prefix matches"                   -- --severity MEDIUM --confidence CONFIRMED --inpr-diff "$DIFF" --file ./commands/review-pr.md
expect INPR_FIX "lineage PR still fixes in-PR"        -- --severity MEDIUM --confidence CONFIRMED --lineage review-finding --inpr-diff "$DIFF" --file src/api/jobs.py
expect ISSUE "MEDIUM CONFIRMED outside diff files"    -- --severity MEDIUM --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/other.py
expect ISSUE "MEDIUM LIKELY in diff is not gated"     -- --severity MEDIUM --confidence LIKELY --inpr-diff "$DIFF" --file src/api/jobs.py
expect INPR_FIX "HIGH CONFIRMED in diff (#3592)"       -- --severity HIGH --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/jobs.py
expect INPR_FIX "CRITICAL CONFIRMED in diff (#3592)"   -- --severity CRITICAL --confidence CONFIRMED --inpr-diff "$DIFF" --file "src/api/jobs.py:9"
expect INPR_FIX "HIGH in diff with safety keyword"     -- --severity HIGH --confidence CONFIRMED --title "billing refund leg unreachable" --inpr-diff "$DIFF" --file src/api/jobs.py
expect ISSUE "HIGH LIKELY in diff stays ISSUE"         -- --severity HIGH --confidence LIKELY --inpr-diff "$DIFF" --file src/api/jobs.py
expect ISSUE "CRITICAL LIKELY in diff stays ISSUE"     -- --severity CRITICAL --confidence LIKELY --inpr-diff "$DIFF" --file src/api/jobs.py
expect ISSUE "HIGH CONFIRMED outside diff stays ISSUE" -- --severity HIGH --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/other.py
expect ISSUE "CRITICAL CONFIRMED outside diff"         -- --severity CRITICAL --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/other.py
expect ISSUE "HIGH CONFIRMED without --inpr-diff"      -- --severity HIGH --confidence CONFIRMED --file src/api/jobs.py
expect ISSUE "HIGH CONFIRMED without --file"           -- --severity HIGH --confidence CONFIRMED --inpr-diff "$DIFF"
for _s in HIGH CRITICAL MEDIUM; do
  _want="INPR_FIX $(printf '%s' "$_s" | tr '[:upper:]' '[:lower:]')-confirmed-in-diff"
  _got=$(bash "$S" --severity "$_s" --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/jobs.py 2>/dev/null)
  if [ "$_got" = "$_want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: reason carries severity $_s (want '$_want', got '$_got')"; fi
done
expect NOTE  "LOW in diff stays NOTE"                 -- --severity LOW --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/jobs.py
expect ISSUE "no --inpr-diff: unchanged behaviour"    -- --severity MEDIUM --confidence CONFIRMED --file src/api/jobs.py
expect ISSUE "no --file: unchanged behaviour"         -- --severity MEDIUM --confidence CONFIRMED --inpr-diff "$DIFF"
expect ISSUE "prefix of a diff path does not match"   -- --severity MEDIUM --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api
rm -f "$DIFF"
expect_exit 2 "unreadable --inpr-diff"        -- --severity MEDIUM --inpr-diff /nonexistent/d --file x

# --- Contract-declared scope gate (#3447) ---
CSCOPE=$(mktemp "${TMPDIR:-/tmp}/classify-finding-scope.XXXXXX")
COPEN=$(mktemp "${TMPDIR:-/tmp}/classify-finding-open.XXXXXX")
TAB=$(printf '\t')
printf 'deferred%ssrc/sync.sh%s3446\naccepted-risk%ssrc/legacy%s\nnot-affected%ssrc/engine%s\ndeferred%ssrc/closed.py%s99\ndeferred%ssrc/a/b%s3446\n' \
  "$TAB" "$TAB" "$TAB" "$TAB" "$TAB" "$TAB" "$TAB" "$TAB" "$TAB" "$TAB" > "$CSCOPE"
printf '3446\n' > "$COPEN"
CS=(--contract-scope "$CSCOPE" --contract-open "$COPEN")
expect NOTE  "deferred + open issue demotes"          -- --severity MEDIUM --confidence CONFIRMED --text "sync gap" --file src/sync.sh "${CS[@]}"
got=$(bash "$S" --severity MEDIUM --confidence CONFIRMED --text "sync gap" --file src/sync.sh "${CS[@]}")
if [ "$got" = "NOTE contract-deferred #3446" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: deferred reason (got '$got')"; fi
expect NOTE  "file:line form demotes"                 -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/sync.sh:42 "${CS[@]}"
expect NOTE  "./ prefix demotes"                      -- --severity MEDIUM --confidence LIKELY --text "gap" --file ./src/sync.sh "${CS[@]}"
expect NOTE  "directory prefix demotes accepted-risk" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/legacy/old.py:9 "${CS[@]}"
got=$(bash "$S" --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/legacy "${CS[@]}")
if [ "$got" = "NOTE contract-accepted-risk" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: accepted-risk reason (got '$got')"; fi
expect NOTE  "nested deferred path demotes"           -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/a/b/c.py "${CS[@]}"
expect ISSUE "sibling with shared name prefix is not under dir" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/legacy2/x.py "${CS[@]}"
expect ISSUE "unrelated path unchanged"               -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/other.py "${CS[@]}"
expect ISSUE "deferred issue closed (not listed) files" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/closed.py "${CS[@]}"
expect ISSUE "no --contract-open means no deferred demotion" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/sync.sh --contract-scope "$CSCOPE"
expect NOTE  "accepted-risk needs no --contract-open" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/legacy/x.py --contract-scope "$CSCOPE"
expect ISSUE "not-affected never demotes"             -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/engine/x.py "${CS[@]}"
expect ISSUE "CRITICAL never demotes"                 -- --severity CRITICAL --confidence CONFIRMED --text "gap" --file src/sync.sh "${CS[@]}"
expect ISSUE "HIGH never demotes"                     -- --severity HIGH --confidence CONFIRMED --text "gap" --file src/legacy/x.py "${CS[@]}"
expect ISSUE "accepted-risk + security keyword files" -- --severity MEDIUM --confidence CONFIRMED --text "token leak in logs" --file src/legacy/x.py "${CS[@]}"
expect ISSUE "accepted-risk + domain agent files"     -- --severity MEDIUM --confidence CONFIRMED --agent Billing --text "nit" --file src/legacy/x.py "${CS[@]}"
expect ISSUE "deferred + security keyword files"     -- --severity MEDIUM --confidence CONFIRMED --text "token leak" --file src/sync.sh "${CS[@]}"
expect ISSUE "deferred + SQL injection keywords files" -- --severity MEDIUM --confidence CONFIRMED --text "SQL injection token password" --file src/sync.sh "${CS[@]}"
expect ISSUE "deferred + domain agent files"          -- --severity MEDIUM --confidence CONFIRMED --agent Auth --text "nit" --file src/sync.sh "${CS[@]}"
expect ISSUE "deferred to own issue never demotes"    -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/sync.sh --merge-issue 3446 "${CS[@]}"
expect ISSUE "deferred to own issue (#N form) files"  -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/sync.sh --merge-issue "#3446" "${CS[@]}"
expect NOTE  "deferred to another issue still demotes" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/sync.sh --merge-issue 3447 "${CS[@]}"
expect NOTE  "LOW LIKELY keyword on deferred path demotes (#3639)" -- --severity LOW --confidence LIKELY --text "token leak" --file src/sync.sh "${CS[@]}"
got=$(bash "$S" --severity LOW --confidence LIKELY --text "token leak" --file src/sync.sh "${CS[@]}")
if [ "$got" = "NOTE contract-deferred #3446" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: LOW LIKELY keyword deferred reason (got '$got')"; fi
expect ISSUE "LOW CONFIRMED keyword on deferred path still files (#3639)" -- --severity LOW --confidence CONFIRMED --text "token leak" --file src/sync.sh "${CS[@]}"
expect NOTE  "accepted-risk unaffected by --merge-issue" -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/legacy/x.py --merge-issue 3446 "${CS[@]}"
DIFF2=$(mktemp "${TMPDIR:-/tmp}/classify-finding-diff.XXXXXX")
printf 'src/sync.sh\nsrc/legacy/touched.py\n' > "$DIFF2"
expect ISSUE "path in PR diff is not demoted (deferred)"      -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/sync.sh --inpr-diff "$DIFF2" "${CS[@]}"
expect ISSUE "path in PR diff is not demoted (accepted-risk)" -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/legacy/touched.py --inpr-diff "$DIFF2" "${CS[@]}"
expect NOTE  "untouched path under accepted dir demotes with diff given" -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/legacy/other.py --inpr-diff "$DIFF2" "${CS[@]}"
rm -f "$DIFF2"
PRF=$(mktemp "${TMPDIR:-/tmp}/classify-finding-prf.XXXXXX")
printf 'src/sync.sh\nsrc/legacy/touched.py\n' > "$PRF"
expect ISSUE "path in --pr-files is not demoted (deferred)"      -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/sync.sh --pr-files "$PRF" "${CS[@]}"
expect ISSUE "path in --pr-files is not demoted (accepted-risk)" -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/legacy/touched.py --pr-files "$PRF" "${CS[@]}"
expect NOTE  "untouched path demotes with --pr-files given"      -- --severity MEDIUM --confidence LIKELY --text "gap" --file src/legacy/other.py --pr-files "$PRF" "${CS[@]}"
expect ISSUE "--pr-files alone never triggers INPR_FIX"          -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/other.py --pr-files "$PRF"
rm -f "$PRF"
expect_exit 2 "unreadable --pr-files"         -- --severity MEDIUM --pr-files /nonexistent/p --file x
expect ISSUE "no --file: no contract demotion"        -- --severity MEDIUM --confidence CONFIRMED --text "gap" "${CS[@]}"
expect ISSUE "no contract flags: unchanged"           -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/sync.sh
expect NOTE  "LOW stays NOTE through the gate"        -- --severity LOW --confidence CONFIRMED --text "gap" --file src/other.py "${CS[@]}"
: > "$CSCOPE"
expect ISSUE "empty scope file: unchanged"            -- --severity MEDIUM --confidence CONFIRMED --text "gap" --file src/sync.sh "${CS[@]}"
rm -f "$CSCOPE" "$COPEN"
expect_exit 2 "unreadable --contract-scope"   -- --severity MEDIUM --contract-scope /nonexistent/s --file x
expect_exit 2 "unreadable --contract-open"    -- --severity MEDIUM --contract-open /nonexistent/o --file x

# --- Cross-head / cross-PR re-flag gate (#3641) ---
expect_out() { # expect_out <full output> <description> -- args...
  want="$1"; desc="$2"; shift 3
  got=$(bash "$S" "$@" 2>/dev/null)
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (want '$want', got '${got}')"; fi
}
TAB=$(printf '\t')
PRIOR=$(mktemp "${TMPDIR:-/tmp}/classify-finding-prior.XXXXXX")
DMAP=$(mktemp "${TMPDIR:-/tmp}/classify-finding-dmap.XXXXXX")
{
  printf 'src/sync.sh\t40\t50\tlock released before write completes\tnote\t\n'
  printf 'src/api.py\t10\t20\tmissing retry on timeout handler\tfiled\t123\n'
  printf 'src/closed.py\t5\t15\tstale cache entry never evicted\tfiled-closed\t77\n'
  printf 'src/notes.py\t\t\tduplicated predicate counted twice\tnote\t\n'
  printf 'src/unlinked.py\t30\t40\tunvalidated redirect target in login handler\tunknown\t\n'
} > "$PRIOR"
PF=(--prior-findings "$PRIOR")
M=(--severity MEDIUM --confidence CONFIRMED)

expect_out "NOTE reflag-note" "re-flag by line IoU (same range)" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 42 --line-end 50 --title "lock handling wording here"
expect_out "NOTE reflag-note" "re-flag via path:line tolerated" -- "${M[@]}" "${PF[@]}" --file src/sync.sh:41 --line-end 50 --title "lock x"
printf 'src/sync.sh\t1\t2\t1\t12\n' > "$DMAP"   # 2 lines became 12: prior 40-50 is now 50-60
expect_out "NOTE reflag-note" "re-flag after the line moved, shifted by diff map" -- "${M[@]}" "${PF[@]}" --diff-map "$DMAP" --file src/sync.sh --line-start 50 --line-end 60 --title "lock something else"
expect ISSUE "line moved with no diff map does not match" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 50 --line-end 60 --title "lock something else"
printf 'garbage\n' > "$DMAP"
expect_out "NOTE reflag-note" "unparseable diff map falls back to unshifted range" -- "${M[@]}" "${PF[@]}" --diff-map "$DMAP" --file src/sync.sh --line-start 41 --line-end 50 --title "lock x"
expect_out "NOTE reflag-note" "re-flag by title tokens (far line)" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 300 --title "Lock released before the write"
expect_out "NOTE reflag-note" "NOTE row with empty line columns matches by title" -- "${M[@]}" "${PF[@]}" --file src/notes.py --line-start 9 --title "Duplicated predicate is counted twice"
expect ISSUE "same line, different topic MEDIUM CONFIRMED is not swallowed (SEC-1)" -- "${M[@]}" --agent security "${PF[@]}" --file src/sync.sh --line-start 42 --line-end 50 --title "SQL injection via unsanitized token"
expect ISSUE "same line with no title at all is not swallowed" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 42 --line-end 50
expect_out "NOTE reflag-note" "same line, same topic (one shared token) still NOTE" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 42 --line-end 50 --title "Lock handling is racy"
expect ISSUE "same line, only a stopword-class word shared is not swallowed (#3719)" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 42 --line-end 50 --title "Path traversal in the write target"
expect ISSUE "far line, only generic words shared is not swallowed (#3719)" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 300 --title "Command injection before write with the lock"
expect ISSUE "non-overlapping same-file finding is classified normally" -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 200 --line-end 210 --title "missing bounds check"
expect ISSUE "two shared tokens are not enough"       -- "${M[@]}" "${PF[@]}" --file src/sync.sh --line-start 200 --title "lock released late"
expect ISSUE "same title on a different file is classified normally" -- "${M[@]}" "${PF[@]}" --file src/other.sh --line-start 45 --title "lock released before write completes"
expect ISSUE "unknown row does not demote MEDIUM CONFIRMED (unlinked prior)" -- "${M[@]}" "${PF[@]}" --file src/unlinked.py --line-start 300 --title "Unvalidated redirect target in the login handler"
expect ISSUE "unknown row does not demote MEDIUM CONFIRMED by line IoU" -- "${M[@]}" "${PF[@]}" --file src/unlinked.py --line-start 32 --line-end 40 --title "redirect target unchecked"
expect ISSUE "unknown row does not demote MEDIUM LIKELY" -- --severity MEDIUM --confidence LIKELY "${PF[@]}" --file src/unlinked.py --line-start 300 --title "Unvalidated redirect target in the login handler"
expect_out "NOTE reflag-note" "unknown row still demotes LOW" -- --severity LOW --confidence CONFIRMED "${PF[@]}" --file src/unlinked.py --line-start 300 --title "Unvalidated redirect target in the login handler"
expect_out "NOTE reflag-note" "unknown row still demotes MEDIUM POSSIBLE" -- --severity MEDIUM --confidence POSSIBLE "${PF[@]}" --file src/unlinked.py --line-start 300 --title "Unvalidated redirect target in the login handler"
expect ISSUE "HIGH unaffected by unknown row" -- --severity HIGH --confidence CONFIRMED "${PF[@]}" --file src/unlinked.py --line-start 300 --title "Unvalidated redirect target in the login handler"
expect_out "NOTE reflag-filed #123" "re-flag of an already-filed issue links it" -- "${M[@]}" "${PF[@]}" --file src/api.py --line-start 12 --line-end 18 --title "retry x"
expect_out "NOTE reflag-filed #123" "filed re-flag by title tokens" -- "${M[@]}" "${PF[@]}" --file src/api.py --line-start 99 --title "Missing retry on timeout"
expect ISSUE "filed-closed row is ignored (regression not swallowed)" -- "${M[@]}" "${PF[@]}" --file src/closed.py --line-start 5 --line-end 15 --title "stale cache entry never evicted"
expect ISSUE "HIGH is never demoted by a re-flag"     -- --severity HIGH --confidence CONFIRMED "${PF[@]}" --file src/api.py --line-start 12 --line-end 18 --title "missing retry on timeout handler"
expect ISSUE "CRITICAL is never demoted by a re-flag" -- --severity CRITICAL "${PF[@]}" --file src/api.py --line-start 12 --line-end 18
expect ISSUE "unparseable severity is never demoted"  -- --severity INFO "${PF[@]}" --file src/api.py --line-start 12 --line-end 18
expect ISSUE "no --file: gate skipped"                -- "${M[@]}" "${PF[@]}" --title "lock released before write completes"
expect ISSUE "no --prior-findings: unchanged"         -- "${M[@]}" --file src/api.py --line-start 12 --line-end 18
expect NOTE  "re-flag wins over in-PR fix gate"       -- "${M[@]}" "${PF[@]}" --file src/api.py --line-start 12 --line-end 18 --title "retry gap" --inpr-diff "$PRIOR"
: > "$PRIOR"
expect ISSUE "empty prior-findings: unchanged"        -- "${M[@]}" "${PF[@]}" --file src/api.py --line-start 12 --line-end 18 --title "missing retry"
rm -f "$PRIOR" "$DMAP"
expect_exit 2 "unreadable --prior-findings"   -- --severity MEDIUM --prior-findings /nonexistent/p --file x

# --- usage errors ---
expect_exit 2 "unknown flag"                  -- --bogus x
expect_exit 2 "bad lineage"                   -- --severity LOW --lineage P3
expect_exit 2 "missing flag value"            -- --severity
expect_exit 2 "unreadable text-file"          -- --severity LOW --text-file /nonexistent/x
expect_exit 0 "valid call exits 0"            -- --severity LOW

echo "classify-finding.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
