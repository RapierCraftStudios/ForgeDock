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
expect ISSUE "LOW from Auth domain agent"     -- --severity LOW --confidence LIKELY --agent "Auth" --text "nit"
expect ISSUE "LOW from Billing domain agent"  -- --severity LOW --confidence POSSIBLE --agent "billing" --text "nit"
expect ISSUE "LOW from Database agent"        -- --severity LOW --confidence POSSIBLE --agent "Database" --text "nit"
expect ISSUE "LOW from Concurrency agent"     -- --severity LOW --confidence POSSIBLE --agent "Concurrency" --text "nit"

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

# --- usage errors ---
expect_exit 2 "unknown flag"                  -- --bogus x
expect_exit 2 "bad lineage"                   -- --severity LOW --lineage P3
expect_exit 2 "missing flag value"            -- --severity
expect_exit 2 "unreadable text-file"          -- --severity LOW --text-file /nonexistent/x
expect_exit 0 "valid call exits 0"            -- --severity LOW

echo "classify-finding.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
