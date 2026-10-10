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
expect ISSUE "LOW with injection keyword"     -- --severity LOW --confidence POSSIBLE --text "shell injection via unquoted var"
expect ISSUE "LOW with auth_service path"     -- --severity LOW --confidence LIKELY --text "src/auth_service.py:12 missing check"
expect ISSUE "LOW with Secrets (case)"        -- --severity LOW --confidence LIKELY --text "Secrets leak to log"
expect ISSUE "LOW with permission-check"      -- --severity LOW --confidence LIKELY --text "permission-check skipped"
expect NOTE  "'author' is not 'auth'"         -- --severity LOW --confidence LIKELY --text "author field unused"
expect NOTE  "'tokenizer' is not 'token'"     -- --severity LOW --confidence LIKELY --text "tokenizer splits oddly"
expect ISSUE "LOW CONFIRMED from Auth domain agent" -- --severity LOW --confidence CONFIRMED --agent "Auth" --text "nit"
expect ISSUE "MEDIUM POSSIBLE from Billing agent"  -- --severity MEDIUM --confidence POSSIBLE --agent "billing" --text "nit"
expect NOTE  "LOW LIKELY from Auth domain agent is a NOTE" -- --severity LOW --confidence LIKELY --agent "Auth" --text "nit"
expect NOTE  "LOW POSSIBLE from Database agent is a NOTE"  -- --severity LOW --confidence POSSIBLE --agent "Database" --text "nit"
expect NOTE  "LOW POSSIBLE Concurrency reviewer is a NOTE (AlterLab #34671)" -- --severity LOW --confidence POSSIBLE --agent "Concurrency reviewer" --text "lock edge cases"
expect ISSUE "LOW CONFIRMED Concurrency reviewer files" -- --severity LOW --confidence CONFIRMED --agent "Concurrency reviewer" --text "lock edge cases"
expect ISSUE "keyword still rescues LOW POSSIBLE from domain agent" -- --severity LOW --confidence POSSIBLE --agent "Database" --text "sql injection"

# --- Rule 3: review-finding lineage (fix for a finding) ---
expect NOTE  "lineage LOW CONFIRMED note"     -- --severity LOW --confidence CONFIRMED --lineage review-finding --text "nit"
expect NOTE  "lineage LOW security keyword still note" -- --severity LOW --confidence CONFIRMED --lineage review-finding --text "injection nit"
expect ISSUE "lineage MEDIUM CONFIRMED files" -- --severity MEDIUM --confidence CONFIRMED --lineage review-finding --text "logic bug"
expect NOTE  "lineage MEDIUM LIKELY no-safety note" -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "logic bug"
expect ISSUE "lineage MEDIUM LIKELY with keyword files" -- --severity MEDIUM --confidence LIKELY --lineage review-finding --text "token leaks"
expect NOTE  "lineage MEDIUM POSSIBLE with keyword note" -- --severity MEDIUM --confidence POSSIBLE --lineage review-finding --text "token leaks"

# --- text-file input ---
TMPF=$(mktemp "${TMPDIR:-/tmp}/classify-finding-test.XXXXXX")
printf 'Title: unchecked xss sink\n' > "$TMPF"
expect ISSUE "text-file keyword"              -- --severity LOW --confidence LIKELY --text-file "$TMPF"
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
expect ISSUE "HIGH in diff stays ISSUE (7B blocks it)" -- --severity HIGH --confidence CONFIRMED --inpr-diff "$DIFF" --file src/api/jobs.py
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

# --- usage errors ---
expect_exit 2 "unknown flag"                  -- --bogus x
expect_exit 2 "bad lineage"                   -- --severity LOW --lineage P3
expect_exit 2 "missing flag value"            -- --severity
expect_exit 2 "unreadable text-file"          -- --severity LOW --text-file /nonexistent/x
expect_exit 0 "valid call exits 0"            -- --severity LOW

echo "classify-finding.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
